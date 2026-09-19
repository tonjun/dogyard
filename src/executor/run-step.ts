import { parseDuration } from "../duration.js";
import { FlowError, errorMatchesAny, toFlowError, type FlowErrorJSON } from "../errors.js";
import type { LoadedFlow } from "../loader.js";
import type { CommandStep, PassStep, TransformStep } from "../schema/flow.js";
import type { StepContext } from "../schema/step-test.js";
import type { AttemptTrace } from "../trace.js";
import { RealRunner, type CommandRunner } from "./command-runner.js";
import type { ExecutionContext } from "./context.js";
import { withRetry } from "./retry.js";
import { DEFAULT_RETRY } from "./run.js";
import { executeCommandStep, resolveStepCwd } from "./steps/command.js";
import { executeTransformStep } from "./steps/transform.js";

export interface StepRunOptions {
  loaded: LoadedFlow;
  stepName: string;
  context: StepContext;
  /** Defaults to a RealRunner. */
  runner?: CommandRunner;
  signal?: AbortSignal;
}

export interface StepRunResult {
  step: string;
  type: "command" | "transform" | "pass";
  status: "succeeded" | "caught" | "failed";
  output?: unknown;
  input?: unknown;
  argv?: string[];
  exit_code?: number;
  stderr?: string;
  attempts: AttemptTrace[];
  error?: FlowErrorJSON;
  duration_ms: number;
}

type RunnableStep = CommandStep | TransformStep | PassStep;

/** Resolve the step to run in isolation: a top-level step, or a map step's sub-step (which needs `item`). */
export function resolveRunnableStep(loaded: LoadedFlow, stepName: string, context: StepContext): { step: RunnableStep; isMapItem: boolean } {
  const step = loaded.flow.steps[stepName];
  if (!step) throw new FlowError("internal", `Unknown step "${stepName}" in flow ${loaded.flow.name}`, { step: stepName });
  if (step.type === "choice") throw new FlowError("internal", `Step "${stepName}" is a choice step and cannot be run in isolation`, { step: stepName });
  if (step.type === "map") {
    if (context.item === undefined) throw new FlowError("internal", `Step "${stepName}" is a map step; provide \`item\` in the context to run its sub-step`, { step: stepName });
    return { step: step.step, isMapItem: true };
  }
  return { step, isMapItem: false };
}

/** Run one step of a flow against a supplied context. Never throws for step failures; inspect `status`/`error`. */
export async function runStep(opts: StepRunOptions): Promise<StepRunResult> {
  const { loaded, stepName, context } = opts;
  const flow = loaded.flow;
  const { step, isMapItem } = resolveRunnableStep(loaded, stepName, context);
  const runner = opts.runner ?? new RealRunner();
  const start = Date.now();

  const ctx: ExecutionContext = { trigger: context.trigger ?? {}, steps: {} };
  for (const [name, output] of Object.entries(context.steps ?? {})) ctx.steps[name] = { status: "succeeded", output };
  if (isMapItem) {
    ctx.item = context.item;
    ctx.index = context.index ?? 0;
  }

  const timeout = step.timeout !== undefined ? parseDuration(step.timeout) : flow.config.default_timeout !== undefined ? parseDuration(flow.config.default_timeout) : undefined;
  const retry = step.retry ?? flow.config.default_retry ?? DEFAULT_RETRY;

  const result: StepRunResult = { step: stepName, type: step.type, status: "succeeded", attempts: [], duration_ms: 0 };

  const body = async (): Promise<unknown> => {
    if (step.type === "command") {
      const o: Parameters<typeof executeCommandStep>[2] = { stepName, runner, cwd: resolveStepCwd(loaded.dir, stepName, step) };
      if (timeout !== undefined) o.timeout = timeout;
      if (opts.signal) o.signal = opts.signal;
      if (isMapItem) o.itemIndex = ctx.index;
      try {
        const r = await executeCommandStep(step, ctx, o);
        result.input = r.input;
        result.argv = r.argv;
        result.exit_code = r.result.exitCode;
        if (r.result.stderr) result.stderr = r.result.stderr;
        return r.output;
      } catch (err) {
        const d = (err as FlowError).details as { exitCode?: number; stderr?: string; argv?: string[] } | undefined;
        if (d?.exitCode !== undefined) result.exit_code = d.exitCode;
        if (d?.stderr) result.stderr = d.stderr;
        if (d?.argv) result.argv = d.argv;
        throw err;
      }
    }
    const r = await executeTransformStep(step, ctx);
    result.input = r.input;
    return r.output;
  };

  try {
    const retryOpts: Parameters<typeof withRetry>[3] = { step: stepName };
    if (opts.signal) retryOpts.signal = opts.signal;
    result.output = await withRetry(retry, result.attempts, body, retryOpts);
  } catch (err) {
    const fe = toFlowError(err, stepName);
    const clause = fe.type !== "interrupted" ? step.catch?.find((c) => errorMatchesAny(fe.type, [c.error_type])) : undefined;
    result.error = fe.toJSON();
    if (clause) {
      result.status = "caught";
      result.output = clause.result ?? null;
    } else {
      result.status = "failed";
    }
  }
  result.duration_ms = Date.now() - start;
  return result;
}
