#!/usr/bin/env node
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { formatEvalTable, loadFixedTasks, runEval } from "../eval/compare.ts";
import { ChatSession } from "./agent/chat-session.ts";
import { runRepl } from "./agent/repl.ts";
import { createBackend } from "./backends/backend.ts";
import { ClaudeCliBackend } from "./backends/claude-cli.ts";
import { OllamaBackend } from "./backends/ollama.ts";
import { loadConfig, PROJECT_ROOT } from "./core/config.ts";
import type { OrchestratorConfig } from "./core/config.ts";
import { collectInput } from "./core/context.ts";
import { runTask } from "./core/orchestrator.ts";
import { runSmallEdit } from "./core/small-edit-run.ts";
import { BackendError, ConfigError, InputError } from "./core/types.ts";
import type { Backend } from "./core/types.ts";
import { formatTable, summarize } from "./log/report.ts";
import { RunLog } from "./log/run-log.ts";
import { taskModules } from "./tasks/task.ts";
import { currentBranch, isWorkTree, repoRoot } from "./workspace/git.ts";

const USAGE = `usage: orch <command> [options]

Typed alone in a terminal, orch opens the chat in the current folder.

commands:
  chat    talk to the local model; harder requests go to Claude
  run     run one task through its chain of backends and print the result
  eval    run the fixed task set against one local backend, to compare models
  report  print pass rate, escalation rate and average time per model, from the log

orch run --type <task type> [--repo <path>] [--file <path>] [--symbol <name>]
         [--config <path>] [--model <name>]

  --type     task type: ${Object.keys(taskModules).join(", ")}
  --repo     repository to read from (default: current directory)
  --file     source file, relative to --repo (docstring, test-stub, small-edit)
  --symbol   function or class name in --file (docstring, test-stub, small-edit)
  --config   config file (default: config/orchestrator.config.json in the project)
  --model    use this model on the Ollama backends instead of the configured one

orch run --type small-edit --file <path> (--symbol <name> | --lines <a>-<b>)
         --instruction "<text>" [--test "<command>"] [--link <path>]...
         [--allow-failing-baseline] [--commit]

  Changes one function in a temporary copy of the repository, runs your tests
  there, and prints a patch when they pass. Your working tree is not changed.
  The tests run the model's code on this machine: use it on projects you trust.

  --instruction  what to change
  --lines        the lines to change, for example 12-30, instead of --symbol
  --test         your project's test command (or "repos" in the config)
  --link         an ignored path the tests need, such as node_modules (repeatable)
  --allow-failing-baseline  the tests fail now and the edit should make them pass
  --commit       also commit the change on a new branch orch/small-edit-<run id>

orch chat [--repo <path>] [--model <name>] [--config <path>]

  --repo     the project folder to work in (default: current directory)
  --model    use this local model instead of the configured one

orch eval --backend <name> [--model <name>] [--type <task type>] [--config <path>]

  --backend  a local backend from the config (cloud backends are refused)
  --model    evaluate this model instead of the configured one
  --type     only the fixed tasks of this task type

orch report [--mode run|eval|chat] [--type <task type>] [--config <path>]

  --mode     run, eval or chat: only records of that kind (default: run and eval)
  --type     only records of this task type
`;

const FIXED_TASKS_DIR = path.join(PROJECT_ROOT, "eval", "fixed-tasks");

/** Wrong command line. Exit code 2, with the usage text. */
class UsageError extends Error {}

