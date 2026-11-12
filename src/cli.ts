#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { createBackend } from "./backends/backend.ts";
import { loadConfig } from "./core/config.ts";
import { collectInput } from "./core/context.ts";
import { runTask } from "./core/orchestrator.ts";
import { ConfigError, InputError } from "./core/types.ts";
import { RunLog } from "./log/run-log.ts";
import { taskModules } from "./tasks/task.ts";

const USAGE = `usage: orch <command> [options]

commands:
  run   run one task through its chain of backends and print the result

orch run --type <task type> [--repo <path>] [--file <path>] [--symbol <name>]
         [--config <path>] [--model <name>]

  --type     task type: ${Object.keys(taskModules).join(", ")}
  --repo     repository to read from (default: current directory)
  --file     source file, relative to --repo (docstring, test-stub)
  --symbol   function or class name in --file (docstring, test-stub)
  --config   config file (default: config/orchestrator.config.json in the project)
  --model    use this model on the Ollama backends instead of the configured one
`;

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

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "--help" || command === "-h" || command === "help") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (command === "run") return await runCommand(rest);
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
