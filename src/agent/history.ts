import { estimateTokens } from "../core/context.ts";
import type { ChatMessage } from "./messages.ts";

export const OMITTED_MARKER = "[earlier conversation omitted]";
const PER_MESSAGE_OVERHEAD = 4;

/** A rough size of one message in tokens, tool calls included. */
export function messageTokens(message: ChatMessage): number {
  const calls = message.role === "assistant" && message.toolCalls ? estimateTokens(JSON.stringify(message.toolCalls)) : 0;
  return estimateTokens(message.content) + calls + PER_MESSAGE_OVERHEAD;
}

function hasToolCalls(message: ChatMessage): boolean {
  return message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0;
}

/** Messages that must stay together: an assistant message that asked for tools, and their results. */
function group(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (const message of messages) {
    const last = groups.at(-1);
    if (message.role === "tool" && last !== undefined && (hasToolCalls(last[0]!) || last[0]!.role === "tool")) last.push(message);
    else groups.push([message]);
  }
  return groups;
}

/**
 * Trim a conversation to a token budget for a model with a small context window.
 * Kept: the system message, the latest user message, and then the newest messages that fit.
 * A tool-call group is kept or dropped whole, so the model never sees a result without its
 * request. When something was dropped, a marker says so.
 */
export function fitHistory(messages: ChatMessage[], budgetTokens: number): ChatMessage[] {
  const total = messages.reduce((sum, message) => sum + messageTokens(message), 0);
  if (total <= budgetTokens) return messages;

  const system = messages[0]?.role === "system" ? messages[0] : undefined;
  const rest = system ? messages.slice(1) : messages;
  const groups = group(rest);
  let lastUser = -1;
  groups.forEach((members, index) => {
    if (members[0]!.role === "user") lastUser = index;
  });

  const marker: ChatMessage = { role: "user", content: OMITTED_MARKER };
  let room = budgetTokens - (system ? messageTokens(system) : 0) - messageTokens(marker);
  if (lastUser !== -1) room -= messageTokens(groups[lastUser]![0]!);

  // Newest first; the first group that does not fit ends the walk, so what is kept is contiguous.
  const keep = new Set<number>(lastUser === -1 ? [] : [lastUser]);
  for (let index = groups.length - 1; index >= 0; index--) {
    if (index === lastUser) continue;
    const cost = groups[index]!.reduce((sum, message) => sum + messageTokens(message), 0);
    if (cost > room) break;
    room -= cost;
    keep.add(index);
  }

  const kept = groups.filter((_, index) => keep.has(index)).flat();
  return [...(system ? [system] : []), marker, ...kept];
}

function renderMessage(message: ChatMessage): string {
  switch (message.role) {
    case "system":
      return "";
    case "user":
      return message.content === OMITTED_MARKER ? OMITTED_MARKER : `User:\n${message.content}`;
    case "tool":
      return `Tool result (${message.toolName}):\n${message.content}`;
    case "assistant": {
      const parts: string[] = [];
      if (message.content.trim() !== "") parts.push(`Assistant (${message.from ?? "assistant"}):\n${message.content}`);
      for (const call of message.toolCalls ?? []) parts.push(`Tool call: ${call.name}(${JSON.stringify(call.arguments)})`);
      return parts.join("\n\n");
    }
  }
}

/** The conversation as plain text for a model that gets it as one prompt. The system message is left out. */
export function renderTranscript(messages: ChatMessage[], budgetTokens: number): string {
  const visible = messages.filter((message) => message.role !== "system");
  return fitHistory(visible, budgetTokens)
    .map(renderMessage)
    .filter((block) => block !== "")
    .join("\n\n");
}
