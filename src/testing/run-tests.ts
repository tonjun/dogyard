import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { errorMatches } from "../errors.js";
import { evaluateExpression } from "../expr.js";
import { MockRunner } from "../executor/command-runner.js";
import { runFlow } from "../executor/run.js";
import { LoadError, formatZodIssues, readYamlFile, type LoadedFlow } from "../loader.js";
import { mocksFileSchema, testFileSchema, type Mocks, type TestCase } from "../schema/test.js";
import { executedPath, type RunTrace } from "../trace.js";

export interface TestOutcome {
  file: string;
  name: string;
  passed: boolean;
  failures: string[];
  trace?: RunTrace;
  durationMs: number;
}

export interface TestSuiteResult {
  outcomes: TestOutcome[];
  passed: number;
  failed: number;
}

export function testsDir(flowDir: string): string {
  return path.join(flowDir, "tests");
}

/** Discover `tests/*.test.yaml` (or .yml) files in a flow folder. */
export function discoverTestFiles(flowDir: string): string[] {
  const dir = testsDir(flowDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.test\.ya?ml$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

export function loadTestFile(file: string): TestCase[] {
  const raw = readYamlFile(file);
  const parsed = testFileSchema.safeParse(raw);
  if (!parsed.success) throw new LoadError(`Invalid test file ${file}`, formatZodIssues(parsed.error), file);
  return "tests" in parsed.data ? parsed.data.tests : [parsed.data];
}

export function loadMocksFile(file: string): Mocks {
  const raw = readYamlFile(file);
  const parsed = mocksFileSchema.safeParse(raw);
  if (!parsed.success) throw new LoadError(`Invalid mocks file ${file}`, formatZodIssues(parsed.error), file);
  return parsed.data.mocks;
}

export function resolveMocks(tc: { mocks?: Mocks; mocks_file?: string }, baseDir: string): Mocks {
  let mocks: Mocks = {};
  if (tc.mocks_file) mocks = { ...loadMocksFile(path.resolve(baseDir, tc.mocks_file)) };
  return { ...mocks, ...(tc.mocks ?? {}) };
}

export interface RunTestsOptions {
  filter?: string;
  /** Files to run (default: discovered). */
  files?: string[];
}

export async function runTests(loaded: LoadedFlow, opts: RunTestsOptions = {}): Promise<TestSuiteResult> {
  const files = opts.files ?? discoverTestFiles(loaded.dir);
  const outcomes: TestOutcome[] = [];
  for (const file of files) {
    for (const tc of loadTestFile(file)) {
      if (opts.filter && !tc.name.toLowerCase().includes(opts.filter.toLowerCase())) continue;
      outcomes.push(await runTestCase(loaded, tc, file));
    }
  }
  return { outcomes, passed: outcomes.filter((o) => o.passed).length, failed: outcomes.filter((o) => !o.passed).length };
}

export async function runTestCase(loaded: LoadedFlow, tc: TestCase, file = "<inline>"): Promise<TestOutcome> {
  const start = Date.now();
  const failures: string[] = [];
  let trace: RunTrace | undefined;
  try {
    const mocks = resolveMocks(tc, path.dirname(file) === "<inline>" ? loaded.dir : path.dirname(file));
    const result = await runFlow({ loaded, trigger: tc.trigger, runner: new MockRunner(mocks), persist: false });
    trace = result.trace;
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
    if (exp.output_jsonata) {
      const ok = await evaluateExpression(exp.output_jsonata, { output: result.output, trigger: tc.trigger, trace: result.trace });
      if (!ok) failures.push(`output_jsonata assertion is falsy: ${exp.output_jsonata}`);
    }
    if (exp.path) {
      const actual = executedPath(result.trace);
      if (!isDeepStrictEqual(actual, exp.path)) failures.push(`path mismatch:\n  expected: ${exp.path.join(" -> ")}\n  actual:   ${actual.join(" -> ")}`);
    }
    if (exp.skipped) {
      for (const name of exp.skipped) {
        const s = result.trace.steps.find((x) => x.name === name);
        if (!s) failures.push(`skipped: unknown step "${name}"`);
        else if (s.status !== "skipped") failures.push(`skipped: expected "${name}" to be skipped, got ${s.status}`);
      }
    }
  } catch (err) {
    failures.push(`error: ${(err as Error).message}`);
  }
  const outcome: TestOutcome = { file, name: tc.name, passed: failures.length === 0, failures, durationMs: Date.now() - start };
  if (trace) outcome.trace = trace;
  return outcome;
}

export function formatTestResults(res: TestSuiteResult, flowDir: string): string {
  const lines: string[] = [];
  for (const o of res.outcomes) {
    lines.push(`${o.passed ? "PASS" : "FAIL"}  ${o.name}  (${path.relative(flowDir, o.file)}, ${o.durationMs}ms)`);
    for (const f of o.failures) lines.push(`      ${f.replace(/\n/g, "\n      ")}`);
  }
  lines.push("", `${res.passed} passed, ${res.failed} failed, ${res.outcomes.length} total`);
  return lines.join("\n");
}
