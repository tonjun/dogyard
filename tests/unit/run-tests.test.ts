import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoadError, loadFlowFromObject } from "../../src/loader.js";
import { discoverTestFiles, formatTestResults, loadMocksFile, loadTestFile, runTestCase, runTests } from "../../src/testing/run-tests.js";
import { testCaseSchema } from "../../src/schema/test.js";

const flowObj = {
  name: "rt",
  version: "0.1.0",
  steps: {
    shout: { type: "command", command: ["shout"], input: "trigger.q", output_mode: "json" },
    route: { type: "choice", needs: ["shout"], branches: [{ when: "$length(steps.shout.output.v) > 3", next: "long" }], default: "short" },
    long: { type: "pass", input: '{ "kind": "long" }', terminal: "success" },
    short: { type: "pass", input: '{ "kind": "short" }', terminal: "success" },
  },
};

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "run-tests-"));
  const write = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
    return path.join(dir, rel);
  };
  return { dir, write, loaded: loadFlowFromObject(flowObj, dir) };
}
const tc = (o: unknown) => testCaseSchema.parse(o);

describe("test discovery and loading", () => {
  it("discovers sorted *.test.yaml/yml files and none without a tests folder", () => {
    const { dir, write } = setup();
    expect(discoverTestFiles(dir)).toEqual([]);
    write("tests/b.test.yml", "name: b\n");
    write("tests/a.test.yaml", "tests: [{ name: a }]\n");
    write("tests/notes.yaml", "x: 1\n");
    expect(discoverTestFiles(dir).map((f) => path.basename(f))).toEqual(["a.test.yaml", "b.test.yml"]);
    expect(loadTestFile(path.join(dir, "tests/b.test.yml")).map((t) => t.name)).toEqual(["b"]);
  });

  it("rejects invalid test and mocks files", () => {
    const { write } = setup();
    expect(() => loadTestFile(write("bad.test.yaml", "tests: 1\n"))).toThrow(LoadError);
    expect(() => loadMocksFile(write("bad-mocks.yaml", "nope: 1\n"))).toThrow(/Invalid mocks file/);
  });
});

describe("runTestCase", () => {
  it("passes when output, output_jsonata, path and skipped all match", async () => {
    const { loaded } = setup();
    const o = await runTestCase(loaded, tc({ name: "long", trigger: { q: "hello" }, mocks: { shout: { output: { v: "HELLO" } } }, expect: { output: { kind: "long" }, output_jsonata: "output.kind = 'long'", path: ["shout", "route", "long"], skipped: ["short"] } }));
    expect(o).toMatchObject({ file: "<inline>", passed: true, failures: [] });
    expect(o.trace?.status).toBe("succeeded");
  });

  it("reports every kind of mismatch", async () => {
    const { loaded } = setup();
    const o = await runTestCase(loaded, tc({ name: "wrong", trigger: { q: "hi" }, mocks: { shout: { output: { v: "HI" } } }, expect: { output: { kind: "long" }, output_jsonata: "output.kind = 'long'", path: ["shout"], skipped: ["short", "ghost", "long"] } }));
    expect(o.passed).toBe(false);
    expect(o.failures).toEqual([
      expect.stringMatching(/^output mismatch:/),
      "output_jsonata assertion is falsy: output.kind = 'long'",
      expect.stringMatching(/^path mismatch:\n {2}expected: shout\n {2}actual: {3}shout -> route -> short/),
      'skipped: expected "short" to be skipped, got succeeded',
      'skipped: unknown step "ghost"',
    ]);
  });

  it("checks status and error_type, including when the run unexpectedly succeeds", async () => {
    const { loaded } = setup();
    const failing = { shout: { stdout: "", stderr: "x", exit_code: 1 } };
    expect((await runTestCase(loaded, tc({ name: "f", mocks: failing, expect: { error_type: "command_failure" } }))).passed).toBe(true);
    const wrongType = await runTestCase(loaded, tc({ name: "f2", mocks: failing, expect: { error_type: "timeout" } }));
    expect(wrongType.failures).toEqual(["error_type: expected timeout, got nonzero_exit"]);
    const ok = { shout: { output: { v: "HELLO" } } };
    const none = await runTestCase(loaded, tc({ name: "f3", mocks: ok, expect: { error_type: "timeout" } }));
    expect(none.failures).toEqual(["status: expected failed, got succeeded", "error_type: expected timeout, got none"]);
    const status = await runTestCase(loaded, tc({ name: "f4", mocks: failing }));
    expect(status.failures[0]).toMatch(/^status: expected succeeded, got failed \(nonzero_exit: /);
  });

  it("turns a missing mocks file into a failure without a trace", async () => {
    const { dir, loaded } = setup();
    const o = await runTestCase(loaded, tc({ name: "m", mocks_file: "missing.yaml" }), path.join(dir, "tests/x.test.yaml"));
    expect(o.passed).toBe(false);
    expect(o.failures[0]).toMatch(/^error: /);
    expect(o.trace).toBeUndefined();
  });
});

describe("runTests", () => {
  it("runs discovered files with a case-insensitive filter, resolving mocks_file next to the test", async () => {
    const { dir, write, loaded } = setup();
    write("tests/mocks.yaml", "mocks:\n  shout: { output: { v: HELLO } }\n");
    write("tests/a.test.yaml", "tests:\n  - { name: Long Route, mocks_file: mocks.yaml, expect: { output: { kind: long } } }\n  - { name: Broken, mocks_file: mocks.yaml, expect: { output: { kind: short } } }\n  - { name: other }\n");
    const all = await runTests(loaded, { filter: "o" });
    expect(all.outcomes.map((o) => o.name)).toEqual(["Long Route", "Broken", "other"]);
    const res = await runTests(loaded, { filter: "ROUTE" });
    expect(res).toMatchObject({ passed: 1, failed: 0 });
    const text = formatTestResults(await runTests(loaded, { filter: "broken" }), dir);
    expect(text).toMatch(/^FAIL {2}Broken {2}\(tests\/a\.test\.yaml, \d+ms\)\n {6}output mismatch:\n {8}expected/);
    expect(text).toMatch(/0 passed, 1 failed, 1 total$/);
    expect(formatTestResults({ outcomes: [{ file: path.join(dir, "steps/s/tests/t.test.yaml"), name: "n", step: "s", passed: true, failures: [], durationMs: 1 }], passed: 1, failed: 0 }, dir)).toMatch(/^PASS {2}s › n {2}\(steps\/s\/tests\/t\.test\.yaml, 1ms\)/);
  });
});
