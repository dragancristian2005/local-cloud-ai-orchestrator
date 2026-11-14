import { estimateTokens, fitSource } from "../core/context.ts";
import { maxLines, noCodeFence, nonEmpty, runChecks } from "../core/verifier.ts";
import type { Check } from "../core/verifier.ts";
import type { CheckedTask, TaskInput } from "../core/types.ts";
import { cleanModelOutput } from "./clean.ts";
import { fileAndSymbol, languageOf } from "./language.ts";
import type { Language } from "./language.ts";
import type { TaskModule } from "./task.ts";

const MAX_COMMENT_LINES = 40;

const FORMAT_RULE: Record<Language, string> = {
  js: "Use JSDoc: start with /** and end with */.",
  py: 'Use a Python docstring: start with """ and end with """.',
};

const TEMPLATE = `You write documentation comments.

Write a documentation comment for \`{symbol}\` in the file below.

Rules:
- {format}
- Describe what it does, each parameter, and the return value.
- Output only the comment. No code, no code fences, no explanation.

File: {file}
{source}
`;

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const oneComment: Record<Language, Check> = {
  js: (out) =>
    out.startsWith("/**") && out.endsWith("*/") && count(out, "*/") === 1
      ? null
      : "answer must be exactly one JSDoc comment: start with /** and end with */, with no code after it",
  py: (out) =>
    out.startsWith('"""') && out.endsWith('"""') && count(out, '"""') === 2
      ? null
      : 'answer must be exactly one docstring: start with """ and end with """, with no code around it',
};

const hasDescription: Check = (out) => {
  const described = out
    .split("\n")
    .map((line) => line.replace(/^\s*(\/\*\*|\*\/|\*|""")?\s*/, "").replace(/\s*(\*\/|""")\s*$/, ""))
    .some((line) => line !== "" && !line.startsWith("@"));
  return described ? null : "comment needs a description line, not only tags";
};

export const docstring: TaskModule = {
  type: "docstring",
  prepare(input: TaskInput, budgetTokens: number): CheckedTask {
    const { filePath, symbol } = fileAndSymbol(input, "docstring");
    const language = languageOf(filePath);
    const source = fitSource(input.text, symbol, Math.max(0, budgetTokens - estimateTokens(TEMPLATE) - 20));
    const checks = [nonEmpty, noCodeFence, maxLines(MAX_COMMENT_LINES), oneComment[language], hasDescription];
    return {
      taskType: "docstring",
      prompt: TEMPLATE.replace("{symbol}", () => symbol)
        .replace("{format}", () => FORMAT_RULE[language])
        .replace("{file}", () => filePath)
        .replace("{source}", () => source),
      normalize: cleanModelOutput,
      verify: (output) => runChecks(output, checks),
    };
  },
};
