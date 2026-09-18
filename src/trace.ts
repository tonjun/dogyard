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
  /** Why a step was skipped. */
  skip_reason?: string;
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

/** Ordered list of step names that actually executed (succeeded/caught/failed), in completion order. */
export function executedPath(trace: RunTrace): string[] {
  return trace.steps
    .filter((s) => s.status === "succeeded" || s.status === "caught" || s.status === "failed")
    .sort((a, b) => (a.ended_at ?? "").localeCompare(b.ended_at ?? ""))
    .map((s) => s.name);
}
