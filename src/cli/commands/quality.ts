import path from "node:path";
import type { Command } from "commander";
import { defaultReportFile, formatReport, writeReport } from "../../eval/report.js";
import { runEval, type EvalReport, type RunEvalOptions } from "../../eval/run-eval.js";
import { runStepEval, type StepEvalReport } from "../../eval/run-step-eval.js";
import { scaffoldFlow, scaffoldStep } from "../../scaffold.js";
import { runStepTests, stepsDir } from "../../testing/run-step-tests.js";
import { formatTestResults, runTests, type TestSuiteResult } from "../../testing/run-tests.js";
import { fail, loadValidFlow, log, printJson } from "../util.js";

export function registerQuality(program: Command): void {
  program
    .command("new <name>")
    .description("Scaffold a new self-contained flow folder")
    .option("-d, --dir <dir>", "parent directory", "flows")
    .option("--force", "overwrite files if the folder exists")
    .action((name: string, flags: { dir: string; force?: boolean }) => {
      const res = scaffoldFlow({ name, dir: flags.dir, force: flags.force ?? false });
      log(`Created flow "${name}" in ${res.dir}`);
      for (const f of res.files) log(`  ${path.relative(process.cwd(), f)}`);
      log(`\nNext: dogyard run ${path.relative(process.cwd(), res.dir)} --query "hello"`);
    });

  program
    .command("new-step <flow> <step>")
    .description("Scaffold steps/<step>/ (tests + evals) for an existing command step of a flow")
    .option("--force", "overwrite files if the folder exists")
    .option("--no-project", "ignore project-level workflows.yaml config")
    .action((flowPath: string, step: string, flags: { force?: boolean; project?: boolean }) => {
      const loaded = loadValidFlow(flowPath, { project: flags.project !== false });
      let res;
      try {
        res = scaffoldStep({ loaded, step, force: flags.force ?? false });
      } catch (err) {
        return fail((err as Error).message);
      }
      log(`Created step folder for "${step}" in ${res.dir}`);
      for (const f of res.files) log(`  ${path.relative(process.cwd(), f)}`);
      log(`\nNext: dogyard test ${path.relative(process.cwd(), loaded.dir)} --step ${step}`);
    });

  program
    .command("test <flow>")
    .description("Run the flow's fixture tests (tests/*.test.yaml) and per-step tests (steps/<step>/tests/*.test.yaml)")
    .option("-k, --filter <text>", "only run tests whose name contains <text>")
    .option("--step <name>", "only run the step-level tests of <name> (skips flow-level tests)")
    .option("--no-steps", "skip step-level tests")
    .option("--json", "print results as JSON")
    .option("--no-project", "ignore project-level workflows.yaml config")
    .action(async (flowPath: string, flags: { filter?: string; step?: string; steps?: boolean; json?: boolean; project?: boolean }) => {
      const loaded = loadValidFlow(flowPath, { project: flags.project !== false });
      if (flags.step !== undefined && flags.steps === false) fail("Use only one of --step and --no-steps");
      const res: TestSuiteResult = { outcomes: [], passed: 0, failed: 0 };
      const merge = (r: TestSuiteResult) => {
        res.outcomes.push(...r.outcomes);
        res.passed += r.passed;
        res.failed += r.failed;
      };
      if (flags.step === undefined) {
        const opts: Parameters<typeof runTests>[1] = {};
        if (flags.filter) opts.filter = flags.filter;
        merge(await runTests(loaded, opts));
      }
      if (flags.steps !== false) {
        const opts: Parameters<typeof runStepTests>[1] = {};
        if (flags.filter) opts.filter = flags.filter;
        if (flags.step !== undefined) opts.step = flags.step;
        merge(await runStepTests(loaded, opts));
      }
      if (flags.json) printJson(res.outcomes.map(({ trace, ...o }) => ({ ...o, run_status: trace?.status })));
      else process.stdout.write(`${formatTestResults(res, loaded.dir)}\n`);
      if (res.outcomes.length === 0) {
        const where = flags.step !== undefined ? path.join(stepsDir(loaded.dir), flags.step, "tests") : `${path.join(loaded.dir, "tests")} or ${stepsDir(loaded.dir)}`;
        log(`No tests found in ${where}`);
      }
      if (res.failed > 0) process.exitCode = 1;
    });

  program
    .command("eval <flow>")
    .description("Run the flow's eval dataset (or one step's with --step), score it with the configured graders, and write a report")
    .option("--step <name>", "evaluate a single step using steps/<name>/evals/eval.yaml")
    .option("-c, --config <file>", "eval config file (default: evals/eval.yaml)")
    .option("-d, --dataset <file>", "dataset file (default: from eval config)")
    .option("--mocks <file>", "serve command output from a mocks YAML file instead of executing")
    .option("--concurrency <n>", "examples to run in parallel")
    .option("--limit <n>", "only run the first <n> examples")
    .option("--report <file>", "where to write the JSON report (default: evals/reports/<timestamp>.json)")
    .option("--no-report", "do not write a report file")
    .option("--json", "print the full report as JSON to stdout")
    .option("-v, --verbose", "print trigger/output for failing examples")
    .option("--no-project", "ignore project-level workflows.yaml config")
    .action(async (flowPath: string, flags: { step?: string; config?: string; dataset?: string; mocks?: string; concurrency?: string; limit?: string; report?: string | boolean; json?: boolean; verbose?: boolean; project?: boolean }) => {
      const loaded = loadValidFlow(flowPath, { project: flags.project !== false });
      const opts: Omit<RunEvalOptions, "onExample"> = {};
      if (flags.config) opts.configFile = flags.config;
      if (flags.dataset) opts.datasetFile = flags.dataset;
      if (flags.mocks) opts.mocksFile = flags.mocks;
      if (flags.concurrency) opts.concurrency = Number(flags.concurrency);
      if (flags.limit) opts.limit = Number(flags.limit);
      const onExample = (r: { id: string; passed: boolean; score: number; durationMs: number }, i: number, total: number) =>
        log(`[${i + 1}/${total}] ${r.id}: ${r.passed ? "pass" : "FAIL"} (score ${r.score.toFixed(2)}, ${r.durationMs}ms)`);
      const report: EvalReport | StepEvalReport =
        flags.step !== undefined
          ? await runStepEval(loaded, flags.step, flags.json ? opts : { ...opts, onExample })
          : await runEval(loaded, flags.json ? opts : { ...opts, onExample });
      if (flags.report !== false) {
        const file = typeof flags.report === "string" ? path.resolve(flags.report) : defaultReportFile(loaded.dir, report);
        writeReport(file, report);
        log(`Report: ${file}`);
      }
      if (flags.json) printJson(report);
      else process.stdout.write(`${formatReport(report, { verbose: flags.verbose ?? false })}\n`);
      if (report.failed > 0) process.exitCode = 1;
    });
}
