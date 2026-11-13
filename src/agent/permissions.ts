import { isSecretPath } from "./secrets.ts";

/** What to do with a command the model asked to run. */
export type CommandVerdict = { decision: "allow" } | { decision: "ask" } | { decision: "deny"; reason: string };

// `git`, optional global options, then the subcommand. Global options that take a value
// (`-C <path>`, `--work-tree <path>`, `--git-dir=<path>`...) are skipped together with it, so
// the value is not mistaken for the subcommand.
const GIT_VALUE_OPTIONS = "-C|-c|--work-tree|--git-dir|--namespace|--exec-path|--config-env|--super-prefix|--attr-source";
function git(subcommand: string): RegExp {
  return new RegExp(`\\bgit\\s+(?:(?:${GIT_VALUE_OPTIONS})(?:=\\S+|\\s+\\S+)\\s+|-\\S+\\s+)*(?:${subcommand})\\b`, "i");
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

const CREDENTIALS_REASON = "commands that touch credentials or secrets files are not allowed";

/**
 * Commands that are never run, whatever the user answers. They enforce the project's hard rules:
 * nothing destructive, no pushing, no touching credentials. This list is a backstop, not a
 * sandbox: the user's approval of every other command is the real control.
 */
const ALWAYS_REFUSED: { pattern: RegExp; reason: string }[] = [
  { pattern: new RegExp(`\\brm\\b${SAME_COMMAND}?\\s(-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive|--force)(?=\\s|$)`), reason: "rm with -r or -f is not allowed" },
  { pattern: new RegExp(`${git("reset").source}${SAME_COMMAND}--ha(r(d)?)?\\b`), reason: "git reset --hard is not allowed" },
  { pattern: git("clean"), reason: "git clean is not allowed" },
  { pattern: git("push"), reason: "git push is not allowed" },
  // An alias defined on the command line can name any subcommand, or a shell command, so the
  // rules here could not tell what would run. --config-env can define one out of sight.
  { pattern: new RegExp(`\\bgit\\b${SAME_COMMAND}\\s(-c\\s*alias\\.|--config-env)`), reason: "git aliases and --config-env on the command line are not allowed" },
  { pattern: new RegExp(`${git("checkout").source}${SAME_COMMAND}\\s(-f|--force|--|\\.)(?=\\s|$)`), reason: "discarding changes is not allowed" },
  { pattern: new RegExp(`${git("switch").source}${SAME_COMMAND}\\s(-f|--force|--discard-changes)(?=\\s|$)`), reason: "discarding changes is not allowed" },
  { pattern: git("restore"), reason: "discarding changes with git restore is not allowed" },
  { pattern: new RegExp(`${git("stash").source}\\s+(drop|clear)\\b`), reason: "dropping stashes is not allowed" },
  { pattern: /\bsudo\b/, reason: "sudo is not allowed" },
  { pattern: /\|\s*(\S*\/)?(env\s+)?(sh|bash|zsh)\b/, reason: "piping into a shell is not allowed" },
  { pattern: new RegExp(`\\bch(mod|own)\\b${SAME_COMMAND}\\s(-[a-zA-Z]*R|--recursive)`), reason: "recursive chmod/chown is not allowed" },
  // Only where a command starts (not as an argument: `grep -r shutdown src` is fine), allowing
  // for a path in front and for wrappers that run their argument.
  { pattern: /(^|[;&|(`])\s*((env|nohup|exec|time|command)\s+)*(\S*\/)?(mkfs\S*|shutdown|reboot|halt|poweroff)\b/, reason: "system commands are not allowed" },
  { pattern: new RegExp(`\\bdd\\b${SAME_COMMAND}\\bif=`), reason: "dd is not allowed" },
  { pattern: CREDENTIALS, reason: CREDENTIALS_REASON },
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
  // Short options can be bundled with a value attached anywhere ("-pO/etc/passwd"), so only the
  // plain form is trusted: a dash followed by letters and digits.
  if (arg.startsWith("-")) return /^-[A-Za-z0-9]+$/.test(arg);
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
  return !LEAVES_REPOSITORY.test(arg) && !LEAVES_REPOSITORY.test(value);
}

// Characters that can make a terminal show something other than the text: control codes
// (escape, carriage return, backspace, newline...), Unicode line separators, and invisible or
// direction-changing Unicode.
// The approval prompt is the user's only view of a command, so such a command is never run.
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/;

// Longer than this and the user cannot be expected to read all of it before approving.
const MAX_COMMAND_CHARS = 1000;

// A word of the command that is written as a path (it has a slash or a dot) and names a secrets
// file. A bare word such as "credentials" is not a path.
function namesSecretsFile(command: string): boolean {
  return command
    .split(/[\s"'`:=]+/)
    .some((piece) => /[/.]/.test(piece) && isSecretPath(piece));
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
  opts: { allowCommands: string[]; onMainBranch: boolean; gitRepository?: boolean },
): CommandVerdict {
  if (UNSHOWABLE.test(command)) {
    return { decision: "deny", reason: "the command contains control or invisible characters; write it on one plain line" };
  }
  if (command.length > MAX_COMMAND_CHARS) return { decision: "deny", reason: "the command is too long to review" };
  // Case is ignored throughout: on macOS "RM" runs rm and ".ENV" opens .env.
  for (const rule of ALWAYS_REFUSED) {
    if (new RegExp(rule.pattern.source, "i").test(command)) return { decision: "deny", reason: rule.reason };
  }
  if (namesSecretsFile(command)) return { decision: "deny", reason: CREDENTIALS_REASON };
  if (opts.onMainBranch && COMMITS_ON_MAIN.test(command)) {
    return { decision: "deny", reason: "commits are not made on the main branch" };
  }

  // Auto-approval is for the plain, harmless form of a listed command only: one command, with
  // arguments that stay inside the repository and cannot write or execute anything.
  const plain = command.trim();
  if (SHELL_SYNTAX.test(plain)) return { decision: "ask" };
  // Outside a repository git's read commands are not confined to one: `git diff a b` compares
  // any two files. So nothing git does there is approved without asking.
  if (opts.gitRepository === false && /^git(\s|$)/i.test(plain)) return { decision: "ask" };
  const entry = opts.allowCommands.find((listed) => plain === listed || plain.startsWith(`${listed} `));
  if (entry === undefined) return { decision: "ask" };
  const args = plain.slice(entry.length).trim().split(/\s+/).filter((arg) => arg !== "");
  return args.every(isSafeArgument) ? { decision: "allow" } : { decision: "ask" };
}
