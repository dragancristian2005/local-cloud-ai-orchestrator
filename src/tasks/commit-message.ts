import { estimateTokens, fitDiff, fitStat } from "../core/context.ts";
import { maxLines, noCodeFence, nonEmpty, runChecks } from "../core/verifier.ts";
import type { Check } from "../core/verifier.ts";
import type { CheckedTask, TaskInput } from "../core/types.ts";
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

// Imperative verbs that end like a past tense, a gerund or a third person and would trip the suffix rule.
const LOOKS_INFLECTED_BUT_IS_NOT = new Set([
  "embed", "seed", "feed", "need", "speed", "shed", "exceed", "proceed", "succeed",
  "bring", "ping", "ring", "string", "alias", "bias", "canvas",
]);

/**
 * "Imperative-ish": the first word, after an optional conventional-commit prefix ("fix:",
 * "feat(cli):"), does not look like a past tense (-ed), a gerund (-ing) or a third person (-s).
 * A suffix rule with a short exception list: a false reject costs one retry, so the rule leans
 * towards catching "Added"/"Adds"/"Adding" over accepting every rare verb.
 */
export function isImperativeish(subject: string): boolean {
  const afterPrefix = subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "");
  const first = (afterPrefix.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (first === "") return false;
  if (LOOKS_INFLECTED_BUT_IS_NOT.has(first)) return true;
  if (/(ed|ing)$/.test(first)) return false;
  // "adds", "fixes", "updates"; but not "pass", "address", "focus".
  return !/[^su]s$/.test(first);
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

const LABEL = /^(commit message|subject)\s*:\s*/i;

/** Remove markdown emphasis around a whole line, and a "Commit message:" / "Subject:" label in front of it. */
function unlabel(line: string): string {
  const plain = line.trim().replace(/^(\*\*|__|\*|_)(.*)\1$/, "$2").trim();
  return plain.replace(LABEL, "").replace(/^(\*\*|__|\*|_)(.*)\1$/, "$2").trim();
}

function normalize(raw: string): string {
  let text = cleanModelOutput(raw);
  // Up to two leading lines can be wrapping: an introduction ("Here is the commit message:") and a label.
  for (let pass = 0; pass < 2; pass++) {
    const firstLine = subjectOf(text);
    const subject = unlabel(firstLine);
    const isIntro = subject.endsWith(":") && CHATTY_FIRST_LINE.test(subject);
    if (subject === "" || isIntro) {
      if (firstLine === text) break;
      text = cleanModelOutput(text.slice(firstLine.length));
    } else {
      text = subject + text.slice(firstLine.length);
      break;
    }
  }
  return text;
}

export const commitMessage: TaskModule = {
  type: "commit-message",
  prepare(input: TaskInput, budgetTokens: number): CheckedTask {
    // The file list gets at most a sixth of the prompt; the diff gets the rest.
    const stat = fitStat(input.stat ?? "", Math.floor(budgetTokens / 6));
    // What the template and the stat use is not available to the diff; 2 tokens cover rounding.
    const diffBudget = Math.max(0, budgetTokens - estimateTokens(TEMPLATE) - estimateTokens(stat) - 2);
    const diff = fitDiff(input.text, diffBudget);
    return {
      taskType: "commit-message",
      prompt: TEMPLATE.replace("{stat}", () => stat).replace("{diff}", () => diff),
      normalize,
      verify: (output) => runChecks(output, checks),
    };
  },
};
