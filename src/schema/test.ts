import { z } from "zod";
import { errorPatternSchema } from "./flow.js";
import { mocksSchema } from "./mock.js";

// The mock schemas live in ./mock.ts (flow.ts needs them too, and this file imports flow.ts).
export { mockEntrySchema, mockResultSchema, mocksFileSchema, mocksSchema } from "./mock.js";
export type { MockEntry, MockResult, Mocks } from "./mock.js";

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
