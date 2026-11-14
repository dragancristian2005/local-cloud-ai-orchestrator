import type { RunLog } from "../log/run-log.ts";
import { buildRetryPrompt, decideNext } from "./policy.ts";
import type { Decision, PolicyState } from "./policy.ts";
import { BackendError } from "./types.ts";
import type { AttemptRecord, Backend, FallbackReason, PreparedTask } from "./types.ts";

export interface RunOutcome {
  runId: string;
  ok: boolean;
  /** The accepted, normalised answer; null when every tier failed. */
  text: string | null;
  attempts: AttemptRecord[];
}

export interface RunTaskOptions {
  task: PreparedTask;
  /** Backends in tier order: cheapest first. */
  chain: Backend[];
  retryBeforeEscalate: number;
  log: RunLog;
  repo: string | null;
  mode: "run" | "eval";
  taskId?: string;
  /** The run's id, when the caller already made one (default: a new one). */
  runId?: string;
  onProgress?: (line: string) => void;
  /** The escalation policy. Defaults to decideNext; tests pass their own. */
  decide?: (state: PolicyState) => Decision;
}

/** What one call to a backend produced: the measured fields, and either an accepted text or a failure. */
interface AttemptResult {
  fields: Pick<
    AttemptRecord,
    "model" | "durationMs" | "promptTokens" | "outputTokens" | "verify" | "verifyDetail" | "outputFile"
  >;
  accepted?: string;
  failure?: { reason: FallbackReason; rejectedOutput?: string };
}

function failed(backend: Backend, reason: FallbackReason, detail: string, durationMs: number): AttemptResult {
  return {
    fields: {
      model: backend.model,
      durationMs,
      promptTokens: null,
      outputTokens: null,
      verify: "skipped",
      verifyDetail: detail,
      outputFile: null,
    },
    failure: { reason },
  };
}

async function isHealthy(backend: Backend): Promise<boolean> {
  try {
    return await backend.healthCheck();
  } catch {
    return false;
  }
}

/**
 * Walk the chain: run a backend, verify its answer, and let the policy decide whether to retry,
 * escalate or stop. Every attempt, including one that never reached the backend, becomes a log record.
 */
export async function runTask(opts: RunTaskOptions): Promise<RunOutcome> {
  const { task, chain, log } = opts;
  const decide = opts.decide ?? decideNext;
  const runId = opts.runId ?? log.newRunId();
  const attempts: AttemptRecord[] = [];

  async function attemptOnce(backend: Backend, tier: number, attempt: number, prompt: string): Promise<AttemptResult> {
    if (attempt === 0 && !(await isHealthy(backend))) {
      return backend.kind === "local"
        ? failed(backend, "pc_unreachable", `${backend.name} is not reachable`, 0)
        : failed(backend, "backend_error", `${backend.name} is not available`, 0);
    }

    const started = Date.now();
    let result;
    try {
      result = await backend.run({ prompt, timeoutMs: backend.timeoutMs });
    } catch (err) {
      const reason = err instanceof BackendError ? err.reason : "backend_error";
      const detail = err instanceof Error ? err.message : String(err);
      return failed(backend, reason, detail, Date.now() - started);
    }

    const fields: AttemptResult["fields"] = {
      model: result.model ?? backend.model,
      durationMs: result.durationMs,
      promptTokens: result.promptTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      verify: "skipped",
      verifyDetail: "",
      outputFile: log.writeOutput(runId, tier, attempt, result.text),
    };
    const text = task.normalize(result.text);
    if (!task.verify) return { fields, accepted: text };

    const verdict = await task.verify(text);
    fields.verify = verdict.status;
    fields.verifyDetail = verdict.detail;
    return verdict.status === "pass"
      ? { fields, accepted: text }
      : { fields, failure: { reason: "verify_failed", rejectedOutput: text } };
  }

  for (let tier = 0; tier < chain.length; tier++) {
    const backend = chain[tier]!;
    const isLastTier = tier === chain.length - 1;
    let prompt = task.prompt;

    for (let attempt = 0; ; attempt++) {
      const result = await attemptOnce(backend, tier, attempt, prompt);
      const record: AttemptRecord = {
        runId,
        ts: new Date().toISOString(),
        repo: opts.repo,
        taskType: task.taskType,
        tier,
        attempt,
        backend: backend.id,
        ...result.fields,
        escalated: false,
        fallbackReason: result.failure?.reason ?? null,
        mode: opts.mode,
        taskId: opts.taskId ?? null,
      };
      const label = `tier ${tier} ${backend.id} (${record.model})`;

      if (result.failure === undefined) {
        attempts.push(record);
        log.append(record);
        const how = record.verify === "pass" ? "pass" : "accepted (no verifier)";
        opts.onProgress?.(`${label}: ${how} (${(record.durationMs / 1000).toFixed(1)}s)`);
        return { runId, ok: true, text: result.accepted ?? "", attempts };
      }

      let decision = decide({
        reason: result.failure.reason,
        backendKind: backend.kind,
        retriesUsed: attempt,
        retryBeforeEscalate: opts.retryBeforeEscalate,
        isLastTier,
      });
      // The loop owns two limits the policy cannot lift: the retry count, and the end of the chain.
      if (decision === "retry" && attempt >= opts.retryBeforeEscalate) decision = "escalate";
      if (decision === "escalate" && isLastTier) decision = "stop";

      record.escalated = decision === "escalate";
      attempts.push(record);
      log.append(record);
      const what = record.verify === "fail" ? "verify fail" : result.failure.reason;
      opts.onProgress?.(`${label}: ${what}: ${record.verifyDetail} -> ${decision}`);

      if (decision === "stop") return { runId, ok: false, text: null, attempts };
      if (decision === "escalate") break;
      if (result.failure.rejectedOutput !== undefined) {
        prompt = buildRetryPrompt(task.prompt, result.failure.rejectedOutput, record.verifyDetail);
      }
    }
  }
  return { runId, ok: false, text: null, attempts };
}
