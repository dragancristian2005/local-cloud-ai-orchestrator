/** What to do with a command the model asked to run. */
export type CommandVerdict = { decision: "allow" } | { decision: "ask" } | { decision: "deny"; reason: string };

// `git`, optional global options (including `-C <path>`), then the subcommand.
function git(subcommand: string): RegExp {
  return new RegExp(`\\bgit\\s+(?:-C\\s+\\S+\\s+|-\\S+\\s+)*(?:${subcommand})\\b`, "i");
}

// Places credentials live, and the secrets files the read tools also refuse.
const CREDENTIALS = new RegExp(
  [
    "\\.claude\\b", "\\.credentials", "\\.ssh\\b", "\\.aws\\b", "\\.gnupg\\b", "\\.kube\\b", "\\.docker\\b",
    "\\.config\\/gh\\b", "\\.netrc\\b", "\\.npmrc\\b", "\\.pypirc\\b", "\\bid_(rsa|ed25519)\\b", "security\\s+find-",
    // ".env" as a file name, not "process.env" or "environment"
    "(^|[^\\w.])\\.env(\\.[\\w.-]+)?(?!\\w)",
  ].join("|"),
  "i",
);

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
  { pattern: CREDENTIALS, reason: "commands that touch credentials or secrets files are not allowed" },
];

// What takes an allow-listed command out of its harmless form: a path outside the repository, or
// an option that reads other files, writes one, or runs a configured helper.
const LEAVES_REPOSITORY = /^[/~]|(^|\/)\.\.(\/|$)/;
const UNSAFE_OPTIONS = ["no-index", "output", "ext-diff", "textconv"];

function isSafeArgument(arg: string): boolean {
  if (arg.startsWith("--")) {
    // git accepts any unambiguous prefix of a long option ("--no-ind"), so a prefix counts as the option.
    const name = arg.slice(2).split("=")[0]!;
    if (name !== "" && UNSAFE_OPTIONS.some((unsafe) => unsafe.startsWith(name))) return false;
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "";
    return !LEAVES_REPOSITORY.test(value);
  }
  // A short option may carry its value attached: "-O/etc/passwd".
  if (arg.startsWith("-")) return !LEAVES_REPOSITORY.test(arg.slice(2));
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
  return !LEAVES_REPOSITORY.test(arg) && !LEAVES_REPOSITORY.test(value);
}

const COMMITS_ON_MAIN = git("commit|merge|rebase|cherry-pick|revert|am");

// Characters the shell gives a meaning to. With any of them the words the program receives are
// not the words on the line (quotes hide a path, a wildcard expands to one), so nothing can be
// concluded from the text and the user is asked.
const SHELL_SYNTAX = /[;&|><$`(){}\\\n"'*?[\]!#]/;

/**
 * Decide whether a command may run: refused outright, allowed without asking, or shown to the
 * user first. Refusals are checked first, so no allow-list entry can override one.
 */
export function classifyCommand(
  command: string,
  opts: { allowCommands: string[]; onMainBranch: boolean },
): CommandVerdict {
  // Case is ignored throughout: on macOS "RM" runs rm and ".ENV" opens .env.
  for (const rule of ALWAYS_REFUSED) {
    if (new RegExp(rule.pattern.source, "i").test(command)) return { decision: "deny", reason: rule.reason };
  }
  if (opts.onMainBranch && COMMITS_ON_MAIN.test(command)) {
    return { decision: "deny", reason: "commits are not made on the main branch" };
  }

  // Auto-approval is for the plain, harmless form of a listed command only: one command, with
  // arguments that stay inside the repository and cannot write or execute anything.
  const plain = command.trim();
  if (SHELL_SYNTAX.test(plain)) return { decision: "ask" };
  const entry = opts.allowCommands.find((listed) => plain === listed || plain.startsWith(`${listed} `));
  if (entry === undefined) return { decision: "ask" };
  const args = plain.slice(entry.length).trim().split(/\s+/).filter((arg) => arg !== "");
  return args.every(isSafeArgument) ? { decision: "allow" } : { decision: "ask" };
}
