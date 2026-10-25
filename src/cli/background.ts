import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { runsDir } from "../trace.js";

/** Files a detached run keeps beside its trace.json. */
export const runLogFile = (flowDir: string, runId: string, traceDir?: string) => path.join(runsDir(flowDir, traceDir), runId, "run.log");
export const runPidFile = (flowDir: string, runId: string, traceDir?: string) => path.join(runsDir(flowDir, traceDir), runId, "pid");
/** Written by `runs stop`; a detached run polls for it (Windows has no SIGTERM a process can handle). */
export const runStopFile = (flowDir: string, runId: string, traceDir?: string) => path.join(runsDir(flowDir, traceDir), runId, "stop");

/** Pid recorded by `--detach`, if any. */
export function readRunPid(flowDir: string, runId: string, traceDir?: string): number | undefined {
  const file = runPidFile(flowDir, runId, traceDir);
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** False only when a detached run's process is known to be gone. */
export function runProcessAlive(flowDir: string, runId: string, traceDir?: string): boolean {
  const pid = readRunPid(flowDir, runId, traceDir);
  return pid === undefined || isAlive(pid);
}

/**
 * Rebuild CLI arguments from the options commander parsed off the command line
 * (not defaults), so a detached child sees the same flags without re-parsing argv.
 */
export function optionArgs(cmd: Command, exclude: string[] = []): string[] {
  const args: string[] = [];
  for (const opt of cmd.options) {
    const key = opt.attributeName();
    if (exclude.includes(key) || cmd.getOptionValueSource(key) !== "cli" || !opt.long) continue;
    const value = cmd.getOptionValue(key) as unknown;
    if (opt.negate) {
      if (value === false) args.push(opt.long);
    } else if (opt.required || opt.optional) {
      if (value !== undefined && value !== true) args.push(opt.long, String(value));
      else if (value === true) args.push(opt.long);
    } else if (value) {
      args.push(opt.long);
    }
  }
  return args;
}

export interface DetachedLaunch {
  run_id: string;
  pid: number;
  log: string;
  trace: string;
}

/**
 * Re-invoke this CLI as a detached process (own session, so it outlives the
 * terminal/SSH connection) with stderr appended to `<run>/run.log` and stdout
 * (the final output JSON) written to `<run>/stdout.json`.
 */
export function launchDetached(opts: { runDir: string; runId: string; args: string[] }): DetachedLaunch {
  mkdirSync(opts.runDir, { recursive: true });
  // A resume reuses the run dir; a leftover request would stop it straight away.
  rmSync(path.join(opts.runDir, "stop"), { force: true });
  const log = path.join(opts.runDir, "run.log");
  const logFd = openSync(log, "a");
  const outFd = openSync(path.join(opts.runDir, "stdout.json"), "w");
  let pid: number | undefined;
  try {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...opts.args], {
      detached: true,
      stdio: ["ignore", outFd, logFd],
      cwd: process.cwd(),
      env: { ...process.env, DOGYARD_DETACHED: "1" },
    });
    pid = child.pid;
    child.unref();
  } finally {
    closeSync(logFd);
    closeSync(outFd);
  }
  if (pid === undefined) throw new Error("Failed to start the background process");
  writeFileSync(path.join(opts.runDir, "pid"), `${pid}\n`);
  return { run_id: opts.runId, pid, log, trace: path.join(opts.runDir, "trace.json") };
}
