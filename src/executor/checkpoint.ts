import { FlowError } from "../errors.js";
import type { LoadedFlow } from "../loader.js";
import type { RunTrace } from "../trace.js";

export interface ResumeOptions {
  /** Proceed even if the flow definition changed since the run started. */
  force?: boolean;
}

/**
 * Turn a persisted trace into the initial state for a resumed run:
 * completed steps/items are kept, everything else is reset to pending.
 */
export function prepareResume(trace: RunTrace, loaded: LoadedFlow, opts: ResumeOptions = {}): RunTrace {
  if (trace.flow.name !== loaded.flow.name) {
    throw new FlowError("internal", `Trace belongs to flow "${trace.flow.name}", not "${loaded.flow.name}"`);
  }
  if (trace.flow.hash !== loaded.hash && !opts.force) {
    throw new FlowError("internal", `Flow definition changed since run ${trace.run_id} started (hash mismatch). Pass --force to resume anyway.`);
  }
  if (trace.status === "succeeded") return trace;

  const byName = new Map(trace.steps.map((s) => [s.name, s]));
  const steps = Object.entries(loaded.flow.steps).map(([name, def]) => {
    const prev = byName.get(name);
    if (!prev || prev.type !== def.type) return { name, type: def.type, status: "pending" as const, attempts: [] };
    if (prev.status === "succeeded" || prev.status === "caught" || prev.status === "skipped") return prev;
    const reset = { ...prev, status: "pending" as const };
    delete reset.error;
    delete reset.output;
    delete reset.ended_at;
    delete reset.duration_ms;
    delete reset.selected;
    delete reset.skip_reason;
    if (reset.items) {
      reset.items = reset.items.map((it) =>
        it.status === "succeeded" || it.status === "caught" ? it : { index: it.index, status: "pending" as const, attempts: it.attempts },
      );
    }
    return reset;
  });

  // Skipped steps whose skip was caused by an abort (terminal never reached) must be re-evaluated:
  // only keep skips that were decided by choice/upstream-skip, which propagateSkips will recompute anyway.
  for (const s of steps) {
    if (s.status === "skipped" && s.skip_reason && !/not selected|upstream step/.test(s.skip_reason)) {
      s.status = "pending";
      delete s.skip_reason;
    }
  }

  return {
    ...trace,
    flow: { ...trace.flow, hash: loaded.hash, dir: loaded.dir },
    status: "running",
    resume_count: trace.resume_count + 1,
    steps,
  };
}
