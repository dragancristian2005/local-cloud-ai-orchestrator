import { openSync, readSync, closeSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** A tool definition in the shape Ollama's /api/chat expects. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      required: string[];
      properties: Record<string, { type: string; description: string }>;
    };
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): ToolDefinition {
  return { type: "function", function: { name, description, parameters: { type: "object", required, properties } } };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  tool(
    "read_file",
    "Read a text file from the repository. Returns up to 200 numbered lines.",
    {
      path: { type: "string", description: "File path relative to the repository root" },
      start_line: { type: "integer", description: "First line to return (default 1)" },
    },
    ["path"],
  ),
  tool(
    "list_dir",
    "List the files and folders in a directory of the repository.",
    { path: { type: "string", description: "Directory relative to the repository root (default: the root)" } },
    [],
  ),
  tool(
    "search",
    "Find lines that contain a piece of text, in all files or under one path. Not a regular expression.",
    {
      query: { type: "string", description: "The exact text to look for (case does not matter)" },
      path: { type: "string", description: "File or directory to search in (default: the whole repository)" },
    },
    ["query"],
  ),
  tool(
    "run_command",
    "Run one shell command in the repository root, for example the tests or git log. The user may refuse.",
    { command: { type: "string", description: "The command line to run" } },
    ["command"],
  ),
  tool(
    "ask_claude",
    "Hand this request to a stronger assistant. Use it when the task is beyond you or you are not making progress.",
    { reason: { type: "string", description: "One line: why you cannot finish this yourself" } },
    ["reason"],
  ),
];

/** The most a single tool result may add to the conversation. */
export const MAX_TOOL_RESULT_CHARS = 4500;

const MAX_LINES_PER_READ = 200;
const MAX_LINE_CHARS = 400;
const MAX_DIR_ENTRIES = 200;
const MAX_MATCHES = 40;
const MAX_MATCH_LINE_CHARS = 200;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_FILES_WALKED = 5000;
const BINARY_SNIFF_BYTES = 8000;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);
const SECRET_NAMES = [/^\.env(\..*)?$/, /\.pem$/, /\.key$/, /^id_rsa/, /^id_ed25519/, /^\.npmrc$/, /^\.netrc$/, /^credentials/i];

/** A problem the model can act on. The agent loop turns it into an "error: ..." tool result. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Turn a path the model gave into an absolute path that is certain to be inside the repository.
 * Symlinks are followed first, so a link that points outside is refused like any other escape.
 */
export function resolveInside(root: string, requested: string): string {
  const rootReal = realpathSync(root);
  const candidate = path.resolve(rootReal, requested);
  if (!isInside(rootReal, candidate)) throw new ToolError("path is outside the repository");
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new ToolError(`no such file or directory: ${requested}`);
  }
  if (!isInside(rootReal, real)) throw new ToolError("path is outside the repository");
  return real;
}

function isSecret(root: string, absolute: string): boolean {
  const parts = path.relative(realpathSync(root), absolute).split(path.sep);
  if (parts.includes(".git")) return true;
  const base = parts.at(-1) ?? "";
  return SECRET_NAMES.some((pattern) => pattern.test(base));
}

function refuseSecret(root: string, absolute: string, requested: string): void {
  if (isSecret(root, absolute)) throw new ToolError(`refused: ${requested} looks like a secrets file`);
}

function isBinary(file: string): boolean {
  const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
  const fd = openSync(file, "r");
  try {
    const read = readSync(fd, buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, read).includes(0);
  } finally {
    closeSync(fd);
  }
}

function stringArg(args: Record<string, unknown>, name: string, fallback?: string): string {
  const value = args[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "") throw new ToolError(`"${name}" must be a non-empty string`);
  return value;
}

function relative(root: string, absolute: string): string {
  return path.relative(realpathSync(root), absolute).split(path.sep).join("/");
}

export function readFileTool(root: string, args: Record<string, unknown>): string {
  const requested = stringArg(args, "path");
  const file = resolveInside(root, requested);
  refuseSecret(root, file, requested);
  if (statSync(file).isDirectory()) throw new ToolError(`${requested} is a directory: use list_dir`);
  if (isBinary(file)) throw new ToolError("binary file");

  const lines = readFileSync(file, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const start = args.start_line === undefined ? 1 : Number(args.start_line);
  if (!Number.isInteger(start) || start < 1) throw new ToolError(`"start_line" must be a whole number from 1`);
  if (start > Math.max(lines.length, 1)) {
    throw new ToolError(`start_line ${start} is past the end of the file (${lines.length} lines)`);
  }

  const note = (last: number) => `[lines ${start}-${last} of ${lines.length}; call read_file again with start_line=${last + 1}]`;
  const room = MAX_TOOL_RESULT_CHARS - note(lines.length).length - 1;
  const shown: string[] = [];
  let used = 0;
  let index = start - 1;
  while (index < lines.length && shown.length < MAX_LINES_PER_READ) {
    const text = lines[index]!;
    const line = `${index + 1}: ${text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)} [line cut]` : text}`;
    if (used + line.length + 1 > room && shown.length > 0) break;
    shown.push(line);
    used += line.length + 1;
    index++;
  }
  if (index < lines.length) shown.push(note(index));
  return shown.join("\n");
}

export function listDirTool(root: string, args: Record<string, unknown>): string {
  const requested = stringArg(args, "path", ".");
  const dir = resolveInside(root, requested);
  if (!statSync(dir).isDirectory()) throw new ToolError(`${requested} is a file: use read_file`);
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git")
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
  if (names.length === 0) return "(empty directory)";
  const shown = names.slice(0, MAX_DIR_ENTRIES);
  if (names.length > shown.length) shown.push(`[${names.length - shown.length} more entries]`);
  return shown.join("\n");
}

export function searchTool(root: string, args: Record<string, unknown>): string {
  const query = stringArg(args, "query").toLowerCase();
  const requested = stringArg(args, "path", ".");
  const start = resolveInside(root, requested);
  refuseSecret(root, start, requested);

  const matches: string[] = [];
  let walked = 0;
  let stopped = false;

  const searchFile = (file: string) => {
    if (isSecret(root, file) || statSync(file).size > MAX_SEARCH_FILE_BYTES || isBinary(file)) return;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.toLowerCase().includes(query)) continue;
      if (matches.length === MAX_MATCHES) {
        stopped = true;
        return;
      }
      matches.push(`${relative(root, file)}:${i + 1}: ${lines[i]!.slice(0, MAX_MATCH_LINE_CHARS)}`);
    }
  };

  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (stopped || walked >= MAX_FILES_WALKED) return;
      const full = path.join(dir, entry.name);
      // Links are not followed: one that points outside the repository must not be searched.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        walked++;
        searchFile(full);
      }
    }
  };

  if (statSync(start).isDirectory()) walk(start);
  else searchFile(start);

  if (matches.length === 0) return "no matches";
  if (stopped) matches.push(`[stopped after ${MAX_MATCHES} matches]`);
  return matches.join("\n");
}
