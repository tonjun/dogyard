import { FlowError } from "../../errors.js";
import { evaluateExpression, resolveTemplatedArgs } from "../../expr.js";
import type { CommandStep } from "../../schema/flow.js";
import type { CommandRequest, CommandResult, CommandRunner } from "../command-runner.js";
import type { ExecutionContext } from "../context.js";

export interface CommandStepOutcome {
  output: unknown;
  argv: string[];
  input: unknown;
  result: CommandResult;
}

export interface CommandStepOptions {
  stepName: string;
  runner: CommandRunner;
  timeout?: number;
  signal?: AbortSignal;
  cwd?: string;
  itemIndex?: number;
}

/** Resolve input + argv, dispatch to the runner, parse stdout per `output_mode`. */
export async function executeCommandStep(step: CommandStep, ctx: ExecutionContext, opts: CommandStepOptions): Promise<CommandStepOutcome> {
  const input = step.input !== undefined ? await evaluateExpression(step.input, ctx) : undefined;
  const argv = await resolveTemplatedArgs(step.command, ctx);
  const req = buildRequest(step, argv, input, opts);
  const result = await opts.runner.run(req);
  return { output: parseOutput(result.stdout, step.output_mode, opts.stepName), argv, input, result };
}

export function buildRequest(step: CommandStep, argv: string[], input: unknown, opts: CommandStepOptions): CommandRequest {
  const req: CommandRequest = { argv: [...argv], step: opts.stepName };
  if (opts.itemIndex !== undefined) req.itemIndex = opts.itemIndex;
  if (opts.timeout !== undefined) req.timeout = opts.timeout;
  if (opts.signal) req.signal = opts.signal;
  const cwd = step.cwd ?? opts.cwd;
  if (cwd) req.cwd = cwd;
  const env: Record<string, string> = { ...(step.env ?? {}) };

  if (input !== undefined) {
    const json = JSON.stringify(input);
    switch (step.input_mode) {
      case "stdin":
        req.stdin = json;
        break;
      case "args":
        req.argv.push(json);
        break;
      case "env":
        env.WF_INPUT = json;
        if (input && typeof input === "object" && !Array.isArray(input)) {
          for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
            if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
              env[`WF_INPUT_${k.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`] = String(v);
            }
          }
        }
        break;
    }
  }
  if (Object.keys(env).length) req.env = env;
  return req;
}

export function parseOutput(stdout: string, mode: CommandStep["output_mode"], stepName: string): unknown {
  const trimmed = stdout.replace(/\r?\n$/, "");
  switch (mode) {
    case "text":
      return trimmed;
    case "lines":
      return trimmed === "" ? [] : trimmed.split(/\r?\n/);
    case "json":
      try {
        return JSON.parse(stdout);
      } catch (err) {
        throw new FlowError("output_parse", `Command output is not valid JSON: ${(err as Error).message}`, { step: stepName, details: { stdout: stdout.slice(0, 2000) } });
      }
    case "auto":
    default: {
      const t = stdout.trim();
      if (t === "") return "";
      if (/^[[{"\d-]|^(true|false|null)$/.test(t)) {
        try {
          return JSON.parse(t);
        } catch {
          /* fall through to text */
        }
      }
      return trimmed;
    }
  }
}
