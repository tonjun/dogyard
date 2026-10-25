import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { Option, type Command } from "commander";
import { parseDuration } from "../../duration.js";
import { FlowError } from "../../errors.js";
import { prepareResume } from "../../executor/checkpoint.js";
import { MockRunner, RealRunner, RecordingRunner, type CommandRunner } from "../../executor/command-runner.js";
import { PauseController } from "../../executor/pause.js";
import { runFlow, type RunOptions, type RunResult } from "../../executor/run.js";
import { loadMocksFile } from "../../testing/run-tests.js";
import type { LoadedFlow } from "../../loader.js";
import { historicalItemMedians } from "../../progress.js";
import { cacheStats, newRunId, readTrace, recentRuns, traceFile, type RunTrace } from "../../trace.js";
import { launchDetached, optionArgs, runPauseFile, runStopFile, startBackgroundRun, type DetachedLaunch } from "../background.js";
import { ProgressDisplay, stepTransitionLogger } from "../progress-display.js";
import { fail, loadValidFlow, log, printJson, resolveTrigger } from "../util.js";

/** How many earlier runs to read when seeding the ETA. */
const HISTORY_RUNS = 10;

interface CommonRunFlags {
  mocks?: string;
  record?: string;
  trace?: boolean;
  traceDir?: string;
  noTrace?: boolean;
  maxConcurrency?: string;
  runTimeout?: string;
  project?: boolean;
  quiet?: boolean;
  cache?: boolean;
  refresh?: string;
  detach?: boolean;
}

/** Set in a detached child's environment; it prefixes the log with a header line. */
const DETACHED_ENV = "DOGYARD_DETACHED";
/**
 * Options the parent consumes and never forwards to a detached child. `quiet`
 * only silences the launcher: the child's log always gets the full progress.
 */
const PARENT_ONLY = ["detach", "query", "input", "inputFile", "resume", "runId", "quiet"];

function addCommonRunFlags(cmd: Command): Command {
  return cmd
    .option("--mocks <file>", "serve command output from a mocks YAML file instead of executing")
    .option("--record <file>", "execute for real and save every command result as a mocks YAML file")
    .option("--trace", "print the full trace JSON to stdout instead of just the output")
    .option("--trace-dir <dir>", "directory for run traces (default: <flow-dir>/.runs)")
    .option("--no-trace-file", "do not write a trace file")
    .option("--max-concurrency <n>", "override the flow's max_concurrency")
    .option("--run-timeout <duration>", "override the flow's run_timeout (e.g. 5m)")
    .option("--no-project", "ignore project-level workflows.yaml config")
    .option("--no-cache", "do not read or write the step result cache")
    .option("--refresh <steps>", "comma-separated steps that skip the cache lookup and store a fresh result")
    .option("-q, --quiet", "suppress progress output on stderr")
    .option("--detach", "run in the background; stderr goes to <run>/run.log (see `runs logs`, `runs watch`, `runs stop`)");
}

function buildRunner(flags: CommonRunFlags, display?: ProgressDisplay): { runner: CommandRunner; recorder?: RecordingRunner } {
  if (flags.mocks && flags.record) fail("Use only one of --mocks and --record");
  if (flags.mocks) return { runner: new MockRunner(loadMocksFile(path.resolve(flags.mocks))) };
  const realOpts: ConstructorParameters<typeof RealRunner>[0] = { streamStderr: !flags.quiet };
  if (display) realOpts.writeStderr = (text) => display.write(text);
  if (flags.record) {
    const recorder = new RecordingRunner(new RealRunner(realOpts));
    return { runner: recorder, recorder };
  }
  return { runner: new RealRunner(realOpts) };
}

function commonOptions(flags: CommonRunFlags & { traceFile?: boolean }): Partial<RunOptions> {
  const o: Partial<RunOptions> = {};
  if (flags.traceFile === false) o.persist = false;
  if (flags.traceDir) o.traceDir = flags.traceDir;
  if (flags.maxConcurrency) o.maxConcurrency = Number(flags.maxConcurrency);
  if (flags.runTimeout) o.runTimeout = parseDuration(flags.runTimeout);
  // --mocks / --record disable the cache by default (see RunOptions.cache).
  if (flags.cache === false) o.cache = { enabled: false };
  else if (flags.refresh) o.cache = { refresh: flags.refresh.split(",").map((s) => s.trim()).filter(Boolean) };
  return o;
}

/**
 * Re-launch this command as a background process and print where to follow it.
 * The run id is fixed up front so it can be announced before the child starts.
 */
function checkDetachFlags(flags: CommonRunFlags & { traceFile?: boolean }): void {
  if (flags.traceFile === false) fail("--detach needs a trace file; drop --no-trace-file");
  if (flags.trace) fail("--detach writes the output to <run>/stdout.json; drop --trace and read the trace file instead");
}

