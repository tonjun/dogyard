import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectInlineMocks } from "../../src/executor/inline-mocks.js";
import { computeFlowHash, loadFlowFromObject } from "../../src/loader.js";
import { validateFlow, validateRawFlow } from "../../src/validate.js";
import { runTestCase } from "../../src/testing/run-tests.js";
import { testCaseSchema } from "../../src/schema/test.js";
import { MockRunner, RealRunner } from "../../src/executor/command-runner.js";
import { evalConfigSchema } from "../../src/schema/eval.js";
import { evalRunnerFactory } from "../../src/eval/run-eval.js";

const flowObj = (steps: Record<string, unknown>) => ({ name: "inline", version: "0.1.0", steps });

const tmp = () => mkdtempSync(path.join(tmpdir(), "wf-inline-"));

const twoStep = {
  a: { type: "command", command: ["a-cli"], mock: { output: { n: 1 } } },
  b: { type: "command", needs: ["a"], command: ["b-cli"], input: "steps.a.output", terminal: "success", mock: { stdout: "plain" } },
};

describe("inline mock: schema", () => {
  it("is accepted on command steps and map sub-steps", () => {
    const r = validateRawFlow(
      flowObj({
        a: { type: "command", command: ["x"], mock: { output: 1 } },
        m: { type: "map", needs: ["a"], over: "[1,2]", step: { type: "command", command: ["y"], mock: [{ output: 1 }, { output: 2 }] } },
        f: { type: "command", command: ["z"], mock: "mock.yaml" },
      }),
    );
    expect(r.errors).toEqual([]);
  });

  it.each(["pass", "transform"])("is rejected on %s steps", (type) => {
    const r = validateRawFlow(flowObj({ a: { type, mock: { output: 1 } } }));
    expect(r.ok).toBe(false);
  });

  it("rejects a malformed mock", () => {
    expect(validateRawFlow(flowObj({ a: { type: "command", command: ["x"], mock: { output: 1, stdout: "x" } } })).ok).toBe(false);
  });
});

describe("inline mock: validate", () => {
  it("errors on a per-item list for a non-map command step", () => {
    const r = validateRawFlow(flowObj({ a: { type: "command", command: ["x"], mock: [{ output: 1 }] } }));
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/list of per-item results/);
  });

  it("warns on a failing mock with no catch or retry", () => {
    const r = validateRawFlow(flowObj({ a: { type: "command", command: ["x"], mock: { exit_code: 2 } } }));
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.message).join("\n")).toMatch(/nonzero exit_code/);
    const ok = validateRawFlow(flowObj({ a: { type: "command", command: ["x"], mock: { exit_code: 2 }, catch: [{ error_type: "any", result: {} }] } }));
    expect(ok.warnings).toEqual([]);
  });

  it("checks that a mock file exists and parses when given the flow dir", () => {
    const dir = tmp();
    const loaded = loadFlowFromObject(flowObj({ a: { type: "command", command: ["x"], mock: "nope.yaml" } }), dir);
    const missing = validateFlow(loaded.flow, { dir });
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]!.message).toMatch(/mock file: .*nope\.yaml/);
    writeFileSync(path.join(dir, "nope.yaml"), "bogus: 1\n");
    expect(validateFlow(loaded.flow, { dir }).ok).toBe(false);
    writeFileSync(path.join(dir, "nope.yaml"), "output: 1\n");
    expect(validateFlow(loaded.flow, { dir }).ok).toBe(true);
    // Without a dir the file cannot be resolved, so it is not checked.
    expect(validateFlow(loaded.flow).ok).toBe(true);
  });
});

