import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadFlowFromObject } from "../../src/loader.js";
import { stepTestCaseSchema } from "../../src/schema/step-test.js";
import { discoverStepTestFiles, runStepTestCase, runStepTests } from "../../src/testing/run-step-tests.js";
import { formatTestResults } from "../../src/testing/run-tests.js";

const node = process.execPath;
const flowObj = {
  name: "st",
  version: "0.1.0",
  steps: {
    fetch: { type: "command", command: ["search", "=trigger.query"], input: '{ "q": trigger.query }', retry: { max_attempts: 2, backoff: "0s" } },
    each: { type: "map", needs: ["fetch"], over: "steps.fetch.output", step: { type: "command", command: ["llm"], input: "item", catch: [{ error_type: "any", result: null }] } },
    route: { type: "choice", needs: ["fetch"], branches: [{ when: "true", next: "fin" }] },
    fin: { type: "pass" },
    echo: { type: "command", command: [node, "-e", "process.stdout.write(require('fs').readFileSync(0,'utf8'))"], input: "trigger" },
  },
};

function makeFlowDir(): { dir: string; loaded: ReturnType<typeof loadFlowFromObject> } {
  const dir = mkdtempSync(path.join(tmpdir(), "step-tests-"));
  return { dir, loaded: loadFlowFromObject(flowObj, dir) };
}

function write(dir: string, rel: string, content: string) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
}

describe("step test schema", () => {
  it("requires exactly one of mock / mocks_file / real", () => {
    expect(stepTestCaseSchema.safeParse({ name: "a" }).success).toBe(false);
    expect(stepTestCaseSchema.safeParse({ name: "a", mock: { output: 1 }, real: true }).success).toBe(false);
    expect(stepTestCaseSchema.safeParse({ name: "a", real: false }).success).toBe(false);
    expect(stepTestCaseSchema.safeParse({ name: "a", real: true }).success).toBe(true);
    expect(stepTestCaseSchema.safeParse({ name: "a", mocks_file: "x.yaml" }).success).toBe(true);
    const parsed = stepTestCaseSchema.parse({ name: "a", mock: { output: 1 } });
    expect(parsed.context).toEqual({ trigger: {}, steps: {} });
  });
});

describe("runStepTestCase assertions", () => {
  const { loaded } = makeFlowDir();
  const tc = (extra: Record<string, unknown>) => stepTestCaseSchema.parse({ name: "t", context: { trigger: { query: "cats" } }, ...extra });

  it("passes when every expectation holds", async () => {
    const o = await runStepTestCase(loaded, "fetch", tc({ mock: { output: [1, 2] }, expect: { output: [1, 2], input: { q: "cats" }, argv: ["search", "cats"], output_jsonata: "$count(output) = 2 and argv[1] = context.trigger.query and step.status = 'succeeded'", attempts: 1 } }));
    expect(o.failures).toEqual([]);
    expect(o.step).toBe("fetch");
  });

  it("reports each failing expectation", async () => {
    const o = await runStepTestCase(loaded, "fetch", tc({ mock: { output: [1] }, expect: { output: [2], input: { q: "dogs" }, argv: ["x"], output_jsonata: "false", attempts: 2, status: "caught" } }));
    expect(o.passed).toBe(false);
    expect(o.failures.map((f) => f.split(/[:\n]/)[0])).toEqual(["status", "output mismatch", "input mismatch", "argv mismatch", "output_jsonata assertion is falsy", "attempts"]);
  });

  it("defaults the expected status to failed when error_type is set", async () => {
    const o = await runStepTestCase(loaded, "fetch", tc({ mock: { stdout: "", exit_code: 1 }, expect: { error_type: "command_failure", attempts: 2 } }));
    expect(o.failures).toEqual([]);
    const wrong = await runStepTestCase(loaded, "fetch", tc({ mock: { stdout: "", exit_code: 1 }, expect: { error_type: "timeout" } }));
    expect(wrong.failures[0]).toMatch(/error_type: expected timeout, got nonzero_exit/);
  });

  it("supports caught map sub-steps and real execution", async () => {
    const caught = await runStepTestCase(loaded, "each", stepTestCaseSchema.parse({ name: "c", context: { item: "x" }, mock: { stdout: "", exit_code: 1 }, expect: { status: "caught", output: null, error_type: "nonzero_exit" } }));
    expect(caught.failures).toEqual([]);
    const real = await runStepTestCase(loaded, "echo", tc({ real: true, expect: { output: { query: "cats" } } }));
    expect(real.failures).toEqual([]);
  });

  it("fails cleanly for unsupported steps", async () => {
    const o = await runStepTestCase(loaded, "route", tc({ real: true }));
    expect(o.failures[0]).toMatch(/choice/);
    const m = await runStepTestCase(loaded, "each", tc({ real: true }));
    expect(m.failures[0]).toMatch(/item/);
  });
});

describe("runStepTests discovery", () => {
  it("discovers steps/<step>/tests/*.test.yaml, resolves mocks_file relative to the test file, and reports bad folders", async () => {
    const { dir, loaded } = makeFlowDir();
    write(dir, "mocks/base.yaml", "mocks:\n  fetch: { output: [9] }\n");
    write(dir, "steps/fetch/tests/a.test.yaml", "tests:\n  - name: from file\n    context: { trigger: { query: q } }\n    mocks_file: ../../../mocks/base.yaml\n    expect: { output: [9] }\n  - name: filtered out\n    real: true\n");
    write(dir, "steps/fetch/tests/notatest.yaml", "nope");
    write(dir, "steps/bogus/tests/b.test.yaml", "name: unknown step\nreal: true\n");
    write(dir, "steps/fin/tests/c.test.yaml", "name: pass step\nreal: true\n");
    write(dir, "steps/echo/tests/d.test.yaml", "name: broken file\ncontext: {}\n");
    expect(discoverStepTestFiles(dir).map((x) => [x.step, path.basename(x.file)])).toEqual([["bogus", "b.test.yaml"], ["echo", "d.test.yaml"], ["fetch", "a.test.yaml"], ["fin", "c.test.yaml"]]);
    expect(discoverStepTestFiles(dir, "fetch")).toHaveLength(1);

    const res = await runStepTests(loaded, { filter: "from file" });
    expect(res.outcomes.map((o) => [o.step, o.passed])).toEqual([["echo", false], ["fetch", true]]);
    expect(res.outcomes[0]!.failures[0]).toMatch(/Invalid step test file/);

    const all = await runStepTests(loaded);
    const by = Object.fromEntries(all.outcomes.map((o) => [`${o.step}:${o.name}`, o]));
    expect(by["bogus:unknown step"]!.failures[0]).toMatch(/Unknown step "bogus"/);
    expect(by["fin:pass step"]!.passed).toBe(true);
    expect(all.failed).toBe(3);
    expect(formatTestResults(all, dir)).toMatch(/PASS {2}fetch › from file {2}\(steps\/fetch\/tests\/a.test.yaml/);

    const only = await runStepTests(loaded, { step: "fetch" });
    expect(only.outcomes.every((o) => o.step === "fetch")).toBe(true);
  });
});
