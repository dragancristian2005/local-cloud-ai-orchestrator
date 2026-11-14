import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ConfigError } from "./types.ts";

export interface OllamaBackendConfig {
  type: "ollama";
  baseUrl: string;
  model: string;
  timeoutMs: number;
  healthTimeoutMs: number;
  options: Record<string, unknown>;
}

export interface ClaudeCliBackendConfig {
  type: "claude-cli";
  timeoutMs: number;
  model?: string;
}

export type BackendConfig = OllamaBackendConfig | ClaudeCliBackendConfig;

export interface OrchestratorConfig {
  backends: Record<string, BackendConfig>;
  chains: Record<string, string[]>;
  retryBeforeEscalate: number;
  promptTokenBudget: number;
  runsDir: string;
  agent: AgentConfig;
  /** Per repository, keyed by its absolute root: how small-edit tests a change there. */
  repos: Record<string, RepoConfig>;
}

export interface RepoConfig {
  /** The project's own test command. The only thing small-edit runs through a shell. */
  testCommand?: string;
  /** Ignored paths (dependencies) to symlink from the checkout into the worktree. */
  linkPaths?: string[];
  testTimeoutMs?: number;
}

/** Settings for the chat: how far the local model may go on its own. */
export interface AgentConfig {
  /** Tool rounds the local model gets per message before the turn is handed over. */
  maxSteps: number;
  commandTimeoutMs: number;
  /** Commands that run without asking. Anything else is shown to the user first. */
  allowCommands: string[];
  historyTokenBudget: number;
  claudeTranscriptTokens: number;
}

export const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");

const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config", "orchestrator.config.json");
const LOCAL_FILE_NAME = "orchestrator.local.json";
const DEFAULT_HEALTH_TIMEOUT_MS = 3000;
const DEFAULT_OLLAMA_OPTIONS = { num_ctx: 8192, temperature: 0.2 };
const DEFAULT_PROMPT_TOKEN_BUDGET = 6000;
// Only these keys: config must never be able to point the Claude backend at another binary.
const CLAUDE_CLI_KEYS = new Set(["type", "timeoutMs", "model"]);

const DEFAULT_AGENT: AgentConfig = {
  maxSteps: 8,
  commandTimeoutMs: 60_000,
  allowCommands: ["git status", "git diff", "git log", "ls", "pwd"],
  historyTokenBudget: 5000,
  claudeTranscriptTokens: 20_000,
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): Json {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new ConfigError(`config file not found: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config file is not valid JSON: ${file} (${(err as Error).message})`);
  }
  if (!isObject(parsed)) throw new ConfigError(`config file must hold a JSON object: ${file}`);
  return parsed;
}

/** Top level is replaced key by key; `backends` is merged per backend, so a local file can change one field. */
function mergeLocal(base: Json, local: Json): Json {
  const merged: Json = { ...base, ...local };
  if (isObject(base.backends) && isObject(local.backends)) {
    const backends: Json = { ...base.backends };
    for (const [id, override] of Object.entries(local.backends)) {
      const existing = backends[id];
      backends[id] = isObject(existing) && isObject(override) ? { ...existing, ...override } : override;
    }
    merged.backends = backends;
  }
  if (isObject(base.agent) && isObject(local.agent)) merged.agent = { ...base.agent, ...local.agent };
  return merged;
}

function positiveNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${what} must be a positive number`);
  }
  return value;
}

function nonEmptyString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError(`${what} must be a non-empty string`);
  return value;
}

function httpUrl(value: unknown, what: string): string {
  const text = nonEmptyString(value, what);
  let url: URL | undefined;
  try {
    url = new URL(text);
  } catch {
    url = undefined;
  }
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new ConfigError(`${what} must be a full URL such as "http://192.168.1.50:11434" (got ${JSON.stringify(text)})`);
  }
  return text.replace(/\/+$/, "");
}

function parseBackend(id: string, raw: unknown): BackendConfig {
  if (!isObject(raw)) throw new ConfigError(`backend "${id}" must be an object`);
  const where = `backend "${id}"`;
  if (raw.type === "ollama") {
    return {
      type: "ollama",
      baseUrl: httpUrl(raw.baseUrl, `${where} baseUrl`),
      model: nonEmptyString(raw.model, `${where} model`),
      timeoutMs: positiveNumber(raw.timeoutMs, `${where} timeoutMs`),
      healthTimeoutMs:
        raw.healthTimeoutMs === undefined
          ? DEFAULT_HEALTH_TIMEOUT_MS
          : positiveNumber(raw.healthTimeoutMs, `${where} healthTimeoutMs`),
      options: isObject(raw.options) ? { ...DEFAULT_OLLAMA_OPTIONS, ...raw.options } : { ...DEFAULT_OLLAMA_OPTIONS },
    };
  }
  if (raw.type === "claude-cli") {
    const extra = Object.keys(raw).filter((key) => !CLAUDE_CLI_KEYS.has(key));
    if (extra.length > 0) {
      throw new ConfigError(`${where}: unsupported key(s) ${extra.join(", ")} (allowed: type, timeoutMs, model)`);
    }
    const cfg: ClaudeCliBackendConfig = {
      type: "claude-cli",
      timeoutMs: positiveNumber(raw.timeoutMs, `${where} timeoutMs`),
    };
    if (raw.model !== undefined) cfg.model = nonEmptyString(raw.model, `${where} model`);
    return cfg;
  }
  throw new ConfigError(`${where} has unknown type ${JSON.stringify(raw.type)} (expected "ollama" or "claude-cli")`);
}

function parseAgent(raw: unknown): AgentConfig {
  if (raw === undefined) return { ...DEFAULT_AGENT, allowCommands: [...DEFAULT_AGENT.allowCommands] };
  if (!isObject(raw)) throw new ConfigError(`"agent" must be an object`);
  const number = (key: "maxSteps" | "commandTimeoutMs" | "historyTokenBudget" | "claudeTranscriptTokens") =>
    raw[key] === undefined ? DEFAULT_AGENT[key] : positiveNumber(raw[key], `"agent.${key}"`);
  const maxSteps = number("maxSteps");
  if (!Number.isInteger(maxSteps) || maxSteps > 50) throw new ConfigError(`"agent.maxSteps" must be a whole number from 1 to 50`);
  let allowCommands = [...DEFAULT_AGENT.allowCommands];
  if (raw.allowCommands !== undefined) {
    if (!Array.isArray(raw.allowCommands) || raw.allowCommands.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
      throw new ConfigError(`"agent.allowCommands" must be an array of commands, for example ["git status", "npm test"]`);
    }
    allowCommands = (raw.allowCommands as string[]).map((entry) => entry.trim());
  }
  return {
    maxSteps,
    commandTimeoutMs: number("commandTimeoutMs"),
    allowCommands,
    historyTokenBudget: number("historyTokenBudget"),
    claudeTranscriptTokens: number("claudeTranscriptTokens"),
  };
}

function parseRepos(raw: unknown): Record<string, RepoConfig> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new ConfigError(`"repos" must be an object keyed by repository path`);
  const repos: Record<string, RepoConfig> = {};
  for (const [root, value] of Object.entries(raw)) {
    const where = `repos["${root}"]`;
    if (!isObject(value)) throw new ConfigError(`${where} must be an object`);
    const repo: RepoConfig = {};
    if (value.testCommand !== undefined) repo.testCommand = nonEmptyString(value.testCommand, `${where}.testCommand`);
    if (value.linkPaths !== undefined) {
      if (!Array.isArray(value.linkPaths) || value.linkPaths.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
        throw new ConfigError(`${where}.linkPaths must be an array of paths, for example ["node_modules"]`);
      }
      repo.linkPaths = value.linkPaths as string[];
    }
    if (value.testTimeoutMs !== undefined) repo.testTimeoutMs = positiveNumber(value.testTimeoutMs, `${where}.testTimeoutMs`);
    repos[root] = repo;
  }
  return repos;
}

/**
 * Load the config file, merge `orchestrator.local.json` from the same directory over it if present,
 * apply defaults and validate. With no argument, reads `config/orchestrator.config.json` in the project.
 */
export function loadConfig(file: string = DEFAULT_CONFIG_PATH): OrchestratorConfig {
  let raw = readJson(file);
  const localFile = path.join(path.dirname(file), LOCAL_FILE_NAME);
  if (existsSync(localFile)) raw = mergeLocal(raw, readJson(localFile));

  if (!isObject(raw.backends) || Object.keys(raw.backends).length === 0) {
    throw new ConfigError(`"backends" must be an object with at least one backend`);
  }
  const backends: Record<string, BackendConfig> = {};
  for (const [id, value] of Object.entries(raw.backends)) backends[id] = parseBackend(id, value);

  if (!isObject(raw.chains)) throw new ConfigError(`"chains" must be an object`);
  const chains: Record<string, string[]> = {};
  for (const [taskType, value] of Object.entries(raw.chains)) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new ConfigError(`chain "${taskType}" must be a non-empty array of backend names`);
    }
    for (const id of value) {
      if (typeof id !== "string" || !(id in backends)) {
        throw new ConfigError(`chain "${taskType}" names unknown backend ${JSON.stringify(id)}`);
      }
    }
    chains[taskType] = value as string[];
  }

  const retry = raw.retryBeforeEscalate ?? 1;
  if (typeof retry !== "number" || !Number.isInteger(retry) || retry < 0 || retry > 2) {
    throw new ConfigError(`"retryBeforeEscalate" must be 0, 1 or 2`);
  }

  const budget =
    raw.promptTokenBudget === undefined
      ? DEFAULT_PROMPT_TOKEN_BUDGET
      : positiveNumber(raw.promptTokenBudget, `"promptTokenBudget"`);

  const runsDir = raw.runsDir === undefined ? "runs" : nonEmptyString(raw.runsDir, `"runsDir"`);

  return {
    backends,
    chains,
    retryBeforeEscalate: retry,
    promptTokenBudget: budget,
    runsDir: path.resolve(PROJECT_ROOT, runsDir),
    agent: parseAgent(raw.agent),
    repos: parseRepos(raw.repos),
  };
}
