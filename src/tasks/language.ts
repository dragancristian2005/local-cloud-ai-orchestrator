import path from "node:path";
import { InputError } from "../core/types.ts";

export type Language = "js" | "py";

const JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** The language family of a source file, by extension. Decides the comment style and the test framework. */
export function languageOf(filePath: string): Language {
  const ext = path.extname(filePath).toLowerCase();
  if (JS_EXTENSIONS.has(ext)) return "js";
  if (ext === ".py") return "py";
  throw new InputError(`unsupported file type "${ext}" for ${filePath} (supported: TypeScript, JavaScript, Python)`);
}

/** The file and symbol a source-based task works on; both are required. */
export function fileAndSymbol(input: { filePath?: string; symbol?: string }, taskType: string): { filePath: string; symbol: string } {
  if (!input.filePath || !input.symbol) throw new InputError(`--file and --symbol are required for ${taskType}`);
  return { filePath: input.filePath, symbol: input.symbol };
}
