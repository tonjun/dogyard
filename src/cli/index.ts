#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "node:module";
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

if (process.argv[1] && /[\\/]cli[\\/]index\.(js|ts)$/.test(process.argv[1])) {
  void main();
}
