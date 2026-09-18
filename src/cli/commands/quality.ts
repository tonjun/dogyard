import path from "node:path";
import type { Command } from "commander";
import { defaultReportFile, formatReport, writeReport } from "../../eval/report.js";
import { runEval } from "../../eval/run-eval.js";
import { scaffoldFlow } from "../../scaffold.js";
import { formatTestResults, runTests } from "../../testing/run-tests.js";
import { loadValidFlow, log, printJson } from "../util.js";

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
      log(`\nNext: dagyard run ${path.relative(process.cwd(), res.dir)} --query "hello"`);
    });

  program
    .command("test <flow>")
    .description("Run the flow's fixture tests (tests/*.test.yaml) with mocked commands")
    .option("-k, --filter <text>", "only run tests whose name contains <text>")
    .option("--json", "print results as JSON")
    .option("--no-project", "ignore project-level workflows.yaml config")
    .action(async (flowPath: string, flags: { filter?: string; json?: boolean; project?: boolean }) => {
      const loaded = loadValidFlow(flowPath, { project: flags.project !== false });
      const opts: Parameters<typeof runTests>[1] = {};
      if (flags.filter) opts.filter = flags.filter;
      const res = await runTests(loaded, opts);
      if (flags.json) printJson(res.outcomes.map(({ trace, ...o }) => ({ ...o, run_status: trace?.status })));
      else process.stdout.write(`${formatTestResults(res, loaded.dir)}\n`);
      if (res.outcomes.length === 0) log(`No tests found in ${path.join(loaded.dir, "tests")}`);
      if (res.failed > 0) process.exitCode = 1;
    });

  program
    .command("eval <flow>")
    .description("Run the flow's eval dataset, score it with the configured graders, and write a report")
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
    .action(async (flowPath: string, flags: { config?: string; dataset?: string; mocks?: string; concurrency?: string; limit?: string; report?: string | boolean; json?: boolean; verbose?: boolean; project?: boolean }) => {
      const loaded = loadValidFlow(flowPath, { project: flags.project !== false });
      const opts: Parameters<typeof runEval>[1] = {};
      if (flags.config) opts.configFile = flags.config;
      if (flags.dataset) opts.datasetFile = flags.dataset;
      if (flags.mocks) opts.mocksFile = flags.mocks;
      if (flags.concurrency) opts.concurrency = Number(flags.concurrency);
      if (flags.limit) opts.limit = Number(flags.limit);
      if (!flags.json) opts.onExample = (r, i, total) => log(`[${i + 1}/${total}] ${r.id}: ${r.passed ? "pass" : "FAIL"} (score ${r.score.toFixed(2)}, ${r.durationMs}ms)`);
      const report = await runEval(loaded, opts);
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
