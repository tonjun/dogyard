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
import { readTrace, traceFile, type RunTrace } from "../../trace.js";
import { fail, loadValidFlow, log, printJson, resolveTrigger } from "../util.js";

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
    .option("-q, --quiet", "suppress progress output on stderr");
}

function buildRunner(flags: CommonRunFlags): { runner: CommandRunner; recorder?: RecordingRunner } {
  if (flags.mocks && flags.record) fail("Use only one of --mocks and --record");
  if (flags.mocks) return { runner: new MockRunner(loadMocksFile(path.resolve(flags.mocks))) };
  const streamStderr = !flags.quiet;
  if (flags.record) {
    const recorder = new RecordingRunner(new RealRunner({ streamStderr }));
    return { runner: recorder, recorder };
  }
  return { runner: new RealRunner({ streamStderr }) };
}

function commonOptions(flags: CommonRunFlags & { traceFile?: boolean }): Partial<RunOptions> {
  const o: Partial<RunOptions> = {};
  if (flags.traceFile === false) o.persist = false;
  if (flags.traceDir) o.traceDir = flags.traceDir;
  if (flags.maxConcurrency) o.maxConcurrency = Number(flags.maxConcurrency);
  if (flags.runTimeout) o.runTimeout = parseDuration(flags.runTimeout);
  return o;
}

/** Wire SIGINT/SIGTERM to an AbortController so the trace records `interrupted`. */
function installSignalHandlers(): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const handler = (sig: NodeJS.Signals) => {
    if (!ac.signal.aborted) {
      log(`\nReceived ${sig}; interrupting run (trace will be checkpointed)…`);
      ac.abort(new FlowError("interrupted", `Run interrupted by ${sig}`));
    }
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return { signal: ac.signal, dispose: () => { process.off("SIGINT", handler); process.off("SIGTERM", handler); } };
}

function progressLogger(quiet: boolean | undefined): RunOptions["onProgress"] {
  if (quiet) return undefined;
  const seen = new Map<string, string>();
  return (trace: RunTrace) => {
    for (const s of trace.steps) {
      if (seen.get(s.name) === s.status) continue;
      seen.set(s.name, s.status);
      if (s.status === "pending") continue;
      const extra = s.status === "skipped" ? ` (${s.skip_reason})` : s.error && s.status !== "caught" ? ` (${s.error.type}: ${s.error.message})` : s.selected ? ` -> ${s.selected}` : "";
      log(`[${s.status.padEnd(11)}] ${s.name}${extra}`);
    }
  };
}

function finishRun(result: RunResult, flags: CommonRunFlags, recorder?: RecordingRunner): void {
  if (recorder && flags.record) {
    writeFileSync(path.resolve(flags.record), YAML.stringify({ mocks: recorder.mocks }));
    log(`Recorded ${Object.keys(recorder.mocks).length} step mock(s) to ${flags.record}`);
  }
  if (!flags.quiet) {
    if (result.traceFile) log(`Trace: ${result.traceFile}`);
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
    const { runner, recorder } = buildRunner(flags);
    const sig = installSignalHandlers();
    try {
      const opts: RunOptions = { loaded, trigger, runner, signal: sig.signal, ...commonOptions(flags) };
      const onProgress = progressLogger(flags.quiet);
      if (onProgress) opts.onProgress = onProgress;
      const result = await runFlow(opts);
      finishRun(result, flags, recorder);
    } finally {
      sig.dispose();
    }
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
  const { runner, recorder } = buildRunner(flags);
  const sig = installSignalHandlers();
  try {
    const opts: RunOptions = { loaded, trigger: resume.trigger, runner, signal: sig.signal, resume, ...commonOptions(flags) };
    const onProgress = progressLogger(flags.quiet);
    if (onProgress) opts.onProgress = onProgress;
    if (!flags.quiet) log(`Resuming run ${runId} (resume #${resume.resume_count})`);
    const result = await runFlow(opts);
    finishRun(result, flags, recorder);
  } finally {
    sig.dispose();
  }
}
