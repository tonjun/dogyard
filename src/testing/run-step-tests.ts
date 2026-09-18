import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { errorMatches } from "../errors.js";
import { evaluateExpression } from "../expr.js";
import { MockRunner, RealRunner, type CommandRunner } from "../executor/command-runner.js";
import { resolveRunnableStep, runStep } from "../executor/run-step.js";
import { LoadError, formatZodIssues, readYamlFile, type LoadedFlow } from "../loader.js";
import type { Mocks } from "../schema/test.js";
import { stepTestFileSchema, type StepTestCase } from "../schema/step-test.js";
import { loadMocksFile, type TestOutcome, type TestSuiteResult } from "./run-tests.js";

export function stepsDir(flowDir: string): string {
  return path.join(flowDir, "steps");
}

export function stepDir(flowDir: string, step: string): string {
  return path.join(stepsDir(flowDir), step);
}

export function stepTestsDir(flowDir: string, step: string): string {
  return path.join(stepDir(flowDir, step), "tests");
}

/** List the `steps/<step>/` folders present in a flow. */
export function discoverStepDirs(flowDir: string): string[] {
  const dir = stepsDir(flowDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Discover `steps/<step>/tests/*.test.yaml` (or .yml) files, grouped by step. */
export function discoverStepTestFiles(flowDir: string, onlyStep?: string): Array<{ step: string; file: string }> {
  const out: Array<{ step: string; file: string }> = [];
  for (const step of discoverStepDirs(flowDir)) {
    if (onlyStep && step !== onlyStep) continue;
    const dir = stepTestsDir(flowDir, step);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => /\.test\.ya?ml$/.test(f)).sort()) out.push({ step, file: path.join(dir, f) });
  }
  return out;
}

export function loadStepTestFile(file: string): StepTestCase[] {
  const raw = readYamlFile(file);
  const parsed = stepTestFileSchema.safeParse(raw);
  if (!parsed.success) throw new LoadError(`Invalid step test file ${file}`, formatZodIssues(parsed.error), file);
  return "tests" in parsed.data ? parsed.data.tests : [parsed.data];
}

export interface RunStepTestsOptions {
  /** Only run tests for this step. */
  step?: string;
  filter?: string;
}

export async function runStepTests(loaded: LoadedFlow, opts: RunStepTestsOptions = {}): Promise<TestSuiteResult> {
  const outcomes: TestOutcome[] = [];
  for (const { step, file } of discoverStepTestFiles(loaded.dir, opts.step)) {
    let cases: StepTestCase[];
    try {
      cases = loadStepTestFile(file);
    } catch (err) {
      outcomes.push({ file, name: path.basename(file), step, passed: false, failures: [`error: ${(err as Error).message}`], durationMs: 0 });
      continue;
    }
    for (const tc of cases) {
      if (opts.filter && !tc.name.toLowerCase().includes(opts.filter.toLowerCase())) continue;
      outcomes.push(await runStepTestCase(loaded, step, tc, file));
    }
  }
  return { outcomes, passed: outcomes.filter((o) => o.passed).length, failed: outcomes.filter((o) => !o.passed).length };
}

function selectRunner(step: string, tc: StepTestCase, file: string): CommandRunner {
  if (tc.real) return new RealRunner();
  if (tc.mocks_file) return new MockRunner(loadMocksFile(path.resolve(path.dirname(file), tc.mocks_file)));
  const mocks: Mocks = { [step]: tc.mock! };
  return new MockRunner(mocks);
}

export async function runStepTestCase(loaded: LoadedFlow, step: string, tc: StepTestCase, file = "<inline>"): Promise<TestOutcome> {
  const start = Date.now();
  const failures: string[] = [];
  try {
    resolveRunnableStep(loaded, step, tc.context);
    const runner = selectRunner(step, tc, file === "<inline>" ? path.join(loaded.dir, "x") : file);
    const result = await runStep({ loaded, stepName: step, context: tc.context, runner });
    const exp = tc.expect;
    const expectedStatus = exp.status ?? (exp.error_type ? "failed" : "succeeded");
    if (result.status !== expectedStatus) {
      failures.push(`status: expected ${expectedStatus}, got ${result.status}${result.error ? ` (${result.error.type}: ${result.error.message})` : ""}`);
    }
    if (exp.error_type && (!result.error || !errorMatches(result.error.type, exp.error_type))) {
      failures.push(`error_type: expected ${exp.error_type}, got ${result.error?.type ?? "none"}`);
    }
    if (exp.output !== undefined && !isDeepStrictEqual(result.output, exp.output)) {
      failures.push(`output mismatch:\n  expected: ${JSON.stringify(exp.output)}\n  actual:   ${JSON.stringify(result.output)}`);
    }
    if (exp.input !== undefined && !isDeepStrictEqual(result.input, exp.input)) {
      failures.push(`input mismatch:\n  expected: ${JSON.stringify(exp.input)}\n  actual:   ${JSON.stringify(result.input)}`);
    }
    if (exp.argv !== undefined && !isDeepStrictEqual(result.argv, exp.argv)) {
      failures.push(`argv mismatch:\n  expected: ${JSON.stringify(exp.argv)}\n  actual:   ${JSON.stringify(result.argv)}`);
    }
    if (exp.output_jsonata) {
      const ok = await evaluateExpression(exp.output_jsonata, { output: result.output, input: result.input, argv: result.argv, context: tc.context, step: result });
      if (!ok) failures.push(`output_jsonata assertion is falsy: ${exp.output_jsonata}`);
    }
    if (exp.attempts !== undefined && result.attempts.length !== exp.attempts) {
      failures.push(`attempts: expected ${exp.attempts}, got ${result.attempts.length}`);
    }
  } catch (err) {
    failures.push(`error: ${(err as Error).message}`);
  }
  return { file, name: tc.name, step, passed: failures.length === 0, failures, durationMs: Date.now() - start };
}
