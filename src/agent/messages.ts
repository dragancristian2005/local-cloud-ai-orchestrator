/** A tool the model asked for. `arguments` is whatever the model sent; each tool validates it. */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  /** `from` is the id of the backend that wrote it; it is shown to the user and never sent to a model. */
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; from?: string }
  | { role: "tool"; toolName: string; content: string };
