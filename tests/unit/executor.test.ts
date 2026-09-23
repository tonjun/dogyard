import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockRunner, RealRunner, type CommandRequest, type CommandResult, type CommandRunner } from "../../src/executor/command-runner.js";
import { prepareResume } from "../../src/executor/checkpoint.js";
import { runFlow } from "../../src/executor/run.js";
import { loadFlowFromObject } from "../../src/loader.js";
import { executedPath, readTrace } from "../../src/trace.js";

const research = {
  name: "research-and-summarize",
  version: "0.1.0",
  config: { default_timeout: "5s" },
  trigger_schema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
  steps: {
    fetch_sources: { type: "command", command: ["search-cli", "--json"], input: '{ "q": trigger.query, "limit": 5 }', retry: { max_attempts: 3, on: ["timeout", "nonzero_exit"] } },
    summarize_each: {
      type: "map",
      needs: ["fetch_sources"],
      over: "steps.fetch_sources.output.results",
      max_concurrency: 2,
      step: { type: "command", command: ["llm-run"], input: '{ "text": item.body, "i": index }', catch: [{ error_type: "command_failure", result: { summary: "" } }] },
    },
    score_quality: {
      type: "command",
      needs: ["fetch_sources", "summarize_each"],
      command: ["quality-scorer"],
      input: '{ "sourceCount": $count(steps.fetch_sources.output.results), "summaries": steps.summarize_each.output }',
    },
    route_on_score: {
      type: "choice",
      needs: ["score_quality"],
      branches: [
        { when: "steps.score_quality.output.score >= 0.7", next: "publish" },
        { when: "steps.score_quality.output.score < 0.7", next: "flag_for_review" },
      ],
      default: "flag_for_review",
    },
    publish: { type: "command", command: ["publish-cli"], input: "steps.summarize_each.output", terminal: "success" },
    flag_for_review: { type: "pass", input: '{ "reason": "low quality score", "score": steps.score_quality.output.score }', terminal: "success" },
  },
};

const baseMocks = {
  fetch_sources: { output: { results: [{ body: "a" }, { body: "b" }, { body: "c" }] } },
  summarize_each: [{ output: { summary: "A" } }, { stdout: "", stderr: "boom", exit_code: 1 }, { output: { summary: "C" } }],
  score_quality: { output: { score: 0.9 } },
  publish: { output: { published: true } },
};

function run(flowObj: unknown, trigger: unknown, mocks: Record<string, unknown>, extra: Partial<Parameters<typeof runFlow>[0]> = {}) {
  const loaded = loadFlowFromObject(flowObj);
  return runFlow({ loaded, trigger, runner: new MockRunner(mocks as never), persist: false, ...extra });
}

describe("runFlow: spec sample", () => {
  it("runs map, fan-in, choice and terminal; catch supplies fallbacks", async () => {
    const r = await run(research, { query: "x" }, baseMocks);
    expect(r.status).toBe("succeeded");
    expect(r.output).toEqual({ published: true });
    const t = r.trace;
    const by = Object.fromEntries(t.steps.map((s) => [s.name, s]));
    expect(by.summarize_each!.output).toEqual([{ summary: "A" }, { summary: "" }, { summary: "C" }]);
    expect(by.summarize_each!.items!.map((i) => i.status)).toEqual(["succeeded", "caught", "succeeded"]);
    expect(by.score_quality!.input).toEqual({ sourceCount: 3, summaries: [{ summary: "A" }, { summary: "" }, { summary: "C" }] });
    expect(by.route_on_score!.selected).toBe("publish");
    expect(by.flag_for_review!.status).toBe("skipped");
    expect(by.flag_for_review!.skip_reason).toMatch(/not selected/);
    expect(t.terminal_step).toBe("publish");
    expect(executedPath(t)).toEqual(["fetch_sources", "summarize_each", "score_quality", "route_on_score", "publish"]);
  });
  it("takes the other branch", async () => {
    const r = await run(research, { query: "x" }, { ...baseMocks, score_quality: { output: { score: 0.2 } } });
    expect(r.status).toBe("succeeded");
    expect(r.output).toEqual({ reason: "low quality score", score: 0.2 });
    expect(r.trace.steps.find((s) => s.name === "publish")!.status).toBe("skipped");
  });
  it("rejects a bad trigger via trigger_schema", async () => {
    const r = await run(research, { nope: 1 }, baseMocks);
    expect(r.status).toBe("failed");
    expect(r.error?.type).toBe("schema_validation");
  });
  it("retries then fails fast when a command keeps failing", async () => {
    const r = await run(research, { query: "x" }, { ...baseMocks, fetch_sources: { stdout: "", stderr: "down", exit_code: 2 } });
    expect(r.status).toBe("failed");
    expect(r.error?.type).toBe("nonzero_exit");
    const fs = r.trace.steps.find((s) => s.name === "fetch_sources")!;
    expect(fs.status).toBe("failed");
    expect(fs.attempts).toHaveLength(3);
    expect(fs.exit_code).toBe(2);
    expect(r.trace.steps.find((s) => s.name === "summarize_each")!.status).toBe("pending");
  });
});

