import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { flowSchema, type FlowDefinition, type FlowConfig } from "./schema/flow.js";
import { PROJECT_CONFIG_FILENAMES, projectConfigSchema, type ProjectConfig } from "./schema/project.js";

export const FLOW_FILENAMES = ["flow.yaml", "flow.yml"] as const;

export interface LoadedFlow {
  /** Absolute path of the flow folder. */
  dir: string;
  /** Absolute path of the flow definition file. */
  file: string;
  /** Validated definition with project defaults merged into `config`. */
  flow: FlowDefinition;
  /** The flow definition as written (before project config merge). */
  raw: unknown;
  /** sha256 over the normalised flow definition; used to guard resume. */
  hash: string;
  project?: { file: string; config: ProjectConfig };
}

export class LoadError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
    readonly file?: string,
  ) {
    super(message);
    this.name = "LoadError";
  }
}

/** Resolve a user-supplied flow path (folder or flow.yaml file) to {dir, file}. */
export function resolveFlowPath(input: string): { dir: string; file: string } {
  const abs = path.resolve(input);
  if (!existsSync(abs)) throw new LoadError(`Flow path not found: ${abs}`);
  if (statSync(abs).isFile()) return { dir: path.dirname(abs), file: abs };
  for (const name of FLOW_FILENAMES) {
    const f = path.join(abs, name);
    if (existsSync(f)) return { dir: abs, file: f };
  }
  throw new LoadError(`No flow.yaml found in ${abs}`);
}

export function readYamlFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new LoadError(`Cannot read ${file}: ${(err as Error).message}`, [], file);
  }
  try {
    return YAML.parse(text);
  } catch (err) {
    throw new LoadError(`Invalid YAML in ${file}: ${(err as Error).message}`, [], file);
  }
}

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}

/** Parse + validate a raw flow object. Throws LoadError with per-field issues. */
export function parseFlow(raw: unknown, file = "<inline>"): FlowDefinition {
  const result = flowSchema.safeParse(raw);
  if (!result.success) {
    throw new LoadError(`Invalid flow definition in ${file}`, formatZodIssues(result.error), file);
  }
  return result.data;
}

export function computeFlowHash(raw: unknown): string {
  return createHash("sha256").update(stableStringify(raw)).digest("hex");
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Walk up from `startDir` looking for a project config file. */
export function findProjectConfig(startDir: string): { file: string; config: ProjectConfig } | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of PROJECT_CONFIG_FILENAMES) {
      const f = path.join(dir, name);
      if (existsSync(f)) {
        const raw = readYamlFile(f) ?? {};
        const parsed = projectConfigSchema.safeParse(raw);
        if (!parsed.success) throw new LoadError(`Invalid project config in ${f}`, formatZodIssues(parsed.error), f);
        return { file: f, config: parsed.data };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function mergeConfig(base: FlowConfig | undefined, override: FlowConfig): FlowConfig {
  return { ...(base ?? {}), ...stripUndefined(override) };
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export interface LoadOptions {
  /** Set false to skip project config discovery. */
  project?: boolean;
}

export function loadFlow(input: string, opts: LoadOptions = {}): LoadedFlow {
  const { dir, file } = resolveFlowPath(input);
  const raw = readYamlFile(file);
  const flow = parseFlow(raw, file);
  const hash = computeFlowHash(raw);
  const loaded: LoadedFlow = { dir, file, flow, raw, hash };
  if (opts.project !== false) {
    const project = findProjectConfig(dir);
    if (project) {
      loaded.project = project;
      loaded.flow = { ...flow, config: mergeConfig(project.config.config, flow.config) };
    }
  }
  return loaded;
}

/** Load a flow from an already-parsed object (used by tests). */
export function loadFlowFromObject(raw: unknown, dir = process.cwd()): LoadedFlow {
  const flow = parseFlow(raw);
  return { dir, file: path.join(dir, "flow.yaml"), flow, raw, hash: computeFlowHash(raw) };
}