function announceDetached(loaded: LoadedFlow, runId: string, launched: DetachedLaunch, flags: CommonRunFlags): void {
  if (!flags.quiet) {
    const rel = path.relative(process.cwd(), loaded.dir);
    const flow = !rel ? "." : rel.startsWith("..") ? loaded.dir : rel;
    log(`Run ${runId} started in background (pid ${launched.pid})`);
    log(`  log:    ${launched.log}`);
    log(`  follow: dogyard runs logs ${flow} ${runId} -f`);
    log(`  watch:  dogyard runs watch ${flow} ${runId}`);
    log(`  stop:   dogyard runs stop ${flow} ${runId}`);
  }
  printJson(launched);
}

/** First line a detached child writes to its log, so appended resumes stay readable. Returns whether we are one. */
function detachedHeader(kind: "run" | "resume", runId: string): boolean {
  if (!process.env[DETACHED_ENV]) return false;
  log(`=== ${new Date().toISOString()} ${kind} ${runId} pid=${process.pid} ===`);
  // Not meant for the flow's own commands (or a nested dogyard run).
  delete process.env[DETACHED_ENV];
  return true;
}

/** How often a run checks for `runs stop` / `runs pause` request files. */
const CONTROL_POLL_MS = 200;

/**
 * Wire SIGINT/SIGTERM (and, for a detached run, a `runs stop` request file) to
 * an AbortController so the trace records `interrupted`. With a `pauseFile`
 * (any run that writes a trace), its presence drain-pauses the run.
 */
function installSignalHandlers(display?: ProgressDisplay, files: { stop?: string; pause?: string } = {}): { signal: AbortSignal; pause?: PauseController; dispose: () => void } {
  const ac = new AbortController();
  const say = display ? (m: string) => display.log(m) : log;
  const interrupt = (what: string) => {
    if (!ac.signal.aborted) {
      say(`\nReceived ${what}; interrupting run (trace will be checkpointed)…`);
      ac.abort(new FlowError("interrupted", `Run interrupted by ${what}`));
    }
  };
  const handler = (sig: NodeJS.Signals) => interrupt(sig);
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  // A request left over from an earlier process of this run (a resume) must not apply to this one.
  if (files.pause) rmSync(files.pause, { force: true });
  const pause = files.pause ? new PauseController() : undefined;
  const { stop: stopFile, pause: pauseFile } = files;
  const poll: NodeJS.Timeout | undefined =
    stopFile || pauseFile
      ? setInterval(() => {
          if (stopFile && existsSync(stopFile)) interrupt("stop request");
          if (pause && pauseFile && existsSync(pauseFile) !== pause.paused) {
            pause.set(!pause.paused);
            // While paused nothing else may be pending; keep the process alive until `runs continue`.
            if (pause.paused) poll?.ref();
            else poll?.unref();
            say(pause.paused ? "Paused: running steps will finish, no new ones start (`runs continue` to go on)" : "Continuing");
          }
        }, CONTROL_POLL_MS)
      : undefined;
  poll?.unref();
  return {
    signal: ac.signal,
    ...(pause ? { pause } : {}),
    dispose: () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
      if (poll) clearInterval(poll);
    },
  };
}

/** Request files this run polls: `stop` only when detached, `pause` whenever it writes a trace. */
function controlFiles(loaded: LoadedFlow, runId: string, flags: CommonRunFlags & { traceFile?: boolean }, detached: boolean): { stop?: string; pause?: string } {
  const files: { stop?: string; pause?: string } = {};
  if (detached) files.stop = runStopFile(loaded.dir, runId, flags.traceDir);
  if (flags.traceFile !== false) files.pause = runPauseFile(loaded.dir, runId, flags.traceDir);
  return files;
}

/** Live progress (unless -q): step transitions plus per-map status lines with an ETA seeded from earlier runs. */
function startProgress(flags: CommonRunFlags, loaded: LoadedFlow, excludeRunId?: string): { display: ProgressDisplay; onProgress: NonNullable<RunOptions["onProgress"]> } | undefined {
  if (flags.quiet) return undefined;
  const history = historicalItemMedians(recentRuns(loaded.dir, HISTORY_RUNS + 1, flags.traceDir), excludeRunId);
  const display = new ProgressDisplay({ history });
  const transitions = stepTransitionLogger((m) => display.log(m));
  return {
    display,
    onProgress: (trace) => {
      transitions(trace);
      display.update(trace);
    },
  };
}

function finishRun(result: RunResult, flags: CommonRunFlags, recorder?: RecordingRunner): void {
  if (recorder && flags.record) {
    writeFileSync(path.resolve(flags.record), YAML.stringify({ mocks: recorder.mocks }));
    log(`Recorded ${Object.keys(recorder.mocks).length} step mock(s) to ${flags.record}`);
  }
  if (!flags.quiet) {
    if (result.traceFile) log(`Trace: ${result.traceFile}`);
    const stats = cacheStats(result.trace);
    if (stats.cached || stats.executed) log(`Cache: ${stats.cached} cached / ${stats.executed} executed`);
    log(`Run ${result.trace.run_id} ${result.status}${result.error ? `: ${result.error.type}: ${result.error.message}` : ""}`);
  }
  if (flags.trace) printJson(result.trace);
  else if (result.status === "succeeded") printJson(result.output ?? null);
  else if (!flags.trace) printJson({ status: result.status, run_id: result.trace.run_id, error: result.error?.toJSON() });
  if (result.status !== "succeeded") process.exitCode = result.status === "interrupted" ? 130 : 1;
}

