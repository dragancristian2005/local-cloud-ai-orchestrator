import { commitAll, makeTempRepo } from "./temp-repo.ts";

export const MATH = `// math helpers
export function clamp(n, lo, hi) {
  if (n < lo) return lo;
  return n > hi ? hi : n;
}

export function double(n) {
  return n * 2;
}
`;

const CHECK = `import assert from "node:assert/strict";
import { clamp } from "./math.js";
assert.equal(clamp(5, 0, 3), 3);
assert.equal(clamp(-1, 0, 3), 0);
`;
/** Fails at HEAD: nothing rejects an inverted range yet. */
export const STRICT_CHECK = CHECK + `assert.throws(() => clamp(1, 3, 0), /lo must not be greater than hi/);\n`;

export const GOOD = `export function clamp(n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n));\n}`;
export const GUARDED = `export function clamp(n, lo, hi) {\n  if (lo > hi) throw new Error("lo must not be greater than hi");\n  return Math.min(hi, Math.max(lo, n));\n}`;
export const BROKEN = `export function clamp(n, lo, hi) {\n  return n;\n}`;

/** A committed repository with math.js (clamp) and check.mjs; the test command is "node check.mjs". */
export async function editRepo(opts: { strict?: boolean; extra?: Record<string, string> } = {}): Promise<string> {
  const repo = await makeTempRepo({ "math.js": MATH, "check.mjs": opts.strict ? STRICT_CHECK : CHECK, ...opts.extra });
  await commitAll(repo);
  return repo;
}

/** The identity ws.commit needs, on any machine. */
export function useTestGitIdentity(): void {
  Object.assign(process.env, GIT_IDENTITY);
}

export const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "orch-test", GIT_AUTHOR_EMAIL: "orch-test@localhost",
  GIT_COMMITTER_NAME: "orch-test", GIT_COMMITTER_EMAIL: "orch-test@localhost",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
};