describe("runFlow: concurrency, sinks, terminal fail, templated argv", () => {
  it("runs independent roots concurrently and returns sink outputs keyed by name", async () => {
    let active = 0;
    let peak = 0;
    const runner: CommandRunner = {
      async run(req: CommandRequest): Promise<CommandResult> {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
        return { stdout: JSON.stringify({ step: req.step, argv: req.argv, stdin: req.stdin, env: req.env }), stderr: "", exitCode: 0, durationMs: 30 };
      },
    };
    const flow = {
      name: "par",
      version: "1.0.0",
      steps: {
        a: { type: "command", command: ["x", "=trigger.query"], input: "trigger", input_mode: "args" },
        b: { type: "command", command: ["y"], input: "trigger", input_mode: "env" },
        c: { type: "transform", needs: ["a", "b"], input: '{ "aArgv": steps.a.output.argv, "bEnv": steps.b.output.env }' },
        d: { type: "pass", needs: ["a"], input: "steps.a.output.step" },
      },
    };
    const r = await runFlow({ loaded: loadFlowFromObject(flow), trigger: { query: "q", n: 2 }, runner, persist: false });
    expect(r.status).toBe("succeeded");
    expect(peak).toBe(2);
    expect(r.output).toEqual({ c: { aArgv: ["x", "q", '{"query":"q","n":2}'], bEnv: { WF_INPUT: '{"query":"q","n":2}', WF_INPUT_QUERY: "q", WF_INPUT_N: "2" } }, d: "a" });
  });
  it("honours max_concurrency", async () => {
    let active = 0;
    let peak = 0;
    const runner: CommandRunner = {
      async run(): Promise<CommandResult> {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { stdout: "1", stderr: "", exitCode: 0, durationMs: 1 };
      },
    };
    const steps = Object.fromEntries(["a", "b", "c", "d"].map((n) => [n, { type: "command", command: ["x"] }]));
    const r = await runFlow({ loaded: loadFlowFromObject({ name: "lim", version: "1.0.0", config: { max_concurrency: 2 }, steps }), trigger: {}, runner, persist: false });
    expect(r.status).toBe("succeeded");
    expect(peak).toBe(2);
  });
  it("terminal fail ends the run with terminal_failure", async () => {
    const r = await run(
      { name: "tf", version: "1.0.0", steps: { a: { type: "pass", input: '"nope"', terminal: "fail" }, b: { type: "pass", needs: ["a"] } } },
      {},
      {},
    );
    expect(r.status).toBe("failed");
    expect(r.error?.type).toBe("terminal_failure");
    expect(r.error?.message).toBe("nope");
  });
  it("catch on a step continues the flow; expression errors are catchable", async () => {
    const r = await run(
      {
        name: "c",
        version: "1.0.0",
        steps: {
          a: { type: "transform", input: "$error('bad')", catch: [{ error_type: "expression_error", result: { ok: false } }] },
          b: { type: "pass", needs: ["a"], input: "steps.a.output" },
        },
      },
      {},
      {},
    );
    expect(r.status).toBe("succeeded");
    expect(r.output).toEqual({ ok: false });
    expect(r.trace.steps[0]!.status).toBe("caught");
  });
  it("choice with no match and no default fails with expression_error", async () => {
    const r = await run({ name: "c", version: "1.0.0", steps: { c: { type: "choice", branches: [{ when: "false", next: "x" }] }, x: { type: "pass" } } }, {}, {});
    expect(r.status).toBe("failed");
    expect(r.error?.type).toBe("expression_error");
  });
  it("run_timeout aborts the run as failed/timeout", async () => {
    const flow = { name: "t", version: "1.0.0", steps: { a: { type: "command", command: [process.execPath, "-e", "setTimeout(()=>{},5000)"] } } };
    const r = await runFlow({ loaded: loadFlowFromObject(flow), trigger: {}, runner: new RealRunner(), persist: false, runTimeout: 100 });
    expect(r.status).toBe("failed");
    expect(r.error?.type).toBe("timeout");
    expect(r.trace.steps[0]!.status).toBe("interrupted");
  });
  it("map item timeout fails only that item and records its duration", async () => {
    const sleep = [process.execPath, "-e", "setTimeout(()=>{}, Number(process.argv[1]))", "=$string(item)"];
    const flow = { name: "t", version: "1.0.0", steps: { m: { type: "map", over: "[10, 5000]", step: { type: "command", command: sleep, output_mode: "text", timeout: "300ms", catch: [{ error_type: "timeout", result: "timed out" }] } } } };
    const r = await runFlow({ loaded: loadFlowFromObject(flow), trigger: {}, runner: new RealRunner(), persist: false });
    expect(r.status).toBe("succeeded");
    const items = r.trace.steps[0]!.items!;
    expect(items.map((i) => i.status)).toEqual(["succeeded", "caught"]);
    expect(items[1]!.error?.type).toBe("timeout");
    expect(items[1]!.output).toBe("timed out");
    expect(items[1]!.duration_ms).toBeGreaterThanOrEqual(300);
  });
  it("a map step's timeout bounds each item, not the whole map", async () => {
    const sleep = [process.execPath, "-e", "setTimeout(()=>{}, Number(process.argv[1]))", "=$string(item)"];
    const flow = { name: "t", version: "1.0.0", steps: { m: { type: "map", timeout: "400ms", max_concurrency: 1, over: "[200, 200, 200]", step: { type: "command", command: sleep, output_mode: "text" } } } };
    const r = await runFlow({ loaded: loadFlowFromObject(flow), trigger: {}, runner: new RealRunner(), persist: false });
    expect(r.status).toBe("succeeded");
    expect(r.trace.steps[0]!.items!.every((i) => i.status === "succeeded")).toBe(true);
  });
  it("external abort marks the run interrupted", async () => {
    const flow = { name: "t", version: "1.0.0", steps: { a: { type: "command", command: [process.execPath, "-e", "setTimeout(()=>{},5000)"] } } };
    const ac = new AbortController();
    const p = runFlow({ loaded: loadFlowFromObject(flow), trigger: {}, runner: new RealRunner(), persist: false, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const r = await p;
    expect(r.status).toBe("interrupted");
    expect(r.trace.steps[0]!.status).toBe("interrupted");
  });
});

describe("resume", () => {
  const flow = {
    name: "res",
    version: "1.0.0",
    steps: {
      a: { type: "command", command: ["a"] },
      m: { type: "map", needs: ["a"], over: "steps.a.output", max_concurrency: 1, step: { type: "command", command: ["m"] } },
      b: { type: "command", needs: ["m"], command: ["b"], input: "steps.m.output" },
    },
  };
  it("re-executes only failed steps and remaining map items, persisting the trace", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wf-res-"));
    const loaded = loadFlowFromObject(flow, dir);
    const first = await runFlow({ loaded, trigger: { query: "q" }, runner: new MockRunner({ a: { output: [1, 2, 3] }, m: [{ output: "x1" }, { stdout: "", stderr: "", exit_code: 1 }] }) });
    expect(first.status).toBe("failed");
    expect(first.traceFile).toBe(path.join(dir, ".runs", first.trace.run_id, "trace.json"));
    const saved = readTrace(first.traceFile!);
    expect(saved.status).toBe("failed");
    const m = saved.steps.find((s) => s.name === "m")!;
    expect(m.status).toBe("failed");
    expect(m.items!.map((i) => i.status)).toEqual(["succeeded", "failed", "pending"]);

    const calls: string[] = [];
    const mock = new MockRunner({ a: { output: "SHOULD NOT RUN" }, m: [{ output: "no" }, { output: "x2" }, { output: "x3" }], b: { output: "done" } });
    const spy: CommandRunner = { run: (req) => { calls.push(`${req.step}${req.itemIndex ?? ""}`); return mock.run(req); } };
    const resumed = await runFlow({ loaded, trigger: undefined, runner: spy, resume: prepareResume(saved, loaded) });
    expect(resumed.status).toBe("succeeded");
    expect(calls).toEqual(["m1", "m2", "b"]);
    expect(resumed.output).toBe("done");
    expect(resumed.trace.resume_count).toBe(1);
    expect(resumed.trace.run_id).toBe(first.trace.run_id);
    expect(resumed.trace.steps.find((s) => s.name === "m")!.output).toEqual(["x1", "x2", "x3"]);
    expect(readTrace(first.traceFile!).status).toBe("succeeded");
  });
  it("refuses a changed flow unless forced", async () => {
    const loaded = loadFlowFromObject(flow);
    const first = await runFlow({ loaded, trigger: {}, persist: false, runner: new MockRunner({ a: { stdout: "", stderr: "", exit_code: 1 } }) });
    const changed = loadFlowFromObject({ ...flow, version: "1.0.1" });
    expect(() => prepareResume(first.trace, changed)).toThrow(/hash mismatch/);
    expect(prepareResume(first.trace, changed, { force: true }).flow.hash).toBe(changed.hash);
    expect(() => prepareResume(first.trace, loadFlowFromObject({ ...flow, name: "other" }))).toThrow(/belongs to flow/);
  });
  it("resuming a succeeded run is a no-op", async () => {
    const loaded = loadFlowFromObject({ name: "ok", version: "1.0.0", steps: { a: { type: "pass", input: "1" } } });
    const first = await runFlow({ loaded, trigger: {}, persist: false });
    expect(first.status).toBe("succeeded");
    expect(prepareResume(first.trace, loaded)).toBe(first.trace);
  });
  it("writes a trace file for a fresh run using the flow dir", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wf-tr-"));
    writeFileSync(path.join(dir, "flow.yaml"), "");
    const loaded = loadFlowFromObject({ name: "ok", version: "1.0.0", steps: { a: { type: "pass", input: "1" } } }, dir);
    const r = await runFlow({ loaded, trigger: {} });
    expect(readTrace(r.traceFile!).output).toBe(1);
  });
});
