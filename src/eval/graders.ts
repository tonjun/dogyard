import { isDeepStrictEqual } from "node:util";
import { parseDuration } from "../duration.js";
import { evaluateExpression } from "../expr.js";
import { RealRunner } from "../executor/command-runner.js";
import type { Grader } from "../schema/eval.js";
import type { StepRunResult } from "../executor/run-step.js";
import type { RunTrace } from "../trace.js";

export interface GradeInput {
  output: unknown;
  expected: unknown;
  trigger: unknown;
  /** Flow evals: the full run trace. */
  trace?: RunTrace;
  /** Step evals: the isolated step result. */
  step?: StepRunResult;
  flowDir: string;
}

export interface GradeResult {
  grader: string;
  /** 0..1 */
  score: number;
  passed: boolean;
  message?: string;
}

export function graderName(g: Grader, index: number): string {
  return g.name ?? `${g.type}#${index + 1}`;
}

export async function grade(g: Grader, index: number, input: GradeInput): Promise<GradeResult> {
  const name = graderName(g, index);
  try {
    switch (g.type) {
      case "exact": {
        const ok = isDeepStrictEqual(input.output, input.expected);
        return { grader: name, score: ok ? 1 : 0, passed: ok, ...(ok ? {} : { message: `expected ${JSON.stringify(input.expected)}, got ${JSON.stringify(input.output)}` }) };
      }
      case "jsonata": {
        const v = await evaluateExpression(g.expression, { output: input.output, expected: input.expected, trigger: input.trigger, trace: input.trace, step: input.step });
        if (typeof v === "number") {
          const score = Math.max(0, Math.min(1, v));
          return { grader: name, score, passed: score >= 1 };
        }
        const ok = Boolean(v);
        return { grader: name, score: ok ? 1 : 0, passed: ok, ...(ok ? {} : { message: `expression returned ${JSON.stringify(v)}` }) };
      }
      case "command": {
        const runner = new RealRunner();
        const req: Parameters<RealRunner["run"]>[0] = {
          step: `grader:${name}`,
          argv: g.command,
          stdin: JSON.stringify({ output: input.output, expected: input.expected, trigger: input.trigger }),
          cwd: input.flowDir,
        };
        if (g.timeout !== undefined) req.timeout = parseDuration(g.timeout);
        try {
          const res = await runner.run(req);
          let score = 1;
          let message: string | undefined;
          try {
            const parsed = JSON.parse(res.stdout) as { score?: number; message?: string };
            if (typeof parsed?.score === "number") score = Math.max(0, Math.min(1, parsed.score));
            if (typeof parsed?.message === "string") message = parsed.message;
          } catch {
            /* non-JSON stdout: exit 0 means pass */
          }
          return { grader: name, score, passed: score >= 1, ...(message ? { message } : {}) };
        } catch (err) {
          const d = (err as { details?: { stdout?: string; stderr?: string } }).details;
          return { grader: name, score: 0, passed: false, message: (d?.stderr || d?.stdout || (err as Error).message).trim() };
        }
      }
    }
  } catch (err) {
    return { grader: name, score: 0, passed: false, message: `grader error: ${(err as Error).message}` };
  }
}
