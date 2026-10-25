import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grade, graderName } from "../../src/eval/graders.js";
import { formatReport } from "../../src/eval/report.js";
import { evalRunnerFactory, loadDataset, loadEvalConfig, readDatasetRaw, runEval, summarize } from "../../src/eval/run-eval.js";
import { MockRunner, RealRunner } from "../../src/executor/command-runner.js";
import { LoadError, loadFlowFromObject } from "../../src/loader.js";
import { evalConfigSchema } from "../../src/schema/eval.js";

const node = process.execPath;
const base = { output: { v: 1 }, expected: { v: 1 }, trigger: { q: "x" }, flowDir: process.cwd() };
const cmd = (src: string) => [node, "-e", src];

describe("grade", () => {
  it("names graders by name or type#index", () => {
    expect(graderName({ type: "exact" }, 0)).toBe("exact#1");
    expect(graderName({ type: "exact", name: "n" }, 3)).toBe("n");
  });

  it("exact compares deeply and explains mismatches", async () => {
    expect(await grade({ type: "exact" }, 0, base)).toEqual({ grader: "exact#1", score: 1, passed: true });
    const miss = await grade({ type: "exact" }, 0, { ...base, expected: { v: 2 } });
    expect(miss).toMatchObject({ score: 0, passed: false, message: 'expected {"v":2}, got {"v":1}' });
  });

  it("jsonata scores numbers (clamped) and booleans", async () => {
    expect(await grade({ type: "jsonata", expression: "0.5" }, 0, base)).toMatchObject({ score: 0.5, passed: false });
    expect(await grade({ type: "jsonata", expression: "7" }, 0, base)).toMatchObject({ score: 1, passed: true });
    expect(await grade({ type: "jsonata", expression: "-3" }, 0, base)).toMatchObject({ score: 0 });
    expect(await grade({ type: "jsonata", expression: "output.v = expected.v" }, 0, base)).toMatchObject({ score: 1, passed: true });
    expect(await grade({ type: "jsonata", expression: "trigger.q = 'y'" }, 0, base)).toMatchObject({ passed: false, message: "expression returned false" });
  });

  it("reports expression errors as a failed grade", async () => {
    const r = await grade({ type: "jsonata", expression: "(((" }, 0, base);
    expect(r).toMatchObject({ score: 0, passed: false });
    expect(r.message).toMatch(/^grader error: /);
  });

  it("command graders read a JSON score/message, or pass on exit 0 with other stdout", async () => {
    const scored = await grade({ type: "command", command: cmd("process.stdout.write(JSON.stringify({ score: 0.25, message: 'meh' }))"), timeout: "10s" }, 0, base);
    expect(scored).toMatchObject({ score: 0.25, passed: false, message: "meh" });
    const clamped = await grade({ type: "command", command: cmd("process.stdout.write('{\"score\": 9}')") }, 0, base);
    expect(clamped).toEqual({ grader: "command#1", score: 1, passed: true });
    expect(await grade({ type: "command", command: cmd("process.stdout.write('ok')") }, 0, base)).toMatchObject({ score: 1, passed: true });
    const echoes = await grade({ type: "command", command: cmd("const i = JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(JSON.stringify({ score: i.output.v === i.expected.v ? 1 : 0 }))") }, 0, base);
    expect(echoes.passed).toBe(true);
  });

  it("command graders fail with stderr, then stdout, then the error message", async () => {
    expect(await grade({ type: "command", command: cmd("console.error(' bad '); process.exit(2)") }, 0, base)).toMatchObject({ passed: false, message: "bad" });
    expect(await grade({ type: "command", command: cmd("process.stdout.write('out'); process.exit(2)") }, 0, base)).toMatchObject({ message: "out" });
    expect((await grade({ type: "command", command: cmd("process.exit(3)") }, 0, base)).message).toMatch(/exited with code 3/);
  });
});

const flowObj = {
  name: "ev",
  version: "0.2.0",
  steps: {
    shout: { type: "command", command: cmd("process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8')).toUpperCase()))"), input: "trigger.q", output_mode: "json" },
  },
};

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-"));
  const write = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
    return path.join(dir, rel);
  };
  return { dir, write, loaded: loadFlowFromObject(flowObj, dir) };
}