function parse<T extends Parameters<typeof parseArgs>[0] & object>(config: T) {
  try {
    return parseArgs(config);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

async function runCommand(args: string[]): Promise<number> {
  const { values } = parse({
    args,
    options: {
      type: { type: "string" },
      repo: { type: "string", default: "." },
      file: { type: "string" },
      symbol: { type: "string" },
      config: { type: "string" },
      model: { type: "string" },
      instruction: { type: "string" },
      lines: { type: "string" },
      test: { type: "string" },
      link: { type: "string", multiple: true },
      "allow-failing-baseline": { type: "boolean" },
      commit: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  const type = values.type;
  if (!type) throw new UsageError("--type is required");
  const module = taskModules[type];
  if (!module) throw new UsageError(`unknown task type "${type}" (known: ${Object.keys(taskModules).join(", ")})`);

  const config = loadConfig(values.config ? path.resolve(values.config) : undefined);
  const chainIds = config.chains[type];
  if (!chainIds) throw new ConfigError(`no chain configured for task type "${type}"`);

  const repo = path.resolve(values.repo);
  const makeChain = () => chainIds.map((id) => createBackend(id, config.backends[id]!, { model: values.model }));
  if (type === "small-edit") return smallEditCommand({ ...values, repo }, config, makeChain);
  for (const flag of SMALL_EDIT_FLAGS) {
    if (values[flag] !== undefined) throw new UsageError(`--${flag} is only for --type small-edit`);
  }
  const input = await collectInput(type, { repo, file: values.file, symbol: values.symbol });
  const task = module.prepare(input, config.promptTokenBudget);
  const chain = makeChain();

  const outcome = await runTask({
    task,
    chain,
    retryBeforeEscalate: config.retryBeforeEscalate,
    log: new RunLog(config.runsDir),
    repo,
    mode: "run",
    onProgress: (line) => process.stderr.write(line + "\n"),
  });
  if (!outcome.ok || outcome.text === null) {
    process.stderr.write(`orch: every tier failed (run ${outcome.runId}, see ${config.runsDir}/log.jsonl)\n`);
    return 1;
  }
  process.stdout.write(outcome.text + "\n");
  return 0;
}

const SMALL_EDIT_FLAGS = ["instruction", "lines", "test", "link", "allow-failing-baseline", "commit"] as const;
const DEFAULT_TEST_TIMEOUT_MS = 300_000;

async function smallEditCommand(
  values: {
    repo: string; file?: string; symbol?: string; instruction?: string; lines?: string; test?: string;
    link?: string[]; "allow-failing-baseline"?: boolean; commit?: boolean;
  },
  config: OrchestratorConfig,
  makeChain: () => Backend[],
): Promise<number> {
  if (!values.file) throw new UsageError("--file is required for small-edit");
  if (!values.instruction?.trim()) throw new UsageError("--instruction is required for small-edit");
  if ((values.symbol === undefined) === (values.lines === undefined)) {
    throw new UsageError("small-edit needs exactly one of --symbol and --lines");
  }

  let folder: string;
  try {
    folder = realpathSync(values.repo);
  } catch {
    throw new InputError(`no such folder: ${values.repo}`);
  }
  const root = await repoRoot(folder);
  const repoConfig = config.repos[root] ?? Object.entries(config.repos).find(([key]) => path.resolve(key) === root)?.[1] ?? {};
  const testCommand = values.test ?? repoConfig.testCommand;
  if (!testCommand?.trim()) {
    throw new UsageError(
      `small-edit needs your project's test command: pass --test "<command>", or set it once in config/orchestrator.local.json:\n` +
        `  "repos": { ${JSON.stringify(root)}: { "testCommand": "npm test" } }`,
    );
  }

  // Ctrl-C stops the tests and removes the worktree before the process leaves.
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop.abort());

  let result;
  try {
    result = await runSmallEdit({
      repo: folder,
      file: values.file,
      symbol: values.symbol,
      lines: values.lines,
      instruction: values.instruction,
      testCommand,
      testTimeoutMs: repoConfig.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
      linkPaths: [...(repoConfig.linkPaths ?? []), ...(values.link ?? [])],
      allowFailingBaseline: values["allow-failing-baseline"] ?? false,
      commit: values.commit ?? false,
      chain: makeChain(),
      retryBeforeEscalate: config.retryBeforeEscalate,
      budgetTokens: config.promptTokenBudget,
      log: new RunLog(config.runsDir),
      mode: "run",
      onProgress: (line) => process.stderr.write(line + "\n"),
      signal: stop.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      process.stderr.write("orch: interrupted; your repository was not changed\n");
      // A model call may still be in flight; do not wait for it.
      process.exit(130);
    }
    throw err;
  }

  if (result.leftAt !== undefined) {
    process.stderr.write(`orch: the tests left files behind, so the temporary worktree was kept at ${result.leftAt}\n`);
  }
  if (result.patch === null) {
    process.stderr.write(`orch: every tier failed (run ${result.outcome.runId}, see ${config.runsDir}/log.jsonl)\n`);
    return 1;
  }
  process.stdout.write(result.patch);
  if (result.branch !== null) {
    process.stderr.write(`committed on branch ${result.branch}; your working tree was not changed\n`);
  } else {
    process.stderr.write(`patch saved to ${result.patchFile}\napply it with: git apply ${result.patchFile}\n`);
  }
  return 0;
}

async function evalCommand(args: string[]): Promise<number> {
  const { values } = parse({
    args,
    options: {
      backend: { type: "string" },
      model: { type: "string" },
      type: { type: "string" },
      config: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.backend) throw new UsageError("--backend is required");
  const config = loadConfig(values.config ? path.resolve(values.config) : undefined);
  const backendConfig = config.backends[values.backend];
  if (!backendConfig) {
    throw new ConfigError(`unknown backend "${values.backend}" (configured: ${Object.keys(config.backends).join(", ")})`);
  }
  const backend = createBackend(values.backend, backendConfig, { model: values.model });
  if (backend.kind === "cloud") {
    throw new InputError("eval refuses cloud backends: no bulk runs against the subscription");
  }

  let tasks = loadFixedTasks(FIXED_TASKS_DIR);
  if (values.type) tasks = tasks.filter((task) => task.taskType === values.type);
  if (tasks.length === 0) throw new UsageError(`no fixed tasks of type "${values.type}"`);

  try {
    const results = await runEval({
      backend,
      tasks,
      budgetTokens: config.promptTokenBudget,
      log: new RunLog(config.runsDir),
      onProgress: (line) => process.stderr.write(line + "\n"),
    });
    process.stdout.write(formatEvalTable(results));
    const lastReason = results.at(-1)?.reason;
    return lastReason === "pc_unreachable" || lastReason === "backend_error" ? 1 : 0;
  } catch (err) {
    if (err instanceof BackendError) {
      process.stderr.write(`orch: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

function reportCommand(args: string[]): number {
  const { values } = parse({
    args,
    options: {
      mode: { type: "string" },
      type: { type: "string" },
      config: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const mode = values.mode;
  if (mode !== undefined && mode !== "run" && mode !== "eval" && mode !== "chat") {
    throw new UsageError(`--mode must be "run", "eval" or "chat"`);
  }
  const config = loadConfig(values.config ? path.resolve(values.config) : undefined);
  const records = new RunLog(config.runsDir).readAll();
  if (records.length === 0) {
    process.stdout.write("no runs logged yet\n");
    return 0;
  }
  const rows = summarize(records, { mode, taskType: values.type });
  process.stdout.write(rows.length === 0 ? "no runs match these filters\n" : formatTable(rows));
  return 0;
}

const MAX_CLOUD_CALLS_PIPED = 3;

async function chatCommand(args: string[]): Promise<number> {
  const { values } = parse({
    args,
    options: {
      repo: { type: "string", default: "." },
      model: { type: "string" },
      config: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const config = loadConfig(values.config ? path.resolve(values.config) : undefined);
  const chainIds = config.chains.chat;
  if (!chainIds) throw new ConfigError(`no "chat" chain in the config: add "chat": ["pc-ollama", "claude"] to "chains"`);

  let root: string;
  try {
    root = realpathSync(path.resolve(values.repo));
  } catch {
    throw new InputError(`no such folder: ${values.repo}`);
  }
  if (!statSync(root).isDirectory()) throw new InputError(`${root} is not a folder`);
  // The tools can read everything under the folder they are started in, so it must be a project.
  if (root === realpathSync(homedir())) {
    throw new InputError(`refusing to chat in ${root}: it is your home directory. cd into a project folder first`);
  }
  if (root === path.parse(root).root) throw new InputError(`refusing to chat in ${root}: cd into a project folder first`);

  const local = createBackend(chainIds[0]!, config.backends[chainIds[0]!]!, { model: values.model });
  if (!(local instanceof OllamaBackend)) {
    throw new ConfigError(`the "chat" chain must start with an Ollama backend ("${chainIds[0]}" is not one)`);
  }
  let cloud: ClaudeCliBackend | null = null;
  if (chainIds[1] !== undefined) {
    const second = createBackend(chainIds[1], config.backends[chainIds[1]]!);
    if (!(second instanceof ClaudeCliBackend)) {
      throw new ConfigError(`the second backend of the "chat" chain must be the Claude backend ("${chainIds[1]}" is not)`);
    }
    cloud = second;
  }

  process.stderr.write(
    `orch chat in ${root}\n` +
      `local model: ${local.model}` +
      (cloud ? "; harder requests go to Claude (read-only)" : "; no Claude backend is configured") +
      `\nType /help for commands, /exit to leave.\n`,
  );
  const log = new RunLog(config.runsDir);
  // Ctrl-C leaves the chat. Aborting first stops a command that is running: it is in its own
  // process group, so it would otherwise outlive the chat.
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stop.abort();
      process.exit(130);
    });
  }
  await runRepl({
    input: process.stdin,
    output: process.stdout,
    errOutput: process.stderr,
    createSession: (hooks) =>
      new ChatSession({
        local,
        cloud,
        root,
        // Asked before every command: the branch can change while the chat is open.
        onMainBranch: async () => ["main", "master"].includes((await currentBranch(root)) ?? ""),
        // Outside a repository git's read commands can reach any file, so none is auto-approved.
        gitRepository: () => isWorkTree(root),
        agent: config.agent,
        log,
        signal: stop.signal,
        // Piped input is not a person at a keyboard: no unattended runs against the subscription.
        maxCloudCalls: process.stdin.isTTY ? undefined : MAX_CLOUD_CALLS_PIPED,
        ...hooks,
      }),
  });
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "--help" || command === "-h" || command === "help") {
      process.stdout.write(USAGE);
      return 0;
    }
    // Like typing `claude`: alone in a terminal, orch opens the chat. Piped, it explains itself.
    if (command === undefined && process.stdin.isTTY) return await chatCommand([]);
    if (command === "chat") return await chatCommand(rest);
    if (command === "run") return await runCommand(rest);
    if (command === "eval") return await evalCommand(rest);
    if (command === "report") return reportCommand(rest);
    throw new UsageError(command === undefined ? "no command given" : `unknown command "${command}"`);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`orch: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    if (err instanceof InputError || err instanceof ConfigError) {
      process.stderr.write(`orch: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`orch: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
