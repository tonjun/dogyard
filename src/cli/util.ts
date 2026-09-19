import { readFileSync } from "node:fs";
import { FlowError } from "../errors.js";
import { LoadError, loadFlow, type LoadedFlow, type LoadOptions } from "../loader.js";
import { formatDiagnostics, validateFlow } from "../validate.js";

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function fail(message: string, exitCode = 1): never {
  throw new CliError(message, exitCode);
}

/** Load + validate a flow, exiting with diagnostics on failure. */
export function loadValidFlow(flowPath: string, opts: LoadOptions = {}): LoadedFlow {
  let loaded: LoadedFlow;
  try {
    loaded = loadFlow(flowPath, opts);
  } catch (err) {
    if (err instanceof LoadError) fail([err.message, ...err.issues.map((i) => `  - ${i}`)].join("\n"));
    throw err;
  }
  const v = validateFlow(loaded.flow, { dir: loaded.dir });
  if (!v.ok) fail(`Flow ${loaded.file} is invalid:\n${formatDiagnostics(v)}`);
  return loaded;
}

export function printJson(value: unknown, pretty = true): void {
  process.stdout.write(`${pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`);
}

export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

export interface TriggerFlags {
  query?: string;
  input?: string;
  inputFile?: string;
}

/**
 * Build the trigger object from --query / --input / --input-file (or stdin when `-`).
 * The trigger is optional: with no flags it is `{}`, for flows whose first step
 * fetches its own input (a file, a database). Flows that need input declare it
 * in `trigger_schema`.
 */
export function resolveTrigger(flags: TriggerFlags): Record<string, unknown> {
  const given = [flags.query !== undefined, flags.input !== undefined, flags.inputFile !== undefined].filter(Boolean).length;
  if (given === 0) return {};
  if (given > 1) fail("Use only one of --query, --input, --input-file");
  let value: unknown;
  if (flags.query !== undefined) return { query: flags.query };
  if (flags.input !== undefined) value = parseJson(flags.input, "--input");
  if (flags.inputFile !== undefined) {
    const text = flags.inputFile === "-" ? readFileSync(0, "utf8") : readFileSync(flags.inputFile, "utf8");
    value = parseJson(text, flags.inputFile);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("Trigger must be a JSON object");
  return value as Record<string, unknown>;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    return fail(`Invalid JSON in ${what}: ${(err as Error).message}`);
  }
}

export function describeError(err: unknown): string {
  if (err instanceof CliError) return err.message;
  if (err instanceof LoadError) return [err.message, ...err.issues.map((i) => `  - ${i}`)].join("\n");
  if (err instanceof FlowError) return `${err.type}${err.step ? ` [${err.step}]` : ""}: ${err.message}`;
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
