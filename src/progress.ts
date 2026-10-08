import { formatShortDuration } from "./duration.js";
import type { ItemTrace, RunStatus, RunTrace, StepStatus, StepTrace } from "./trace.js";
import type { StepType } from "./schema/flow.js";

/** How many recently executed items the rolling median (and the history seed) looks at. */
export const ETA_WINDOW = 20;

export interface ItemCounts {
  total: number;
  /** succeeded + caught + failed. */
  done: number;
  succeeded: number;
  caught: number;
  failed: number;
  /** Items whose output came from the step cache (a subset of `succeeded`). */
  cached: number;
  running: number;
  pending: number;
  interrupted: number;
}

export interface StepProgress {
  name: string;
  type: StepType;
  status: StepStatus;
  /** Wall time since the step started (until it ended, if it has). */
  elapsed_ms?: number;
  /** Map steps only. */
  items?: ItemCounts;
  /** Median wall time of recently executed (non-cached) items. */
  median_ms?: number;
  /** Estimated time to finish the remaining items; only while the step is running. */
  eta_ms?: number;
  /** Where the median came from: this run's items, or earlier runs' traces. */
  eta_source?: "run" | "history";
  last_error?: { type: string; message: string; item?: number; stderr?: string };
}

export interface RunProgress {
  run_id: string;
  status: RunStatus;
  elapsed_ms: number;
  steps: StepProgress[];
}

export interface ProgressOptions {
  /** Defaults to Date.now(). */
  now?: number;
  /** Per-step median item time (ms) from earlier runs, used until this run has finished an item. */
  history?: Record<string, number>;
}

/** Derive progress counts and ETAs from a (possibly in-flight) trace. */
export function computeProgress(trace: RunTrace, opts: ProgressOptions = {}): RunProgress {
  const now = opts.now ?? Date.now();
  return {
    run_id: trace.run_id,
    status: trace.status,
    elapsed_ms: span(trace.started_at, trace.ended_at, now) ?? 0,
    steps: trace.steps.map((s) => stepProgress(s, now, opts.history?.[s.name])),
  };
}

function stepProgress(s: StepTrace, now: number, historyMedian: number | undefined): StepProgress {
  const p: StepProgress = { name: s.name, type: s.type, status: s.status };
  const elapsed = s.started_at ? span(s.started_at, s.status === "running" ? undefined : s.ended_at, now) : undefined;
  if (elapsed !== undefined) p.elapsed_ms = elapsed;

  if (s.error) p.last_error = { type: s.error.type, message: s.error.message, ...(s.stderr ? { stderr: s.stderr } : {}) };
  if (s.type !== "map" || !s.items) return p;

  const items = s.items;
  p.items = countItems(items);
  const lastFailed = items.filter((i) => i.error).sort(byEnded).at(-1);
  if (lastFailed?.error) {
    p.last_error = { type: lastFailed.error.type, message: lastFailed.error.message, item: lastFailed.index, ...(lastFailed.stderr ? { stderr: lastFailed.stderr } : {}) };
  }

  const recent = executedDurations(items);
  const median = recent.length ? medianOf(recent) : historyMedian;
  if (median !== undefined) {
    p.median_ms = median;
    p.eta_source = recent.length ? "run" : "history";
  }
  const remaining = p.items.total - p.items.done;
  if (s.status === "running" && median !== undefined && remaining > 0) {
    const concurrency = Math.max(1, Math.min(s.max_concurrency ?? 1, remaining));
    p.eta_ms = Math.round((median * remaining) / concurrency);
  }
  return p;
}

export function countItems(items: ItemTrace[]): ItemCounts {
  const c: ItemCounts = { total: items.length, done: 0, succeeded: 0, caught: 0, failed: 0, cached: 0, running: 0, pending: 0, interrupted: 0 };
  for (const i of items) {
    switch (i.status) {
      case "succeeded":
      case "caught":
      case "failed":
        c[i.status]++;
        c.done++;
        break;
      case "running":
      case "pending":
      case "interrupted":
        c[i.status]++;
        break;
    }
    if (i.cache?.hit) c.cached++;
  }
  return c;
}

