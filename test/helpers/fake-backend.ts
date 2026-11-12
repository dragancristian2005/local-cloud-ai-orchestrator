import { BackendError } from "../../src/core/types.ts";
import type { Backend, BackendRequest, BackendResult } from "../../src/core/types.ts";

/** A scripted backend: each run() takes the next reply; a BackendError reply is thrown. Records the prompts it saw. */
export function fakeBackend(opts: {
  id: string;
  kind?: "local" | "cloud";
  healthy?: boolean;
  replies: (string | BackendError)[];
}): Backend & { prompts: string[] } {
  const replies = [...opts.replies];
  const prompts: string[] = [];
  return {
    id: opts.id,
    name: `fake:${opts.id}`,
    kind: opts.kind ?? "local",
    model: `${opts.id}-model`,
    timeoutMs: 1000,
    prompts,
    async healthCheck(): Promise<boolean> {
      return opts.healthy ?? true;
    },
    async run(req: BackendRequest): Promise<BackendResult> {
      prompts.push(req.prompt);
      const reply = replies.shift();
      if (reply === undefined) throw new Error(`fake backend ${opts.id} has no reply left`);
      if (reply instanceof BackendError) throw reply;
      return { text: reply, durationMs: 5, promptTokens: 10, outputTokens: 2 };
    },
  };
}
