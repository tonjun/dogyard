import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML, { isMap, isScalar, type Node } from "yaml";
import { DEFAULT_MAX_CONCURRENCY, DEFAULT_RETRY } from "../executor/run.js";
import { resolveStepCwd } from "../executor/steps/command.js";
import { buildGraph, type GraphEdge, type GraphNode } from "../graph.js";
import type { LoadedFlow } from "../loader.js";
import type { FlowConfig, Step } from "../schema/flow.js";

export type ConfigSource = "flow" | "project" | "default";

export interface StepInfo extends GraphNode {
  needs: string[];
  /** The step as validated, minus its inline `mock` (test-only). */
  definition: Record<string, unknown>;
  /** The step's own lines from flow.yaml, dedented. */
  yaml?: string;
  /** Command steps (and map command sub-steps): cwd relative to the flow folder ("." for the folder itself). */
  cwd?: string;
  has_tests: boolean;
  has_evals: boolean;
}

/** Everything the UI shows about a flow definition (no run state). */
export interface FlowInfo {
  name: string;
  version: string;
  description?: string;
  dir: string;
  /** `dir` relative to the server's cwd when inside it, for copyable commands. */
  display_dir: string;
  file: string;
  project_file?: string;
  trigger_schema?: Record<string, unknown>;
  config: Record<string, { value: unknown; source: ConfigSource }>;
  steps: StepInfo[];
  edges: GraphEdge[];
  order: string[];
  sinks: string[];
  has_tests: boolean;
  has_evals: boolean;
}

const CONFIG_KEYS = ["max_concurrency", "run_timeout", "default_timeout", "default_retry"] as const;
const CONFIG_DEFAULTS: Partial<Record<(typeof CONFIG_KEYS)[number], unknown>> = {
  max_concurrency: DEFAULT_MAX_CONCURRENCY,
  default_retry: DEFAULT_RETRY,
};

export function describeFlow(loaded: LoadedFlow): FlowInfo {
  const { flow, dir } = loaded;
  const graph = buildGraph(flow);
  const snippets = stepSnippets(loaded.file);
  const steps: StepInfo[] = graph.nodes.map((node) => {
    const step = flow.steps[node.name]!;
    const info: StepInfo = {
      ...node,
      needs: step.needs,
      definition: withoutMock(step),
      has_tests: hasFiles(path.join(dir, "steps", node.name, "tests"), ".test.yaml"),
      has_evals: existsSync(path.join(dir, "steps", node.name, "evals", "eval.yaml")),
    };
    const yaml = snippets.get(node.name);
    if (yaml) info.yaml = yaml;
    const cwd = commandCwd(dir, node.name, step);
    if (cwd !== undefined) info.cwd = cwd;
    return info;
  });

  const info: FlowInfo = {
    name: flow.name,
    version: flow.version,
    dir,
    display_dir: displayPath(dir),
    file: loaded.file,
    config: effectiveConfig(loaded),
    steps,
    edges: graph.edges,
    order: graph.order,
    sinks: graph.sinks,
    has_tests: hasFiles(path.join(dir, "tests"), ".test.yaml"),
    has_evals: existsSync(path.join(dir, "evals", "eval.yaml")),
  };
  if (flow.description) info.description = flow.description;
  if (flow.trigger_schema) info.trigger_schema = flow.trigger_schema;
  if (loaded.project) info.project_file = loaded.project.file;
  return info;
}

/** Each config value with where it came from: the flow, workflows.yaml, or the engine default. */
function effectiveConfig(loaded: LoadedFlow): FlowInfo["config"] {
  const own = ((loaded.raw as { config?: FlowConfig } | undefined)?.config ?? {}) as Record<string, unknown>;
  const project = (loaded.project?.config.config ?? {}) as Record<string, unknown>;
  const merged = loaded.flow.config as Record<string, unknown>;
  const out: FlowInfo["config"] = {};
  for (const key of CONFIG_KEYS) {
    if (own[key] !== undefined) out[key] = { value: merged[key], source: "flow" };
    else if (project[key] !== undefined) out[key] = { value: merged[key], source: "project" };
    else if (CONFIG_DEFAULTS[key] !== undefined) out[key] = { value: CONFIG_DEFAULTS[key], source: "default" };
  }
  return out;
}

function commandCwd(dir: string, name: string, step: Step): string | undefined {
  const cmd = step.type === "command" ? step : step.type === "map" && step.step.type === "command" ? step.step : undefined;
  if (!cmd) return undefined;
  return path.relative(dir, resolveStepCwd(dir, name, cmd)) || ".";
}

function withoutMock(step: Step): Record<string, unknown> {
  const { mock: _mock, ...rest } = step as Step & { mock?: unknown };
  if (rest.type === "map") {
    const { mock: _sub, ...sub } = rest.step as typeof rest.step & { mock?: unknown };
    return { ...rest, step: sub };
  }
  return rest;
}

function hasFiles(dir: string, suffix: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.endsWith(suffix));
  } catch {
    return false;
  }
}

/** Slice each step's `name: …` block out of flow.yaml (comments inside it kept), dedented. */
export function stepSnippets(file: string): Map<string, string> {
  const out = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  const doc = YAML.parseDocument(text);
  const steps = doc.get("steps", true);
  if (!isMap(steps)) return out;
  for (const pair of steps.items) {
    const key = pair.key as Node | null;
    const value = pair.value as Node | null;
    if (!isScalar(key) || !key.range || !value?.range) continue;
    const start = text.lastIndexOf("\n", key.range[0]) + 1;
    out.set(String(key.value), dedent(text.slice(start, value.range[1]).trimEnd()));
  }
  return out;
}

function dedent(s: string): string {
  const lines = s.split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((l) => l.slice(indent)).join("\n");
}

function displayPath(dir: string): string {
  const rel = path.relative(process.cwd(), dir);
  return !rel ? "." : rel.startsWith("..") || path.isAbsolute(rel) ? dir : rel;
}
