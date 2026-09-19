import path from "node:path";
import { LoadError, formatZodIssues, readYamlFile } from "../loader.js";
import type { FlowDefinition, CommandStep } from "../schema/flow.js";
import { mockEntrySchema, type MockEntry, type Mocks } from "../schema/mock.js";
import { resolveStepCwd } from "./steps/command.js";

/** Read a file holding one mock result (or an array of per-item results). */
export function loadMockEntryFile(file: string): MockEntry {
  const parsed = mockEntrySchema.safeParse(readYamlFile(file));
  if (!parsed.success) throw new LoadError(`Invalid mock file ${file}`, formatZodIssues(parsed.error), file);
  return parsed.data;
}

/**
 * The command steps that can carry a `mock`, keyed by the name the runner sees:
 * top-level command steps, and a map's command sub-step under the map's name.
 */
export function commandStepsByName(flow: FlowDefinition): Array<{ name: string; label: string; step: CommandStep }> {
  const out: Array<{ name: string; label: string; step: CommandStep }> = [];
  for (const [name, step] of Object.entries(flow.steps)) {
    if (step.type === "command") out.push({ name, label: name, step });
    else if (step.type === "map" && step.step.type === "command") out.push({ name, label: `${name}.step`, step: step.step });
  }
  return out;
}

/** A step's mock with any file reference loaded. A file path resolves like the step's cwd. */
export function resolveStepMock(flowDir: string, name: string, step: CommandStep): MockEntry | undefined {
  if (step.mock === undefined) return undefined;
  if (typeof step.mock !== "string") return step.mock;
  return loadMockEntryFile(path.resolve(resolveStepCwd(flowDir, name, step), step.mock));
}

/** Mocks declared on the flow's own steps (`mock:`), for test/eval to layer under explicit mocks. */
export function collectInlineMocks(loaded: { dir: string; flow: FlowDefinition }): Mocks {
  const mocks: Mocks = {};
  for (const { name, step } of commandStepsByName(loaded.flow)) {
    const entry = resolveStepMock(loaded.dir, name, step);
    if (entry !== undefined) mocks[name] = entry;
  }
  return mocks;
}
