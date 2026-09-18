import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGraph, exportGraph } from "../../src/graph.js";
import { loadFlow, loadFlowFromObject, computeFlowHash } from "../../src/loader.js";
import { validateRawFlow } from "../../src/validate.js";

const sample = {
  name: "sample",
  version: "0.1.0",
  steps: {
    a: { type: "command", command: ["echo"] },
    b: { type: "command", command: ["echo"], needs: ["a"] },
    c: { type: "choice", needs: ["b"], branches: [{ when: "true", next: "d" }], default: "e" },
    d: { type: "pass", terminal: "success" },
    e: { type: "pass", terminal: "success" },
  },
};

describe("graph", () => {
  it("builds implicit choice edges, sinks and topo order", () => {
    const { flow } = loadFlowFromObject(sample);
    const g = buildGraph(flow);
    expect(g.edges.filter((e) => e.kind === "choice").map((e) => e.to).sort()).toEqual(["d", "e"]);
    expect([...g.deps.get("d")!]).toEqual(["c"]);
    expect(g.sinks.sort()).toEqual(["d", "e"]);
    expect(g.order.indexOf("a")).toBeLessThan(g.order.indexOf("b"));
    expect(g.cycle).toBeUndefined();
    expect(exportGraph(g, "mermaid")).toContain("c -.");
    expect(exportGraph(g, "dot")).toContain('"a" -> "b"');
    expect(JSON.parse(exportGraph(g, "json")).edges).toHaveLength(4);
  });
  it("detects cycles", () => {
    const r = validateRawFlow({
      name: "cyc",
      version: "1.0.0",
      steps: { a: { type: "pass", needs: ["b"] }, b: { type: "pass", needs: ["a"] } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes("cycle"))).toBe(true);
  });
});

describe("validate", () => {
  it("accepts the sample", () => {
    const r = validateRawFlow(sample);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
  it("reports structural and reference errors", () => {
    const r = validateRawFlow({
      name: "Bad Name",
      version: "x",
      steps: {
        a: { type: "command", command: [], needs: ["nope"], input: "{" },
        c: { type: "choice", branches: [{ when: "true", next: "zzz" }] },
      },
    });
    expect(r.ok).toBe(false);
    const msgs = r.errors.map((e) => e.message).join("\n");
    expect(msgs).toMatch(/name/);
    expect(msgs).toMatch(/version/);
  });
  it("reports unknown needs and bad expressions after structure passes", () => {
    const r = validateRawFlow({
      name: "bad",
      version: "1.0.0",
      steps: {
        a: { type: "command", command: ["x"], needs: ["nope"], input: "{" },
        c: { type: "choice", branches: [{ when: "true", next: "zzz" }] },
      },
    });
    const msgs = r.errors.map((e) => `${e.step}: ${e.message}`);
    expect(msgs.some((m) => m.includes('unknown step "nope"'))).toBe(true);
    expect(msgs.some((m) => m.includes("input:"))).toBe(true);
    expect(msgs.some((m) => m.includes('unknown step "zzz"'))).toBe(true);
    expect(r.warnings.some((w) => w.message.includes("no default"))).toBe(true);
  });
});

describe("loader", () => {
  it("loads from a folder and merges project config", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-"));
    writeFileSync(path.join(root, "workflows.yaml"), "config:\n  default_timeout: 5s\n  max_concurrency: 2\n");
    const dir = path.join(root, "flows", "x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "flow.yaml"), "name: x\nversion: 1.0.0\nconfig:\n  max_concurrency: 3\nsteps:\n  a: { type: pass }\n");
    const loaded = loadFlow(dir);
    expect(loaded.flow.config).toEqual({ default_timeout: "5s", max_concurrency: 3 });
    expect(loaded.project?.file).toBe(path.join(root, "workflows.yaml"));
    expect(loadFlow(dir, { project: false }).flow.config).toEqual({ max_concurrency: 3 });
    expect(loadFlow(path.join(dir, "flow.yaml")).dir).toBe(dir);
  });
  it("hashes stably regardless of key order", () => {
    expect(computeFlowHash({ a: 1, b: [1, { c: 2 }] })).toBe(computeFlowHash({ b: [1, { c: 2 }], a: 1 }));
  });
});
