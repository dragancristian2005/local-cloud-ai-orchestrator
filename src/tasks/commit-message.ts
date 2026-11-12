import { maxLines, noCodeFence, nonEmpty, runChecks } from "../core/verifier.ts";
import type { Check } from "../core/verifier.ts";
import type { PreparedTask, TaskInput } from "../core/types.ts";
import { cleanModelOutput } from "./clean.ts";
import type { TaskModule } from "./task.ts";

const MAX_SUBJECT_CHARS = 72;
const MAX_MESSAGE_LINES = 20;
const CHATTY_FIRST_LINE = /^(here('s| is)|sure|certainly|commit message)/i;
const EXPLAINS_ITSELF = /^(here('s| is)|sure|certainly|this commit|the following)/i;

const TEMPLATE = `You write git commit messages.

Rules:
- Line 1: a subject of at most 72 characters, imperative mood ("Add", "Fix", "Remove"), no trailing period.
- Optionally a blank line, then a short body explaining why.
- Output only the commit message. No quotes, no code fences, no explanation.

Changed files:
{stat}

Diff:
{diff}
`;

function subjectOf(message: string): string {
  return message.split("\n")[0] ?? "";
}

// 👤 Yours to write (5-10 lines). Decide what "imperative-ish" means.
// Skip an optional conventional-commit prefix ("fix:", "feat(cli):") and look at the first word.
// Trade-off: a suffix rule (-ed, -ing, third-person -s) is tiny but rejects "Embed", "Bring", "Pass", "Address";
// a deny-list of known offenders ("added", "fixes", "updating", ...) never rejects a good subject but misses rare verbs.
// A false reject costs one retry and maybe an escalation; a false accept costs a slightly worse message.
export function isImperativeish(subject: string): boolean {
  throw new Error(`TODO(you): isImperativeish (called with ${JSON.stringify(subject)})`);
}

const checks: Check[] = [
  nonEmpty,
  (out) => {
    const length = subjectOf(out).length;
    return length > MAX_SUBJECT_CHARS ? `subject is ${length} chars (max ${MAX_SUBJECT_CHARS})` : null;
  },
  (out) => (subjectOf(out).endsWith(".") ? "subject must not end with a period" : null),
  noCodeFence,
  (out) => (EXPLAINS_ITSELF.test(subjectOf(out)) ? "reply with the commit message only, no introduction" : null),
  (out) => {
    const second = out.split("\n")[1];
    return second !== undefined && second.trim() !== "" ? "line 2 must be blank (subject, blank line, body)" : null;
  },
  maxLines(MAX_MESSAGE_LINES),
  (out) =>
    isImperativeish(subjectOf(out))
      ? null
      : 'subject should start with an imperative verb ("Add", not "Added"/"Adds"/"Adding")',
];

function normalize(raw: string): string {
  let text = cleanModelOutput(raw);
  const firstLine = subjectOf(text);
  if (firstLine.trimEnd().endsWith(":") && CHATTY_FIRST_LINE.test(firstLine)) {
    text = cleanModelOutput(text.slice(firstLine.length));
  }
  return text;
}

export const commitMessage: TaskModule = {
  type: "commit-message",
  prepare(input: TaskInput, _budgetTokens: number): PreparedTask {
    return {
      taskType: "commit-message",
      prompt: TEMPLATE.replace("{stat}", () => input.stat ?? "").replace("{diff}", () => input.text),
      normalize,
      verify: (output) => runChecks(output, checks),
    };
  },
};
