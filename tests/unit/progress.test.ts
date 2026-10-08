import { describe, expect, it } from "vitest";
import { ProgressDisplay } from "../../src/cli/progress-display.js";
import { formatShortDuration } from "../../src/duration.js";
import { computeProgress, formatStepLine, historicalItemMedians, runSummary } from "../../src/progress.js";
import type { ItemTrace, RunTrace, StepTrace } from "../../src/trace.js";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

/** A finished item that ran from `start` for `dur` ms. */
function done(index: number, start: number, dur: number, extra: Partial<ItemTrace> = {}): ItemTrace {
  return { index, status: "succeeded", attempts: [], started_at: at(start), ended_at: at(start + dur), ...extra };
}
const pending = (index: number): ItemTrace => ({ index, status: "pending", attempts: [] });

function trace(steps: StepTrace[], extra: Partial<RunTrace> = {}): RunTrace {
  return { schema_version: 1, run_id: "r1", flow: { name: "f", version: "0.1.0", hash: "h" }, status: "running", started_at: at(0), resume_count: 0, trigger: {}, steps, ...extra };
}

function mapStep(items: ItemTrace[], extra: Partial<StepTrace> = {}): StepTrace {
  return { name: "analyze", type: "map", status: "running", attempts: [], started_at: at(0), max_concurrency: 1, items, ...extra };
}

describe("computeProgress", () => {
  it("counts items and estimates the rest from the median executed item time", () => {
    const items = [
      done(0, 0, 10_000),
      done(1, 10_000, 30_000),
      done(2, 40_000, 20_000),
      done(3, 60_000, 1, { cache: { key: "k", hit: true } }), // cached: excluded from the median
      { index: 4, status: "failed", attempts: [], started_at: at(60_000), ended_at: at(61_000), error: { type: "nonzero_exit", message: "boom" }, stderr: "line1\nline2\n" },
      { index: 5, status: "caught", attempts: [], started_at: at(61_000), ended_at: at(81_000), error: { type: "timeout", message: "slow" } },
      { index: 6, status: "running", attempts: [], started_at: at(81_000) },
      pending(7),
      pending(8),
      pending(9),
    ] as ItemTrace[];
    const p = computeProgress(trace([mapStep(items)]), { now: T0 + 90_000 });
    const s = p.steps[0]!;
    expect(s.items).toMatchObject({ total: 10, done: 6, succeeded: 4, caught: 1, failed: 1, cached: 1, running: 1, pending: 3 });
    // executed durations: 10s, 30s, 20s, 20s (caught) -> median 20s; 4 remaining at concurrency 1
    expect(s.median_ms).toBe(20_000);
    expect(s.eta_source).toBe("run");
    expect(s.eta_ms).toBe(80_000);
    expect(s.last_error).toMatchObject({ item: 5, type: "timeout" });
    expect(p.elapsed_ms).toBe(90_000);
  });

  it("divides by concurrency, capped at the items left", () => {
    const items = [done(0, 0, 10_000), pending(1), pending(2), pending(3), pending(4)];
    expect(computeProgress(trace([mapStep(items, { max_concurrency: 2 })])).steps[0]!.eta_ms).toBe(20_000);
    expect(computeProgress(trace([mapStep(items, { max_concurrency: 8 })])).steps[0]!.eta_ms).toBe(10_000);
  });

  it("seeds the ETA from history until an item finishes, and has none without either", () => {
    const items = [pending(0), pending(1)];
    const seeded = computeProgress(trace([mapStep(items)]), { history: { analyze: 5_000 } }).steps[0]!;
    expect(seeded).toMatchObject({ eta_ms: 10_000, eta_source: "history" });
    expect(computeProgress(trace([mapStep(items)])).steps[0]!.eta_ms).toBeUndefined();
  });

  it("gives no ETA once the step is no longer running", () => {
    const p = computeProgress(trace([mapStep([done(0, 0, 1000)], { status: "succeeded", ended_at: at(1000) })]));
    expect(p.steps[0]!.eta_ms).toBeUndefined();
    expect(p.steps[0]!.elapsed_ms).toBe(1000);
  });
});

describe("historicalItemMedians", () => {
  it("fills the window from the newest runs' executed items, excluding the given run", () => {
    const old = trace([mapStep([done(0, 0, 100_000)], { status: "succeeded" })], { run_id: "old", started_at: at(0) });
    const recent = trace([mapStep([done(0, 0, 4_000), done(1, 0, 6_000), done(2, 0, 1, { cache: { key: "k", hit: true } })], { status: "succeeded" })], { run_id: "recent", started_at: at(1000) });
    const current = trace([mapStep([done(0, 0, 999_000)])], { run_id: "current", started_at: at(2000) });
    // window not full after `recent`, so `old` contributes too: median(4s, 6s, 100s)
    expect(historicalItemMedians([old, recent, current], "current")).toEqual({ analyze: 6_000 });
    expect(historicalItemMedians([recent])).toEqual({ analyze: 5_000 });
  });
});

