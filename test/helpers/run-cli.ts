import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.resolve(import.meta.dirname, "../../src/cli.ts");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the real CLI in a child process. */
export function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

/** Write a config into a fresh temp directory, with its runs directory next to it. */
export function writeTempConfig(config: Record<string, unknown>): { configPath: string; runsDir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "orch-cli-"));
  const runsDir = path.join(dir, "runs");
  const configPath = path.join(dir, "orchestrator.config.json");
  writeFileSync(configPath, JSON.stringify({ runsDir, ...config }));
  return { configPath, runsDir };
}

export function ollamaOnlyConfig(baseUrl: string, taskTypes: string[] = ["commit-message"]): Record<string, unknown> {
  return {
    backends: {
      "pc-ollama": { type: "ollama", baseUrl, model: "qwen2.5-coder:7b", timeoutMs: 5000, healthTimeoutMs: 500 },
    },
    chains: Object.fromEntries(taskTypes.map((type) => [type, ["pc-ollama"]])),
    retryBeforeEscalate: 1,
  };
}
