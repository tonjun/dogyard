import path from "node:path";
import pLimit from "p-limit";
import type { CommandRunner } from "../executor/command-runner.js";
import { collectInlineMocks } from "../executor/inline-mocks.js";
import { resolveRunnableStep, runStep, type StepRunResult } from "../executor/run-step.js";
import { LoadError, formatZodIssues, type LoadedFlow } from "../loader.js";
import type { EvalConfig } from "../schema/eval.js";
import { stepEvalDatasetSchema, type StepEvalExample } from "../schema/step-eval.js";
import type { StepContext } from "../schema/step-test.js";
import { stepDir } from "../testing/run-step-tests.js";
import { grade, graderName, type GradeResult } from "./graders.js";
import { evalRunnerFactory, loadEvalConfig, readDatasetRaw, summarize, type EvalReport, type RunEvalOptions } from "./run-eval.js";

export interface StepExampleResult {
  id: string;
  context: StepContext;
  expected: unknown;
  output?: unknown;
  status: StepRunResult["status"];
  error?: string;
  grades: GradeResult[];
  score: number;
  passed: boolean;
  durationMs: number;
  result: StepRunResult;
}

export interface StepEvalReport extends Omit<EvalReport, "examples"> {
  step: string;
  examples: StepExampleResult[];
}

export function stepEvalsDir(flowDir: string, step: string): string {
  return path.join(stepDir(flowDir, step), "evals");
}

export function loadStepDataset(file: string): StepEvalExample[] {
  const raw = readDatasetRaw(file);
  const parsed = stepEvalDatasetSchema.safeParse(raw);
  if (!parsed.success) throw new LoadError(`Invalid step dataset ${file}`, formatZodIssues(parsed.error), file);
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.examples;
}

export interface RunStepEvalOptions extends Omit<RunEvalOptions, "onExample"> {
  onExample?: (r: StepExampleResult, index: number, total: number) => void;
}

/** Run one step's eval dataset (`steps/<step>/evals/eval.yaml`) through the step harness and grade it. */
export async function runStepEval(loaded: LoadedFlow, step: string, opts: RunStepEvalOptions = {}): Promise<StepEvalReport> {
  const { file: cfgFile, config } = loadEvalConfig(loaded.dir, opts.configFile, stepEvalsDir(loaded.dir, step));
  const cfgDir = path.dirname(cfgFile);
  const datasetFile = opts.datasetFile ? path.resolve(opts.datasetFile) : path.resolve(cfgDir, config.dataset);
  let examples = loadStepDataset(datasetFile);
  if (opts.limit) examples = examples.slice(0, opts.limit);
  const runnerFactory = evalRunnerFactory(config, cfgDir, opts.mocksFile, () => collectInlineMocks(loaded));

  const started_at = new Date().toISOString();
  const limit = pLimit(opts.concurrency ?? config.concurrency);
  const results = await Promise.all(
    examples.map((ex, i) =>
      limit(async () => {
        const r = await runExample(loaded, step, config, ex, i, runnerFactory());
        opts.onExample?.(r, i, examples.length);
        return r;
      }),
    ),
  );
  return {
    flow: { name: loaded.flow.name, version: loaded.flow.version, dir: loaded.dir },
    step,
    started_at,
    ended_at: new Date().toISOString(),
    ...summarize(config, results),
    examples: results,
  };
}

async function runExample(loaded: LoadedFlow, step: string, config: EvalConfig, ex: StepEvalExample, index: number, runner: CommandRunner): Promise<StepExampleResult> {
  const start = Date.now();
  const id = ex.id ?? `#${index + 1}`;
  resolveRunnableStep(loaded, step, ex.context); // throws early for unknown / unsupported steps
  const run = await runStep({ loaded, stepName: step, context: ex.context, runner });
  const grades: GradeResult[] = [];
  if (run.status === "succeeded") {
    for (const [gi, g] of config.graders.entries()) {
      grades.push(await grade(g, gi, { output: run.output, expected: ex.expected, trigger: ex.context.trigger, step: run, flowDir: loaded.dir }));
    }
  } else {
    for (const [gi, g] of config.graders.entries()) {
      grades.push({ grader: graderName(g, gi), score: 0, passed: false, message: `step ${run.status}: ${run.error?.message ?? ""}` });
    }
  }
  const score = grades.length ? grades.reduce((a, g) => a + g.score, 0) / grades.length : 0;
  const result: StepExampleResult = {
    id,
    context: ex.context,
    expected: ex.expected,
    status: run.status,
    grades,
    score,
    passed: run.status === "succeeded" && score >= config.pass_threshold,
    durationMs: Date.now() - start,
    result: run,
  };
  if (run.status === "succeeded") result.output = run.output;
  if (run.error) result.error = `${run.error.type}: ${run.error.message}`;
  return result;
}