describe("formatting", () => {
  it("formats a running map's status line", () => {
    const items = [done(0, 0, 60_000), done(1, 0, 60_000, { cache: { key: "k", hit: true } }), { index: 2, status: "failed", attempts: [] }, ...Array.from({ length: 70 }, (_, i) => pending(i + 3))] as ItemTrace[];
    const p = computeProgress(trace([mapStep(items)])).steps[0]!;
    expect(formatStepLine(p)).toBe("analyze  3/73  ● 1 failed  ● 1 cached  ETA 1h10m");
    const seeded = computeProgress(trace([mapStep([pending(0)])]), { history: { analyze: 42_000 } }).steps[0]!;
    expect(formatStepLine(seeded)).toBe("analyze  0/1  ETA ~42s");
  });

  it("formats finished and non-map steps", () => {
    const now = T0 + 125_000;
    const cmd: StepTrace = { name: "embed", type: "command", status: "running", attempts: [], started_at: at(0) };
    expect(formatStepLine(computeProgress(trace([cmd]), { now }).steps[0]!)).toBe("embed  running 2m05s");
    const ended: StepTrace = { ...cmd, status: "succeeded", ended_at: at(3000) };
    expect(formatStepLine(computeProgress(trace([ended]), { now }).steps[0]!)).toBe("embed  succeeded in 3s");
  });

  it("formats short durations", () => {
    expect(formatShortDuration(400)).toBe("0s");
    expect(formatShortDuration(185_000)).toBe("3m05s");
    expect(formatShortDuration(4_320_000)).toBe("1h12m");
    expect(formatShortDuration(100 * 3_600_000)).toBe("4d4h");
  });

  it("summarises a run's duration and items", () => {
    const t = trace([mapStep([done(0, 0, 1), pending(1)]), mapStep([done(0, 0, 1)], { name: "b" })], { duration_ms: 1234 });
    expect(runSummary(t)).toEqual({ duration_ms: 1234, items_done: 2, items_total: 3 });
    expect(runSummary(trace([]), T0 + 5000).duration_ms).toBe(5000);
  });
});

describe("ProgressDisplay (non-TTY)", () => {
  function capture() {
    const out: string[] = [];
    return { out, stream: { write: (s: string) => out.push(s), isTTY: false } };
  }

  it("prints a map line on start, every N items, after a quiet interval, and once at the end", () => {
    const { out, stream } = capture();
    let now = T0;
    const display = new ProgressDisplay({ stream, everyItems: 2, everyMs: 30_000, now: () => now });
    const items = [pending(0), pending(1), pending(2), pending(3)];
    const t = trace([mapStep(items)]);
    display.update(t);
    expect(out).toEqual(["analyze  0/4  running 0s\n"]);

    items[0] = done(0, 0, 1000);
    display.update(t);
    expect(out).toHaveLength(1); // 1 item since last line < everyItems

    items[1] = done(1, 1000, 1000);
    display.update(t);
    expect(out.at(-1)).toMatch(/^analyze {2}2\/4 {2}ETA 2s\n$/);

    now += 30_000;
    display.update(t);
    expect(out).toHaveLength(3); // heartbeat after everyMs

    items[2] = done(2, 2000, 1000);
    items[3] = done(3, 3000, 1000);
    t.steps[0]!.status = "succeeded";
    t.steps[0]!.ended_at = at(4000);
    display.update(t);
    display.update(t);
    display.stop();
    expect(out.at(-1)).toBe("analyze  4/4  succeeded in 4s\n");
    expect(out.filter((l) => l.includes("succeeded"))).toHaveLength(1);
  });

  it("passes logs and raw writes straight through", () => {
    const { out, stream } = capture();
    const display = new ProgressDisplay({ stream });
    display.log("hello");
    display.write("partial");
    display.stop();
    expect(out).toEqual(["hello\n", "partial"]);
  });
});

describe("ProgressDisplay (TTY)", () => {
  it("writes complete lines above the live block and redraws it", async () => {
    const out: string[] = [];
    const display = new ProgressDisplay({ stream: { write: (s: string) => out.push(s), isTTY: true }, now: () => T0 });
    display.update(trace([mapStep([pending(0), pending(1)])]));
    await new Promise((r) => setTimeout(r, 150));
    expect(out.join("")).toBe("analyze  0/2  running 0s");
    display.write("abc");
    expect(out).toHaveLength(1); // held until the line is complete
    display.write("def\n");
    expect(out.slice(1)).toEqual(["\r\x1b[J", "abcdef\n", "analyze  0/2  running 0s"]);
    display.stop();
    expect(out.at(-1)).toBe("\r\x1b[J");
  });
});
