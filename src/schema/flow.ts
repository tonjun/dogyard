import { z } from "zod";
import { ERROR_TYPES } from "../errors.js";
import { isDuration } from "../duration.js";

export const SCHEMA_VERSION = 1;

export const STEP_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
export const FLOW_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const durationSchema = z.union([z.string(), z.number()]).refine(isDuration, { message: "Expected a duration like 30s, 500ms, 2m" });

export const errorPatternSchema = z.enum(ERROR_TYPES);

export const retryPolicySchema = z
  .object({
    max_attempts: z.number().int().min(1).default(1),
    backoff: durationSchema.default("0s"),
    on: z.array(errorPatternSchema).min(1).default(["command_failure"]),
  })
  .strict();
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export const catchClauseSchema = z
  .object({
    error_type: errorPatternSchema.default("any"),
    result: z.unknown().optional(),
  })
  .strict();
export type CatchClause = z.infer<typeof catchClauseSchema>;

export const flowConfigSchema = z
  .object({
    default_timeout: durationSchema.optional(),
    default_retry: retryPolicySchema.optional(),
    max_concurrency: z.number().int().min(1).optional(),
    run_timeout: durationSchema.optional(),
  })
  .strict();
export type FlowConfig = z.infer<typeof flowConfigSchema>;

const stepName = z.string().regex(STEP_NAME_RE, "Step names must match [a-zA-Z_][a-zA-Z0-9_-]*");

const commonStepFields = {
  needs: z.array(stepName).default([]),
  input: z.string().optional(),
  timeout: durationSchema.optional(),
  retry: retryPolicySchema.optional(),
  catch: z.array(catchClauseSchema).optional(),
  terminal: z.enum(["success", "fail"]).optional(),
  description: z.string().optional(),
};

export const INPUT_MODES = ["stdin", "args", "env"] as const;
export const OUTPUT_MODES = ["auto", "json", "text", "lines"] as const;

export const commandStepSchema = z
  .object({
    type: z.literal("command"),
    command: z.array(z.string()).min(1),
    input_mode: z.enum(INPUT_MODES).default("stdin"),
    output_mode: z.enum(OUTPUT_MODES).default("auto"),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    ...commonStepFields,
  })
  .strict();

export const transformStepSchema = z.object({ type: z.literal("transform"), ...commonStepFields }).strict();
export const passStepSchema = z.object({ type: z.literal("pass"), ...commonStepFields }).strict();

export const choiceStepSchema = z
  .object({
    type: z.literal("choice"),
    branches: z.array(z.object({ when: z.string(), next: stepName }).strict()).min(1),
    default: stepName.optional(),
    ...commonStepFields,
  })
  .strict();

/** Sub-steps inside a map cannot be choice or map themselves. */
export const mapSubStepSchema = z.discriminatedUnion("type", [commandStepSchema, transformStepSchema, passStepSchema]);

export const mapStepSchema = z
  .object({
    type: z.literal("map"),
    over: z.string(),
    max_concurrency: z.number().int().min(1).optional(),
    step: mapSubStepSchema,
    ...commonStepFields,
  })
  .strict();

export const stepSchema = z.discriminatedUnion("type", [commandStepSchema, transformStepSchema, passStepSchema, choiceStepSchema, mapStepSchema]);

export const flowSchema = z
  .object({
    schema_version: z.number().int().default(SCHEMA_VERSION),
    name: z.string().regex(FLOW_NAME_RE, "Flow names must match [a-z0-9][a-z0-9_-]*"),
    version: z.string().regex(SEMVER_RE, "version must be semver (e.g. 0.1.0)"),
    description: z.string().optional(),
    config: flowConfigSchema.default({}),
    trigger_schema: z.record(z.string(), z.unknown()).optional(),
    steps: z.record(stepName, stepSchema).refine((s) => Object.keys(s).length > 0, { message: "steps must not be empty" }),
  })
  .strict();

export type CommandStep = z.infer<typeof commandStepSchema>;
export type TransformStep = z.infer<typeof transformStepSchema>;
export type PassStep = z.infer<typeof passStepSchema>;
export type ChoiceStep = z.infer<typeof choiceStepSchema>;
export type MapStep = z.infer<typeof mapStepSchema>;
export type MapSubStep = z.infer<typeof mapSubStepSchema>;
export type Step = z.infer<typeof stepSchema>;
export type StepType = Step["type"];
export type FlowDefinition = z.infer<typeof flowSchema>;
export type FlowInput = z.input<typeof flowSchema>;
