import { describe, expect, it } from "vitest";
import { MockRunner } from "../../src/executor/command-runner.js";
import { runStep } from "../../src/executor/run-step.js";
import { loadFlowFromObject } from "../../src/loader.js";

const node = process.execPath;

const flow = {
  name: "steps",
  version: "0.1.0",
  config: { default_timeout: "5s", default_retry: { max_attempts: 2, backoff: "0s" } },
  steps: {
    fetch: { type: "command", command: ["search-cli", "--json", "=trigger.query"], input: '{ "q": trigger.query, "limit": trigger.limit ? trigger.limit : 3 }', retry: { max_attempts: 3, backoff: "0s", on: ["nonzero_exit"] } },
    each: { type: "map", needs: ["fetch"], over: "steps.fetch.output.results", step: { type: "command", command: ["llm"], input: '{ "text": item.body, "i": index }', catch: [{ error_type: "command_failure", result: { summary: "" } }] } },
    score: { type: "command", needs: ["fetch", "each"], command: ["scorer"], input: '{ "n": $count(steps.fetch.output.results), "s": steps.each.output }' },
    route: { type: "choice", needs: ["score"], branches: [{ when: "steps.score.output.score > 0.5", next: "done" }], default: "done" },
    done: { type: "pass", input: '{ "score": steps.score.output.score }' },
    real: { type: "command", command: [node, "-e", "process.stdout.write(JSON.stringify({ got: JSON.parse(require('fs').readFileSync(0,'utf8')) }))"], input: "trigger" },
    boom: { type: "command", command: [node, "-e", "console.error('bad'); process.exit(3)"] },
  },
};
const loaded = loadFlowFromObject(flow);

describe("runStep", () => {
  it("resolves input and argv against the supplied context and parses the mock output", async () => {
    const r = await runStep({ loaded, stepName: "fetch", context: { trigger: { query: "cats" }, steps: {} }, runner: new MockRunner({ fetch: { output: { results: [1] } } }) });
    expect(r.status).toBe("succeeded");
    expect(r.input).toEqual({ q: "cats", limit: 3 });
    expect(r.argv).toEqual(["search-cli", "--json", "cats"]);
    expect(r.output).toEqual({ results: [1] });
    expect(r.attempts).toHaveLength(1);
    expect(r.exit_code).toBe(0);
  });

  it("applies the step retry policy and reports the final error", async () => {
    const r = await runStep({ loaded, stepName: "fetch", context: { trigger: { query: "x" }, steps: {} }, runner: new MockRunner({ fetch: { stdout: "", stderr: "503", exit_code: 1 } }) });
    expect(r.status).toBe("failed");
    expect(r.error?.type).toBe("nonzero_exit");
    expect(r.attempts).toHaveLength(3);
    expect(r.exit_code).toBe(1);
    expect(r.stderr).toBe("503");
  });

  it("falls back to the flow default retry policy", async () => {
    const r = await runStep({ loaded, stepName: "score", context: { trigger: {}, steps: { fetch: { results: [] }, each: [] } }, runner: new MockRunner({ score: { stdout: "", exit_code: 2 } }) });
    expect(r.status).toBe("failed");
    expect(r.attempts).toHaveLength(2);
  });

  it("exposes upstream outputs as steps.<name>.output", async () => {
    const r = await runStep({ loaded, stepName: "score", context: { trigger: {}, steps: { fetch: { results: [1, 2] }, each: ["a", "b"] } }, runner: new MockRunner({ score: { output: { score: 1 } } }) });
    expect(r.input).toEqual({ n: 2, s: ["a", "b"] });
  });

  it("runs a map sub-step for one item and indexes array mocks by context.index", async () => {
    const mocks = { each: [{ output: { summary: "A" } }, { output: { summary: "B" } }] };
    const r = await runStep({ loaded, stepName: "each", context: { trigger: {}, steps: {}, item: { body: "b" }, index: 1 }, runner: new MockRunner(mocks) });
    expect(r.input).toEqual({ text: "b", i: 1 });
    expect(r.output).toEqual({ summary: "B" });
  });

  it("applies catch clauses of a map sub-step", async () => {
    const r = await runStep({ loaded, stepName: "each", context: { trigger: {}, steps: {}, item: { body: "b" } }, runner: new MockRunner({ each: { stdout: "", stderr: "refused", exit_code: 2 } }) });
    expect(r.status).toBe("caught");
    expect(r.output).toEqual({ summary: "" });
    expect(r.error?.type).toBe("nonzero_exit");
    expect(r.attempts).toHaveLength(2);
  });

  it("requires item for a map step and rejects choice / unknown steps", async () => {
    await expect(runStep({ loaded, stepName: "each", context: { trigger: {}, steps: {} } })).rejects.toThrow(/provide `item`/);
    await expect(runStep({ loaded, stepName: "route", context: { trigger: {}, steps: {} } })).rejects.toThrow(/choice/);
    await expect(runStep({ loaded, stepName: "nope", context: { trigger: {}, steps: {} } })).rejects.toThrow(/Unknown step/);
  });

  it("runs transform/pass steps without a runner", async () => {
    const r = await runStep({ loaded, stepName: "done", context: { trigger: {}, steps: { score: { score: 0.9 } } } });
    expect(r.type).toBe("pass");
    expect(r.output).toEqual({ score: 0.9 });
  });

  it("runs real commands with the flow dir as cwd", async () => {
    const ok = await runStep({ loaded, stepName: "real", context: { trigger: { a: 1 }, steps: {} } });
    expect(ok.status).toBe("succeeded");
    expect(ok.output).toEqual({ got: { a: 1 } });
    const bad = await runStep({ loaded, stepName: "boom", context: { trigger: {}, steps: {} } });
    expect(bad.status).toBe("failed");
    expect(bad.error?.type).toBe("nonzero_exit");
    expect(bad.exit_code).toBe(3);
    expect(bad.stderr).toBe("bad\n");
  });
});
