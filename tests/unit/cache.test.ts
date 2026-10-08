import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlowError } from "../../src/errors.js";
import { clearCache, expandGlob, listCacheEntries } from "../../src/executor/cache.js";
import { MockRunner, type CommandRequest, type CommandResult, type CommandRunner } from "../../src/executor/command-runner.js";
import { runFlow } from "../../src/executor/run.js";
import { loadFlowFromObject } from "../../src/loader.js";
import { runTests } from "../../src/testing/run-tests.js";
import { cacheStats } from "../../src/trace.js";
import { validateFlow } from "../../src/validate.js";

/** Echoes `{ argv, stdin }` back as JSON and counts calls; `fail` makes matching calls exit 1. */
class CountingRunner implements CommandRunner {
  calls: CommandRequest[] = [];
  constructor(private fail?: (req: CommandRequest) => boolean) {}
  async run(req: CommandRequest): Promise<CommandResult> {
    this.calls.push(req);
    if (this.fail?.(req)) throw new FlowError("nonzero_exit", "boom", { details: { exitCode: 1, stderr: "boom" } });
    const stdin = req.stdin !== undefined ? JSON.parse(req.stdin) : null;
    return { stdout: JSON.stringify({ argv: req.argv, stdin }), stderr: "", exitCode: 0, durationMs: 1 };
  }
}

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "wf-cache-"));
}

function flowWith(step: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { name: "cached", version: "0.1.0", steps: { work: { type: "command", command: ["tool"], input: "trigger", cache: true, ...step } }, ...extra };
}

async function run(dir: string, raw: unknown, trigger: unknown = { q: 1 }, runner = new CountingRunner(), cache?: { enabled?: boolean; refresh?: string[] }) {
  const loaded = loadFlowFromObject(raw, dir);
  const r = await runFlow({ loaded, trigger, runner, persist: false, ...(cache ? { cache } : {}) });
  return { r, runner, loaded };
}

