import { classifyCommand } from "./permissions.ts";
import type { Policy } from "./toolkit.ts";

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
