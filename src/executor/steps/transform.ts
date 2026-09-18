import { evaluateExpression } from "../../expr.js";
import type { PassStep, TransformStep } from "../../schema/flow.js";
import type { ExecutionContext } from "../context.js";

/** `transform` and `pass` both emit their resolved `input` (or `{}` when absent). */
export async function executeTransformStep(step: TransformStep | PassStep, ctx: ExecutionContext): Promise<{ input: unknown; output: unknown }> {
  const value = step.input !== undefined ? await evaluateExpression(step.input, ctx) : {};
  return { input: value, output: value === undefined ? null : value };
}
