import { Ajv, type ErrorObject } from "ajv";
import { parseDuration } from "../duration.js";
import { FlowError, errorMatchesAny, toFlowError } from "../errors.js";
import { evaluateExpression } from "../expr.js";
import { buildGraph, type FlowGraph } from "../graph.js";
import type { LoadedFlow } from "../loader.js";
import type { FlowDefinition, RetryPolicy, Step } from "../schema/flow.js";
import { newRunId, now, traceFile, writeTrace, type RunTrace, type StepTrace } from "../trace.js";
import { RealRunner, type CommandRunner } from "./command-runner.js";
import { buildContext } from "./context.js";
import { withRetry } from "./retry.js";
import { executeChoiceStep } from "./steps/choice.js";
import { executeCommandStep } from "./steps/command.js";
import { executeMapStep } from "./steps/map.js";
import { executeTransformStep } from "./steps/transform.js";

export interface RunOptions {
  loaded: LoadedFlow;
  trigger: unknown;
  runner?: CommandRunner;
  /** Write trace checkpoints to disk (default true). */
  persist?: boolean;
  traceDir?: string;
  signal?: AbortSignal;
  maxConcurrency?: number;
  runTimeout?: number;
  /** Resume from an existing trace (prepared by `prepareResume`). */
  resume?: RunTrace;
  /** Fired after every checkpoint. */
  onProgress?: (trace: RunTrace) => void;
}

export interface RunResult {
  trace: RunTrace;
  status: RunTrace["status"];
  output?: unknown;
  error?: FlowError;
  traceFile?: string;
}

const DEFAULT_MAX_CONCURRENCY = 8;
export const DEFAULT_RETRY: RetryPolicy = { max_attempts: 1, backoff: "0s", on: ["command_failure"] };

class RunEnded extends Error {
  constructor() {
    super("run ended");
  }
}