describe("collectInlineMocks", () => {
  it("collects inline mocks keyed by step name, with map sub-step mocks under the map's name", () => {
    const loaded = loadFlowFromObject(
      flowObj({
        a: { type: "command", command: ["x"], mock: { output: 1 } },
        none: { type: "command", command: ["x"] },
        m: { type: "map", needs: ["a"], over: "[1,2]", step: { type: "command", command: ["y"], mock: [{ output: 1 }, { output: 2 }] } },
      }),
    );
    expect(collectInlineMocks(loaded)).toEqual({ a: { output: 1 }, m: [{ output: 1 }, { output: 2 }] });
  });

  it("resolves file mocks from the step folder when it exists, else the flow folder", () => {
    const dir = tmp();
    mkdirSync(path.join(dir, "steps/a"), { recursive: true });
    writeFileSync(path.join(dir, "steps/a/mock.yaml"), "output: from-step-folder\n");
    writeFileSync(path.join(dir, "shared.yaml"), "output: from-flow-folder\n");
    writeFileSync(path.join(dir, "items.yaml"), "- output: 1\n- output: 2\n");
    const loaded = loadFlowFromObject(
      flowObj({
        a: { type: "command", command: ["x"], mock: "mock.yaml" },
        b: { type: "command", command: ["x"], mock: "shared.yaml" },
        c: { type: "command", command: ["x"], mock: "mock.yaml", cwd: "steps/a" },
        m: { type: "map", needs: ["a"], over: "[1,2]", step: { type: "command", command: ["y"], mock: "items.yaml" } },
      }),
      dir,
    );
    expect(collectInlineMocks(loaded)).toEqual({
      a: { output: "from-step-folder" },
      b: { output: "from-flow-folder" },
      c: { output: "from-step-folder" },
      m: [{ output: 1 }, { output: 2 }],
    });
  });

  it("names the file when it is missing or invalid", () => {
    const dir = tmp();
    const loaded = loadFlowFromObject(flowObj({ a: { type: "command", command: ["x"], mock: "gone.yaml" } }), dir);
    expect(() => collectInlineMocks(loaded)).toThrow(/gone\.yaml/);
  });
});

describe("inline mock: test runs", () => {
  const tc = (over: object = {}) => testCaseSchema.parse({ name: "t", expect: { output: "plain" }, ...over });

  it("runs a test with no mocks of its own", async () => {
    const out = await runTestCase(loadFlowFromObject(flowObj(twoStep)), tc());
    expect(out.failures).toEqual([]);
    expect(out.passed).toBe(true);
  });

  it("lets a test's own mocks override an inline mock", async () => {
    const out = await runTestCase(loadFlowFromObject(flowObj(twoStep)), tc({ mocks: { b: { output: "overridden" } }, expect: { output: "overridden" } }));
    expect(out.failures).toEqual([]);
  });

  it("still fails hard when a command step has no mock anywhere", async () => {
    const steps = { ...twoStep, b: { ...twoStep.b, mock: undefined } };
    const out = await runTestCase(loadFlowFromObject(flowObj(steps)), tc());
    expect(out.passed).toBe(false);
    expect(out.failures.join("\n")).toMatch(/No mock defined for step "b"/);
  });

  it("reports a bad mock file as a test failure", async () => {
    const dir = tmp();
    const steps = { a: { type: "command", command: ["x"], terminal: "success", mock: "gone.yaml" } };
    const out = await runTestCase(loadFlowFromObject(flowObj(steps), dir), tc());
    expect(out.passed).toBe(false);
    expect(out.failures.join("\n")).toMatch(/gone\.yaml/);
  });
});

describe("inline mock: resume hash", () => {
  it("ignores mocks, including on map sub-steps, but not other edits", () => {
    const base = flowObj({
      a: { type: "command", command: ["x"], mock: { output: 1 } },
      m: { type: "map", needs: ["a"], over: "[1]", step: { type: "command", command: ["y"], mock: { output: 1 } } },
    });
    const edited = flowObj({
      a: { type: "command", command: ["x"], mock: "other.yaml" },
      m: { type: "map", needs: ["a"], over: "[1]", step: { type: "command", command: ["y"] } },
    });
    const changed = flowObj({
      a: { type: "command", command: ["x2"], mock: { output: 1 } },
      m: { type: "map", needs: ["a"], over: "[1]", step: { type: "command", command: ["y"], mock: { output: 1 } } },
    });
    expect(computeFlowHash(edited)).toBe(computeFlowHash(base));
    expect(computeFlowHash(changed)).not.toBe(computeFlowHash(base));
  });
});

describe("inline mock: eval", () => {
  const config = (extra: object = {}) => evalConfigSchema.parse({ dataset: "dataset.yaml", graders: [{ type: "exact" }], ...extra });
  const req = (step: string) => ({ argv: ["x"], step });

  it("fills gaps under explicit eval mocks", async () => {
    const runner = evalRunnerFactory(config({ mocks: { a: { output: "explicit" } } }), tmp(), undefined, () => ({ a: { output: "inline" }, b: { output: "inline-b" } }))();
    expect(runner).toBeInstanceOf(MockRunner);
    expect((await runner.run(req("a"))).stdout).toBe("explicit");
    expect((await runner.run(req("b"))).stdout).toBe("inline-b");
  });

  it("does not switch to mocking on its own, and does not read inline mocks then", () => {
    const inline = () => {
      throw new Error("should not be read");
    };
    expect(evalRunnerFactory(config(), tmp(), undefined, inline)()).toBeInstanceOf(RealRunner);
  });
});
