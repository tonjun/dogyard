import { z } from "zod";
import { errorPatternSchema } from "./flow.js";

/** A canned command result: either a parsed `output` or raw stdout/exit code. */
export const mockResultSchema = z.union([
  z.object({ output: z.unknown() }).strict(),
  z
    .object({
      stdout: z.string().default(""),
      stderr: z.string().default(""),
      exit_code: z.number().int().default(0),
    })
    .strict(),
]);
export type MockResult = z.infer<typeof mockResultSchema>;

/** Per step: one result, or an ordered array of per-item results for map sub-steps. */
export const mocksSchema = z.record(z.string(), z.union([mockResultSchema, z.array(mockResultSchema)]));
export type Mocks = z.infer<typeof mocksSchema>;

export const mocksFileSchema = z.object({ mocks: mocksSchema }).strict();

export const testCaseSchema = z
  .object({
    name: z.string(),
    trigger: z.record(z.string(), z.unknown()).default({}),
    mocks: mocksSchema.default({}),
    mocks_file: z.string().optional(),
    expect: z
      .object({
        status: z.enum(["succeeded", "failed"]).optional(),
        output: z.unknown().optional(),
        output_jsonata: z.string().optional(),
        path: z.array(z.string()).optional(),
        skipped: z.array(z.string()).optional(),
        error_type: errorPatternSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type TestCase = z.infer<typeof testCaseSchema>;

export const testFileSchema = z.union([testCaseSchema, z.object({ tests: z.array(testCaseSchema) }).strict()]);
