import { spawn } from "node:child_process";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClaudeCliBackendConfig } from "../core/config.ts";
import { BackendError } from "../core/types.ts";
import type { Backend, BackendRequest, BackendResult } from "../core/types.ts";

// The only binary this backend runs from config: the user's own `claude`, found on PATH, with its
// own login. Credentials are never read here. Flags are documented in docs/claude-cli-flags.md.
const CLAUDE_BIN = "claude";
const CLAUDE_ARGS = ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--safe-mode"];

/** The only tools Claude gets in the chat: it can look at the repository, not change it or run anything. */
export const CHAT_TOOLS = "Read,Grep,Glob";
// Headless with tools: `--permission-prompts none` makes anything that would ask for permission
// fail at once instead of waiting for an answer nobody can give.
const CHAT_ARGS = ["-p", "--output-format", "json", "--tools", CHAT_TOOLS, "--permission-prompts", "none", "--no-session-persistence", "--safe-mode"];
const HEALTH_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 2000;

/**
 * With any of these set, `claude -p` stops using the subscription login: it bills an API key,
 * or talks to another provider or gateway. This project is zero-cost and never routes the
 * subscription elsewhere, so the backend refuses to start. Only the names are checked; the
 * values are never read.
 */
export const BILLING_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

interface ClaudeResult {
  result?: unknown;
  is_error?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  modelUsage?: Record<string, unknown>;
}

// Claude calls run one at a time, across every instance in this process.
let queue: Promise<unknown> = Promise.resolve();

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export class ClaudeCliBackend implements Backend {
  readonly id: string;
  readonly name = "claude-cli";
  readonly kind = "cloud" as const;
  readonly model: string;
  readonly timeoutMs: number;
  private readonly cfg: ClaudeCliBackendConfig;
  private readonly bin: string;

  /** `testOnly.bin` lets tests substitute a fake binary. Nothing built from config ever passes it. */
  constructor(id: string, cfg: ClaudeCliBackendConfig, testOnly?: { bin: string }) {
    this.id = id;
    this.cfg = cfg;
    this.model = cfg.model ?? "default";
    this.timeoutMs = cfg.timeoutMs;
    this.bin = testOnly?.bin ?? CLAUDE_BIN;
  }

  /** True when `claude --version` exits 0. Makes no model call. */
  healthCheck(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.bin, ["--version"], { stdio: "ignore" });
      // Our own timer, cleared on every outcome: spawn's `timeout` option leaves a timer running
      // when the binary is missing, which would hold the process open for the full timeout.
      const timer = setTimeout(() => child.kill("SIGKILL"), HEALTH_TIMEOUT_MS);
      const done = (healthy: boolean) => {
        clearTimeout(timer);
        resolve(healthy);
      };
      child.on("error", () => done(false));
      child.on("close", (code) => done(code === 0));
    });
  }

  /** A stateless call: no tools, and a neutral directory unless one is given. */
  run(req: BackendRequest): Promise<BackendResult> {
    return this.enqueue(CLAUDE_ARGS, req);
  }

  /** A headless call inside a repository, with the read-only chat tools. */
  runAgent(req: { prompt: string; cwd: string; timeoutMs: number }): Promise<BackendResult> {
    return this.enqueue(CHAT_ARGS, req);
  }

  /** Every call goes through here: the billing check first, then the one-at-a-time queue. */
  private enqueue(baseArgs: string[], req: BackendRequest): Promise<BackendResult> {
    const blocking = BILLING_ENV_VARS.find((name) => (process.env[name] ?? "") !== "");
    if (blocking !== undefined) {
      return Promise.reject(
        new BackendError(
          "backend_error",
          `${blocking} is set in your environment: claude would not use your subscription login. Unset it and run again.`,
        ),
      );
    }
    const next = queue.then(() => this.runNow(baseArgs, req));
    queue = next.catch(() => {});
    return next;
  }

  private runNow(baseArgs: string[], req: BackendRequest): Promise<BackendResult> {
    const started = Date.now();
    // A neutral directory by default: the worker gets the prompt and nothing else.
    const ownDir = req.cwd === undefined ? mkdtempSync(path.join(tmpdir(), "orch-claude-")) : undefined;
    const args = this.cfg.model ? [...baseArgs, "--model", this.cfg.model] : baseArgs;

    return new Promise<BackendResult>((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd: req.cwd ?? ownDir, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
      }, req.timeoutMs);

      const finish = (outcome: BackendResult | BackendError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ownDir !== undefined) {
          try {
            rmdirSync(ownDir); // only removes the directory if it is still empty
          } catch {
            // leave it
          }
        }
        if (outcome instanceof BackendError) reject(outcome);
        else resolve(outcome);
      };

      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.stdin.on("error", () => {}); // the child may exit before reading the prompt
      child.stdin.end(req.prompt);

      child.on("error", (err) => finish(new BackendError("backend_error", `cannot start ${this.bin}: ${err.message}`)));
      child.on("close", (code) => {
        if (timedOut) return finish(new BackendError("timeout", `claude did not answer within ${req.timeoutMs} ms`));
        if (code !== 0) {
          const detail = (stderr.trim() || stdout.trim()).slice(0, 300);
          return finish(new BackendError("backend_error", `claude exited with code ${code}: ${detail}`));
        }
        let parsed: ClaudeResult;
        try {
          parsed = JSON.parse(stdout) as ClaudeResult;
        } catch {
          return finish(new BackendError("backend_error", `claude did not print JSON: ${stdout.trim().slice(0, 200)}`));
        }
        if (parsed.is_error === true || typeof parsed.result !== "string" || parsed.result.trim() === "") {
          const detail = typeof parsed.result === "string" ? parsed.result.slice(0, 300) : "no result text";
          return finish(new BackendError("backend_error", `claude reported an error: ${detail}`));
        }
        finish({
          text: parsed.result,
          durationMs: Date.now() - started,
          promptTokens: optionalNumber(parsed.usage?.input_tokens),
          outputTokens: optionalNumber(parsed.usage?.output_tokens),
          model: Object.keys(parsed.modelUsage ?? {})[0] ?? this.model,
        });
      });
    });
  }
}
