import { spawn } from "node:child_process";

export interface CommandResult {
  /** True only when the command exited with code 0 and was not cut short. */
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** stdout and stderr in arrival order; only the end is kept when it is long. */
  output: string;
}

const MAX_OUTPUT_CHARS = 20_000;
const KILL_GRACE_MS = 500;

/**
 * Run one shell command line and wait for it. Never rejects: a command that cannot start, fails,
 * hangs or is aborted comes back as `ok: false`.
 *
 * This is the only place a shell is used. The command must come from the user, or be one the user
 * approved; nothing a model wrote may reach it unseen.
 */
export function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;

    // Its own process group, so a timeout takes the children with it and not only the shell.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { shell: true, cwd: opts.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      // For example a NUL byte in the command line.
      const message = err instanceof Error ? err.message : String(err);
      resolve({ ok: false, exitCode: null, timedOut: false, output: `cannot start the command: ${message}\n` });
      return;
    }

    const killGroup = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      // A child that left the group can keep the output open. Do not wait for it.
      setTimeout(() => finish(null), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    const onAbort = () => killGroup();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) killGroup();

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const aborted = opts.signal?.aborted ?? false;
      resolve({ ok: exitCode === 0 && !timedOut && !aborted, exitCode, timedOut, output });
    };

    const collect = (chunk: string) => {
      output = (output + chunk).slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout?.setEncoding("utf8").on("data", collect);
    child.stderr?.setEncoding("utf8").on("data", collect);
    child.on("error", (err) => {
      collect(`cannot start the command: ${err.message}\n`);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
