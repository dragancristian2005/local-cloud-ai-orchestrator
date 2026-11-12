import path from "node:path";
import { stagedDiff } from "../workspace/git.ts";
import { InputError } from "./types.ts";
import type { TaskInput } from "./types.ts";

const CHARS_PER_TOKEN = 4;

/** A rough token count (4 characters per token). Good enough to keep a prompt inside the context window. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function truncationMarker(lines: number): string {
  return `[... ${lines} more lines truncated ...]\n`;
}

/** Cut one file's diff to `maxChars` at a line boundary. Its `diff --git` header line always survives. */
function cutSection(section: string, maxChars: number): string {
  const lines = section.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const reserve = truncationMarker(lines.length).length;
  let kept = `${lines[0]}\n`;
  let count = 1;
  while (count < lines.length) {
    const next = `${lines[count]}\n`;
    if (kept.length + next.length + reserve > maxChars) break;
    kept += next;
    count++;
  }
  return kept + truncationMarker(lines.length - count);
}

/**
 * Fit a diff into a token budget. Small files are kept whole; the budget they leave unused goes to
 * the large ones, which are cut at a line boundary. Every changed file stays visible by name.
 */
export function fitDiff(diff: string, budgetTokens: number): string {
  const charBudget = budgetTokens * CHARS_PER_TOKEN;
  if (diff.length <= charBudget) return diff;

  const sections: string[] = [];
  for (const line of diff.split(/(?<=\n)/)) {
    if (line.startsWith("diff --git ") || sections.length === 0) sections.push(line);
    else sections[sections.length - 1] += line;
  }

  // Smallest first, so whatever a small file does not need is shared among the larger ones.
  const order = sections.map((_, i) => i).sort((a, b) => sections[a]!.length - sections[b]!.length);
  let remaining = charBudget;
  order.forEach((index, position) => {
    const share = Math.floor(remaining / (order.length - position));
    const section = sections[index]!;
    if (section.length > share) sections[index] = cutSection(section, share);
    remaining -= Math.min(sections[index]!.length, share);
  });
  return sections.join("");
}

/** Gather what a task needs from the repository. Throws InputError when there is nothing to work on. */
export async function collectInput(
  taskType: string,
  args: { repo: string; file?: string; symbol?: string },
): Promise<TaskInput> {
  const repo = path.resolve(args.repo);
  if (taskType === "commit-message") {
    const { stat, diff } = await stagedDiff(repo);
    if (diff.trim() === "") throw new InputError(`nothing staged in ${repo}: stage changes with git add first`);
    return { text: diff, stat };
  }
  throw new InputError(`unknown task type: ${taskType}`);
}
