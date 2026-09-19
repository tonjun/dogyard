import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const CLI = path.join(ROOT, "src/cli/index.ts");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const EXAMPLES = path.join(ROOT, "examples");

interface Exec { code: number | null; stdout: string; stderr: string; }

function cli(args: string[], opts: { cwd?: string; signalAfterMs?: number; timeout?: number } = {}): Promise<Exec> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [CLI, ...args], { cwd: opts.cwd ?? ROOT, env: { ...process.env, FORCE_COLOR: "0" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (opts.signalAfterMs) setTimeout(() => child.kill("SIGINT"), opts.signalAfterMs);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const json = (s: string) => JSON.parse(s);

/** Copy examples into a temp dir so traces/reports don't pollute the repo. */
let work: string;
let hello: string;
let research: string;
let flaky: string;
beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "wf-e2e-"));
  // skip .runs so stale traces from local runs of the examples do not leak into the copy
  cpSync(EXAMPLES, path.join(work, "examples"), { recursive: true, filter: (src) => path.basename(src) !== ".runs" });
  hello = path.join(work, "examples/flows/hello");
  research = path.join(work, "examples/flows/research");
  flaky = path.join(work, "examples/flows/flaky");
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("validate / list / describe / graph", () => {
  it("validates the examples", async () => {
    for (const f of [hello, research, flaky]) {
      const r = await cli(["validate", f]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/^OK:/m);
    }
  });
  it("rejects a broken flow with diagnostics and nonzero exit", async () => {
    const dir = mkdtempSync(path.join(work, "bad-"));
    writeFileSync(path.join(dir, "flow.yaml"), "name: bad\nversion: 1.0.0\nsteps:\n  a: { type: pass, needs: [b] }\n  b: { type: pass, needs: [a] }\n  c: { type: command, command: [x], needs: [nope] }\n");
    const r = await cli(["validate", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cycle/);
    expect(r.stderr).toMatch(/unknown step "nope"/);
    const j = await cli(["validate", dir, "--json"]);
    expect(json(j.stdout).ok).toBe(false);
  });
  it("lists flows and describes one", async () => {
    const r = await cli(["list", path.join(work, "examples"), "--json"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout).map((x: { name: string }) => x.name).sort()).toEqual(["filter", "flaky", "hello", "research-and-summarize"]);
    const d = await cli(["describe", research, "--json"]);
    expect(json(d.stdout).steps).toHaveLength(6);
  });
  it("exports graphs in three formats", async () => {
    const j = json((await cli(["graph", research, "--format", "json"])).stdout);
    expect(j.edges.filter((e: { kind: string }) => e.kind === "choice")).toHaveLength(3);
    expect((await cli(["graph", research, "--format", "dot"])).stdout).toMatch(/digraph/);
    expect((await cli(["graph", research, "--format", "mermaid"])).stdout).toMatch(/flowchart LR/);
    expect((await cli(["graph", research, "--format", "svg"])).code).toBe(1);
  });
});

describe("run", () => {
  it("runs the hello flow for real and writes a trace", async () => {
    // hello's steps declare `mock:` (HELLO / 5); `run` must ignore them and execute the commands.
    const r = await cli(["run", hello, "--query", "hello world"]);
    expect(r.code, r.stderr).toBe(0);
    expect(json(r.stdout)).toEqual({ kind: "long", value: "HELLO WORLD", length: 11 });
    const runs = readdirSync(path.join(hello, ".runs"));
    expect(runs).toHaveLength(1);
    const trace = json(readFileSync(path.join(hello, ".runs", runs[0]!, "trace.json"), "utf8"));
    expect(trace.status).toBe("succeeded");
    expect(trace.terminal_step).toBe("long");
    expect(trace.steps.find((s: { name: string }) => s.name === "short").status).toBe("skipped");
  });
  it("supports --input, --input-file, --trace and --no-trace-file", async () => {
    const f = path.join(work, "trigger.json");
    writeFileSync(f, JSON.stringify({ query: "hi" }));
    const before = existsSync(path.join(hello, ".runs")) ? readdirSync(path.join(hello, ".runs")).length : 0;
    const r = await cli(["run", hello, "--input-file", f, "--trace", "--no-trace-file", "-q"]);
    expect(r.code, r.stderr).toBe(0);
    const t = json(r.stdout);
    expect(t.output).toEqual({ kind: "short", value: "HI", length: 2 });
    expect(readdirSync(path.join(hello, ".runs")).length).toBe(before);
    const r2 = await cli(["run", hello, "--input", '{"query":"abc"}', "-q", "--no-trace-file"]);
    expect(json(r2.stdout).length).toBe(3);
  });
  it("fails on a bad trigger and with missing trigger flags", async () => {
    const r = await cli(["run", hello, "--input", '{"nope":1}', "-q", "--no-trace-file"]);
    expect(r.code).toBe(1);
    expect(json(r.stdout).error.type).toBe("schema_validation");
    const r2 = await cli(["run", hello, "-q", "--no-trace-file"]);
    expect(r2.code).toBe(1);
    expect(json(r2.stdout).error.type).toBe("schema_validation");
  });
  it("runs with no trigger when the flow does not require one", async () => {
    const dir = path.join(work, "no-trigger");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "data.json"), '{"rows":2}');
    writeFileSync(
      path.join(dir, "flow.yaml"),
      'name: no-trigger\nversion: 0.1.0\nsteps:\n  load:\n    type: command\n    command: ["cat", "data.json"]\n',
    );
    const r = await cli(["run", dir, "-q", "--no-trace-file"]);
    expect(r.code, r.stderr).toBe(0);
    expect(json(r.stdout)).toEqual({ rows: 2 });
  });
  it("runs the research flow: parallel map, fan-in, choice, terminal", async () => {
    const r = await cli(["run", research, "--input", '{"query":"cats","limit":3}', "--trace", "-q"]);
    expect(r.code, r.stderr).toBe(0);
    const t = json(r.stdout);
    expect(t.output).toEqual({ published: 3 });
    const by = Object.fromEntries(t.steps.map((s: { name: string }) => [s.name, s]));
    expect(by.summarize_each.items.map((i: { status: string }) => i.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(by.route_on_score.selected).toBe("publish");
    expect(by.flag_for_review.status).toBe("skipped");
  });
  it("records mocks and replays them", async () => {
    const mocks = path.join(work, "recorded.yaml");
    const r = await cli(["run", research, "--input", '{"query":"fail","limit":2}', "--record", mocks, "-q", "--no-trace-file"]);
    expect(r.code, r.stderr).toBe(0);
    expect(json(r.stdout)).toEqual({ reason: "low quality score", score: 0 });
    expect(readFileSync(mocks, "utf8")).toMatch(/summarize_each:/);
    const r2 = await cli(["run", research, "--input", '{"query":"fail","limit":2}', "--mocks", mocks, "-q", "--no-trace-file", "--trace"]);
    expect(r2.code, r2.stderr).toBe(0);
    const t = json(r2.stdout);
    expect(t.steps.find((s: { name: string }) => s.name === "summarize_each").items.map((i: { status: string }) => i.status)).toEqual(["caught", "caught"]);
  });
});

describe("test / eval", () => {
  it("runs fixture tests and step tests for the example flows", async () => {
    const h = await cli(["test", hello]);
    expect(h.code, h.stdout).toBe(0);
    expect(h.stdout).toMatch(/8 passed, 0 failed/);
    expect(h.stdout).toMatch(/PASS {2}shout › the real command uppercases the text/);
    const r = await cli(["test", research, "--json"]);
    expect(r.code, r.stdout).toBe(0);
    const outcomes = json(r.stdout) as Array<{ passed: boolean; step?: string }>;
    expect(outcomes.every((o) => o.passed)).toBe(true);
    expect(new Set(outcomes.map((o) => o.step ?? "<flow>"))).toEqual(new Set(["<flow>", "fetch_sources", "summarize_each", "score_quality", "publish"]));
    const f = await cli(["test", flaky]);
    expect(f.code, f.stdout).toBe(0);
    expect(f.stdout).toMatch(/6 passed, 0 failed/);
  });
  it("filters step tests with --step and skips them with --no-steps", async () => {
    const only = await cli(["test", hello, "--step", "count", "--json"]);
    expect(only.code, only.stdout).toBe(0);
    expect(json(only.stdout).map((o: { step: string }) => o.step)).toEqual(["count", "count"]);
    const none = await cli(["test", hello, "--no-steps"]);
    expect(none.code).toBe(0);
    expect(none.stdout).toMatch(/4 passed, 0 failed/);
    const missing = await cli(["test", hello, "--step", "nope"]);
    expect(missing.code).toBe(0);
    expect(missing.stderr).toMatch(/No tests found in .*steps\/nope\/tests/);
    expect((await cli(["test", hello, "--step", "count", "--no-steps"])).code).toBe(1);
  });
  it("reports a step folder that does not match a step", async () => {
    const dir = path.join(work, "hello-badstep");
    cpSync(hello, dir, { recursive: true });
    writeFileSync(path.join(dir, "steps/count/tests/fail.test.yaml"), "name: wrong argv\ncontext: { trigger: { query: hi } }\nmock: { output: 2 }\nexpect:\n  argv: [node]\n  attempts: 2\n");
    mkdirSync(path.join(dir, "steps/route/tests"), { recursive: true });
    writeFileSync(path.join(dir, "steps/route/tests/a.test.yaml"), "name: choice\nreal: true\n");
    const r = await cli(["test", dir, "--step", "route"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL {2}route › choice/);
    expect(r.stdout).toMatch(/choice step/);
    const c = await cli(["test", dir, "--step", "count", "-k", "wrong"]);
    expect(c.code).toBe(1);
    expect(c.stdout).toMatch(/argv mismatch/);
    expect(c.stdout).toMatch(/attempts: expected 2, got 1/);
  });
  it("evaluates a single step with --step and writes the report under the step folder", async () => {
    const r = await cli(["eval", research, "--step", "fetch_sources", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const j = json(r.stdout);
    expect(j.step).toBe("fetch_sources");
    expect(j.pass_rate).toBe(1);
    expect(j.examples[0].result.argv).toEqual(["node", "../../../../bin/search-cli.cjs", "--json"]);
    expect(r.stderr).toMatch(/Report: .*steps\/fetch_sources\/evals\/reports\//);
    expect(readdirSync(path.join(research, "steps/fetch_sources/evals/reports"))).toHaveLength(1);
    const m = await cli(["eval", flaky, "--step", "wait_for_marker", "--no-report"]);
    expect(m.code, m.stdout).toBe(0);
    expect(m.stdout).toMatch(/Eval: flaky@0.1.0 step wait_for_marker/);
    expect((await cli(["eval", hello, "--step", "route", "--no-report"])).code).toBe(1);
  });
  it("fails a test with a readable diff", async () => {
    const dir = path.join(work, "hello-bad");
    cpSync(hello, dir, { recursive: true });
    writeFileSync(
      path.join(dir, "tests/bad.test.yaml"),
      "name: wrong path\ntrigger: { query: hello }\nmocks:\n  shout: { output: { shouted: HELLO } }\n  count: { output: 5 }\nexpect:\n  path: [shout, count, route, short]\n  output: { kind: short }\n",
    );
    const r = await cli(["test", dir, "-k", "wrong"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL {2}wrong path/);
    expect(r.stdout).toMatch(/path mismatch/);
    expect(r.stdout).toMatch(/output mismatch/);
  });
  it("evaluates a dataset and writes a report with failing traces", async () => {
    const dir = path.join(work, "hello-eval");
    cpSync(hello, dir, { recursive: true });
    writeFileSync(path.join(dir, "evals/dataset.yaml"), "examples:\n  - { id: ok, trigger: { query: hello }, expected: { kind: long, value: HELLO, length: 5 } }\n  - { id: wrong, trigger: { query: hi }, expected: { kind: long, value: HI, length: 2 } }\n");
    const report = path.join(work, "report.json");
    const r = await cli(["eval", dir, "--report", report]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/pass rate: 50.0%/);
    expect(r.stdout).toMatch(/exact-output\s+1\s+1/);
    expect(r.stdout).toMatch(/wrong/);
    const j = json(readFileSync(report, "utf8"));
    expect(j.total).toBe(2);
    expect(j.examples.find((e: { id: string }) => e.id === "wrong").trace.steps.length).toBe(5);
    const ok = await cli(["eval", research, "--no-report", "--json"]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(json(ok.stdout).pass_rate).toBe(1);
  });
  it("scaffolds a new flow that validates, tests and runs", async () => {
    const r = await cli(["new", "my-flow", "--dir", work]);
    expect(r.code, r.stderr).toBe(0);
    const dir = path.join(work, "my-flow");
    expect((await cli(["validate", dir])).code).toBe(0);
    const t = await cli(["test", dir]);
    expect(t.code, t.stdout).toBe(0);
    expect(t.stdout).toMatch(/4 passed, 0 failed/);
    expect(existsSync(path.join(dir, "steps/shout/evals/dataset.yaml"))).toBe(true);
    const e = await cli(["eval", dir, "--step", "shout", "--no-report"]);
    expect(e.code, e.stdout).toBe(0);
    const run = await cli(["run", dir, "--query", "hello", "-q", "--no-trace-file"]);
    expect(json(run.stdout)).toEqual({ kind: "long", value: "HELLO" });
    expect((await cli(["new", "my-flow", "--dir", work])).code).toBe(1);
  });
  it("scaffolds a step folder for an existing command step with new-step", async () => {
    const dir = path.join(work, "research-newstep");
    cpSync(research, dir, { recursive: true });
    rmSync(path.join(dir, "steps"), { recursive: true, force: true });
    const r = await cli(["new-step", dir, "summarize_each"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/steps\/summarize_each\/tests\/basic.test.yaml/);
    const yaml = readFileSync(path.join(dir, "steps/summarize_each/tests/basic.test.yaml"), "utf8");
    expect(yaml).toMatch(/fetch_sources: null/);
    expect(yaml).toMatch(/item: null/);
    expect((await cli(["new-step", dir, "summarize_each"])).code).toBe(1);
    expect((await cli(["new-step", dir, "summarize_each", "--force"])).code).toBe(0);
    const bad = await cli(["new-step", dir, "route_on_score"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/choice step/);
    expect((await cli(["new-step", dir, "missing"])).code).toBe(1);
  });
});

describe("runs show", () => {
  it("defaults to the latest run, also as `latest`, and still accepts a run id", async () => {
    const dir = path.join(work, "examples/flows/hello-latest");
    cpSync(hello, dir, { recursive: true });
    rmSync(path.join(dir, ".runs"), { recursive: true, force: true });

    const none = await cli(["runs", "show", dir]);
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/No runs found/);

    const first = json((await cli(["run", dir, "--query", "first", "--trace", "-q"])).stdout);
    const second = json((await cli(["run", dir, "--query", "second", "--trace", "-q"])).stdout);
    expect(second.run_id).not.toBe(first.run_id);

    const latest = await cli(["runs", "show", dir]);
    expect(latest.code, latest.stderr).toBe(0);
    expect(json(latest.stdout).run_id).toBe(second.run_id);
    expect(json((await cli(["runs", "show", dir, "latest"])).stdout).run_id).toBe(second.run_id);
    expect(json((await cli(["runs", "show", dir, first.run_id])).stdout).run_id).toBe(first.run_id);
  });
});

describe("resume", () => {
  it("resumes a failed run after the cause is fixed, re-running only what failed", async () => {
    const marker = path.join(work, "marker1");
    const r = await cli(["run", flaky, "--input", JSON.stringify({ marker }), "-q"]);
    expect(r.code).toBe(1);
    const runId = json(r.stdout).run_id as string;
    const list = await cli(["runs", flaky, "--json"]);
    expect(json(list.stdout).find((x: { run_id: string }) => x.run_id === runId).status).toBe("failed");
    writeFileSync(marker, "");
    const res = await cli(["resume", flaky, runId, "--trace", "-q"]);
    expect(res.code, res.stderr).toBe(0);
    const t = json(res.stdout);
    expect(t.status).toBe("succeeded");
    expect(t.resume_count).toBe(1);
    expect(t.output).toEqual({ count: 4, marker });
    const by = Object.fromEntries(t.steps.map((s: { name: string }) => [s.name, s]));
    expect(by.prepare.attempts).toHaveLength(1);
    expect(by.slow_map.attempts).toHaveLength(1);
    expect(by.wait_for_marker.attempts).toHaveLength(2);
    const again = await cli(["resume", flaky, runId, "-q"]);
    expect(again.code).toBe(0);
    expect(again.stderr).toMatch(/already succeeded/);
    const show = await cli(["runs", "show", flaky, runId]);
    expect(json(show.stdout).run_id).toBe(runId);
  });
  it("refuses to resume when the flow changed unless --force", async () => {
    const dir = path.join(work, "examples/flows/flaky-copy");
    cpSync(flaky, dir, { recursive: true });
    rmSync(path.join(dir, ".runs"), { recursive: true, force: true });
    const marker = path.join(work, "marker2");
    const r = await cli(["run", dir, "--input", JSON.stringify({ marker }), "-q"]);
    const runId = json(r.stdout).run_id as string;
    const yaml = readFileSync(path.join(dir, "flow.yaml"), "utf8");
    writeFileSync(path.join(dir, "flow.yaml"), yaml.replace("version: 0.1.0", "version: 0.2.0"));
    const refused = await cli(["resume", dir, runId, "-q"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/hash mismatch/);
    writeFileSync(marker, "");
    const forced = await cli(["resume", dir, runId, "-q", "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
  });
  it("checkpoints on SIGINT mid-map and resumes only the remaining items", async () => {
    const dir = path.join(work, "examples/flows/flaky-sigint");
    cpSync(flaky, dir, { recursive: true });
    rmSync(path.join(dir, ".runs"), { recursive: true, force: true });
    const marker = path.join(work, "marker3");
    writeFileSync(marker, "");
    const r = await cli(["run", dir, "--input", JSON.stringify({ marker, delay_ms: 400 }), "-q"], { signalAfterMs: 2000 });
    expect(r.code).toBe(130);
    const runId = json(r.stdout).run_id as string;
    const trace = json(readFileSync(path.join(dir, ".runs", runId, "trace.json"), "utf8"));
    expect(trace.status).toBe("interrupted");
    const items = trace.steps.find((s: { name: string }) => s.name === "slow_map").items.map((i: { status: string }) => i.status);
    expect(items).toContain("succeeded");
    expect(items.filter((s: string) => s !== "succeeded").length).toBeGreaterThan(0);
    const res = await cli(["resume", dir, runId, "--trace", "-q"]);
    expect(res.code, res.stderr).toBe(0);
    const t = json(res.stdout);
    expect(t.status).toBe("succeeded");
    const after = t.steps.find((s: { name: string }) => s.name === "slow_map").items;
    const reran = after.filter((i: { attempts: unknown[] }) => i.attempts.length > 1).length;
    expect(reran).toBeLessThan(4);
    expect(t.output.count).toBe(4);
  }, 60_000);
});