/** Wall time of an item across its attempts, if it has started and ended. */
export function itemDurationMs(item: ItemTrace): number | undefined {
  return item.started_at && item.ended_at ? span(item.started_at, item.ended_at, 0) : undefined;
}

/** Durations of the most recently finished items that actually executed (cache hits excluded), oldest first. */
function executedDurations(items: ItemTrace[], window = ETA_WINDOW): number[] {
  return items
    .filter((i) => (i.status === "succeeded" || i.status === "caught") && !i.cache?.hit && i.started_at && i.ended_at)
    .sort(byEnded)
    .slice(-window)
    .map((i) => itemDurationMs(i)!);
}

export function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Per-map-step median item time from earlier runs (newest first, up to
 * ETA_WINDOW executed items per step), to seed the ETA before this run has
 * finished an item.
 */
export function historicalItemMedians(runs: RunTrace[], excludeRunId?: string): Record<string, number> {
  const samples = new Map<string, number[]>();
  const newestFirst = [...runs].filter((r) => r.run_id !== excludeRunId).sort((a, b) => b.started_at.localeCompare(a.started_at));
  for (const run of newestFirst) {
    for (const s of run.steps) {
      if (s.type !== "map" || !s.items) continue;
      const have = samples.get(s.name) ?? [];
      if (have.length >= ETA_WINDOW) continue;
      const recent = executedDurations(s.items).reverse();
      samples.set(s.name, [...have, ...recent].slice(0, ETA_WINDOW));
    }
  }
  const out: Record<string, number> = {};
  for (const [name, values] of samples) if (values.length) out[name] = medianOf(values);
  return out;
}

export interface RunSummary {
  duration_ms: number;
  /** Summed over map steps; both 0 when the run has no map items. */
  items_done: number;
  items_total: number;
}

/** Duration (live elapsed while running) and item totals across a run's map steps. */
export function runSummary(trace: RunTrace, now = Date.now()): RunSummary {
  let items_done = 0;
  let items_total = 0;
  for (const s of trace.steps) {
    if (!s.items) continue;
    const c = countItems(s.items);
    items_done += c.done;
    items_total += c.total;
  }
  return { duration_ms: trace.duration_ms ?? span(trace.started_at, trace.ended_at, now) ?? 0, items_done, items_total };
}

/**
 * One status line for a step, e.g.
 * `analyze_posts  142/300  ● 3 failed  ● 2 caught  ● 40 cached  ETA 1h12m`.
 * A `~` before the ETA marks one seeded from earlier runs.
 */
export function formatStepLine(p: StepProgress, nameWidth = 0): string {
  const parts = [p.name.padEnd(nameWidth)];
  if (p.items) {
    const c = p.items;
    parts.push(`${c.done}/${c.total}`);
    if (c.failed) parts.push(`● ${c.failed} failed`);
    if (c.caught) parts.push(`● ${c.caught} caught`);
    if (c.cached) parts.push(`● ${c.cached} cached`);
    if (c.interrupted) parts.push(`● ${c.interrupted} interrupted`);
  }
  if (p.status === "running") {
    if (p.eta_ms !== undefined) parts.push(`ETA ${p.eta_source === "history" ? "~" : ""}${formatShortDuration(p.eta_ms)}`);
    else if (p.elapsed_ms !== undefined) parts.push(`running ${formatShortDuration(p.elapsed_ms)}`);
  } else if (p.status !== "pending") {
    parts.push(p.elapsed_ms !== undefined ? `${p.status} in ${formatShortDuration(p.elapsed_ms)}` : p.status);
  }
  return parts.join("  ");
}

function span(start: string, end: string | undefined, now: number): number | undefined {
  const s = Date.parse(start);
  if (Number.isNaN(s)) return undefined;
  const e = end ? Date.parse(end) : now;
  return Number.isNaN(e) ? undefined : Math.max(0, e - s);
}

function byEnded(a: ItemTrace, b: ItemTrace): number {
  return (a.ended_at ?? "").localeCompare(b.ended_at ?? "");
}
