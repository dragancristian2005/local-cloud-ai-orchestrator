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
}

export const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");

const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config", "orchestrator.config.json");
const LOCAL_FILE_NAME = "orchestrator.local.json";
const DEFAULT_HEALTH_TIMEOUT_MS = 3000;
const DEFAULT_OLLAMA_OPTIONS = { num_ctx: 8192, temperature: 0.2 };
const DEFAULT_PROMPT_TOKEN_BUDGET = 6000;
// Only these keys: config must never be able to point the Claude backend at another binary.
const CLAUDE_CLI_KEYS = new Set(["type", "timeoutMs", "model"]);

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

function parseBackend(id: string, raw: unknown): BackendConfig {
  if (!isObject(raw)) throw new ConfigError(`backend "${id}" must be an object`);
  const where = `backend "${id}"`;
  if (raw.type === "ollama") {
    return {
      type: "ollama",
      baseUrl: nonEmptyString(raw.baseUrl, `${where} baseUrl`).replace(/\/+$/, ""),
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
  };
}
