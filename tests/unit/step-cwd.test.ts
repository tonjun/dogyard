import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runStep } from "../../src/executor/run-step.js";
import { runFlow } from "../../src/executor/run.js";
import { resolveStepCwd } from "../../src/executor/steps/command.js";
import { loadFlowFromObject } from "../../src/loader.js";

const node = process.execPath;
const pwd = [node, "-e", "process.stdout.write(process.cwd())"];

function fixture() {
  // realpath: on macOS tmpdir() is a symlink, but process.cwd() reports the resolved path
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "wf-cwd-")));
  writeFileSync(path.join(dir, "flow.yaml"), "");
  mkdirSync(path.join(dir, "steps", "owned"), { recursive: true });
  mkdirSync(path.join(dir, "steps", "mapped"), { recursive: true });
  mkdirSync(path.join(dir, "sub"), { recursive: true });
  const flow = {
    name: "cwd",
    version: "0.1.0",
    steps: {
      owned: { type: "command", command: pwd },
      orphan: { type: "command", command: pwd },
      explicit: { type: "command", command: pwd, cwd: "sub" },
      mapped: { type: "map", over: "[1, 2]", step: { type: "command", command: pwd } },
    },
  };
  return { dir, loaded: loadFlowFromObject(flow, dir) };
}

describe("command step cwd", () => {
  it("resolveStepCwd prefers explicit cwd, then the step folder, then the flow folder", () => {
    const { dir } = fixture();
    expect(resolveStepCwd(dir, "owned", {})).toBe(path.join(dir, "steps", "owned"));
    expect(resolveStepCwd(dir, "orphan", {})).toBe(dir);
    expect(resolveStepCwd(dir, "owned", { cwd: "sub" })).toBe(path.join(dir, "sub"));
    // A native absolute path: "/abs" is drive-relative on Windows, so derive the root from dir.
    const abs = path.join(path.parse(dir).root, "abs");
    expect(resolveStepCwd(dir, "owned", { cwd: abs })).toBe(abs);
  });

  it("runFlow spawns each command in its step folder, including map sub-steps", async () => {
    const { dir, loaded } = fixture();
    const r = await runFlow({ loaded, trigger: {}, traceDir: path.join(dir, ".runs") });
    expect(r.status).toBe("succeeded");
    const out = (name: string) => r.trace.steps.find((s) => s.name === name)!.output;
    expect(out("owned")).toBe(path.join(dir, "steps", "owned"));
    expect(out("orphan")).toBe(dir);
    expect(out("explicit")).toBe(path.join(dir, "sub"));
    expect(out("mapped")).toEqual([path.join(dir, "steps", "mapped"), path.join(dir, "steps", "mapped")]);
  });

  it("runStep uses the same resolution", async () => {
    const { dir, loaded } = fixture();
    const owned = await runStep({ loaded, stepName: "owned", context: { trigger: {}, steps: {} } });
    expect(owned.output).toBe(path.join(dir, "steps", "owned"));
    const mapped = await runStep({ loaded, stepName: "mapped", context: { trigger: {}, steps: {}, item: 1 } });
    expect(mapped.output).toBe(path.join(dir, "steps", "mapped"));
  });
});
