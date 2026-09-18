import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EvalReport } from "./run-eval.js";
import { evalsDir } from "./run-eval.js";
import type { StepEvalReport } from "./run-step-eval.js";
import { stepEvalsDir } from "./run-step-eval.js";

/** Flow reports go to `evals/reports/`; step reports to `steps/<step>/evals/reports/`. */
export function defaultReportFile(flowDir: string, report: EvalReport | StepEvalReport): string {
  const ts = report.started_at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dir = "step" in report ? stepEvalsDir(flowDir, report.step) : evalsDir(flowDir);
  return path.join(dir, "reports", `${ts}.json`);
}

export function writeReport(file: string, report: EvalReport | StepEvalReport): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2));
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function formatReport(report: EvalReport | StepEvalReport, opts: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`Eval: ${report.flow.name}@${report.flow.version}${"step" in report ? ` step ${report.step}` : ""}`);
  lines.push(`Examples: ${report.total}   passed: ${report.passed}   failed: ${report.failed}   pass rate: ${pct(report.pass_rate)}   mean score: ${report.mean_score.toFixed(3)}`);
  lines.push("");
  lines.push("Grader                     Passed  Failed  Pass rate  Mean score");
  for (const g of report.graders) {
    lines.push(`${g.name.padEnd(26)} ${String(g.passed).padStart(6)}  ${String(g.failed).padStart(6)}  ${pct(g.pass_rate).padStart(9)}  ${g.mean_score.toFixed(3).padStart(10)}`);
  }
  const failing = report.examples.filter((e) => !e.passed);
  if (failing.length) {
    lines.push("", `Failing examples (${failing.length}):`);
    for (const e of failing) {
      lines.push(`  ${e.id}  status=${e.status}  score=${e.score.toFixed(2)}${e.error ? `  ${e.error}` : ""}`);
      for (const g of e.grades.filter((x) => !x.passed)) lines.push(`      ${g.grader}: ${g.message ?? "failed"}`);
      if (opts.verbose) {
        lines.push("trigger" in e ? `      trigger: ${JSON.stringify(e.trigger)}` : `      context: ${JSON.stringify(e.context)}`);
        lines.push(`      output:  ${JSON.stringify(e.output)}`);
      }
    }
  }
  return lines.join("\n");
}
