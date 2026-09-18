/**
 * Error taxonomy for the workflow engine.
 *
 * Leaf types are concrete failures; `command_failure` is a category covering
 * every way a command step can fail; `any` matches everything. Retry `on:` and
 * catch `error_type:` patterns match by exact type or by category.
 */
export const LEAF_ERROR_TYPES = [
  "nonzero_exit",
  "timeout",
  "spawn_error",
  "output_parse",
  "schema_validation",
  "expression_error",
  "terminal_failure",
  "interrupted",
  "internal",
] as const;

export const CATEGORY_ERROR_TYPES = ["command_failure", "any"] as const;

export const ERROR_TYPES = [...LEAF_ERROR_TYPES, ...CATEGORY_ERROR_TYPES] as const;

export type LeafErrorType = (typeof LEAF_ERROR_TYPES)[number];
export type ErrorPattern = (typeof ERROR_TYPES)[number];

const CATEGORIES: Record<(typeof CATEGORY_ERROR_TYPES)[number], readonly LeafErrorType[]> = {
  command_failure: ["nonzero_exit", "timeout", "spawn_error", "output_parse"],
  any: LEAF_ERROR_TYPES,
};

export interface FlowErrorJSON {
  type: LeafErrorType;
  message: string;
  step?: string;
  details?: unknown;
}

export class FlowError extends Error {
  readonly type: LeafErrorType;
  readonly step?: string;
  readonly details?: unknown;

  constructor(type: LeafErrorType, message: string, opts: { step?: string; details?: unknown; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "FlowError";
    this.type = type;
    this.step = opts.step;
    this.details = opts.details;
  }

  withStep(step: string): FlowError {
    if (this.step === step) return this;
    return new FlowError(this.type, this.message, { step, details: this.details, cause: this.cause });
  }

  toJSON(): FlowErrorJSON {
    const json: FlowErrorJSON = { type: this.type, message: this.message };
    if (this.step !== undefined) json.step = this.step;
    if (this.details !== undefined) json.details = this.details;
    return json;
  }

  static fromJSON(json: FlowErrorJSON): FlowError {
    return new FlowError(json.type, json.message, { step: json.step, details: json.details });
  }
}

/** Does `type` match the pattern (exact leaf type or a category)? */
export function errorMatches(type: LeafErrorType, pattern: ErrorPattern): boolean {
  if (pattern === type) return true;
  const members = (CATEGORIES as Record<string, readonly LeafErrorType[] | undefined>)[pattern];
  return members !== undefined && members.includes(type);
}

export function errorMatchesAny(type: LeafErrorType, patterns: readonly ErrorPattern[]): boolean {
  return patterns.some((p) => errorMatches(type, p));
}

/** Normalise anything thrown into a FlowError (unknown errors become `internal`). */
export function toFlowError(err: unknown, step?: string): FlowError {
  if (err instanceof FlowError) return step ? err.withStep(step) : err;
  const message = err instanceof Error ? err.message : String(err);
  return new FlowError("internal", message, { step, cause: err });
}
