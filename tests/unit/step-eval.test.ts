import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultReportFile, formatReport } from "../../src/eval/report.js";
import { loadStepDataset, runStepEval } from "../../src/eval/run-step-eval.js";
import { loadFlowFromObject } from "../../src/loader.js";

const node = process.execPath;
const slashes = (p: string) => p.split(path.sep).join("/");
const flowObj = {
  name: "se",
  version: "0.1.0",
  steps: {
    double: { type: "command", command: [node, "-e", "process.stdout.write(String(JSON.parse(require('fs').readFileSync(0,'utf8')).n * 2))"], input: '{ "n": trigger.n }', output_mode: "json" },
    each: { type: "map", over: "trigger.items", step: { type: "command", command: ["llm"], input: "item" } },
  },
};

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "step-eval-"));
  const loaded = loadFlowFromObject(flowObj, dir);
  const write = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
  return { dir, loaded, write };
}

describe("runStepEval", () => {
  it("runs the real command for each example and grades with step in scope", async () => {
    const { dir, loaded, write } = setup();
    write("steps/double/evals/eval.yaml", "dataset: dataset.yaml\ngraders:\n  - { type: exact, name: exact }\n  - { type: jsonata, name: via-step, expression: 'step.input.n * 2 = output and trigger.n = step.input.n' }\n");
    write("steps/double/evals/dataset.yaml", "examples:\n  - { id: two, context: { trigger: { n: 2 } }, expected: 4 }\n  - { id: wrong, context: { trigger: { n: 3 } }, expected: 7 }\n");
    const seen: string[] = [];
    const report = await runStepEval(loaded, "double", { onExample: (r) => seen.push(r.id) });
    expect(report.step).toBe("double");
    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(seen.sort()).toEqual(["two", "wrong"]);
    const wrong = report.examples.find((e) => e.id === "wrong")!;
    expect(wrong.output).toBe(6);
    expect(wrong.grades.map((g) => g.passed)).toEqual([false, true]);
    expect(wrong.result.argv?.[0]).toBe(node);
    expect(report.graders.map((g) => [g.name, g.passed])).toEqual([["exact", 1], ["via-step", 2]]);
    expect(slashes(defaultReportFile(dir, report))).toMatch(/steps\/double\/evals\/reports\/\d+T\d+Z\.json$/);
    expect(formatReport(report, { verbose: true })).toMatch(/Eval: se@0.1.0 step double[\s\S]*context: \{"trigger":\{"n":3\},"steps":\{\}\}/);
  });

  it("uses config mocks (keyed by step, indexed by context.index) and scores failed steps as 0", async () => {
    const { loaded, write } = setup();
    write("steps/each/evals/eval.yaml", "dataset: data.jsonl\nmocks:\n  each: [{ output: A }, { stdout: '', exit_code: 1 }]\ngraders:\n  - { type: jsonata, expression: 'output = expected' }\n");
    write("steps/each/evals/data.jsonl", '{"id":"first","context":{"item":"x","index":0},"expected":"A"}\n{"id":"second","context":{"item":"y","index":1},"expected":"B"}\n');
    expect(loadStepDataset(path.join(loaded.dir, "steps/each/evals/data.jsonl"))).toHaveLength(2);
    const report = await runStepEval(loaded, "each");
    expect(report.examples.map((e) => [e.id, e.status, e.score])).toEqual([["first", "succeeded", 1], ["second", "failed", 0]]);
    expect(report.examples[1]!.error).toMatch(/nonzero_exit/);
    expect(report.pass_rate).toBe(0.5);
  });

  it("honours limit, --mocks override and missing config", async () => {
    const { dir, loaded, write } = setup();
    write("steps/double/evals/eval.yaml", "graders: [{ type: exact }]\n");
    write("steps/double/evals/dataset.yaml", "- { context: { trigger: { n: 1 } }, expected: 2 }\n- { context: { trigger: { n: 2 } }, expected: 4 }\n");
    write("override.yaml", "mocks:\n  double: { output: 2 }\n");
    const r = await runStepEval(loaded, "double", { limit: 1, mocksFile: path.join(dir, "override.yaml") });
    expect(r.total).toBe(1);
    expect(r.examples[0]!.id).toBe("#1");
    expect(r.examples[0]!.result.exit_code).toBe(0);
    await expect(runStepEval(loaded, "each")).rejects.toSatisfy((e: Error) => /No eval.yaml found in .*steps\/each\/evals/.test(slashes(e.message)));
  });
});