export function registerRun(program: Command): void {
  addCommonRunFlags(
    program
      .command("run <flow>")
      .description("Run a flow once against a trigger and print its output JSON")
      .option("-Q, --query <text>", "trigger with { query: <text> }")
      .option("-i, --input <json>", "trigger JSON object")
      .option("-f, --input-file <path>", "read trigger JSON from a file (- for stdin)")
      .option("--resume <run_id>", "resume an earlier run instead of starting a new one")
      .option("--force", "with --resume: proceed even if the flow definition changed")
      .addOption(new Option("--run-id <id>", "use this id for the new run").hideHelp()),
  ).action(async (flowPath: string, flags: CommonRunFlags & { query?: string; input?: string; inputFile?: string; resume?: string; force?: boolean; traceFile?: boolean; runId?: string }, cmd: Command) => {
    if (flags.resume) return resumeAction(flowPath, flags.resume, flags, cmd);
    const loaded = loadValidFlow(flowPath, { project: flags.project !== false });
    const trigger = resolveTrigger(flags);
    if (flags.detach) {
      checkDetachFlags(flags);
      const runId = newRunId();
      const extraArgs = optionArgs(cmd, PARENT_ONLY);
      const launched = startBackgroundRun({ flowDir: loaded.dir, runId, trigger, extraArgs, ...(flags.traceDir ? { traceDir: flags.traceDir } : {}) });
      return announceDetached(loaded, runId, launched, flags);
    }
    const detached = flags.runId ? detachedHeader("run", flags.runId) : false;
    const progress = startProgress(flags, loaded);
    const { runner, recorder } = buildRunner(flags, progress?.display);
    const runId = flags.runId ?? newRunId();
    const sig = installSignalHandlers(progress?.display, controlFiles(loaded, runId, flags, detached));
    let result: RunResult;
    try {
      const opts: RunOptions = { loaded, trigger, runner, signal: sig.signal, runId, ...commonOptions(flags) };
      if (sig.pause) opts.pause = sig.pause;
      if (progress) opts.onProgress = progress.onProgress;
      result = await runFlow(opts);
    } finally {
      progress?.display.stop();
      sig.dispose();
    }
    finishRun(result, flags, recorder);
  });

  addCommonRunFlags(
    program
      .command("resume <flow> <run_id>")
      .description("Resume an interrupted or failed run from its trace; completed steps are not re-run")
      .option("--force", "proceed even if the flow definition changed since the run started"),
  ).action(async (flowPath: string, runId: string, flags: CommonRunFlags & { force?: boolean; traceFile?: boolean }, cmd: Command) => resumeAction(flowPath, runId, flags, cmd));
}

async function resumeAction(flowPath: string, runId: string, flags: CommonRunFlags & { force?: boolean; traceFile?: boolean }, cmd: Command): Promise<void> {
  const loaded = loadValidFlow(flowPath, { project: flags.project !== false });
  const file = traceFile(loaded.dir, runId, flags.traceDir);
  let trace: RunTrace;
  try {
    trace = readTrace(file);
  } catch (err) {
    return fail(`Cannot read trace for run ${runId} at ${file}: ${(err as Error).message}`);
  }
  const resume = prepareResume(trace, loaded, { force: flags.force ?? false });
  if (resume.status === "succeeded") {
    log(`Run ${runId} already succeeded; nothing to resume.`);
    printJson(resume.output ?? null);
    return;
  }
  if (flags.detach) {
    checkDetachFlags(flags);
    const runDir = path.dirname(traceFile(loaded.dir, runId, flags.traceDir));
    return announceDetached(loaded, runId, launchDetached({ runDir, runId, args: ["resume", path.resolve(flowPath), runId, ...optionArgs(cmd, PARENT_ONLY)] }), flags);
  }
  const detached = detachedHeader("resume", runId);
  if (!flags.quiet) log(`Resuming run ${runId} (resume #${resume.resume_count})`);
  const progress = startProgress(flags, loaded, runId);
  const { runner, recorder } = buildRunner(flags, progress?.display);
  const sig = installSignalHandlers(progress?.display, controlFiles(loaded, runId, flags, detached));
  let result: RunResult;
  try {
    const opts: RunOptions = { loaded, trigger: resume.trigger, runner, signal: sig.signal, resume, ...commonOptions(flags) };
    if (sig.pause) opts.pause = sig.pause;
    if (progress) opts.onProgress = progress.onProgress;
    result = await runFlow(opts);
  } finally {
    progress?.display.stop();
    sig.dispose();
  }
  finishRun(result, flags, recorder);
}
