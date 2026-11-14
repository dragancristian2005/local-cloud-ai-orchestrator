import type { ChatMessage, ToolCall } from "../agent/messages.ts";
import type { ToolDefinition } from "../agent/toolkit.ts";

export type FallbackReason =
  | "pc_unreachable" | "timeout" | "verify_failed" | "backend_error"
  // chat only: why a message was answered by Claude instead of the local model
  | "agent_asked" | "step_limit" | "gave_up" | "triage" | "too_long" | "user_request";
export type VerifyStatus = "pass" | "fail" | "skipped";

export interface VerifyResult {
  status: "pass" | "fail";
  detail: string;
}

export interface BackendRequest {
  prompt: string;
  timeoutMs: number;
  cwd?: string;
}

export interface BackendResult {
  text: string;
  durationMs: number;
  promptTokens?: number;
  outputTokens?: number;
  model?: string;
}

export interface Backend {
  /** Config key, e.g. "pc-ollama". */
  id: string;
  /** "ollama:qwen2.5-coder:7b" | "claude-cli" */
  name: string;
  kind: "local" | "cloud";
  model: string;
  timeoutMs: number;
  healthCheck(): Promise<boolean>;
  run(req: BackendRequest): Promise<BackendResult>;
}

/** The ways a call to a backend itself can fail. */
export type BackendFailure = "pc_unreachable" | "timeout" | "backend_error";

/** A backend call failed for a reason that is not the model's answer quality. */
export class BackendError extends Error {
  reason: BackendFailure;

  constructor(reason: BackendFailure, message: string) {
    super(message);
    this.name = "BackendError";
    this.reason = reason;
  }
}

/** Bad input from the user or the repo (nothing staged, symbol missing). Exit code 2. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** Bad or missing configuration. Exit code 2. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface TaskInput {
  /** The diff (commit-message) or the source file content (docstring, test-stub). */
  text: string;
  stat?: string;
  filePath?: string;
  symbol?: string;
}

export interface PreparedTask {
  taskType: string;
  prompt: string;
  normalize(raw: string): string;
  /** Absent = verifier kind "none": the attempt is logged as "skipped" and accepted. */
  verify?(output: string): VerifyResult;
}

export interface AttemptRecord {
  runId: string;
  ts: string;
  repo: string | null;
  taskType: string;
  tier: number;
  /** 0 = first try at this tier, 1 = retry. */
  attempt: number;
  backend: string;
  model: string;
  durationMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
  verify: VerifyStatus;
  verifyDetail: string;
  escalated: boolean;
  fallbackReason: FallbackReason | null;
  outputFile: string | null;
  mode: "run" | "eval" | "chat";
  taskId: string | null;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Tools the model may ask for. Empty means a plain exchange. */
  tools: ToolDefinition[];
  timeoutMs: number;
}

export interface ChatResult {
  content: string;
  /** Empty when the model answered instead of asking for a tool. */
  toolCalls: ToolCall[];
  durationMs: number;
  promptTokens?: number;
  outputTokens?: number;
}

/** A local backend that can hold a conversation and ask for tools. */
export interface ChatBackend {
  id: string;
  name: string;
  model: string;
  kind: "local";
  timeoutMs: number;
  healthCheck(): Promise<boolean>;
  chat(req: ChatRequest): Promise<ChatResult>;
}
