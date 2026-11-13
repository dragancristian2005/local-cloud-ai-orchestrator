import { createInterface } from "node:readline";
import type { ChatEvent, ChatReply, ChatSession } from "./chat-session.ts";
import type { Approval } from "./loop.ts";
import { REASON_TEXT } from "./router.ts";

const HELP = `Type a message and press Enter. orch decides whether the local model or Claude answers.

  /claude   answer the last message again, with Claude
  /clear    start a new conversation
  /help     show this
  /exit     leave
`;

/** Lines from a stream, one at a time, for a loop that sometimes needs the next line as an answer. */
function lineReader(input: NodeJS.ReadableStream): { next(): Promise<string | null> } {
  const queue: string[] = [];
  let waiting: ((line: string | null) => void) | undefined;
  let closed = false;
  const rl = createInterface({ input, terminal: false });
  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(line);
    } else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    waiting?.(null);
    waiting = undefined;
  });
  return {
    next: () =>
      new Promise((resolve) => {
        const line = queue.shift();
        if (line !== undefined) resolve(line);
        else if (closed) resolve(null);
        else waiting = resolve;
      }),
  };
}

/**
 * Text from a model, made safe to print: control characters (escape sequences could redraw the
 * screen or fake a prompt) and invisible Unicode are shown as visible codes instead of being sent
 * to the terminal. Newlines and tabs are kept where an answer may have them.
 */
function printable(text: string, keepLayout = false): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, (char) => {
    if (keepLayout && (char === "\n" || char === "\t")) return char;
    const code = char.codePointAt(0)!;
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function describe(event: ChatEvent): string {
  switch (event.type) {
    case "handover":
      return `(to claude: ${REASON_TEXT[event.reason]})`;
    case "tool":
      return `  [${printable(event.summary)}]`;
    case "command":
      if (event.verdict === "refused") return `  [refused] ${printable(event.command)} (${event.detail ?? "not allowed"})`;
      if (event.verdict === "declined") return `  [declined] ${printable(event.command)}`;
      return `  [run] ${printable(event.command)} -> exit ${event.exitCode ?? "unknown"}`;
  }
}

/**
 * The chat in a terminal. The conversation goes to `output`; everything else (tool activity,
 * routing notes, approval prompts, errors) goes to `errOutput`. Ends when the input ends or on /exit.
 */
export async function runRepl(opts: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  errOutput: NodeJS.WritableStream;
  createSession: (hooks: {
    approve: (command: string) => Promise<Approval>;
    onEvent: (event: ChatEvent) => void;
  }) => ChatSession;
}): Promise<void> {
  const lines = lineReader(opts.input);
  const say = (text: string) => opts.output.write(text);
  const note = (text: string) => opts.errOutput.write(text);
  const errIsTerminal = (opts.errOutput as { isTTY?: boolean }).isTTY === true;
  const inputIsTerminal = (opts.input as { isTTY?: boolean }).isTTY === true;

  // While Claude works there is nothing to show but the time; on a terminal, keep one line ticking.
  let ticker: NodeJS.Timeout | undefined;
  const stopTicker = () => {
    if (ticker === undefined) return;
    clearInterval(ticker);
    ticker = undefined;
    note("\r\x1b[K");
  };
  const startTicker = () => {
    if (!errIsTerminal) return;
    const started = Date.now();
    ticker = setInterval(() => note(`\rclaude is working... ${Math.round((Date.now() - started) / 1000)}s`), 1000);
  };

  const session = opts.createSession({
    approve: async (command) => {
      note(`Run this command? ${printable(command)}  [y]es / [n]o / [a]lways: `);
      const answer = (await lines.next())?.trim().toLowerCase();
      if (!inputIsTerminal) note("\n");
      if (answer === "y" || answer === "yes") return "yes";
      if (answer === "a" || answer === "always") return "always";
      // Anything else, and the end of the input, means no.
      return "no";
    },
    onEvent: (event) => {
      note(describe(event) + "\n");
      if (event.type === "handover") startTicker();
    },
  });

  const show = (reply: ChatReply) => {
    stopTicker();
    if (reply.error !== undefined) note(`orch: ${printable(reply.error, true)}\n`);
    else say(`${reply.routedBecause === null ? "local" : "claude"}> ${printable(reply.text, true)}\n`);
  };

  for (;;) {
    say("> ");
    const line = await lines.next();
    if (line === null) {
      say("\n");
      return;
    }
    const text = line.trim();
    if (text === "") continue;
    if (text === "/exit" || text === "/quit") return;
    try {
      if (text === "/help") note(HELP);
      else if (text === "/clear") {
        session.clear();
        note("conversation cleared\n");
      } else if (text === "/claude") show(await session.askClaude());
      else if (text.startsWith("/")) note(`unknown command ${text.split(/\s+/)[0]}; type /help\n`);
      else show(await session.send(text));
    } catch (err) {
      stopTicker();
      note(`orch: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}
