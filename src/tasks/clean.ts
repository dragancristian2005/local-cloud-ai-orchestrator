const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
// A reasoning model cut off mid-thought: "<think>" with no closing tag, up to the first blank line.
const UNCLOSED_THINK = /^\s*<think>[\s\S]*?(\n\s*\n|$)/i;
const WHOLE_FENCE = /^```[\w-]*\n([\s\S]*?)\n```$/;
const QUOTE_PAIRS: Record<string, string> = { '"': '"', "'": "'", "`": "`", "“": "”" };

/**
 * Strip the wrapping small models add around an answer: reasoning blocks, a code fence around the
 * whole answer, quotes around a one-line answer. The answer itself is not changed.
 */
export function cleanModelOutput(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").replace(THINK_BLOCK, "");
  text = text.replace(UNCLOSED_THINK, "").trim();

  const fenced = WHOLE_FENCE.exec(text);
  if (fenced?.[1] !== undefined && !fenced[1].includes("```")) text = fenced[1].trim();

  if (!text.includes("\n") && text.length >= 2) {
    const closing = QUOTE_PAIRS[text[0] as string];
    const inner = text.slice(1, -1);
    // Only a single pair of quotes is wrapping. A doubled or tripled quote is part of the answer
    // itself: a Python docstring starts and ends with """.
    const isWrapped = closing !== undefined && text.endsWith(closing) && !inner.startsWith(text[0]!) && !inner.endsWith(closing);
    if (isWrapped) text = inner.trim();
  }
  return text;
}
