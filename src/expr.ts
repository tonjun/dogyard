import jsonata, { type Expression } from "jsonata";
import { FlowError } from "./errors.js";

/** Prefix marking an argv entry (or other string slot) as a JSONata expression. */
export const EXPR_PREFIX = "=";

const cache = new Map<string, Expression>();

export function compileExpression(source: string): Expression {
  let expr = cache.get(source);
  if (!expr) {
    try {
      expr = jsonata(source);
    } catch (err) {
      const e = err as { message?: string; position?: number };
      throw new FlowError("expression_error", `Invalid JSONata expression: ${e.message ?? String(err)}`, {
        details: { expression: source, position: e.position },
        cause: err,
      });
    }
    cache.set(source, expr);
  }
  return expr;
}

/** Evaluate a JSONata expression against a context; wraps failures as `expression_error`. */
export async function evaluateExpression(source: string, context: unknown, bindings?: Record<string, unknown>): Promise<unknown> {
  const expr = compileExpression(source);
  try {
    const result = await expr.evaluate(context, bindings);
    return normalise(result);
  } catch (err) {
    const e = err as { message?: string; code?: string; token?: string };
    throw new FlowError("expression_error", `JSONata evaluation failed: ${e.message ?? String(err)}`, {
      details: { expression: source, code: e.code, token: e.token },
      cause: err,
    });
  }
}

/** Resolve an argv-style array: entries starting with `=` are evaluated, everything else is literal. */
export async function resolveTemplatedArgs(args: readonly string[], context: unknown): Promise<string[]> {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.startsWith(EXPR_PREFIX)) {
      const value = await evaluateExpression(arg.slice(EXPR_PREFIX.length), context);
      if (value === undefined || value === null) continue; // absent value drops the arg
      if (Array.isArray(value)) {
        for (const v of value) out.push(stringifyArg(v));
      } else {
        out.push(stringifyArg(value));
      }
    } else {
      out.push(arg);
    }
  }
  return out;
}

function stringifyArg(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * JSONata returns sequences with special flags and `undefined` for no-match;
 * convert to plain JSON so traces and downstream tools see ordinary values.
 */
function normalise(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "function") return undefined;
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === "object") {
    return JSON.parse(JSON.stringify(value));
  }
  return value;
}

/** Syntax-check an expression without evaluating (used by `validate`). */
export function checkExpressionSyntax(source: string): FlowError | undefined {
  try {
    compileExpression(source);
    return undefined;
  } catch (err) {
    return err as FlowError;
  }
}
