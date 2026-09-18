import { FlowError } from "../../errors.js";
import { evaluateExpression } from "../../expr.js";
import type { ChoiceStep } from "../../schema/flow.js";
import type { ExecutionContext } from "../context.js";

export interface ChoiceOutcome {
  selected: string;
  matched?: string;
  output: { selected: string; matched: string | null };
}

/** Evaluate branch conditions in order; first truthy wins, else `default`. */
export async function executeChoiceStep(step: ChoiceStep, ctx: ExecutionContext, stepName: string): Promise<ChoiceOutcome> {
  for (const b of step.branches) {
    const v = await evaluateExpression(b.when, ctx);
    if (isTruthy(v)) return { selected: b.next, matched: b.when, output: { selected: b.next, matched: b.when } };
  }
  if (step.default) return { selected: step.default, output: { selected: step.default, matched: null } };
  throw new FlowError("expression_error", `No choice branch matched and no default is set`, { step: stepName });
}

function isTruthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}
