/** What to do with a command the model asked to run. */
export type CommandVerdict = { decision: "allow" } | { decision: "ask" } | { decision: "deny"; reason: string };

// `git`, optional global options (including `-C <path>`), then the subcommand.
function git(subcommand: string): RegExp {
  return new RegExp(`\\bgit\\s+(?:-C\\s+\\S+\\s+|-\\S+\\s+)*(?:${subcommand})\\b`);
}

const SAME_COMMAND = "[^;&|\\n]*"; // stays inside one command of a pipeline or list

/**
 * Commands that are never run, whatever the user answers. They enforce the project's hard rules:
 * nothing destructive, no pushing, no touching credentials. This list is a backstop, not a
 * sandbox: the user's approval of every other command is the real control.
 */
const ALWAYS_REFUSED: { pattern: RegExp; reason: string }[] = [
  { pattern: new RegExp(`\\brm\\b${SAME_COMMAND}?\\s(-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive|--force)(?=\\s|$)`), reason: "rm with -r or -f is not allowed" },
  { pattern: new RegExp(`${git("reset").source}${SAME_COMMAND}--hard`), reason: "git reset --hard is not allowed" },
  { pattern: git("clean"), reason: "git clean is not allowed" },
  { pattern: git("push"), reason: "git push is not allowed" },
  { pattern: new RegExp(`${git("checkout").source}${SAME_COMMAND}\\s--(\\s|$)`), reason: "discarding changes with git checkout -- is not allowed" },
  { pattern: git("restore"), reason: "discarding changes with git restore is not allowed" },
  { pattern: new RegExp(`${git("stash").source}\\s+(drop|clear)\\b`), reason: "dropping stashes is not allowed" },
  { pattern: /\bsudo\b/, reason: "sudo is not allowed" },
  { pattern: /\|\s*(sh|bash|zsh)\b/, reason: "piping into a shell is not allowed" },
  { pattern: new RegExp(`\\bch(mod|own)\\b${SAME_COMMAND}\\s-[a-zA-Z]*R`), reason: "recursive chmod/chown is not allowed" },
  { pattern: /\b(mkfs\S*|shutdown|reboot)\b/, reason: "system commands are not allowed" },
  { pattern: new RegExp(`\\bdd\\b${SAME_COMMAND}\\bif=`), reason: "dd is not allowed" },
  { pattern: /\.claude\b|\.credentials|\.ssh\b|security\s+find-/, reason: "commands that touch credentials are not allowed" },
];

const COMMITS_ON_MAIN = git("commit|merge|rebase|cherry-pick|revert|am");

// Any of these means the line is more than one plain command, so a prefix match proves nothing.
const SHELL_OPERATORS = /[;&|><$`(){}\\\n]/;

/**
 * Decide whether a command may run: refused outright, allowed without asking, or shown to the
 * user first. Refusals are checked first, so no allow-list entry can override one.
 */
export function classifyCommand(
  command: string,
  opts: { allowCommands: string[]; onMainBranch: boolean },
): CommandVerdict {
  for (const rule of ALWAYS_REFUSED) {
    if (rule.pattern.test(command)) return { decision: "deny", reason: rule.reason };
  }
  if (opts.onMainBranch && COMMITS_ON_MAIN.test(command)) {
    return { decision: "deny", reason: "commits are not made on the main branch" };
  }

  const plain = command.trim();
  const isSingleCommand = !SHELL_OPERATORS.test(plain) && !/(^|\s)--output\b/.test(plain);
  const listed = opts.allowCommands.some((entry) => plain === entry || plain.startsWith(`${entry} `));
  return isSingleCommand && listed ? { decision: "allow" } : { decision: "ask" };
}
