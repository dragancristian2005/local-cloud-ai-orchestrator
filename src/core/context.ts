import { readFileSync } from "node:fs";
import path from "node:path";
import { languageOf } from "../tasks/language.ts";
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

/** The line (0-based) where a symbol is declared, or -1. Falls back to its first call or assignment. */
function findSymbolLine(lines: string[], symbol: string): number {
  const name = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`\\b(function|class|const|let|var|def|interface|type)\\s+\\*?\\s*${name}\\b`);
  const index = lines.findIndex((line) => declaration.test(line));
  if (index !== -1) return index;
  const use = new RegExp(`\\b${name}\\s*[(=:]`);
  return lines.findIndex((line) => use.test(line));
}

function omitted(lines: number): string {
  return `[... ${lines} lines omitted ...]\n`;
}

/**
 * Fit a source file into a token budget: the whole file when it fits, otherwise a window of whole
 * lines around the symbol's declaration (one third before it, two thirds after).
 * Throws InputError when the symbol is not in the file at all.
 */
export function fitSource(source: string, symbol: string, budgetTokens: number): string {
  const lines = source.split("\n");
  const declared = findSymbolLine(lines, symbol);
  if (declared === -1) throw new InputError(`symbol ${symbol} not found`);
  if (estimateTokens(source) <= budgetTokens) return source;

  const charBudget = budgetTokens * CHARS_PER_TOKEN - 2 * omitted(lines.length).length;
  const cost = (index: number) => lines[index]!.length + 1;
  let start = declared;
  let end = declared;
  let used = cost(declared);
  const afterLimit = used + Math.floor(((charBudget - used) * 2) / 3);
  while (end + 1 < lines.length && used + cost(end + 1) <= afterLimit) used += cost(++end);
  while (start > 0 && used + cost(start - 1) <= charBudget) used += cost(--start);
  // Whatever the lines before did not need goes to the lines after.
  while (end + 1 < lines.length && used + cost(end + 1) <= charBudget) used += cost(++end);

  const before = start > 0 ? omitted(start) : "";
  const after = end < lines.length - 1 ? omitted(lines.length - 1 - end) : "";
  return before + lines.slice(start, end + 1).join("\n") + "\n" + after;
}

const SOURCE_TASKS = new Set(["docstring", "test-stub"]);

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
  if (SOURCE_TASKS.has(taskType)) {
    if (!args.file || !args.symbol) throw new InputError(`--file and --symbol are required for ${taskType}`);
    languageOf(args.file);
    let source: string;
    try {
      source = readFileSync(path.resolve(repo, args.file), "utf8");
    } catch {
      throw new InputError(`cannot read ${args.file} in ${repo}`);
    }
    if (findSymbolLine(source.split("\n"), args.symbol) === -1) {
      throw new InputError(`symbol ${args.symbol} not found in ${args.file}`);
    }
    return { text: source, filePath: args.file, symbol: args.symbol };
  }
  throw new InputError(`unknown task type: ${taskType}`);
}
