import { z } from "zod";
import { stepContextSchema } from "./step-test.js";

export { evalConfigSchema as stepEvalConfigSchema } from "./eval.js";

export const stepEvalExampleSchema = z
  .object({
    id: z.string().optional(),
    context: stepContextSchema.prefault({}),
    expected: z.unknown().optional(),
  })
  .strict();
export type StepEvalExample = z.infer<typeof stepEvalExampleSchema>;

export const stepEvalDatasetSchema = z.union([z.array(stepEvalExampleSchema), z.object({ examples: z.array(stepEvalExampleSchema) }).strict()]);
