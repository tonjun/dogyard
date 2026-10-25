import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { readTrace, runsDir, traceFile } from "../trace.js";

/** Files a detached run keeps beside its trace.json. */
export const runLogFile = (flowDir: string, runId: string, traceDir?: string) => path.join(runsDir(flowDir, traceDir), runId, "run.log");
export const runPidFile = (flowDir: string, runId: string, traceDir?: string) => path.join(runsDir(flowDir, traceDir), runId, "pid");
/** Written by `runs stop`; a detached run polls for it (Windows has no SIGTERM a process can handle). */
export const runStopFile = (flowDir: string, runId: string, traceDir?: string) => path.join(runsDir(flowDir, traceDir), runId, "stop");

/** While this file exists the run is drain-paused (see `runs pause` / `runs continue`). Any run with a trace file polls it. */
export const runPauseFile = (flowDir: string, runId: string, traceDir?: string) => path.join(runsDir(flowDir, traceDir), runId, "pause");

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

/** argv prefix that invokes the dogyard CLI, e.g. `[node, dist/cli/index.js]`. */
export type CliCommand = string[];

/** This process's own CLI invocation (node, its exec args and the script). */
export function selfCommand(): CliCommand {
  return [process.execPath, ...process.execArgv, process.argv[1]!];
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
export function launchDetached(opts: { runDir: string; runId: string; args: string[]; command?: CliCommand }): DetachedLaunch {
  mkdirSync(opts.runDir, { recursive: true });
  // A resume reuses the run dir; a leftover request would stop (or pause) it straight away.
  rmSync(path.join(opts.runDir, "stop"), { force: true });
  rmSync(path.join(opts.runDir, "pause"), { force: true });
  const log = path.join(opts.runDir, "run.log");
  const logFd = openSync(log, "a");
  const outFd = openSync(path.join(opts.runDir, "stdout.json"), "w");
  let pid: number | undefined;
  try {
    const [exe, ...pre] = opts.command ?? selfCommand();
    const child = spawn(exe!, [...pre, ...opts.args], {
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

/**
 * Start a fresh run of `flowDir` in the background. The trigger goes to
 * `<run>/trigger.json` (the child cannot read our stdin) and `extraArgs` are
 * forwarded flags such as `--max-concurrency`.
 */
export function startBackgroundRun(opts: { flowDir: string; runId: string; trigger: unknown; extraArgs?: string[]; traceDir?: string; command?: CliCommand }): DetachedLaunch {
  const runDir = path.dirname(traceFile(opts.flowDir, opts.runId, opts.traceDir));
  mkdirSync(runDir, { recursive: true });
  const triggerFile = path.join(runDir, "trigger.json");
  writeFileSync(triggerFile, JSON.stringify(opts.trigger));
  const args = ["run", opts.flowDir, ...(opts.extraArgs ?? []), "--input-file", triggerFile, "--run-id", opts.runId];
  return launchDetached({ runDir, runId: opts.runId, args, ...(opts.command ? { command: opts.command } : {}) });
}

/** Thrown by the run-control helpers when the request does not apply to the run's state. */
export class RunControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunControlError";
  }
}

function runningStatus(flowDir: string, runId: string, traceDir?: string): void {
  const file = traceFile(flowDir, runId, traceDir);
  if (!existsSync(file)) throw new RunControlError(`No trace for run ${runId}`);
  const status = readTrace(file).status;
  if (status !== "running") throw new RunControlError(`Run ${runId} is not running (${status})`);
}

/**
 * Interrupt a --detach run: write the stop request and, on POSIX, SIGTERM it.
 * Returns a human-readable description of what was done.
 */
export function stopRun(flowDir: string, runId: string, traceDir?: string): string {
  const pid = readRunPid(flowDir, runId, traceDir);
  if (pid === undefined) throw new RunControlError(`Run ${runId} has no pid file (only runs started with --detach can be stopped)`);
  runningStatus(flowDir, runId, traceDir);
  if (!isAlive(pid)) throw new RunControlError(`Run ${runId}'s process (pid ${pid}) is not running`);
  writeFileSync(runStopFile(flowDir, runId, traceDir), `${new Date().toISOString()}\n`);
  // On Windows process.kill() terminates outright, skipping the checkpoint; the run polls for the stop file instead.
  if (process.platform === "win32") return `Requested stop of run ${runId} (pid ${pid})`;
  process.kill(pid, "SIGTERM");
  return `Sent SIGTERM to run ${runId} (pid ${pid})`;
}

/** Ask a running run to drain-pause. */
export function pauseRun(flowDir: string, runId: string, traceDir?: string): string {
  runningStatus(flowDir, runId, traceDir);
  if (!runProcessAlive(flowDir, runId, traceDir)) throw new RunControlError(`Run ${runId}'s process is not running`);
  writeFileSync(runPauseFile(flowDir, runId, traceDir), `${new Date().toISOString()}\n`);
  return `Requested pause of run ${runId}; running steps will finish, no new ones start`;
}

/** Let a paused run continue. */
export function continueRun(flowDir: string, runId: string, traceDir?: string): string {
  runningStatus(flowDir, runId, traceDir);
  const file = runPauseFile(flowDir, runId, traceDir);
  if (!existsSync(file)) throw new RunControlError(`Run ${runId} is not paused`);
  rmSync(file, { force: true });
  return `Run ${runId} continues`;
}
