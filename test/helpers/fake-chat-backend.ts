import { BackendError } from "../../src/core/types.ts";
import type { ChatBackend, ChatRequest, ChatResult } from "../../src/core/types.ts";

/** A scripted local model: each chat() takes the next reply; a BackendError reply is thrown. Records every request. */
export function fakeChatBackend(
  replies: Array<Partial<ChatResult> | BackendError>,
  opts: { healthy?: boolean; id?: string } = {},
): ChatBackend & { requests: ChatRequest[] } {
  const queue = [...replies];
  const requests: ChatRequest[] = [];
  return {
    id: opts.id ?? "pc-ollama",
    name: "fake:local",
    model: "fake-local-model",
    kind: "local",
    timeoutMs: 1000,
    requests,
    async healthCheck(): Promise<boolean> {
      return opts.healthy ?? true;
    },
    async chat(req: ChatRequest): Promise<ChatResult> {
      requests.push(structuredClone(req));
      const reply = queue.shift();
      if (reply === undefined) throw new Error("the fake chat backend has no reply left");
      if (reply instanceof BackendError) throw reply;
      return { content: "", toolCalls: [], durationMs: 5, promptTokens: 20, outputTokens: 5, ...reply };
    },
  };
}

/** Shorthand for a reply that asks for one tool. */
export function call(name: string, args: Record<string, unknown> = {}): Partial<ChatResult> {
  return { toolCalls: [{ name, arguments: args }] };
}
