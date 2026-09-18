import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { MockRunner, RealRunner, type CommandRunner } from "../executor/command-runner.js";
import { runFlow } from "../executor/run.js";
import { LoadError, formatZodIssues, readYamlFile, type LoadedFlow } from "../loader.js";
import { evalConfigSchema, evalDatasetSchema, type EvalConfig, type EvalExample, type Grader } from "../schema/eval.js";
import { resolveMocks } from "../testing/run-tests.js";
import type { RunTrace } from "../trace.js";
import { grade, graderName, type GradeResult } from "./graders.js";

export interface ExampleResult {
  id: string;
  trigger: unknown;
  expected: unknown;
  output?: unknown;
  status: RunTrace["status"];
  error?: string;
  grades: GradeResult[];
  score: number;
  passed: boolean;
  durationMs: number;
  trace: RunTrace;
}

export interface EvalReport {
  flow: { name: string; version: string; dir: string };
  started_at: string;
  ended_at: string;
  total: number;
  passed: number;
  failed: number;
  pass_rate: number;
  mean_score: number;
  graders: Array<{ name: string; type: Grader["type"]; passed: number; failed: number; pass_rate: number; mean_score: number }>;
  examples: ExampleResult[];
}

export function evalsDir(flowDir: string): string {
  return path.join(flowDir, "evals");
}

export function loadEvalConfig(flowDir: string, file?: string): { file: string; config: EvalConfig } {
  const f = file ? path.resolve(file) : ["eval.yaml", "eval.yml"].map((n) => path.join(evalsDir(flowDir), n)).find(existsSync);
  if (!f || !existsSync(f)) throw new LoadError(`No evals/eval.yaml found in ${flowDir}`);
  const parsed = evalConfigSchema.safeParse(readYamlFile(f));
  if (!parsed.success) throw new LoadError(`Invalid eval config ${f}`, formatZodIssues(parsed.error), f);
  return { file: f, config: parsed.data };
}

export function loadDataset(file: string): EvalExample[] {
  if (!existsSync(file)) throw new LoadError(`Dataset not found: ${file}`);
  let raw: unknown;
  if (file.endsWith(".jsonl")) {
    raw = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } else {
    raw = readYamlFile(file);
  }
  const parsed = evalDatasetSchema.safeParse(raw);
  if (!parsed.success) throw new LoadError(`Invalid dataset ${file}`, formatZodIssues(parsed.error), file);
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.examples;
}

export interface RunEvalOptions {
  configFile?: string;
  datasetFile?: string;
  concurrency?: number;
  /** Explicit mocks (e.g. from --mocks) override eval.yaml mocks; omit for real execution. */
  mocksFile?: string;
  limit?: number;
  onExample?: (r: ExampleResult, index: number, total: number) => void;
}

export async function runEval(loaded: LoadedFlow, opts: RunEvalOptions = {}): Promise<EvalReport> {
  const { file: cfgFile, config } = loadEvalConfig(loaded.dir, opts.configFile);
  const cfgDir = path.dirname(cfgFile);
  const datasetFile = opts.datasetFile ? path.resolve(opts.datasetFile) : path.resolve(cfgDir, config.dataset);
  let examples = loadDataset(datasetFile);
  if (opts.limit) examples = examples.slice(0, opts.limit);

  let runnerFactory: () => CommandRunner;
  if (opts.mocksFile) {
    const mocks = resolveMocks({ mocks_file: opts.mocksFile }, process.cwd());
    runnerFactory = () => new MockRunner(mocks);
  } else if (config.mocks || config.mocks_file) {
    const mocks = resolveMocks(config, cfgDir);
    runnerFactory = () => new MockRunner(mocks);
  } else {
    const real = new RealRunner();
    runnerFactory = () => real;
  }

  const started_at = new Date().toISOString();
  const limit = pLimit(opts.concurrency ?? config.concurrency);
  const results = await Promise.all(
    examples.map((ex, i) =>
      limit(async () => {
        const r = await runExample(loaded, config, ex, i, runnerFactory());
        opts.onExample?.(r, i, examples.length);
        return r;
      }),
    ),
  );

  const graders = config.graders.map((g, gi) => {
    const gs = results.map((r) => r.grades[gi]).filter((x): x is GradeResult => !!x);
    const passed = gs.filter((x) => x.passed).length;
    return {
      name: graderName(g, gi),
      type: g.type,
      passed,
      failed: gs.length - passed,
      pass_rate: gs.length ? passed / gs.length : 0,
      mean_score: gs.length ? gs.reduce((a, x) => a + x.score, 0) / gs.length : 0,
    };
  });
  const passed = results.filter((r) => r.passed).length;
  return {
    flow: { name: loaded.flow.name, version: loaded.flow.version, dir: loaded.dir },
    started_at,
    ended_at: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    pass_rate: results.length ? passed / results.length : 0,
    mean_score: results.length ? results.reduce((a, r) => a + r.score, 0) / results.length : 0,
    graders,
    examples: results,
  };
}

async function runExample(loaded: LoadedFlow, config: EvalConfig, ex: EvalExample, index: number, runner: CommandRunner): Promise<ExampleResult> {
  const start = Date.now();
  const id = ex.id ?? `#${index + 1}`;
  const run = await runFlow({ loaded, trigger: ex.trigger, runner, persist: false });
  const grades: GradeResult[] = [];
  if (run.status === "succeeded") {
    for (const [gi, g] of config.graders.entries()) {
      grades.push(await grade(g, gi, { output: run.output, expected: ex.expected, trigger: ex.trigger, trace: run.trace, flowDir: loaded.dir }));
    }
  } else {
    for (const [gi, g] of config.graders.entries()) {
      grades.push({ grader: graderName(g, gi), score: 0, passed: false, message: `run ${run.status}: ${run.error?.message ?? ""}` });
    }
  }
  const score = grades.length ? grades.reduce((a, g) => a + g.score, 0) / grades.length : 0;
  const result: ExampleResult = {
    id,
    trigger: ex.trigger,
    expected: ex.expected,
    status: run.status,
    grades,
    score,
    passed: run.status === "succeeded" && score >= config.pass_threshold,
    durationMs: Date.now() - start,
    trace: run.trace,
  };
  if (run.status === "succeeded") result.output = run.output;
  if (run.error) result.error = `${run.error.type}: ${run.error.message}`;
  return result;
}
