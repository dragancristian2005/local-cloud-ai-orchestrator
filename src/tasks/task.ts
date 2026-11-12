import type { PreparedTask, TaskInput } from "../core/types.ts";
import { commitMessage } from "./commit-message.ts";

export { cleanModelOutput } from "./clean.ts";

/** One task type: turns an input (a diff, a source file) into a prompt plus the rules its answer must meet. */
export interface TaskModule {
  type: string;
  prepare(input: TaskInput, budgetTokens: number): PreparedTask;
}

export const taskModules: Record<string, TaskModule> = {
  [commitMessage.type]: commitMessage,
};
