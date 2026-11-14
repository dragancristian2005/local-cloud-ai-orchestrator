import { runCommand } from "../core/command.ts";
import { classifyCommand } from "./permissions.ts";
import { ToolError } from "./toolkit.ts";
import type { Policy, Tool, ToolDefinition, Toolkit } from "./toolkit.ts";
import { listDirTool, readFileTool, searchTool, TOOL_DEFINITIONS } from "./tools.ts";

export interface CodingOptions {
  root: string;
  commandTimeoutMs: number;
  allowCommands: string[];
  /** Whether the repository is on main or master. A function is asked again before every command. */
  onMainBranch: boolean | (() => boolean | Promise<boolean>);
  /** Whether the folder is a git repository (default true). A function is asked again before every command. */
  gitRepository?: boolean | (() => boolean | Promise<boolean>);
}

// They confine themselves to the repository and refuse secrets files.
const READING_TOOLS = new Set(["read_file", "list_dir", "search"]);

/** The one policy for the coding tools. A tool it does not know is asked, never allowed. */
export function codingPolicy(opts: Pick<CodingOptions, "allowCommands" | "onMainBranch" | "gitRepository">): Policy {
  return {
    async check(tool, args) {
      if (READING_TOOLS.has(tool)) return { decision: "allow" };
      if (tool !== "run_command") return { decision: "ask" };
      const command = args.command;
      // Nothing to run: the tool itself rejects it.
      if (typeof command !== "string" || command.trim() === "") return { decision: "allow" };
      // Looked up now, not at the start of the chat: the branch may have changed since.
      const onMainBranch = typeof opts.onMainBranch === "function" ? await opts.onMainBranch() : opts.onMainBranch;
      const gitRepository = typeof opts.gitRepository === "function" ? await opts.gitRepository() : (opts.gitRepository ?? true);
      return classifyCommand(command, { allowCommands: opts.allowCommands, onMainBranch, gitRepository });
    },
  };
}

export const CODING_SYSTEM_PROMPT = (root: string): string => `You are a coding assistant working in the repository at ${root}.
You can call tools to read files, list directories, search, and run commands. The user approves commands before they run.
Rules:
- Use a tool when you need facts about the code. Do not guess file contents.
- Paths are relative to the repository root.
- Keep answers short and concrete.
- If the task is beyond you, or you have tried twice without progress, call ask_claude with a one-line reason.
`;

const MAX_COMMAND_OUTPUT_CHARS = 4000;

function definition(name: string): ToolDefinition {
  const found = TOOL_DEFINITIONS.find((tool) => tool.function.name === name);
  if (found === undefined) throw new Error(`no definition for the tool ${name}`);
  return found;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The coding tools, bound to one repository, with the policy that gates them. */
export function codingToolkit(opts: CodingOptions): Toolkit {
  const fileTool = (name: string, fn: (root: string, args: Record<string, unknown>) => string): Tool => ({
    definition: definition(name),
    describe(args) {
      const path = text(args.path);
      if (name === "search") return `search "${text(args.query)}"${path === "" ? "" : ` in ${path}`}`;
      return path === "" ? name : `${name} ${path}`;
    },
    run: (args) => fn(opts.root, args),
  });

  const runCommandTool: Tool = {
    definition: definition("run_command"),
    describe: (args) => text(args.command),
    async run(args, ctx) {
      const command = args.command;
      if (typeof command !== "string" || command.trim() === "") throw new ToolError('"command" must be a non-empty string');
      const result = await runCommand(command, { cwd: opts.root, timeoutMs: opts.commandTimeoutMs, signal: ctx.signal });
      const output = result.output.slice(-MAX_COMMAND_OUTPUT_CHARS).trimEnd();
      const status = result.timedOut
        ? `timed out after ${Math.round(opts.commandTimeoutMs / 1000)} s`
        : `exit code ${result.exitCode ?? "unknown"}`;
      return { text: output === "" ? status : `${status}\n${output}`, exitCode: result.exitCode };
    },
  };

  return {
    systemPrompt: CODING_SYSTEM_PROMPT(opts.root),
    tools: [fileTool("read_file", readFileTool), fileTool("list_dir", listDirTool), fileTool("search", searchTool), runCommandTool],
    policy: codingPolicy(opts),
  };
}