/** Execute a flow (fresh or resumed). Never throws for flow-level failures; inspect `status`/`error`. */
export async function runFlow(opts: RunOptions): Promise<RunResult> {
  const { loaded } = opts;
  const flow = loaded.flow;
  const graph = buildGraph(flow);
  if (graph.cycle) throw new FlowError("internal", `Flow has a dependency cycle: ${graph.cycle.join(" -> ")}`);
  const runner = opts.runner ?? new RealRunner();
  const persist = opts.persist !== false;

  const trace: RunTrace = opts.resume ?? {
    schema_version: 1,
    run_id: newRunId(),
    flow: { name: flow.name, version: flow.version, hash: loaded.hash, dir: loaded.dir },
    status: "running",
    started_at: now(),
    resume_count: 0,
    trigger: opts.trigger,
    steps: Object.entries(flow.steps).map(([name, s]) => ({ name, type: s.type, status: "pending", attempts: [] })),
  };
  if (opts.resume) {
    trace.status = "running";
    delete trace.ended_at;
    delete trace.error;
    delete trace.output;
    delete trace.terminal_step;
  }
  const file = traceFile(loaded.dir, trace.run_id, opts.traceDir);
  const checkpoint = () => {
    if (persist) writeTrace(file, trace);
    opts.onProgress?.(trace);
  };

  const states = new Map<string, StepTrace>(trace.steps.map((s) => [s.name, s]));
  const controller = new AbortController();
  const signal = controller.signal;
  const abortWith = (err: FlowError) => {
    if (!signal.aborted) controller.abort(err);
  };
  const onExternalAbort = () => abortWith(toFlowError(opts.signal?.reason ?? new FlowError("interrupted", "Run interrupted")));
  if (opts.signal?.aborted) onExternalAbort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const runTimeoutMs = opts.runTimeout ?? (flow.config.run_timeout !== undefined ? parseDuration(flow.config.run_timeout) : undefined);
  const runTimer = runTimeoutMs ? setTimeout(() => abortWith(new FlowError("timeout", `Run exceeded run_timeout of ${runTimeoutMs}ms`)), runTimeoutMs) : undefined;
  runTimer?.unref();

  const maxConcurrency = opts.maxConcurrency ?? flow.config.max_concurrency ?? DEFAULT_MAX_CONCURRENCY;
  const defaultTimeout = flow.config.default_timeout !== undefined ? parseDuration(flow.config.default_timeout) : undefined;
  const defaultRetry = flow.config.default_retry ?? DEFAULT_RETRY;

  let runError: FlowError | undefined;
  let ended = false;
  let terminalStep: string | undefined;
  let output: unknown;

  const finish = (status: RunTrace["status"], err?: FlowError) => {
    if (ended) return;
    ended = true;
    trace.status = status;
    if (err) {
      runError = err;
      trace.error = err.toJSON();
    }
  };

  const endRun = (status: RunTrace["status"], err?: FlowError) => {
    finish(status, err);
    abortWith(err ?? new FlowError("interrupted", "Run ended"));
  };

  try {
    checkpoint();
    if (!opts.resume) validateTrigger(flow, opts.trigger);

    const running = new Map<string, Promise<void>>();

    const isComplete = (s: StepTrace) => s.status === "succeeded" || s.status === "caught";

    const propagateSkips = () => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const s of states.values()) {
          if (s.status !== "pending") continue;
          const deps = [...(graph.deps.get(s.name) ?? [])];
          const skippedDep = deps.find((d) => states.get(d)?.status === "skipped");
          if (skippedDep) {
            skip(s, `upstream step "${skippedDep}" was skipped`);
            changed = true;
            continue;
          }
          const choices = graph.choiceTargets.get(s.name);
          if (choices && choices.size) {
            const sources = [...choices].map((c) => states.get(c)!);
            const selectedByAny = sources.some((c) => isComplete(c) && c.selected === s.name);
            const allDecided = sources.every((c) => isComplete(c) || c.status === "skipped");
            if (!selectedByAny && allDecided) {
              skip(s, `not selected by choice ${sources.map((c) => `"${c.name}"`).join(", ")}`);
              changed = true;
            }
          }
        }
      }
    };

    const skip = (s: StepTrace, reason: string) => {
      s.status = "skipped";
      s.skip_reason = reason;
      s.ended_at = now();
    };

    const isReady = (s: StepTrace) => {
      if (s.status !== "pending") return false;
      const deps = [...(graph.deps.get(s.name) ?? [])];
      if (!deps.every((d) => isComplete(states.get(d)!))) return false;
      const choices = graph.choiceTargets.get(s.name);
      if (choices && choices.size) {
        return [...choices].some((c) => {
          const cs = states.get(c)!;
          return isComplete(cs) && cs.selected === s.name;
        });
      }
      return true;
    };

    // Main scheduling loop.
    while (!ended) {
      propagateSkips();
      const ready = graph.order.filter((n) => isReady(states.get(n)!));
      for (const name of ready) {
        if (running.size >= maxConcurrency) break;
        const p = executeStep(name).finally(() => running.delete(name));
        running.set(name, p);
      }
      if (running.size === 0) {
        checkpoint();
        break;
      }
      await Promise.race(running.values());
      checkpoint();
    }
    // Drain in-flight work (after a terminal step or failure the rest were aborted).
    await Promise.all(running.values());

    if (!ended) {
      const stuck = [...states.values()].filter((s) => s.status === "pending");
      if (stuck.length) {
        for (const s of stuck) skip(s, "unreachable");
      }
      output = collectSinkOutput(graph, states);
      finish("succeeded");
    }
  } catch (err) {
    if (!(err instanceof RunEnded)) finish("failed", toFlowError(err));
  } finally {
    if (runTimer) clearTimeout(runTimer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }

  // Mark still-pending steps as skipped when a terminal step ended the run successfully.
  if (trace.status === "succeeded") {
    for (const s of states.values()) {
      if (s.status === "pending" || s.status === "running") {
        s.status = "skipped";
        s.skip_reason = terminalStep ? `run ended by terminal step "${terminalStep}"` : "unreachable";
      }
    }
    trace.output = output;
    if (terminalStep) trace.terminal_step = terminalStep;
  }
  trace.ended_at = now();
  trace.duration_ms = Date.parse(trace.ended_at) - Date.parse(trace.started_at);
  checkpoint();

  const result: RunResult = { trace, status: trace.status };
  if (trace.status === "succeeded") result.output = trace.output;
  if (runError) result.error = runError;
  if (persist) result.traceFile = file;
  return result;

  // ---- step execution ----

  async function executeStep(name: string): Promise<void> {
    const step = flow.steps[name]!;
    const st = states.get(name)!;
    st.status = "running";
    st.started_at = now();
    delete st.error;
    delete st.skip_reason;
    checkpoint();

    const ctx = buildContext(trace.trigger, states.values());
    const stepTimeout = step.timeout !== undefined ? parseDuration(step.timeout) : defaultTimeout;
    const retry = step.retry ?? defaultRetry;

    try {
      const value = await withRetry(retry, st.attempts, () => runStepBody(step, st, ctx, stepTimeout), {
        signal,
        step: name,
        onAttempt: () => checkpoint(),
      });
      st.output = value;
      st.status = "succeeded";
    } catch (err) {
      const fe = toFlowError(err, name);
      if (fe.type === "interrupted") {
        st.status = "interrupted";
        st.error = fe.toJSON();
        st.ended_at = now();
        st.duration_ms = Date.parse(st.ended_at) - Date.parse(st.started_at!);
        const reason = signal.reason instanceof FlowError ? signal.reason : fe;
        finish(reason.type === "timeout" ? "failed" : "interrupted", reason);
        return;
      }
      const clause = step.catch?.find((c) => errorMatchesAny(fe.type, [c.error_type]));
      if (clause) {
        st.status = "caught";
        st.error = fe.toJSON();
        st.output = clause.result ?? null;
      } else {
        st.status = "failed";
        st.error = fe.toJSON();
        st.ended_at = now();
        st.duration_ms = Date.parse(st.ended_at) - Date.parse(st.started_at!);
        endRun("failed", fe);
        return;
      }
    }
    st.ended_at = now();
    st.duration_ms = Date.parse(st.ended_at) - Date.parse(st.started_at!);

    if (step.terminal === "success") {
      output = st.output;
      terminalStep = name;
      endRun("succeeded");
    } else if (step.terminal === "fail") {
      terminalStep = name;
      const msg = typeof st.output === "string" ? st.output : `Terminal fail step "${name}" reached`;
      endRun("failed", new FlowError("terminal_failure", msg, { step: name, details: st.output }));
    }
  }

  async function runStepBody(step: Step, st: StepTrace, ctx: ReturnType<typeof buildContext>, timeout: number | undefined): Promise<unknown> {
    if (signal.aborted) throw signal.reason instanceof FlowError ? signal.reason : new FlowError("interrupted", "Run aborted", { step: st.name });
    switch (step.type) {
      case "command": {
        const o: Parameters<typeof executeCommandStep>[2] = { stepName: st.name, runner, signal, cwd: loaded.dir };
        if (timeout !== undefined) o.timeout = timeout;
        try {
          const r = await executeCommandStep(step, ctx, o);
          st.input = r.input;
          st.argv = r.argv;
          st.exit_code = r.result.exitCode;
          if (r.result.stderr) st.stderr = r.result.stderr;
          return r.output;
        } catch (err) {
          const d = (err as FlowError).details as { exitCode?: number; stderr?: string; argv?: string[] } | undefined;
          if (d?.exitCode !== undefined) st.exit_code = d.exitCode;
          if (d?.stderr) st.stderr = d.stderr;
          if (d?.argv) st.argv = d.argv;
          throw err;
        }
      }
      case "transform":
      case "pass": {
        const r = await executeTransformStep(step, ctx);
        st.input = r.input;
        return r.output;
      }
      case "choice": {
        if (step.input !== undefined) st.input = await evaluateExpression(step.input, ctx);
        const r = await executeChoiceStep(step, ctx, st.name);
        st.selected = r.selected;
        return r.output;
      }
      case "map": {
        const itemRetry = step.step.retry ?? defaultRetry;
        const itemTimeout = step.step.timeout !== undefined ? parseDuration(step.step.timeout) : timeout;
        const o: Parameters<typeof executeMapStep>[2] = {
          stepName: st.name,
          runner,
          signal,
          cwd: loaded.dir,
          itemRetry,
          maxConcurrency: step.max_concurrency ?? maxConcurrency,
          onItemChange: (items) => {
            st.items = items;
            checkpoint();
          },
        };
        if (itemTimeout !== undefined) o.itemTimeout = itemTimeout;
        if (st.items) o.items = st.items;
        const r = await executeMapStep(step, ctx, o);
        st.input = r.input;
        st.items = r.items;
        return r.output;
      }
    }
  }
}

