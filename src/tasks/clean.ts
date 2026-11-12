const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
// A reasoning model cut off mid-thought: "<think>" with no closing tag, up to the first blank line.
const UNCLOSED_THINK = /^\s*<think>[\s\S]*?(\n\s*\n|$)/i;
// A fenced block whose fence lines start at column 0. A fence inside a comment (" * ```ts") does not match.
const FENCED_BLOCK = /^(`{3,})[^\n]*\n([\s\S]*?)\n\1[ \t]*$/gm;
// What may stand in front of the fence: nothing, or one line that ends like a sentence ("Here it is:").
const INTRO_LINE = /^[^\n]*[:.!]$/;
const QUOTE_PAIRS: Record<string, string> = { '"': '"', "'": "'", "`": "`", "“": "”" };

/**
 * Strip the wrapping small models add around an answer: reasoning blocks, a code fence around the
 * answer (with an optional one-line introduction and any closing remark), quotes around a one-line
 * answer. The answer itself is not changed.
 */
export function cleanModelOutput(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").replace(THINK_BLOCK, "");
  text = text.replace(UNCLOSED_THINK, "").trim();

  const blocks = [...text.matchAll(FENCED_BLOCK)];
  if (blocks.length === 1) {
    const block = blocks[0]!;
    const before = text.slice(0, block.index).trim();
    if (before === "" || INTRO_LINE.test(before)) text = (block[2] ?? "").trim();
  }

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
