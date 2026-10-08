import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseDuration } from "../duration.js";
import { evaluateExpression } from "../expr.js";
import { stableStringify, type LoadedFlow } from "../loader.js";
import type { CacheConfig, CommandStep } from "../schema/flow.js";
import { now, type CacheTrace } from "../trace.js";
import type { ExecutionContext } from "./context.js";
import { resolveCommandInvocation, type CommandInvocation } from "./steps/command.js";

/** Bump when the key composition changes so old entries stop matching. */
const KEY_VERSION = 1;

export interface CacheEntry {
  key: string;
  output: unknown;
  created_at: string;
  run_id: string;
  duration_ms?: number;
  item_index?: number;
}

/** Per-run cache settings, built once by `runFlow`. */
export interface CacheContext {
  root: string;
  flow: string;
  runId: string;
  /** Steps that skip the lookup (but still store a fresh result). */
  refresh: Set<string>;
}

/** The result of looking a step (or map item) up: its key, plus the entry on a hit. */
export interface CacheProbe {
  key: string;
  dir: string;
  runId: string;
  invocation: CommandInvocation;
  hit?: CacheEntry;
}

/** The project root (folder holding workflows.yaml), else the flow folder. */
export function cacheRoot(loaded: Pick<LoadedFlow, "dir" | "project">): string {
  return loaded.project ? path.dirname(loaded.project.file) : loaded.dir;
}

export function cacheDir(root: string, flow: string, step: string): string {
  return path.join(root, ".dogyard", "cache", flow, step);
}

export function cacheConfigOf(step: CommandStep): CacheConfig | undefined {
  return step.cache === true ? {} : step.cache;
}

/** Fields that do not change a command's output, so editing them keeps the cache valid. */
const NON_KEY_FIELDS = ["mock", "needs", "description", "timeout", "retry", "catch", "terminal"] as const;

