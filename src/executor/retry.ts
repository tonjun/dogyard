import { parseDuration, sleep } from "../duration.js";
import { errorMatchesAny, toFlowError, type FlowError } from "../errors.js";
import type { RetryPolicy } from "../schema/flow.js";
import { now, type AttemptTrace } from "../trace.js";

export interface RetryHooks {
  /** Called when an attempt starts/ends so the caller can checkpoint. */
  onAttempt?: (attempt: AttemptTrace, index: number) => void;
}

/**
 * Run `fn` up to `policy.max_attempts` times, sleeping `backoff` between attempts,
 * retrying only errors matching `policy.on`. Every attempt is appended to `attempts`.
 */
export async function withRetry<T>(
  policy: RetryPolicy,
  attempts: AttemptTrace[],
  fn: (attemptIndex: number) => Promise<T>,
  opts: { signal?: AbortSignal; step?: string } & RetryHooks = {},
): Promise<T> {
  const backoffMs = parseDuration(policy.backoff);
  let lastError: FlowError | undefined;
  for (let i = 0; i < policy.max_attempts; i++) {
    const attempt: AttemptTrace = { started_at: now() };
    attempts.push(attempt);
    opts.onAttempt?.(attempt, i);
    try {
      const result = await fn(i);
      attempt.ended_at = now();
      opts.onAttempt?.(attempt, i);
      return result;
    } catch (err) {
      const fe = toFlowError(err, opts.step);
      attempt.ended_at = now();
      attempt.error = fe.toJSON();
      opts.onAttempt?.(attempt, i);
      lastError = fe;
      const canRetry = i < policy.max_attempts - 1 && fe.type !== "interrupted" && errorMatchesAny(fe.type, policy.on);
      if (!canRetry) throw fe;
      if (backoffMs > 0) await sleep(backoffMs, opts.signal);
    }
  }
  throw lastError;
}
