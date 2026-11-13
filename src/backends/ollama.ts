import type { ChatMessage, ToolCall } from "../agent/messages.ts";
import type { OllamaBackendConfig } from "../core/config.ts";
import { BackendError } from "../core/types.ts";
import type { Backend, BackendRequest, BackendResult, ChatBackend, ChatRequest, ChatResult } from "../core/types.ts";

interface ChatResponse {
  message?: { content?: unknown; tool_calls?: unknown };
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  error?: unknown;
}

interface Exchange {
  message: NonNullable<ChatResponse["message"]>;
  durationMs: number;
  promptTokens?: number;
  outputTokens?: number;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Our message shape to the one Ollama's /api/chat expects. `from` is ours alone and is not sent. */
function toWire(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") return { role: "tool", tool_name: message.toolName, content: message.content };
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })),
    };
  }
  return { role: message.role, content: message.content };
}

/** Small models send broken tool calls. Keep what is usable: a call needs a name; bad arguments become {}. */
function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const entry of raw) {
    const fn = isObject(entry) ? entry.function : undefined;
    if (!isObject(fn) || typeof fn.name !== "string" || fn.name === "") continue;
    calls.push({ name: fn.name, arguments: isObject(fn.arguments) ? fn.arguments : {} });
  }
  return calls;
}

/**
 * The local model on the PC, through Ollama's /api/chat. `run` is the stateless worker used by
 * tasks; `chat` is the conversational call with tools used by the chat's agent loop. Both classify
 * failures the same way, so a sleeping PC is never confused with a bad model.
 */
export class OllamaBackend implements Backend, ChatBackend {
  readonly id: string;
  readonly name: string;
  readonly kind = "local" as const;
  readonly model: string;
  readonly timeoutMs: number;
  private readonly cfg: OllamaBackendConfig;

  constructor(id: string, cfg: OllamaBackendConfig) {
    this.id = id;
    this.cfg = cfg;
    this.model = cfg.model;
    this.name = `ollama:${cfg.model}`;
    this.timeoutMs = cfg.timeoutMs;
  }

  /** True only when Ollama answers within healthTimeoutMs. A hanging connection (PC asleep) counts as down. */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(this.cfg.healthTimeoutMs),
      });
      await res.body?.cancel();
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async run(req: BackendRequest): Promise<BackendResult> {
    const exchange = await this.exchange({ messages: [{ role: "user", content: req.prompt }] }, req.timeoutMs);
    const text = exchange.message.content;
    if (typeof text !== "string" || text.trim() === "") {
      throw new BackendError("backend_error", `Ollama returned no text for model ${this.model}`);
    }
    return {
      text,
      durationMs: exchange.durationMs,
      promptTokens: exchange.promptTokens,
      outputTokens: exchange.outputTokens,
      model: this.model,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = { messages: req.messages.map(toWire) };
    if (req.tools.length > 0) body.tools = req.tools;
    const exchange = await this.exchange(body, req.timeoutMs);
    const content = typeof exchange.message.content === "string" ? exchange.message.content : "";
    const toolCalls = parseToolCalls(exchange.message.tool_calls);
    if (content.trim() === "" && toolCalls.length === 0) {
      throw new BackendError("backend_error", `Ollama returned neither text nor a tool call for model ${this.model}`);
    }
    return {
      content,
      toolCalls,
      durationMs: exchange.durationMs,
      promptTokens: exchange.promptTokens,
      outputTokens: exchange.outputTokens,
    };
  }

  /** One POST to /api/chat, with every failure turned into a BackendError that names its cause. */
  private async exchange(body: Record<string, unknown>, timeoutMs: number): Promise<Exchange> {
    const started = Date.now();
    let res: Response;
    let bodyText: string;
    try {
      res = await fetch(`${this.cfg.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, ...body, stream: false, options: this.cfg.options }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      bodyText = await res.text();
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new BackendError("timeout", `${this.name} did not answer within ${timeoutMs} ms`);
      }
      throw new BackendError("pc_unreachable", `cannot reach Ollama at ${this.cfg.baseUrl}`);
    }

    let parsed: ChatResponse | undefined;
    try {
      parsed = JSON.parse(bodyText) as ChatResponse;
    } catch {
      parsed = undefined;
    }

    if (!res.ok) {
      const detail = typeof parsed?.error === "string" ? parsed.error : bodyText.slice(0, 200);
      const hint = /tool/i.test(detail)
        ? ". This model does not support tool calling: pick one with tool support (Ollama's own examples use qwen3)"
        : "";
      throw new BackendError("backend_error", `Ollama returned HTTP ${res.status} for model ${this.model}: ${detail}${hint}`);
    }
    if (!isObject(parsed?.message)) {
      throw new BackendError("backend_error", `Ollama returned no message for model ${this.model}`);
    }

    // Ollama cuts a prompt that does not fit, without saying so. A prompt that fills the whole
    // window was almost certainly cut, and an answer to half a prompt is not worth using.
    const promptTokens = optionalNumber(parsed.prompt_eval_count);
    const window = this.cfg.options.num_ctx;
    if (typeof window === "number" && promptTokens !== undefined && promptTokens >= window) {
      throw new BackendError(
        "backend_error",
        `prompt was truncated by Ollama: it filled the ${window}-token context window of ${this.model} (raise options.num_ctx or lower promptTokenBudget)`,
      );
    }

    return {
      message: parsed.message,
      durationMs: Date.now() - started,
      promptTokens,
      outputTokens: optionalNumber(parsed.eval_count),
    };
  }
}
