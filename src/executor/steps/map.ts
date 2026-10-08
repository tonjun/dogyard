import pLimit from "p-limit";
import { FlowError, errorMatchesAny, toFlowError } from "../../errors.js";
import { evaluateExpression } from "../../expr.js";
import type { MapStep, MapSubStep, RetryPolicy } from "../../schema/flow.js";
import { now, type ItemTrace } from "../../trace.js";
import { hitTrace, probeCache, storeResult, type CacheContext } from "../cache.js";
import type { CommandRunner } from "../command-runner.js";
import { buildContext, type ExecutionContext } from "../context.js";
import { withRetry } from "../retry.js";
import { executeCommandStep } from "./command.js";
import { executeTransformStep } from "./transform.js";

export interface MapStepOptions {
  stepName: string;
  runner: CommandRunner;
  signal?: AbortSignal;
  cwd?: string;
  /** Effective per-item timeout (ms) and retry policy after applying flow defaults. */
  itemTimeout?: number;
  itemRetry: RetryPolicy;
  maxConcurrency: number;
  /** Existing item traces from a checkpoint; completed items are reused. */
  items?: ItemTrace[];
  /** Fired whenever an item's state changes so the caller can checkpoint. */
  onItemChange?: (items: ItemTrace[]) => void;
  /** Result cache, used per item when the command sub-step declares `cache`. */
  cache?: CacheContext;
}

export interface MapOutcome {
  input: unknown;
  output: unknown[];
  items: ItemTrace[];
}

/** Run the sub-step once per element of `over`, bounded concurrency, results in order. */
export async function executeMapStep(step: MapStep, ctx: ExecutionContext, opts: MapStepOptions): Promise<MapOutcome> {
  const collection = await evaluateExpression(step.over, ctx);
  const list = collection === undefined || collection === null ? [] : Array.isArray(collection) ? collection : [collection];

  const items: ItemTrace[] = list.map((_, index) => {
    const prev = opts.items?.[index];
    if (prev && (prev.status === "succeeded" || prev.status === "caught")) return prev;
    return { index, status: "pending", attempts: prev?.attempts ?? [] };
  });
  opts.onItemChange?.(items);

  const limit = pLimit(opts.maxConcurrency);
  let firstError: FlowError | undefined;

  await Promise.all(
    items.map((item, index) =>
      limit(async () => {
        if (item.status === "succeeded" || item.status === "caught") return;
        if (firstError || opts.signal?.aborted) return; // fail fast: don't start new items
        item.status = "running";
        item.started_at = now();
        delete item.ended_at;
        opts.onItemChange?.(items);
        const itemCtx = buildContext(ctx.trigger, [], { item: list[index], index, total: list.length });
        itemCtx.steps = ctx.steps;
        try {
          const sub = step.step;
          const probe = sub.type === "command" ? await probeCache(opts.cache, opts.stepName, sub, itemCtx, opts.cwd ?? process.cwd()) : undefined;
          if (probe?.hit) {
            item.input = probe.invocation.input;
            item.output = probe.hit.output;
            item.cache = hitTrace(probe);
          } else {
            if (probe) item.cache = { key: probe.key, hit: false };
            const started = Date.now();
            const res = await withRetry(opts.itemRetry, item.attempts, () => runSubStep(sub, itemCtx, opts, index, item), {
              signal: opts.signal,
              step: opts.stepName,
            });
            item.output = res;
            if (probe) item.cache = storeResult(probe, res, { duration_ms: Date.now() - started, item_index: index });
          }
          item.status = "succeeded";
        } catch (err) {
          const fe = toFlowError(err, opts.stepName);
          const clause = step.step.catch?.find((c) => errorMatchesAny(fe.type, [c.error_type]));
          if (clause && fe.type !== "interrupted") {
            item.status = "caught";
            item.error = fe.toJSON();
            item.output = clause.result ?? null;
          } else {
            item.status = fe.type === "interrupted" ? "interrupted" : "failed";
            item.error = fe.toJSON();
            firstError ??= fe;
          }
        }
        item.ended_at = now();
        opts.onItemChange?.(items);
      }),
    ),
  );

  if (firstError) {
    const failed = items.filter((i) => i.status === "failed" || i.status === "interrupted").map((i) => i.index);
    throw new FlowError(firstError.type, `Map item ${failed[0]} failed: ${firstError.message}`, {
      step: opts.stepName,
      details: { failed_items: failed, cause: firstError.toJSON() },
    });
  }

  return { input: list, output: items.map((i) => i.output), items };
}

async function runSubStep(sub: MapSubStep, ctx: ExecutionContext, opts: MapStepOptions, index: number, item: ItemTrace): Promise<unknown> {
  switch (sub.type) {
    case "command": {
      const cmdOpts: Parameters<typeof executeCommandStep>[2] = { stepName: opts.stepName, runner: opts.runner, itemIndex: index };
      if (ctx.total !== undefined) cmdOpts.itemTotal = ctx.total;
      if (opts.itemTimeout !== undefined) cmdOpts.timeout = opts.itemTimeout;
      if (opts.signal) cmdOpts.signal = opts.signal;
      if (opts.cwd) cmdOpts.cwd = opts.cwd;
      try {
        const r = await executeCommandStep(sub, ctx, cmdOpts);
        item.input = r.input;
        item.exit_code = r.result.exitCode;
        if (r.result.stderr) item.stderr = r.result.stderr;
        item.duration_ms = r.result.durationMs;
        return r.output;
      } catch (err) {
        const d = (err as FlowError).details as { exitCode?: number; stderr?: string; durationMs?: number } | undefined;
        if (d?.exitCode !== undefined) item.exit_code = d.exitCode;
        if (d?.stderr) item.stderr = d.stderr;
        if (d?.durationMs !== undefined) item.duration_ms = d.durationMs;
        throw err;
      }
    }
    case "transform":
    case "pass": {
      const r = await executeTransformStep(sub, ctx);
      item.input = r.input;
      return r.output;
    }
  }
}

export { now };
