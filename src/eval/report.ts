import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EvalReport } from "./run-eval.js";
import { evalsDir } from "./run-eval.js";

export function defaultReportFile(flowDir: string, report: EvalReport): string {
  const ts = report.started_at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return path.join(evalsDir(flowDir), "reports", `${ts}.json`);
}

export function writeReport(file: string, report: EvalReport): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2));
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function formatReport(report: EvalReport, opts: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`Eval: ${report.flow.name}@${report.flow.version}`);
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
      if (opts.verbose) lines.push(`      trigger: ${JSON.stringify(e.trigger)}`, `      output:  ${JSON.stringify(e.output)}`);
    }
  }
  return lines.join("\n");
}
