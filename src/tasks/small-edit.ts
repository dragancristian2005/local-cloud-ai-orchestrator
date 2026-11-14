import { estimateTokens } from "../core/context.ts";
import { noCodeFence, nonEmpty, runChecks } from "../core/verifier.ts";
import type { Check } from "../core/verifier.ts";
import { InputError } from "../core/types.ts";
import type { CheckedTask, TaskInput } from "../core/types.ts";
import { cleanModelOutput } from "./clean.ts";
import { regionText, reindent } from "./region.ts";
import type { TaskModule } from "./task.ts";

export const EDIT_START = "<<<EDIT START>>>";
export const EDIT_END = "<<<EDIT END>>>";

const HEADER = `You edit code.

Change the code between the markers so that: {instruction}

Rules:
- Reply with the complete new version of the marked code and nothing else.
- Change only what the instruction asks. Keep everything else as it is.
- Do not include the marker lines. No code fences, no explanation.

File: {file}
`;

const CHARS_PER_TOKEN = 3;

/** Whole lines nearest the region, half of the room before it and half after. */
function contextAround(lines: string[], region: { start: number; end: number }, roomChars: number): { before: string[]; after: string[] } {
  const half = Math.floor(roomChars / 2);
  let start = region.start;
  for (let used = 0; start > 0 && used + lines[start - 1]!.length + 1 <= half; start--) used += lines[start - 1]!.length + 1;
  let end = region.end;
  for (let used = 0; end + 1 < lines.length && used + lines[end + 1]!.length + 1 <= half; end++) used += lines[end + 1]!.length + 1;
  return { before: lines.slice(start, region.start), after: lines.slice(region.end + 1, end + 1) };
}

/** cleanModelOutput trims the answer; give the first line back the indentation it had in the raw reply. */
function withFirstLineIndent(cleaned: string, raw: string): string {
  const text = raw.replace(/\r\n/g, "\n");
  const at = text.indexOf(cleaned);
  if (at === -1) return cleaned;
  const lead = text.slice(text.lastIndexOf("\n", at - 1) + 1, at);
  return /^[ \t]*$/.test(lead) ? lead + cleaned : cleaned;
}

export const smallEdit: TaskModule = {
  type: "small-edit",
  prepare(input: TaskInput, budgetTokens: number): CheckedTask {
    const { filePath, region, symbol } = input;
    const instruction = input.instruction?.trim() ?? "";
    if (!filePath) throw new InputError("--file is required for small-edit");
    if (instruction === "") throw new InputError("--instruction is required for small-edit");
    if (region === undefined) throw new InputError("small-edit needs the code to change: pass --symbol or --lines");

    const original = regionText(input.text, region);
    const limit = Math.floor(budgetTokens / 2);
    if (estimateTokens(original) > limit) {
      throw new InputError(
        `the code to edit is about ${estimateTokens(original)} tokens; small-edit takes at most ${limit}: choose a smaller range with --lines`,
      );
    }

    const header = HEADER.replace("{instruction}", () => instruction).replace("{file}", () => filePath);
    const fixed = `${header}${EDIT_START}\n${original}\n${EDIT_END}\n`;
    const room = Math.max(0, (budgetTokens - estimateTokens(fixed) - 20) * CHARS_PER_TOKEN);
    const lines = input.text.split(/\r?\n/);
    const { before, after } = contextAround(lines, region, room);
    const prompt = header + [...before, EDIT_START, original, EDIT_END, ...after].join("\n").trimEnd() + "\n";

    const originalLines = original.split("\n").length;
    const maxAnswerLines = Math.max(3 * originalLines, originalLines + 40);
    const checks: Check[] = [
      nonEmpty,
      noCodeFence,
      (out) => (out.trimEnd() === original.trimEnd() ? "the answer is identical to the original code" : null),
      (out) => {
        const count = out.split("\n").length;
        return count > maxAnswerLines
          ? `answer is ${count} lines for a ${originalLines}-line original: change only what the instruction asks`
          : null;
      },
    ];
    if (symbol) {
      const word = new RegExp(`(?<![\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
      checks.push((out) => (word.test(out) ? null : `the answer no longer contains ${symbol}`));
    }

    return {
      taskType: "small-edit",
      prompt,
      normalize(raw: string): string {
        const cleaned = withFirstLineIndent(cleanModelOutput(raw), raw);
        const kept = cleaned.split("\n").filter((line) => line.trim() !== EDIT_START && line.trim() !== EDIT_END);
        return reindent(kept.join("\n"), original).trimEnd();
      },
      verify: (output) => runChecks(output, checks),
    };
  },
};
