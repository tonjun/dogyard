import type { StepTrace } from "../trace.js";

export interface StepContextEntry {
  status: string;
  output?: unknown;
}

export interface ExecutionContext {
  trigger: unknown;
  steps: Record<string, StepContextEntry>;
  item?: unknown;
  index?: number;
  /** Map sub-steps: number of items in the map. */
  total?: number;
}

/** Build the JSONata evaluation context from the current step states. */
export function buildContext(trigger: unknown, steps: Iterable<StepTrace>, extra?: { item: unknown; index: number; total?: number }): ExecutionContext {
  const ctx: ExecutionContext = { trigger, steps: {} };
  for (const s of steps) {
    const entry: StepContextEntry = { status: s.status };
    if (s.status === "succeeded" || s.status === "caught") entry.output = s.output;
    ctx.steps[s.name] = entry;
  }
  if (extra) {
    ctx.item = extra.item;
    ctx.index = extra.index;
    if (extra.total !== undefined) ctx.total = extra.total;
  }
  return ctx;
}
