import { writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Command } from "commander";
import { parseDuration } from "../../duration.js";
import { FlowError } from "../../errors.js";
import { prepareResume } from "../../executor/checkpoint.js";
import { MockRunner, RealRunner, RecordingRunner, type CommandRunner } from "../../executor/command-runner.js";
import { runFlow, type RunOptions, type RunResult } from "../../executor/run.js";
import { loadMocksFile } from "../../testing/run-tests.js";
import type { LoadedFlow } from "../../loader.js";
import { historicalItemMedians } from "../../progress.js";
import { cacheStats, readTrace, recentRuns, traceFile, type RunTrace } from "../../trace.js";
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
}

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
    .option("-q, --quiet", "suppress progress output on stderr");
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

/** Wire SIGINT/SIGTERM to an AbortController so the trace records `interrupted`. */
function installSignalHandlers(display?: ProgressDisplay): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const handler = (sig: NodeJS.Signals) => {
    if (!ac.signal.aborted) {
      (display ? (m: string) => display.log(m) : log)(`\nReceived ${sig}; interrupting run (trace will be checkpointed)…`);
      ac.abort(new FlowError("interrupted", `Run interrupted by ${sig}`));
    }
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return { signal: ac.signal, dispose: () => { process.off("SIGINT", handler); process.off("SIGTERM", handler); } };
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
      .option("--force", "with --resume: proceed even if the flow definition changed"),
  ).action(async (flowPath: string, flags: CommonRunFlags & { query?: string; input?: string; inputFile?: string; resume?: string; force?: boolean; traceFile?: boolean }) => {
    if (flags.resume) return resumeAction(flowPath, flags.resume, flags);
    const loaded = loadValidFlow(flowPath, { project: flags.project !== false });
    const trigger = resolveTrigger(flags);
    const progress = startProgress(flags, loaded);
    const { runner, recorder } = buildRunner(flags, progress?.display);
    const sig = installSignalHandlers(progress?.display);
    let result: RunResult;
    try {
      const opts: RunOptions = { loaded, trigger, runner, signal: sig.signal, ...commonOptions(flags) };
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
  ).action(async (flowPath: string, runId: string, flags: CommonRunFlags & { force?: boolean; traceFile?: boolean }) => resumeAction(flowPath, runId, flags));
}

async function resumeAction(flowPath: string, runId: string, flags: CommonRunFlags & { force?: boolean; traceFile?: boolean }): Promise<void> {
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
  if (!flags.quiet) log(`Resuming run ${runId} (resume #${resume.resume_count})`);
  const progress = startProgress(flags, loaded, runId);
  const { runner, recorder } = buildRunner(flags, progress?.display);
  const sig = installSignalHandlers(progress?.display);
  let result: RunResult;
  try {
    const opts: RunOptions = { loaded, trigger: resume.trigger, runner, signal: sig.signal, resume, ...commonOptions(flags) };
    if (progress) opts.onProgress = progress.onProgress;
    result = await runFlow(opts);
  } finally {
    progress?.display.stop();
    sig.dispose();
  }
  finishRun(result, flags, recorder);
}
