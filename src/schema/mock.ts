import { z } from "zod";

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

/** One result, or an ordered array of per-item results for map sub-steps. */
export const mockEntrySchema = z.union([mockResultSchema, z.array(mockResultSchema)]);
export type MockEntry = z.infer<typeof mockEntrySchema>;

/** Per step name. */
export const mocksSchema = z.record(z.string(), mockEntrySchema);
export type Mocks = z.infer<typeof mocksSchema>;

export const mocksFileSchema = z.object({ mocks: mocksSchema }).strict();
