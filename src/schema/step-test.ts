import { z } from "zod";
import { errorPatternSchema } from "./flow.js";
import { mockResultSchema } from "./test.js";

/** The JSONata context a single step is evaluated against when run in isolation. */
export const stepContextSchema = z
  .object({
    trigger: z.record(z.string(), z.unknown()).default({}),
    /** Upstream step outputs, keyed by step name (shorthand for `{ status: succeeded, output }`). */
    steps: z.record(z.string(), z.unknown()).default({}),
    /** Map sub-steps: the current element (required when the step is a map). */
    item: z.unknown().optional(),
    index: z.number().int().min(0).optional(),
  })
  .strict();
export type StepContext = z.infer<typeof stepContextSchema>;
export type StepContextInput = z.input<typeof stepContextSchema>;

export const STEP_STATUSES = ["succeeded", "caught", "failed"] as const;

export const stepTestCaseSchema = z
  .object({
    name: z.string(),
    context: stepContextSchema.prefault({}),
    /** A canned result for this step (exactly one of mock / mocks_file / real). */
    mock: mockResultSchema.optional(),
    /** A mocks file (relative to the test file); `mocks[<step>]` is used. */
    mocks_file: z.string().optional(),
    /** Spawn the real command. */
    real: z.boolean().optional(),
    expect: z
      .object({
        status: z.enum(STEP_STATUSES).optional(),
        output: z.unknown().optional(),
        output_jsonata: z.string().optional(),
        input: z.unknown().optional(),
        argv: z.array(z.string()).optional(),
        error_type: errorPatternSchema.optional(),
        attempts: z.number().int().min(1).optional(),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((tc, ctx) => {
    const given = [tc.mock !== undefined, tc.mocks_file !== undefined, tc.real === true].filter(Boolean).length;
    if (given !== 1) ctx.addIssue({ code: "custom", message: "Provide exactly one of `mock`, `mocks_file`, or `real: true`" });
  });
export type StepTestCase = z.infer<typeof stepTestCaseSchema>;

export const stepTestFileSchema = z.union([stepTestCaseSchema, z.object({ tests: z.array(stepTestCaseSchema) }).strict()]);
