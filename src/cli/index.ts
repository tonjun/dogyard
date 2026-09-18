#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerInspect } from "./commands/inspect.js";
import { registerQuality } from "./commands/quality.js";
import { registerRun } from "./commands/run.js";
import { describeError } from "./util.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { name: string; version: string; description: string };

export function buildProgram(): Command {
  const program = new Command();
  program.name(pkg.name).description(pkg.description).version(pkg.version).showHelpAfterError();
  registerRun(program);
  registerInspect(program);
  registerQuality(program);
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    process.stderr.write(`error: ${describeError(err)}\n`);
    process.exitCode = (err as { exitCode?: number }).exitCode ?? 1;
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}
