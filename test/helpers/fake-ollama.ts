import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOllama {
  url: string;
  requests: { method: string; path: string; body: string }[];
  close(): Promise<void>;
}

export type FakeHandler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

/** A stand-in for Ollama on 127.0.0.1. The handler decides every response; a handler that never responds simulates a hang. */
export function startFakeOllama(handler: FakeHandler): Promise<FakeOllama> {
  const requests: FakeOllama["requests"] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", path: req.url ?? "", body });
      handler(req, body, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Reply with a JSON body. */
export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A handler for the common case: /api/tags is healthy and /api/chat answers with `content`. */
export function chatReplies(content: string | (() => string)): FakeHandler {
  return (req, _body, res) => {
    if (req.url === "/api/tags") return json(res, 200, { models: [] });
    json(res, 200, {
      message: { role: "assistant", content: typeof content === "string" ? content : content() },
      prompt_eval_count: 12,
      eval_count: 3,
    });
  };
}

/** A URL on which nothing listens. */
export async function closedPortUrl(): Promise<string> {
  const server = await startFakeOllama(() => {});
  await server.close();
  return server.url;
}