describe("step cache", () => {
  it("reuses a successful result on the next run", async () => {
    const dir = tmp();
    const first = await run(dir, flowWith({}));
    expect(first.runner.calls).toHaveLength(1);
    expect(first.r.trace.steps[0]!.cache).toMatchObject({ hit: false });

    const second = await run(dir, flowWith({}));
    expect(second.runner.calls).toHaveLength(0);
    expect(second.r.status).toBe("succeeded");
    expect(second.r.output).toEqual(first.r.output);
    const st = second.r.trace.steps[0]!;
    expect(st.status).toBe("succeeded");
    expect(st.attempts).toHaveLength(0);
    expect(st.cache).toMatchObject({ hit: true, source_run_id: first.r.trace.run_id });
    expect(st.input).toEqual({ q: 1 });
    expect(cacheStats(second.r.trace)).toEqual({ cached: 1, executed: 0 });
  });

  it("misses when input, command, files or env change; hits when timeout/retry/mock change", async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "prompt.md"), "v1");
    const base = { cache: { files: ["prompt.md"], env: ["WF_CACHE_TEST"] } };
    process.env.WF_CACHE_TEST = "a";
    try {
      await run(dir, flowWith(base));
      expect((await run(dir, flowWith(base))).runner.calls).toHaveLength(0);
      expect((await run(dir, flowWith({ ...base, timeout: "9s", retry: { max_attempts: 2 }, mock: { output: 1 } }))).runner.calls).toHaveLength(0);

      expect((await run(dir, flowWith(base), { q: 2 })).runner.calls).toHaveLength(1);
      expect((await run(dir, flowWith({ ...base, command: ["tool", "--v2"] }))).runner.calls).toHaveLength(1);
      writeFileSync(path.join(dir, "prompt.md"), "v2");
      expect((await run(dir, flowWith(base))).runner.calls).toHaveLength(1);
      process.env.WF_CACHE_TEST = "b";
      expect((await run(dir, flowWith(base))).runner.calls).toHaveLength(1);
    } finally {
      delete process.env.WF_CACHE_TEST;
    }
  });

  it("canonicalizes with a key expression", async () => {
    const dir = tmp();
    const raw = flowWith({ cache: { key: "$lowercase(url)" } });
    await run(dir, raw, { url: "https://X.com" });
    const again = await run(dir, raw, { url: "https://x.com" });
    expect(again.runner.calls).toHaveLength(0);
  });

  it("caches map items individually", async () => {
    const dir = tmp();
    const raw = (n: number) => ({
      name: "cached",
      version: "0.1.0",
      steps: {
        list: { type: "pass", input: `[1..${n}]` },
        each: { type: "map", needs: ["list"], over: "steps.list.output", step: { type: "command", command: ["tool"], input: "{ 'n': item }", cache: true } },
      },
    });
    const first = await run(dir, raw(3));
    expect(first.runner.calls).toHaveLength(3);
    const second = await run(dir, raw(4));
    expect(second.runner.calls).toHaveLength(1);
    expect(second.runner.calls[0]!.stdin).toBe(JSON.stringify({ n: 4 }));
    const items = second.r.trace.steps.find((s) => s.name === "each")!.items!;
    expect(items.map((i) => i.cache?.hit)).toEqual([true, true, true, false]);
    expect((second.r.output as Array<{ stdin: unknown }>).map((o) => o.stdin)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    expect(cacheStats(second.r.trace)).toEqual({ cached: 3, executed: 1 });
  });

  it("never stores failed or caught results", async () => {
    const dir = tmp();
    const failing = new CountingRunner(() => true);
    const caught = await run(dir, flowWith({ catch: [{ error_type: "any", result: "fallback" }] }), { q: 1 }, failing);
    expect(caught.r.trace.steps[0]!.status).toBe("caught");
    const failed = await run(dir, flowWith({}), { q: 1 }, new CountingRunner(() => true));
    expect(failed.r.status).toBe("failed");
    expect(listCacheEntries(failed.loaded)).toHaveLength(0);
    expect((await run(dir, flowWith({}))).runner.calls).toHaveLength(1);
  });

  it("honours ttl, refresh and enabled: false", async () => {
    const dir = tmp();
    await run(dir, flowWith({}));
    expect((await run(dir, flowWith({ cache: { ttl: 0 } }))).runner.calls).toHaveLength(1);
    expect((await run(dir, flowWith({}), { q: 1 }, new CountingRunner(), { refresh: ["work"] })).runner.calls).toHaveLength(1);
    const off = await run(dir, flowWith({}), { q: 1 }, new CountingRunner(), { enabled: false });
    expect(off.runner.calls).toHaveLength(1);
    expect(off.r.trace.steps[0]!.cache).toBeUndefined();
  });

  it("falls through to normal error handling when the key cannot be computed", async () => {
    const dir = tmp();
    const r = await run(dir, flowWith({ input: "$error('bad')", catch: [{ error_type: "expression_error", result: "x" }] }));
    expect(r.r.trace.steps[0]!.status).toBe("caught");
    expect(r.r.trace.steps[0]!.error?.type).toBe("expression_error");
  });

  it("is off with a MockRunner and in runTests", async () => {
    const dir = tmp();
    const raw = flowWith({});
    await runFlow({ loaded: loadFlowFromObject(raw, dir), trigger: { q: 1 }, runner: new MockRunner({ work: { output: 1 } }), persist: false });
    mkdirTests(dir);
    const res = await runTests(loadFlowFromObject(raw, dir));
    expect(res.passed).toBe(1);
    expect(existsSync(path.join(dir, ".dogyard"))).toBe(false);
  });

  it("lists and clears entries", async () => {
    const dir = tmp();
    const { loaded } = await run(dir, flowWith({}));
    await run(dir, flowWith({}), { q: 2 });
    expect(listCacheEntries(loaded).map((e) => e.step)).toEqual(["work", "work"]);
    expect(clearCache(loaded, { expiredOnly: true })).toBe(0);
    expect(clearCache(loaded, { step: "work" })).toBe(2);
    expect(readdirSync(path.join(dir, ".dogyard/cache/cached/work"))).toHaveLength(0);
  });
});

function mkdirTests(dir: string): void {
  const tests = path.join(dir, "tests");
  mkdirSync(tests, { recursive: true });
  writeFileSync(path.join(tests, "a.test.yaml"), "name: a\ntrigger: { q: 1 }\nmocks:\n  work: { output: 1 }\nexpect:\n  output: 1\n");
}

describe("cache helpers", () => {
  it("expands simple globs", () => {
    const dir = tmp();
    mkdirSync(path.join(dir, "config/nested"), { recursive: true });
    for (const f of ["a.md", "config/x.json", "config/y.json", "config/nested/z.json"]) writeFileSync(path.join(dir, f), f);
    expect(expandGlob("a.md", dir)).toEqual(["a.md"]);
    expect(expandGlob("config/*.json", dir)).toEqual(["config/x.json", "config/y.json"]);
    expect(expandGlob("config/**/*.json", dir)).toEqual(["config/nested/z.json", "config/x.json", "config/y.json"]);
    expect(expandGlob("missing.md", dir)).toEqual([]);
  });

  it("validates cache.key syntax and unmatched files", () => {
    const dir = tmp();
    const loaded = loadFlowFromObject(flowWith({ cache: { key: "(", files: ["nope.md"] } }), dir);
    const v = validateFlow(loaded.flow, { dir });
    expect(v.errors.map((e) => e.message).join()).toMatch(/cache\.key/);
    expect(v.warnings.map((e) => e.message).join()).toMatch(/nope\.md/);
  });
});
