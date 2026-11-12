import type { OllamaBackendConfig } from "../core/config.ts";
import { BackendError } from "../core/types.ts";
import type { Backend, BackendRequest, BackendResult } from "../core/types.ts";

interface ChatResponse {
  message?: { content?: unknown };
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  error?: unknown;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * A stateless text-in/text-out worker: one POST to Ollama's /api/chat per call.
 * It classifies failures so a sleeping PC is never confused with a bad model.
 */
export class OllamaBackend implements Backend {
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
    const started = Date.now();
    let res: Response;
    let bodyText: string;
    try {
      res = await fetch(`${this.cfg.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: req.prompt }],
          stream: false,
          options: this.cfg.options,
        }),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      bodyText = await res.text();
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new BackendError("timeout", `${this.name} did not answer within ${req.timeoutMs} ms`);
      }
      throw new BackendError("pc_unreachable", `cannot reach Ollama at ${this.cfg.baseUrl}`);
    }

    let body: ChatResponse | undefined;
    try {
      body = JSON.parse(bodyText) as ChatResponse;
    } catch {
      body = undefined;
    }

    if (!res.ok) {
      const detail = typeof body?.error === "string" ? body.error : bodyText.slice(0, 200);
      throw new BackendError("backend_error", `Ollama returned HTTP ${res.status} for model ${this.model}: ${detail}`);
    }
    const text = body?.message?.content;
    if (typeof text !== "string" || text.trim() === "") {
      throw new BackendError("backend_error", `Ollama returned no text for model ${this.model}`);
    }

    // Ollama cuts a prompt that does not fit, without saying so. A prompt that fills the whole
    // window was almost certainly cut, and an answer to half a prompt is not worth verifying.
    const promptTokens = optionalNumber(body?.prompt_eval_count);
    const window = this.cfg.options.num_ctx;
    if (typeof window === "number" && promptTokens !== undefined && promptTokens >= window) {
      throw new BackendError(
        "backend_error",
        `prompt was truncated by Ollama: it filled the ${window}-token context window of ${this.model} (raise options.num_ctx or lower promptTokenBudget)`,
      );
    }

    return {
      text,
      durationMs: Date.now() - started,
      promptTokens,
      outputTokens: optionalNumber(body?.eval_count),
      model: this.model,
    };
  }
}
