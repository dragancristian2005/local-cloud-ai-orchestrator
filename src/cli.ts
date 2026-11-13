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
import { collectInput } from "./core/context.ts";
import { runTask } from "./core/orchestrator.ts";
import { BackendError, ConfigError, InputError } from "./core/types.ts";
import { formatTable, summarize } from "./log/report.ts";
import { RunLog } from "./log/run-log.ts";
import { taskModules } from "./tasks/task.ts";
import { currentBranch } from "./workspace/git.ts";

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
  --file     source file, relative to --repo (docstring, test-stub)
  --symbol   function or class name in --file (docstring, test-stub)
  --config   config file (default: config/orchestrator.config.json in the project)
  --model    use this model on the Ollama backends instead of the configured one

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
  const input = await collectInput(type, { repo, file: values.file, symbol: values.symbol });
  const task = module.prepare(input, config.promptTokenBudget);
  const chain = chainIds.map((id) => createBackend(id, config.backends[id]!, { model: values.model }));

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

  const branch = await currentBranch(root);
  process.stderr.write(
    `orch chat in ${root}\n` +
      `local model: ${local.model}` +
      (cloud ? "; harder requests go to Claude (read-only)" : "; no Claude backend is configured") +
      `\nType /help for commands, /exit to leave.\n`,
  );
  const log = new RunLog(config.runsDir);
  await runRepl({
    input: process.stdin,
    output: process.stdout,
    errOutput: process.stderr,
    createSession: (hooks) =>
      new ChatSession({
        local,
        cloud,
        root,
        onMainBranch: branch === "main" || branch === "master",
        agent: config.agent,
        log,
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
