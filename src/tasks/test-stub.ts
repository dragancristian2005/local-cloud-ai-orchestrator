import path from "node:path";
import { estimateTokens, fitSource } from "../core/context.ts";
import { maxLines, noCodeFence, nonEmpty, runChecks } from "../core/verifier.ts";
import type { Check } from "../core/verifier.ts";
import type { CheckedTask, TaskInput } from "../core/types.ts";
import { cleanModelOutput } from "./clean.ts";
import { fileAndSymbol, languageOf } from "./language.ts";
import type { Language } from "./language.ts";
import type { TaskModule } from "./task.ts";

const MAX_TEST_FILE_LINES = 150;

const TEMPLATE = `You write unit test files.

Write a test file for \`{symbol}\` from the file below.

Rules:
- {framework}
- Write two to four test cases: typical inputs and one edge case.
- Output only the content of the test file. No code fences, no explanation.

File: {file}
{source}
`;

function frameworkRule(language: Language, filePath: string, symbol: string): string {
  const base = path.basename(filePath);
  return language === "js"
    ? `Use node:test and node:assert/strict. Import \`${symbol}\` from "./${base}".`
    : `Use pytest. Import \`${symbol}\` from the module \`${base.replace(/\.py$/, "")}\`.`;
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

const balanced: Check = (out) =>
  count(out, "{") === count(out, "}") && count(out, "(") === count(out, ")")
    ? null
    : "unbalanced braces: output looks cut off";

const languageChecks: Record<Language, Check[]> = {
  js: [
    (out) => (/\b(test|it)\s*\(/.test(out) ? null : "no test(...) or it(...) call found"),
    (out) => (/\bimport\b|\brequire\s*\(/.test(out) ? null : "the test file must import the code it tests"),
    balanced,
  ],
  py: [
    (out) => (/^def test_\w+\(/m.test(out) ? null : "no test function found (def test_...)"),
    (out) => (/^(import|from)\s/m.test(out) ? null : "the test file must import the code it tests"),
  ],
};

export const testStub: TaskModule = {
  type: "test-stub",
  prepare(input: TaskInput, budgetTokens: number): CheckedTask {
    const { filePath, symbol } = fileAndSymbol(input, "test-stub");
    const language = languageOf(filePath);
    const source = fitSource(input.text, symbol, Math.max(0, budgetTokens - estimateTokens(TEMPLATE) - 40));
    const mentionsSymbol = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const checks: Check[] = [
      nonEmpty,
      noCodeFence,
      maxLines(MAX_TEST_FILE_LINES),
      (out) => (mentionsSymbol.test(out) ? null : `the test file never mentions ${symbol}`),
      ...languageChecks[language],
    ];
    return {
      taskType: "test-stub",
      prompt: TEMPLATE.replace("{symbol}", () => symbol)
        .replace("{framework}", () => frameworkRule(language, filePath, symbol))
        .replace("{file}", () => filePath)
        .replace("{source}", () => source),
      normalize: cleanModelOutput,
      verify: (output) => runChecks(output, checks),
    };
  },
};
