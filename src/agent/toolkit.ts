/** A tool definition in the shape Ollama's /api/chat expects. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      required: string[];
      properties: Record<string, { type: string; description: string }>;
    };
  };
}

/** The policy's answer for one tool call: run it, show it to the user first, or refuse it. */
export type Verdict = { decision: "allow" } | { decision: "ask" } | { decision: "deny"; reason: string };

/** What a tool returns: text, or text plus the exit code of something it ran. */
export type ToolOutput = string | { text: string; exitCode: number | null };

export interface Tool {
  definition: ToolDefinition;
  /** One line that names this call: shown in the activity log and in the approval prompt. */
  describe(args: Record<string, unknown>): string;
  /** Throws ToolError for a problem the model can act on. */
  run(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): ToolOutput | Promise<ToolOutput>;
}

/** One policy decides for every tool call. A tool it does not know must be asked, never allowed. */
export interface Policy {
  check(tool: string, args: Record<string, unknown>): Verdict | Promise<Verdict>;
}

/** Everything the agent loop needs to know about a domain. */
export interface Toolkit {
  systemPrompt: string;
  tools: Tool[];
  policy: Policy;
}

/** A problem the model can act on. The agent loop turns it into an "error: ..." tool result. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** The most a single tool result may add to the conversation. */
export const MAX_TOOL_RESULT_CHARS = 4500;

/** The hand-over to Claude. The loop offers it with every toolkit and handles it itself. */
export const ASK_CLAUDE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "ask_claude",
    description: "Hand this request to a stronger assistant. Use it when the task is beyond you or you are not making progress.",
    parameters: {
      type: "object",
      required: ["reason"],
      properties: { reason: { type: "string", description: "One line: why you cannot finish this yourself" } },
    },
  },
};
