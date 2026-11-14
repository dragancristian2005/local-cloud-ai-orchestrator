import type { VerifyResult } from "./types.ts";

// The shell-command verifier: run the project's own test command and look at its exit code.
export { runCommand } from "./command.ts";
export type { CommandResult } from "./command.ts";

/** The end of a failed command's output: what a model, or a person, needs to see to fix it. */
export function failureTail(output: string, maxLines = 30, maxChars = 1500): string {
  return output.trimEnd().split("\n").slice(-maxLines).join("\n").slice(-maxChars);
}

/** A format check: null when the output is fine, otherwise a short reason a model could act on. */
export type Check = (output: string) => string | null;

/** Run checks in order; the first failure decides the result. */
export function runChecks(output: string, checks: Check[]): VerifyResult {
  for (const check of checks) {
    const problem = check(output);
    if (problem !== null) return { status: "fail", detail: problem };
  }
  return { status: "pass", detail: "" };
}

export const nonEmpty: Check = (output) => (output.trim() === "" ? "answer is empty" : null);

export const noCodeFence: Check = (output) =>
  /^\s*```/m.test(output) ? "answer contains a code fence (```): reply with the text only" : null;

export function maxLines(n: number): Check {
  return (output) => {
    const count = output.split("\n").length;
    return count > n ? `answer has ${count} lines (max ${n})` : null;
  };
}
