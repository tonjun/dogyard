import { z } from "zod";
import { mocksSchema } from "./test.js";

export const graderSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exact"), name: z.string().optional() }).strict(),
  z.object({ type: z.literal("jsonata"), name: z.string().optional(), expression: z.string() }).strict(),
  z.object({ type: z.literal("command"), name: z.string().optional(), command: z.array(z.string()).min(1), timeout: z.union([z.string(), z.number()]).optional() }).strict(),
]);
export type Grader = z.infer<typeof graderSchema>;

export const evalConfigSchema = z
  .object({
    dataset: z.string().default("dataset.yaml"),
    graders: z.array(graderSchema).min(1),
    mocks: mocksSchema.optional(),
    mocks_file: z.string().optional(),
    concurrency: z.number().int().min(1).default(1),
    /** Pass threshold: an example passes when the mean grader score >= this. */
    pass_threshold: z.number().min(0).max(1).default(1),
  })
  .strict();
export type EvalConfig = z.infer<typeof evalConfigSchema>;

export const evalExampleSchema = z
  .object({
    id: z.string().optional(),
    trigger: z.record(z.string(), z.unknown()).default({}),
    expected: z.unknown().optional(),
  })
  .strict();
export type EvalExample = z.infer<typeof evalExampleSchema>;

export const evalDatasetSchema = z.union([z.array(evalExampleSchema), z.object({ examples: z.array(evalExampleSchema) }).strict()]);