export interface CacheKeyInput {
  step: CommandStep;
  invocation: CommandInvocation;
  /** Folder that relative `cache.files` resolve from (the step cwd). */
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** sha256 over the key value (or input + argv), the step definition, `files` contents and `env` values. */
export async function computeCacheKey({ step, invocation, cwd, env = process.env }: CacheKeyInput): Promise<string> {
  const cfg = cacheConfigOf(step) ?? {};
  const key = cfg.key !== undefined ? await evaluateExpression(cfg.key, invocation.input) : { input: invocation.input, argv: invocation.argv };

  const def: Record<string, unknown> = { ...step };
  for (const f of NON_KEY_FIELDS) delete def[f];
  if (step.cache !== true && step.cache) {
    const { ttl: _ttl, ...rest } = step.cache;
    def.cache = rest;
  }

  const files: Record<string, string> = {};
  for (const pattern of cfg.files ?? []) {
    const matches = expandGlob(pattern, cwd);
    if (!matches.length) files[pattern] = "missing";
    for (const rel of matches) files[rel] = createHash("sha256").update(readFileSync(path.resolve(cwd, rel))).digest("hex");
  }

  const envValues: Record<string, string | null> = {};
  for (const name of cfg.env ?? []) envValues[name] = step.env?.[name] ?? env[name] ?? null;

  return createHash("sha256")
    .update(stableStringify({ v: KEY_VERSION, key, step: def, files, env: envValues }))
    .digest("hex");
}

/**
 * Look a cacheable command step up. Returns undefined when the step has no `cache`
 * or its key cannot be computed (the normal execution path then reports the error).
 */
export async function probeCache(
  cache: CacheContext | undefined,
  stepName: string,
  step: CommandStep,
  ctx: ExecutionContext,
  cwd: string,
): Promise<CacheProbe | undefined> {
  if (!cache || step.cache === undefined) return undefined;
  let invocation: CommandInvocation;
  let key: string;
  try {
    invocation = await resolveCommandInvocation(step, ctx);
    key = await computeCacheKey({ step, invocation, cwd });
  } catch {
    return undefined;
  }
  const dir = cacheDir(cache.root, cache.flow, stepName);
  const probe: CacheProbe = { key, dir, runId: cache.runId, invocation };
  if (!cache.refresh.has(stepName)) {
    const ttl = cacheConfigOf(step)?.ttl;
    const hit = readCacheEntry(dir, key, ttl !== undefined ? parseDuration(ttl) : undefined);
    if (hit) probe.hit = hit;
  }
  return probe;
}

/** Trace info for a hit. */
export function hitTrace(probe: CacheProbe): CacheTrace {
  return { key: probe.key, hit: true, source_run_id: probe.hit!.run_id, created_at: probe.hit!.created_at };
}

/** Store a successful result; a write failure is recorded in the trace, never fails the step. */
export function storeResult(probe: CacheProbe, output: unknown, extra: { duration_ms?: number; item_index?: number } = {}): CacheTrace {
  const entry: CacheEntry = { key: probe.key, output, created_at: now(), run_id: probe.runId, ...extra };
  try {
    writeCacheEntry(probe.dir, entry);
    return { key: probe.key, hit: false };
  } catch (err) {
    return { key: probe.key, hit: false, store_error: (err as Error).message };
  }
}

export function readCacheEntry(dir: string, key: string, ttlMs?: number): CacheEntry | undefined {
  const file = path.join(dir, `${key}.json`);
  if (!existsSync(file)) return undefined;
  let entry: CacheEntry;
  try {
    entry = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
  } catch {
    return undefined;
  }
  if (isExpired(entry, ttlMs)) return undefined;
  return entry;
}

export function writeCacheEntry(dir: string, entry: CacheEntry): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.key}.json`);
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, file);
}

function isExpired(entry: CacheEntry, ttlMs: number | undefined): boolean {
  return ttlMs !== undefined && Date.now() - Date.parse(entry.created_at) >= ttlMs;
}

export interface CacheListing extends CacheEntry {
  step: string;
  file: string;
  expired: boolean;
}

/** The current `ttl` of each cacheable step (top-level command or map command sub-step). */
function stepTtls(loaded: LoadedFlow): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>();
  for (const [name, step] of Object.entries(loaded.flow.steps)) {
    const cmd = step.type === "command" ? step : step.type === "map" && step.step.type === "command" ? step.step : undefined;
    const ttl = cmd ? cacheConfigOf(cmd)?.ttl : undefined;
    out.set(name, ttl !== undefined ? parseDuration(ttl) : undefined);
  }
  return out;
}

/** Every entry in a flow's cache store (optionally one step's), oldest first. */
export function listCacheEntries(loaded: LoadedFlow, step?: string): CacheListing[] {
  const base = path.join(cacheRoot(loaded), ".dogyard", "cache", loaded.flow.name);
  if (!existsSync(base)) return [];
  const ttls = stepTtls(loaded);
  const out: CacheListing[] = [];
  for (const s of readdirSync(base).sort()) {
    if (step !== undefined && s !== step) continue;
    const dir = path.join(base, s);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const file = path.join(dir, f);
      try {
        const entry = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
        out.push({ ...entry, step: s, file, expired: isExpired(entry, ttls.get(s)) });
      } catch {
        /* ignore unreadable entries */
      }
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Delete cache entries (all, one step's, or only expired ones). Returns how many were removed. */
export function clearCache(loaded: LoadedFlow, opts: { step?: string; expiredOnly?: boolean } = {}): number {
  const entries = listCacheEntries(loaded, opts.step).filter((e) => !opts.expiredOnly || e.expired);
  for (const e of entries) rmSync(e.file, { force: true });
  return entries.length;
}

const GLOB_CHARS = /[*?]/;
const GLOB_SKIP_DIRS = new Set(["node_modules", ".git", ".dogyard", ".runs"]);

/**
 * Expand a simple glob (`*`, `**`, `?`) relative to `cwd`; returns sorted posix
 * paths relative to `cwd`. A pattern without glob characters matches itself if it exists.
 */
export function expandGlob(pattern: string, cwd: string): string[] {
  const norm = path.posix.normalize(pattern.split(path.sep).join("/"));
  if (!GLOB_CHARS.test(norm)) return existsSync(path.resolve(cwd, norm)) && statSync(path.resolve(cwd, norm)).isFile() ? [norm] : [];

  const segments = norm.split("/");
  const firstGlob = segments.findIndex((s) => GLOB_CHARS.test(s));
  const base = path.resolve(cwd, segments.slice(0, firstGlob).join("/") || ".");
  const re = globToRegExp(norm);
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!GLOB_SKIP_DIRS.has(e.name)) walk(abs);
      } else if (e.isFile()) {
        const rel = path.relative(cwd, abs).split(path.sep).join("/");
        if (re.test(rel)) out.push(rel);
      }
    }
  };
  walk(base);
  return out.sort();
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
