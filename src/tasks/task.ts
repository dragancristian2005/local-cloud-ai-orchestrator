import type { CheckedTask, TaskInput } from "../core/types.ts";
import { commitMessage } from "./commit-message.ts";
import { docstring } from "./docstring.ts";
import { smallEdit } from "./small-edit.ts";
import { testStub } from "./test-stub.ts";

export { cleanModelOutput } from "./clean.ts";
export { languageOf } from "./language.ts";

/** One task type: turns an input (a diff, a source file) into a prompt plus the rules its answer must meet. */
export interface TaskModule {
  type: string;
  prepare(input: TaskInput, budgetTokens: number): CheckedTask;
}

export const taskModules: Record<string, TaskModule> = {
  [commitMessage.type]: commitMessage,
  [docstring.type]: docstring,
  [testStub.type]: testStub,
  [smallEdit.type]: smallEdit,
};
