import { z } from "zod";
import { flowConfigSchema } from "./flow.js";

export const PROJECT_CONFIG_FILENAMES = ["workflows.yaml", "workflows.yml", ".workflows.yaml", ".workflows.yml"] as const;

export const projectConfigSchema = z
  .object({
    schema_version: z.number().int().default(1),
    config: flowConfigSchema.default({}),
    flows_dir: z.string().optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
