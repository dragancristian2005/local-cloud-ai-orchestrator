import { findSymbolLine } from "../core/context.ts";
import { InputError } from "../core/types.ts";
import type { Language } from "./language.ts";

/** A run of whole lines in a file: 0-based line indexes, both inclusive. */
export interface Region {
  start: number;
  end: number;
}

function linesOf(source: string): string[] {
  return source.split(/\r?\n/);
}

/** Read "--lines 12-30": 1-based and inclusive, inside a file of `lineCount` lines. */
export function parseLineRange(text: string, lineCount: number): Region {
  const match = /^(\d+)-(\d+)$/.exec(text.trim());
  const first = Number(match?.[1]);
  const last = Number(match?.[2]);
  if (match === null || first < 1 || last < first || last > lineCount) {
    throw new InputError(`--lines must be <start>-<end> within the file's ${lineCount} lines, for example 12-30 (got "${text}")`);
  }
  return { start: first - 1, end: last - 1 };
}

function noEnd(symbol: string): InputError {
  return new InputError(`could not find the end of ${symbol}: pass --lines <start>-<end>`);
}

/** The last line of a JavaScript or TypeScript declaration that starts on `start`. */
function endOfJsBlock(lines: string[], start: number, symbol: string): number {
  let braces = 0;
  let parens = 0;
  let inBlockComment = false;
  let inTemplate = false;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    let quote = ""; // a '…' or "…" string never runs past its line
    for (let at = 0; at < line.length; at++) {
      const char = line[at]!;
      const next = line[at + 1];
      if (inBlockComment) {
        if (char === "*" && next === "/") {
          inBlockComment = false;
          at++;
        }
      } else if (inTemplate || quote !== "") {
        if (char === "\\") at++;
        else if (inTemplate && char === "`") inTemplate = false;
        else if (char === quote) quote = "";
      } else if (char === "/" && next === "/") {
        break;
      } else if (char === "/" && next === "*") {
        inBlockComment = true;
        at++;
      } else if (char === "`") {
        inTemplate = true;
      } else if (char === "'" || char === '"') {
        quote = char;
      } else if (char === "(" || char === "[") {
        parens++;
      } else if (char === ")" || char === "]") {
        parens--;
      } else if (char === "{") {
        braces++;
      } else if (char === "}") {
        braces--;
        // A brace pair inside a parameter list (a default value, a destructuring) is not the body.
        if (braces <= 0 && parens <= 0) return index;
      } else if (char === ";" && braces === 0 && parens <= 0) {
        return index; // a one-statement declaration
      }
    }
  }
  throw noEnd(symbol);
}

function indentWidth(line: string): number {
  return line.length - line.trimStart().length;
}

/** The last line of a Python block that starts on `start`: the last following line indented more than it. */
function endOfPyBlock(lines: string[], start: number, symbol: string): number {
  const base = indentWidth(lines[start]!);
  let end = -1;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    if (indentWidth(line) <= base) break;
    end = index;
  }
  if (end === -1) throw noEnd(symbol);
  return end;
}

/** The lines that make up a symbol's declaration: a function, a method, a class, a one-line constant. */
export function findRegion(source: string, language: Language, symbol: string): Region {
  const lines = linesOf(source);
  const start = findSymbolLine(lines, symbol);
  if (start === -1) throw new InputError(`symbol ${symbol} not found`);
  const end = language === "py" ? endOfPyBlock(lines, start, symbol) : endOfJsBlock(lines, start, symbol);
  return { start, end };
}

/** The region's lines, joined with "\n". */
export function regionText(source: string, region: Region): string {
  return linesOf(source).slice(region.start, region.end + 1).join("\n");
}

function leadingWhitespace(line: string): string {
  return line.slice(0, indentWidth(line));
}

/**
 * Give a replacement the indentation of the code it replaces: strip the indentation its non-blank
 * lines share, then put the indentation of the original's first line in front of each of them.
 */
export function reindent(replacement: string, original: string): string {
  const lines = replacement.split("\n");
  const filled = lines.filter((line) => line.trim() !== "");
  const shared = filled.length === 0 ? 0 : Math.min(...filled.map(indentWidth));
  const indent = leadingWhitespace(original.split("\n")[0] ?? "");
  return lines.map((line) => (line.trim() === "" ? "" : indent + line.slice(shared))).join("\n");
}

/** Replace the region's lines. The file keeps its line endings and its final newline, or the lack of one. */
export function spliceRegion(source: string, region: Region, replacement: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = linesOf(source);
  const added = replacement.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  return [...lines.slice(0, region.start), ...added, ...lines.slice(region.end + 1)].join(eol);
}
