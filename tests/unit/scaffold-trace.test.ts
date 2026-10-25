import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadFlow, loadFlowFromObject } from "../../src/loader.js";
import { scaffoldFlow, scaffoldStep } from "../../src/scaffold.js";
import { executedPath, latestRun, listRuns, recentRuns, runsDir, traceFile, type RunTrace } from "../../src/trace.js";
import { validateFlow } from "../../src/validate.js";

const tmp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));

describe("scaffoldFlow", () => {
  it("writes a valid flow folder and refuses to overwrite without force", () => {
    const parent = tmp("scaffold-");
    const res = scaffoldFlow({ name: "my_flow", dir: parent });
    expect(res.dir).toBe(path.join(parent, "my_flow"));
    expect(res.files.map((f) => path.relative(res.dir, f).split(path.sep).join("/"))).toContain("steps/shout/evals/dataset.yaml");
    const loaded = loadFlow(res.dir);
    expect(validateFlow(loaded.flow, { dir: loaded.dir }).ok).toBe(true);
    expect(() => scaffoldFlow({ name: "my_flow", dir: parent })).toThrow(/already exists/);
    expect(scaffoldFlow({ name: "my_flow", dir: parent, force: true }).files).toHaveLength(res.files.length);
    expect(() => scaffoldFlow({ name: "Bad Name", dir: parent })).toThrow(/Invalid flow name/);
  });
});

describe("scaffoldStep", () => {
  const flow = {
    name: "s",
    version: "0.1.0",
    steps: {
      fetch: { type: "command", command: ["fetch", "--all"] },
      each: { type: "map", needs: ["fetch"], over: "steps.fetch.output", step: { type: "command", command: ["llm"] } },
      shape: { type: "transform", needs: ["each"], input: "steps.each.output" },
      maps_transform: { type: "map", over: "trigger.xs", step: { type: "transform", input: "item" } },
    },
  };

  it("writes a test/eval skeleton for command and map-of-command steps", () => {
    const dir = tmp("scaffold-step-");
    const loaded = loadFlowFromObject(flow, dir);
    const plain = scaffoldStep({ loaded, step: "fetch" });
    expect(plain.dir).toBe(path.join(dir, "steps/fetch"));
    const test = readFileSync(path.join(plain.dir, "tests/basic.test.yaml"), "utf8");
    expect(test).toContain('argv: ["fetch","--all"]');
    expect(test).not.toContain("steps:");
    const map = scaffoldStep({ loaded, step: "each" });
    const dataset = readFileSync(path.join(map.dir, "evals/dataset.yaml"), "utf8");
    expect(dataset).toMatch(/steps:\n {8}fetch: null[\s\S]*item: null {3}# one element of `steps\.fetch\.output`\n {6}index: 0/);
    expect(existsSync(path.join(map.dir, "evals/eval.yaml"))).toBe(true);
    expect(() => scaffoldStep({ loaded, step: "fetch" })).toThrow(/already exists/);
    expect(scaffoldStep({ loaded, step: "fetch", force: true }).files).toHaveLength(3);
  });

  it("rejects unknown and non-command steps", () => {
    const loaded = loadFlowFromObject(flow, tmp("scaffold-step-"));
    expect(() => scaffoldStep({ loaded, step: "nope" })).toThrow(/Unknown step "nope"/);
    expect(() => scaffoldStep({ loaded, step: "shape" })).toThrow(/is a transform step/);
    expect(() => scaffoldStep({ loaded, step: "maps_transform" })).toThrow(/is a map of transform step/);
  });
});

describe("trace listing", () => {
  const trace = (id: string, started: string): RunTrace => ({ run_id: id, started_at: started, status: "succeeded", steps: [] }) as unknown as RunTrace;

  function setup() {
    const flowDir = tmp("traces-");
    const put = (id: string, content: string) => {
      mkdirSync(path.join(flowDir, ".runs", id), { recursive: true });
      writeFileSync(traceFile(flowDir, id), content);
    };
    return { flowDir, put };
  }

  it("returns nothing when there is no runs folder", () => {
    const { flowDir } = setup();
    expect(listRuns(flowDir)).toEqual([]);
    expect(recentRuns(flowDir, 5)).toEqual([]);
    expect(latestRun(flowDir)).toBeUndefined();
  });

  it("lists runs by start time, skipping files, folders without traces and unreadable traces", () => {
    const { flowDir, put } = setup();
    put("20260102T000000Z-b", JSON.stringify(trace("b", "2026-01-02T00:00:00Z")));
    put("20260101T000000Z-a", JSON.stringify(trace("a", "2026-01-01T00:00:00Z")));
    put("20260103T000000Z-c", "{ not json");
    mkdirSync(path.join(flowDir, ".runs", "20260104T000000Z-empty"));
    writeFileSync(path.join(flowDir, ".runs", "stray.txt"), "");
    expect(listRuns(flowDir).map((r) => r.run_id)).toEqual(["a", "b"]);
    expect(latestRun(flowDir)?.run_id).toBe("b");
    expect(recentRuns(flowDir, 5).map((r) => r.run_id)).toEqual(["b", "a"]);
    expect(recentRuns(flowDir, 1).map((r) => r.run_id)).toEqual(["b"]);
  });

  it("resolves an explicit trace dir", () => {
    const { flowDir } = setup();
    const other = path.join(flowDir, "elsewhere");
    expect(runsDir(flowDir, other)).toBe(path.resolve(other));
    expect(traceFile(flowDir, "r", other)).toBe(path.join(path.resolve(other), "r", "trace.json"));
  });

  it("orders the executed path by end time, keeping only steps that ran", () => {
    const t = {
      steps: [
        { name: "b", status: "succeeded", ended_at: "2026-01-01T00:00:02Z" },
        { name: "skip", status: "skipped" },
        { name: "a", status: "caught", ended_at: "2026-01-01T00:00:01Z" },
        { name: "c", status: "failed" },
      ],
    } as unknown as RunTrace;
    expect(executedPath(t)).toEqual(["c", "a", "b"]);
  });
});