function collectSinkOutput(graph: FlowGraph, states: Map<string, StepTrace>): unknown {
  const out: Record<string, unknown> = {};
  for (const name of graph.sinks) {
    const s = states.get(name)!;
    if (s.status === "succeeded" || s.status === "caught") out[name] = s.output;
  }
  const keys = Object.keys(out);
  return keys.length === 1 ? out[keys[0]!] : out;
}

const ajv = new Ajv({ allErrors: true, strict: false });

export function validateTrigger(flow: FlowDefinition, trigger: unknown): void {
  if (trigger === null || typeof trigger !== "object" || Array.isArray(trigger)) {
    throw new FlowError("schema_validation", "Trigger must be a JSON object");
  }
  if (!flow.trigger_schema) return;
  let validate;
  try {
    validate = ajv.compile(flow.trigger_schema);
  } catch (err) {
    throw new FlowError("schema_validation", `Invalid trigger_schema: ${(err as Error).message}`);
  }
  if (!validate(trigger)) {
    const msgs = (validate.errors ?? []).map((e: ErrorObject) => `${e.instancePath || "(root)"} ${e.message ?? ""}`.trim());
    throw new FlowError("schema_validation", `Trigger does not match trigger_schema: ${msgs.join("; ")}`, { details: validate.errors });
  }
}
