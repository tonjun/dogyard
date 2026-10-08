import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { FlowErrorJSON } from "./errors.js";
import type { StepType } from "./schema/flow.js";

export type RunStatus = "running" | "succeeded" | "failed" | "interrupted";
export type StepStatus = "pending" | "running" | "succeeded" | "caught" | "failed" | "skipped" | "interrupted";

export interface AttemptTrace {
  started_at: string;
  ended_at?: string;
  error?: FlowErrorJSON;
}

/** Cache outcome of a command step (or map item) that declares `cache`. */
export interface CacheTrace {
  key: string;
  /** true: output reused from the store; false: executed (and stored). */
  hit: boolean;
  /** Hits: the run that produced the reused output, and when. */
  source_run_id?: string;
  created_at?: string;
  /** Misses: why the fresh result could not be stored. */
  store_error?: string;
}

export interface ItemTrace {
  index: number;
  status: StepStatus;
  input?: unknown;
  output?: unknown;
  error?: FlowErrorJSON;
  attempts: AttemptTrace[];
  exit_code?: number;
  stderr?: string;
  duration_ms?: number;
  /** Wall-clock span of the item across all attempts (incl. retry backoff). */
  started_at?: string;
  ended_at?: string;
  cache?: CacheTrace;
}

export interface StepTrace {
  name: string;
  type: StepType;
  status: StepStatus;
  attempts: AttemptTrace[];
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  input?: unknown;
  output?: unknown;
  error?: FlowErrorJSON;
  /** Command steps: exit code / stderr of the final attempt. */
  exit_code?: number;
  stderr?: string;
  argv?: string[];
  /** Choice steps: the selected target. */
  selected?: string;
  /** Map steps: per-item state (the checkpoint for item-granular resume). */
  items?: ItemTrace[];
  /** Map steps: the effective item concurrency (used for ETA). */
  max_concurrency?: number;
  /** Why a step was skipped. */
  skip_reason?: string;
  cache?: CacheTrace;
}

export interface RunTrace {
  schema_version: 1;
  run_id: string;
  flow: { name: string; version: string; hash: string; dir?: string };
  status: RunStatus;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  resume_count: number;
  trigger: unknown;
  output?: unknown;
  error?: FlowErrorJSON;
  /** Name of the terminal step that ended the run, if any. */
  terminal_step?: string;
  steps: StepTrace[];
}

export function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${ts}-${randomBytes(3).toString("hex")}`;
}

export function now(): string {
  return new Date().toISOString();
}

/** Atomically write a trace (tmp file + rename) so readers never see a torn file. */
export function writeTrace(file: string, trace: RunTrace): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(trace, null, 2));
  renameSync(tmp, file);
}

export function readTrace(file: string): RunTrace {
  return JSON.parse(readFileSync(file, "utf8")) as RunTrace;
}

export function runsDir(flowDir: string, traceDir?: string): string {
  return traceDir ? path.resolve(traceDir) : path.join(flowDir, ".runs");
}

export function traceFile(flowDir: string, runId: string, traceDir?: string): string {
  return path.join(runsDir(flowDir, traceDir), runId, "trace.json");
}

export function listRuns(flowDir: string, traceDir?: string): RunTrace[] {
  const dir = runsDir(flowDir, traceDir);
  if (!existsSync(dir)) return [];
  const runs: RunTrace[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const f = path.join(dir, entry.name, "trace.json");
    if (!existsSync(f)) continue;
    try {
      runs.push(readTrace(f));
    } catch {
      /* ignore unreadable traces */
    }
  }
  return runs.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/**
 * Up to `limit` most recent runs, newest first, reading only those traces
 * (run ids start with a UTC timestamp, so directory names sort by start time).
 */
export function recentRuns(flowDir: string, limit: number, traceDir?: string): RunTrace[] {
  const dir = runsDir(flowDir, traceDir);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  const runs: RunTrace[] = [];
  for (const name of names) {
    if (runs.length >= limit) break;
    const f = path.join(dir, name, "trace.json");
    if (!existsSync(f)) continue;
    try {
      runs.push(readTrace(f));
    } catch {
      /* ignore unreadable traces */
    }
  }
  return runs;
}

/** The most recently started run, if any. */
export function latestRun(flowDir: string, traceDir?: string): RunTrace | undefined {
  return listRuns(flowDir, traceDir).at(-1);
}

/** Ordered list of step names that actually executed (succeeded/caught/failed), in completion order. */
export function executedPath(trace: RunTrace): string[] {
  return trace.steps
    .filter((s) => s.status === "succeeded" || s.status === "caught" || s.status === "failed")
    .sort((a, b) => (a.ended_at ?? "").localeCompare(b.ended_at ?? ""))
    .map((s) => s.name);
}

/**
 * Cacheable work (command steps / map items that declare `cache`) reused from the
 * store vs actually executed. Pending or skipped work is not counted.
 */
export function cacheStats(trace: RunTrace): { cached: number; executed: number } {
  let cached = 0;
  let executed = 0;
  const count = (t: { status: StepStatus; cache?: CacheTrace }) => {
    if (!t.cache) return;
    if (t.cache.hit) cached++;
    else if (t.status === "succeeded" || t.status === "caught" || t.status === "failed") executed++;
  };
  for (const s of trace.steps) {
    count(s);
    s.items?.forEach(count);
  }
  return { cached, executed };
}
