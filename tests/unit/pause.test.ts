import { describe, expect, it } from "vitest";
import type { CommandRequest, CommandResult, CommandRunner } from "../../src/executor/command-runner.js";
import { FlowError } from "../../src/errors.js";
import { PauseController } from "../../src/executor/pause.js";
import { runFlow } from "../../src/executor/run.js";
import { loadFlowFromObject } from "../../src/loader.js";
import type { RunTrace } from "../../src/trace.js";

/** A runner whose commands finish only when the test releases them. */
class ManualRunner implements CommandRunner {
  readonly started: string[] = [];
  private readonly pending = new Map<string, () => void>();

  run(req: CommandRequest): Promise<CommandResult> {
    const id = req.itemIndex !== undefined ? `${req.step}[${req.itemIndex}]` : req.step;
    this.started.push(id);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      req.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, () => {
        req.signal?.removeEventListener("abort", onAbort);
        resolve({ stdout: JSON.stringify({ id }), stderr: "", exitCode: 0, durationMs: 1 });
      });
    });
  }

  release(id: string): void {
    const done = this.pending.get(id);
    if (!done) throw new Error(`${id} is not running (started: ${this.started.join(", ")})`);
    this.pending.delete(id);
    done();
  }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await tick(5);
  }
}

const chain = {
  name: "chain",
  version: "0.1.0",
  steps: {
    a: { type: "command", command: ["a"] },
    b: { type: "command", command: ["b"], needs: ["a"] },
  },
};

function start(flow: unknown, extra: Partial<Parameters<typeof runFlow>[0]> = {}) {
  const runner = new ManualRunner();
  const pause = new PauseController();
  const traces: RunTrace[] = [];
  const result = runFlow({
    loaded: loadFlowFromObject(flow),
    trigger: {},
    runner,
    persist: false,
    pause,
    onProgress: (t) => traces.push(structuredClone(t)),
    ...extra,
  });
  return { runner, pause, traces, result };
}

describe("PauseController", () => {
  it("opens waiters on continue or abort and notifies only on transitions", async () => {
    const gate = new PauseController();
    const seen: boolean[] = [];
    const off = gate.onChange((p) => seen.push(p));
    await gate.wait(); // open: resolves at once

    gate.pause();
    gate.pause();
    let released = false;
    const w = gate.wait().then(() => (released = true));
    await tick();
    expect(released).toBe(false);
    gate.continue();
    await w;
    expect(seen).toEqual([true, false]);

    gate.pause();
    const ac = new AbortController();
    const aborted = gate.wait(ac.signal);
    ac.abort();
    await aborted;
    await gate.wait(ac.signal); // already aborted: resolves at once
    off();
    gate.continue();
    expect(seen).toEqual([true, false, true]);
  });
});

describe("runFlow: drain pause", () => {
  it("lets the running step finish but starts nothing new until continue", async () => {
    const { runner, pause, traces, result } = start(chain);
    await until(() => runner.started.includes("a"));
    pause.pause();
    await until(() => traces.at(-1)?.paused_at !== undefined);
    runner.release("a");
    await tick(50);
    expect(runner.started).toEqual(["a"]);
    expect(traces.at(-1)!.steps.find((s) => s.name === "a")!.status).toBe("succeeded");

    pause.continue();
    await until(() => runner.started.includes("b"));
    expect(traces.at(-1)!.paused_at).toBeUndefined();
    runner.release("b");
    const r = await result;
    expect(r.status).toBe("succeeded");
    expect(r.trace.paused_at).toBeUndefined();
  });

  it("starts ready steps on continue without waiting for a step still running", async () => {
    const flow = {
      name: "fan",
      version: "0.1.0",
      config: { max_concurrency: 1 },
      steps: { slow: { type: "command", command: ["s"] }, quick: { type: "command", command: ["q"] } },
    };
    const { runner, pause, result } = start(flow);
    await until(() => runner.started.length === 1);
    pause.pause();
    const [first] = runner.started;
    const other = first === "slow" ? "quick" : "slow";
    runner.release(first!);
    await tick(30);
    expect(runner.started).toEqual([first]);
    pause.continue();
    await until(() => runner.started.includes(other));
    runner.release(other);
    expect((await result).status).toBe("succeeded");
  });

  it("holds map items that have not started", async () => {
    const flow = {
      name: "m",
      version: "0.1.0",
      steps: {
        list: { type: "transform", input: "[1, 2, 3]" },
        each: { type: "map", needs: ["list"], over: "steps.list.output", max_concurrency: 1, step: { type: "command", command: ["x"] } },
      },
    };
    const { runner, pause, traces, result } = start(flow);
    await until(() => runner.started.includes("each[0]"));
    pause.pause();
    runner.release("each[0]");
    await tick(50);
    expect(runner.started).toEqual(["each[0]"]);
    const items = traces.at(-1)!.steps.find((s) => s.name === "each")!.items!;
    expect(items.map((i) => i.status)).toEqual(["succeeded", "pending", "pending"]);

    pause.continue();
    await until(() => runner.started.includes("each[1]"));
    runner.release("each[1]");
    await until(() => runner.started.includes("each[2]"));
    runner.release("each[2]");
    expect((await result).status).toBe("succeeded");
  });

  it("does not start at all when paused up front, and records paused_at", async () => {
    const runner = new ManualRunner();
    const pause = new PauseController();
    pause.pause();
    const traces: RunTrace[] = [];
    const result = runFlow({ loaded: loadFlowFromObject(chain), trigger: {}, runner, persist: false, pause, onProgress: (t) => traces.push(structuredClone(t)) });
    await tick(30);
    expect(runner.started).toEqual([]);
    expect(traces[0]!.paused_at).toBeDefined();
    pause.continue();
    await until(() => runner.started.includes("a"));
    runner.release("a");
    await until(() => runner.started.includes("b"));
    runner.release("b");
    expect((await result).status).toBe("succeeded");
  });

  it("ends as interrupted when stopped while idle and paused, keeping later steps pending for resume", async () => {
    const ac = new AbortController();
    const { runner, pause, result } = start(chain, { signal: ac.signal });
    await until(() => runner.started.includes("a"));
    pause.pause();
    runner.release("a");
    await tick(30);
    ac.abort(new FlowError("interrupted", "stop request"));
    const r = await result;
    expect(r.status).toBe("interrupted");
    expect(r.error?.type).toBe("interrupted");
    expect(r.trace.steps.map((s) => s.status)).toEqual(["succeeded", "pending"]);
    expect(r.trace.paused_at).toBeUndefined();
  });

  it("still enforces run_timeout while paused", async () => {
    const { runner, pause, result } = start(chain, { runTimeout: 80 });
    await until(() => runner.started.includes("a"));
    pause.pause();
    runner.release("a");
    const r = await result;
    expect(r.status).toBe("failed");
    expect(r.error?.type).toBe("timeout");
  });
});
