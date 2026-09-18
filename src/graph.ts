import type { FlowDefinition, Step } from "./schema/flow.js";

export interface GraphEdge {
  from: string;
  to: string;
  /** `needs` = explicit dependency; `choice` = implicit edge from a choice step to a branch target. */
  kind: "needs" | "choice";
  /** For choice edges: the branch condition, or "default". */
  label?: string;
}

export interface GraphNode {
  name: string;
  type: Step["type"];
  terminal?: "success" | "fail";
  description?: string;
}

export interface FlowGraph {
  flow: { name: string; version: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Upstream dependencies per node (explicit needs + implicit choice sources). */
  deps: Map<string, Set<string>>;
  /** Downstream dependents per node. */
  dependents: Map<string, Set<string>>;
  /** Names of steps that are the target of at least one choice branch. */
  choiceTargets: Map<string, Set<string>>;
  /** Steps nobody depends on (sinks). */
  sinks: string[];
  /** Topological order (only valid when there are no cycles). */
  order: string[];
  /** Cycle found during build, if any (list of names forming the cycle). */
  cycle?: string[];
}

export function buildGraph(flow: FlowDefinition): FlowGraph {
  const names = Object.keys(flow.steps);
  const nodes: GraphNode[] = names.map((name) => {
    const step = flow.steps[name]!;
    const n: GraphNode = { name, type: step.type };
    if (step.terminal) n.terminal = step.terminal;
    if (step.description) n.description = step.description;
    return n;
  });
  const edges: GraphEdge[] = [];
  const deps = new Map<string, Set<string>>(names.map((n) => [n, new Set<string>()]));
  const dependents = new Map<string, Set<string>>(names.map((n) => [n, new Set<string>()]));
  const choiceTargets = new Map<string, Set<string>>();

  const addEdge = (from: string, to: string, kind: GraphEdge["kind"], label?: string) => {
    edges.push(label !== undefined ? { from, to, kind, label } : { from, to, kind });
    deps.get(to)?.add(from);
    dependents.get(from)?.add(to);
  };

  for (const name of names) {
    const step = flow.steps[name]!;
    for (const dep of step.needs) addEdge(dep, name, "needs");
    if (step.type === "choice") {
      for (const b of step.branches) {
        addEdge(name, b.next, "choice", b.when);
        if (!choiceTargets.has(b.next)) choiceTargets.set(b.next, new Set());
        choiceTargets.get(b.next)!.add(name);
      }
      if (step.default) {
        addEdge(name, step.default, "choice", "default");
        if (!choiceTargets.has(step.default)) choiceTargets.set(step.default, new Set());
        choiceTargets.get(step.default)!.add(name);
      }
    }
  }

  // Kahn's algorithm for topo order + cycle detection.
  const indeg = new Map<string, number>(names.map((n) => [n, 0]));
  for (const n of names) indeg.set(n, [...(deps.get(n) ?? [])].filter((d) => deps.has(d)).length);
  const queue = names.filter((n) => indeg.get(n) === 0);
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const d of dependents.get(n) ?? []) {
      if (!indeg.has(d)) continue;
      indeg.set(d, indeg.get(d)! - 1);
      if (indeg.get(d) === 0) queue.push(d);
    }
  }
  let cycle: string[] | undefined;
  if (order.length < names.length) cycle = findCycle(names.filter((n) => !order.includes(n)), deps);

  const sinks = names.filter((n) => (dependents.get(n)?.size ?? 0) === 0);
  const g: FlowGraph = { flow: { name: flow.name, version: flow.version }, nodes, edges, deps, dependents, choiceTargets, sinks, order };
  if (cycle) g.cycle = cycle;
  return g;
}

function findCycle(candidates: string[], deps: Map<string, Set<string>>): string[] {
  const set = new Set(candidates);
  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const dfs = (n: string): string[] | undefined => {
    visited.add(n);
    stack.push(n);
    onStack.add(n);
    for (const d of deps.get(n) ?? []) {
      if (!set.has(d)) continue;
      if (onStack.has(d)) return stack.slice(stack.indexOf(d)).concat(d);
      if (!visited.has(d)) {
        const r = dfs(d);
        if (r) return r;
      }
    }
    stack.pop();
    onStack.delete(n);
    return undefined;
  };
  for (const c of candidates) {
    if (!visited.has(c)) {
      const r = dfs(c);
      if (r) return r;
    }
  }
  return candidates;
}

// ---------- Export formats ----------

export type GraphFormat = "json" | "dot" | "mermaid";

export function exportGraph(graph: FlowGraph, format: GraphFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify({ flow: graph.flow, nodes: graph.nodes, edges: graph.edges }, null, 2);
    case "dot":
      return toDot(graph);
    case "mermaid":
      return toMermaid(graph);
  }
}

function toDot(g: FlowGraph): string {
  const lines = [`digraph "${g.flow.name}" {`, "  rankdir=LR;", "  node [shape=box, fontname=Helvetica];"];
  for (const n of g.nodes) {
    const attrs = [`label="${n.name}\\n(${n.type})"`];
    if (n.type === "choice") attrs.push("shape=diamond");
    if (n.type === "map") attrs.push("shape=box3d");
    if (n.terminal === "success") attrs.push("style=filled", 'fillcolor="#d4edda"');
    if (n.terminal === "fail") attrs.push("style=filled", 'fillcolor="#f8d7da"');
    lines.push(`  "${n.name}" [${attrs.join(", ")}];`);
  }
  for (const e of g.edges) {
    const attrs = e.kind === "choice" ? ` [style=dashed, label="${escapeDot(e.label ?? "")}"]` : "";
    lines.push(`  "${e.from}" -> "${e.to}"${attrs};`);
  }
  lines.push("}");
  return lines.join("\n");
}

function escapeDot(s: string): string {
  return s.replace(/"/g, '\\"');
}

function toMermaid(g: FlowGraph): string {
  const lines = ["flowchart LR"];
  for (const n of g.nodes) {
    const label = `${n.name}<br/>(${n.type})`;
    const shape = n.type === "choice" ? `{"${label}"}` : n.type === "map" ? `[["${label}"]]` : `["${label}"]`;
    lines.push(`  ${id(n.name)}${shape}`);
    if (n.terminal === "success") lines.push(`  style ${id(n.name)} fill:#d4edda`);
    if (n.terminal === "fail") lines.push(`  style ${id(n.name)} fill:#f8d7da`);
  }
  for (const e of g.edges) {
    if (e.kind === "choice") lines.push(`  ${id(e.from)} -. "${(e.label ?? "").replace(/"/g, "#quot;")}" .-> ${id(e.to)}`);
    else lines.push(`  ${id(e.from)} --> ${id(e.to)}`);
  }
  return lines.join("\n");
}

function id(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