describe("eval config and datasets", () => {
  it("finds eval.yaml or eval.yml and rejects missing/invalid configs", () => {
    const { dir, write } = setup();
    expect(() => loadEvalConfig(dir)).toThrow(/No eval.yaml found/);
    write("evals/eval.yml", "graders: []\n");
    expect(() => loadEvalConfig(dir)).toThrow(LoadError);
    const f = write("custom.yaml", "graders: [{ type: exact }]\n");
    expect(loadEvalConfig(dir, f).config).toMatchObject({ dataset: "dataset.yaml", concurrency: 1, pass_threshold: 1 });
    expect(() => loadEvalConfig(dir, path.join(dir, "nope.yaml"))).toThrow(/No eval.yaml/);
  });

  it("reads YAML lists, examples objects and JSONL", () => {
    const { write } = setup();
    expect(loadDataset(write("a.yaml", "- { trigger: { q: a } }\n"))).toEqual([{ trigger: { q: "a" } }]);
    expect(loadDataset(write("b.yaml", "examples:\n  - { id: b }\n"))).toEqual([{ id: "b", trigger: {} }]);
    expect(readDatasetRaw(write("c.jsonl", '{"id":"c1"}\r\n\n{"id":"c2"}\n'))).toEqual([{ id: "c1" }, { id: "c2" }]);
    expect(() => readDatasetRaw("/nonexistent/x.yaml")).toThrow(/Dataset not found/);
    expect(() => loadDataset(write("d.yaml", "examples: 3\n"))).toThrow(/Invalid dataset/);
  });

  it("picks explicit mocks, then config mocks, then the real runner", () => {
    const { dir, write } = setup();
    const mocksFile = write("m.yaml", "mocks:\n  shout: { output: FROM-FILE }\n");
    const real = evalRunnerFactory(evalConfigSchema.parse({ graders: [{ type: "exact" }] }), dir);
    expect(real()).toBeInstanceOf(RealRunner);
    expect(real()).toBe(real());
    expect(evalRunnerFactory(evalConfigSchema.parse({ graders: [{ type: "exact" }] }), dir, mocksFile)()).toBeInstanceOf(MockRunner);
    expect(evalRunnerFactory(evalConfigSchema.parse({ graders: [{ type: "exact" }], mocks_file: "m.yaml" }), dir)()).toBeInstanceOf(MockRunner);
  });

  it("summarizes empty results as zeros", () => {
    const s = summarize(evalConfigSchema.parse({ graders: [{ type: "exact" }] }), []);
    expect(s).toEqual({ total: 0, passed: 0, failed: 0, pass_rate: 0, mean_score: 0, graders: [{ name: "exact#1", type: "exact", passed: 0, failed: 0, pass_rate: 0, mean_score: 0 }] });
  });
});

describe("runEval", () => {
  it("runs real commands, grades, honours limit and reports failing examples", async () => {
    const { write, loaded } = setup();
    write("evals/eval.yaml", "pass_threshold: 0.5\ngraders:\n  - { type: exact, name: exact }\n  - { type: jsonata, expression: \"$length(output) > 0\" }\n");
    write("evals/dataset.yaml", "- { id: ok, trigger: { q: hi }, expected: HI }\n- { trigger: { q: yo }, expected: nope }\n- { id: skipped-by-limit, trigger: { q: z } }\n");
    const seen: number[] = [];
    const report = await runEval(loaded, { limit: 2, concurrency: 2, onExample: (_r, i, total) => seen.push(i * 10 + total) });
    expect(seen.sort((a, b) => a - b)).toEqual([2, 12]);
    expect(report).toMatchObject({ flow: { name: "ev", version: "0.2.0" }, total: 2, passed: 2, failed: 0 });
    expect(report.examples.map((e) => [e.id, e.output, e.score])).toEqual([["ok", "HI", 1], ["#2", "YO", 0.5]]);
    expect(report.graders.map((g) => [g.name, g.passed, g.failed])).toEqual([["exact", 1, 1], ["jsonata#2", 2, 0]]);
  });

  it("scores failed runs as 0 and uses config mocks", async () => {
    const { write, loaded } = setup();
    write("evals/eval.yaml", "dataset: data.jsonl\ngraders: [{ type: exact }]\nmocks:\n  shout: { stdout: '', stderr: boom, exit_code: 1 }\n");
    write("evals/data.jsonl", '{"id":"x","trigger":{"q":"a"},"expected":"A"}\n');
    const report = await runEval(loaded);
    const [ex] = report.examples;
    expect(ex).toMatchObject({ id: "x", status: "failed", passed: false, score: 0 });
    expect(ex!.output).toBeUndefined();
    expect(ex!.error).toMatch(/^nonzero_exit: /);
    expect(ex!.grades[0]!.message).toMatch(/^run failed: /);
    expect(formatReport(report, { verbose: true })).toMatch(/Failing examples \(1\):\n {2}x {2}status=failed {2}score=0.00 {2}nonzero_exit[\s\S]*trigger: \{"q":"a"\}\n {6}output: {2}undefined/);
  });

  it("prefers an explicit dataset file and mocks file", async () => {
    const { write, loaded } = setup();
    write("evals/eval.yaml", "graders: [{ type: exact }]\n");
    const data = write("other.yaml", "- { trigger: { q: a }, expected: { m: 1 } }\n");
    const mocks = write("m.yaml", "mocks:\n  shout: { output: { m: 1 } }\n");
    const report = await runEval(loaded, { datasetFile: data, mocksFile: mocks, cache: true });
    expect(report.examples[0]!.error).toBeUndefined();
    expect(report.passed).toBe(1);
    expect(formatReport(report)).not.toMatch(/Failing/);
  });
});
