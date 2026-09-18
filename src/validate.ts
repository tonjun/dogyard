import { buildGraph, type FlowGraph } from "./graph.js";
import { checkExpressionSyntax } from "./expr.js";
import { LoadError, parseFlow } from "./loader.js";
import type { FlowDefinition, Step } from "./schema/flow.js";
import { SCHEMA_VERSION } from "./schema/flow.js";

export interface Diagnostic {
  level: "error" | "warning";
  message: string;
  step?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  flow?: FlowDefinition;
  graph?: FlowGraph;
}

/** Validate a raw (parsed YAML) flow object: structure, references, DAG, expressions. */
export function validateRawFlow(raw: unknown, file?: string): ValidationResult {
  let flow: FlowDefinition;
  try {
    flow = parseFlow(raw, file);
  } catch (err) {
    if (err instanceof LoadError) {
      const errors = (err.issues.length ? err.issues : [err.message]).map((m) => ({ level: "error" as const, message: m }));
      return { ok: false, errors, warnings: [] };
    }
    throw err;
  }
  return validateFlow(flow);
}

export function validateFlow(flow: FlowDefinition): ValidationResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const names = new Set(Object.keys(flow.steps));
  const err = (message: string, step?: string) => errors.push(step ? { level: "error", message, step } : { level: "error", message });
  const warn = (message: string, step?: string) => warnings.push(step ? { level: "warning", message, step } : { level: "warning", message });

  if (flow.schema_version !== SCHEMA_VERSION) err(`Unsupported schema_version ${flow.schema_version} (engine supports ${SCHEMA_VERSION})`);

  const checkExpr = (source: string | undefined, what: string, step: string) => {
    if (source === undefined) return;
    const e = checkExpressionSyntax(source);
    if (e) err(`${what}: ${e.message}`, step);
  };

  for (const [name, step] of Object.entries(flow.steps)) {
    for (const dep of step.needs) {
      if (dep === name) err(`step depends on itself`, name);
      else if (!names.has(dep)) err(`needs unknown step "${dep}"`, name);
    }
    checkExpr(step.input, "input", name);
    checkStepCommon(step, name, warn);

    if (step.type === "choice") {
      for (const b of step.branches) {
        if (!names.has(b.next)) err(`branch targets unknown step "${b.next}"`, name);
        if (b.next === name) err(`branch targets itself`, name);
        checkExpr(b.when, `branch condition "${b.when}"`, name);
      }
      if (step.default && !names.has(step.default)) err(`default targets unknown step "${step.default}"`, name);
      if (!step.default) warn(`choice has no default; the run fails with expression_error if no branch matches`, name);
      if (step.terminal) err(`choice steps cannot be terminal`, name);
      if (step.input) warn(`input on a choice step is evaluated but unused`, name);
    }
    if (step.type === "map") {
      checkExpr(step.over, "over", name);
      checkExpr(step.step.input, "step.input", name);
      if (step.step.needs.length) warn(`map sub-step "needs" is ignored`, name);
      if (step.step.terminal) err(`map sub-step cannot be terminal`, name);
      checkStepCommon(step.step, `${name}.step`, warn);
    }
    if (step.type === "command" && step.command.length === 0) err(`command must not be empty`, name);
  }

  const graph = buildGraph(flow);
  if (graph.cycle) err(`dependency cycle: ${graph.cycle.join(" -> ")}`);

  // A choice target should not also be reachable through a plain `needs` chain that
  // bypasses the choice, otherwise it would run even when not selected.
  for (const [target, choices] of graph.choiceTargets) {
    const step = flow.steps[target];
    if (!step) continue;
    if (step.needs.some((n) => !choices.has(n))) {
      warn(`is a choice target but also has other needs (${step.needs.join(", ")}); it only runs when selected AND its needs succeed`, target);
    }
  }

  const result: ValidationResult = { ok: errors.length === 0, errors, warnings, flow };
  if (!graph.cycle) result.graph = graph;
  return result;
}

function checkStepCommon(step: Step | FlowDefinition["steps"][string], name: string, warn: (m: string, s?: string) => void): void {
  if (step.retry && step.retry.max_attempts === 1) warn(`retry.max_attempts is 1, retry has no effect`, name);
  if (step.catch) {
    const seenAny = step.catch.findIndex((c) => c.error_type === "any");
    if (seenAny >= 0 && seenAny < step.catch.length - 1) warn(`catch clauses after "any" are unreachable`, name);
  }
}

export function formatDiagnostics(result: ValidationResult): string {
  const lines: string[] = [];
  for (const d of [...result.errors, ...result.warnings]) {
    lines.push(`${d.level === "error" ? "error" : "warning"}${d.step ? ` [${d.step}]` : ""}: ${d.message}`);
  }
  return lines.join("\n");
}
