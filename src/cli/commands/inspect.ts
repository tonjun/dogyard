import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { formatShortDuration, parseDuration, sleep } from "../../duration.js";
import { buildGraph, exportGraph, type GraphFormat } from "../../graph.js";
import { FLOW_FILENAMES, LoadError, loadFlow } from "../../loader.js";
import { computeProgress, historicalItemMedians, runSummary, type RunProgress } from "../../progress.js";
import { cacheStats, latestRun, listRuns, readTrace, recentRuns, runsDir, traceFile, type RunTrace } from "../../trace.js";
import { ProgressDisplay, stepTransitionLogger } from "../progress-display.js";
import { formatDiagnostics, validateFlow } from "../../validate.js";
import { fail, loadValidFlow, log, printJson } from "../util.js";

export function registerInspect(program: Command): void {
  program
    .command("validate <flow>")
    .description("Validate a flow definition: structure, references, DAG and expression syntax")
    .option("--no-project", "ignore project-level workflows.yaml config")
    .option("--json", "print diagnostics as JSON")
    .action((flowPath: string, flags: { project?: boolean; json?: boolean }) => {
      let loaded;
      try {
        loaded = loadFlow(flowPath, { project: flags.project !== false });
      } catch (err) {
        if (err instanceof LoadError) {
          if (flags.json) printJson({ ok: false, errors: (err.issues.length ? err.issues : [err.message]).map((m) => ({ level: "error", message: m })), warnings: [] });
          else log([err.message, ...err.issues.map((i) => `  - ${i}`)].join("\n"));
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      const v = validateFlow(loaded.flow, { dir: loaded.dir });
      if (flags.json) printJson({ ok: v.ok, file: loaded.file, errors: v.errors, warnings: v.warnings });
      else {
        const diag = formatDiagnostics(v);
        if (diag) log(diag);
        log(v.ok ? `OK: ${loaded.flow.name}@${loaded.flow.version} (${Object.keys(loaded.flow.steps).length} steps)` : `INVALID: ${loaded.file}`);
      }
      if (!v.ok) process.exitCode = 1;
    });

  program
    .command("graph <flow>")
    .description("Export the flow's step graph")
    .option("-F, --format <format>", "json | dot | mermaid", "json")
    .option("--no-project", "ignore project-level workflows.yaml config")
    .action((flowPath: string, flags: { format: string; project?: boolean }) => {
      if (!["json", "dot", "mermaid"].includes(flags.format)) fail(`Unknown format "${flags.format}" (json | dot | mermaid)`);
      const loaded = loadValidFlow(flowPath, { project: flags.project !== false });
      process.stdout.write(`${exportGraph(buildGraph(loaded.flow), flags.format as GraphFormat)}\n`);
    });

  program
    .command("describe <flow>")
    .description("Print a flow's metadata, config and steps")
    .option("--json", "print as JSON")
    .option("--no-project", "ignore project-level workflows.yaml config")
    .action((flowPath: string, flags: { json?: boolean; project?: boolean }) => {
      const loaded = loadValidFlow(flowPath, { project: flags.project !== false });
      const g = buildGraph(loaded.flow);
      if (flags.json) {
        printJson({ name: loaded.flow.name, version: loaded.flow.version, description: loaded.flow.description, dir: loaded.dir, hash: loaded.hash, project: loaded.project?.file, config: loaded.flow.config, steps: g.nodes, edges: g.edges });
        return;
      }
      const lines = [`${loaded.flow.name}@${loaded.flow.version}${loaded.flow.description ? ` — ${loaded.flow.description}` : ""}`, `  dir:     ${loaded.dir}`];
      if (loaded.project) lines.push(`  project: ${loaded.project.file}`);
      lines.push(`  config:  ${JSON.stringify(loaded.flow.config)}`, "  steps:");
      for (const name of g.order) {
        const step = loaded.flow.steps[name]!;
        const deps = [...(g.deps.get(name) ?? [])];
        let detail = "";
        if (step.type === "command") detail = ` ${JSON.stringify(step.command)}${step.mock !== undefined ? " [mock]" : ""}`;
        if (step.type === "choice") detail = ` -> ${[...step.branches.map((b) => b.next), ...(step.default ? [`${step.default} (default)`] : [])].join(" | ")}`;
        if (step.type === "map") detail = ` over ${step.over} (${step.step.type})${step.step.type === "command" && step.step.mock !== undefined ? " [mock]" : ""}`;
        lines.push(`    ${name.padEnd(20)} ${step.type.padEnd(9)}${step.terminal ? ` terminal:${step.terminal}` : ""}${deps.length ? ` needs: [${deps.join(", ")}]` : ""}${detail}`);
      }
      process.stdout.write(`${lines.join("\n")}\n`);
    });

  program
    .command("list [root]")
    .description("List flows (folders containing flow.yaml) under a directory")
    .option("--json", "print as JSON")
    .action((root: string | undefined, flags: { json?: boolean }) => {
      const base = path.resolve(root ?? ".");
      const found = findFlows(base);
      const rows = found.map((dir) => {
        try {
          const loaded = loadFlow(dir);
          const v = validateFlow(loaded.flow, { dir: loaded.dir });
          return { dir, name: loaded.flow.name, version: loaded.flow.version, description: loaded.flow.description, steps: Object.keys(loaded.flow.steps).length, valid: v.ok };
        } catch (err) {
          return { dir, error: err instanceof LoadError ? err.message : String(err), valid: false };
        }
      });
      if (flags.json) return printJson(rows);
      if (!rows.length) return log(`No flows found under ${base}`);
      for (const r of rows) {
        const rel = path.relative(base, r.dir) || ".";
        if ("error" in r) process.stdout.write(`${rel.padEnd(30)} INVALID  ${r.error}\n`);
        else process.stdout.write(`${rel.padEnd(30)} ${`${r.name}@${r.version}`.padEnd(28)} ${String(r.steps).padStart(3)} steps${r.valid ? "" : "  INVALID"}${r.description ? `  ${r.description}` : ""}\n`);
      }
    });

  const runs = program.command("runs").description("Inspect persisted run traces");
  runs
    .command("list <flow>", { isDefault: true })
    .description("List runs recorded under <flow>/.runs")
    .option("--trace-dir <dir>", "directory holding run traces")
    .option("--json", "print as JSON")
    .action((flowPath: string, flags: { traceDir?: string; json?: boolean }) => {
      const loaded = loadValidFlow(flowPath);
      const all = listRuns(loaded.dir, flags.traceDir);
      if (flags.json) return printJson(all.map((t) => ({ run_id: t.run_id, status: t.status, started_at: t.started_at, ended_at: t.ended_at, resume_count: t.resume_count, terminal_step: t.terminal_step, error: t.error, cache: cacheStats(t), progress: runSummary(t) })));
      if (!all.length) return log("No runs found");
      for (const t of all) {
        const c = cacheStats(t);
        const p = runSummary(t);
        const cache = c.cached || c.executed ? `  cached=${c.cached} executed=${c.executed}` : "";
        const items = p.items_total ? `  items=${p.items_done}/${p.items_total}` : "";
        process.stdout.write(`${t.run_id}  ${t.status.padEnd(11)}  ${t.started_at}  ${formatShortDuration(p.duration_ms).padStart(6)}  resumes=${t.resume_count}${items}${cache}${t.error ? `  ${t.error.type}: ${t.error.message}` : ""}\n`);
      }
    });
  runs
    .command("show <flow> [run_id]")
    .description("Print a run's trace JSON (the latest run if no run_id, or run_id is `latest`)")
    .option("--trace-dir <dir>", "directory holding run traces")
    .action((flowPath: string, runId: string | undefined, flags: { traceDir?: string }) => {
      const loaded = loadValidFlow(flowPath);
      if (runId === undefined || runId === "latest") {
        const latest = latestRun(loaded.dir, flags.traceDir);
        if (!latest) fail(`No runs found under ${runsDir(loaded.dir, flags.traceDir)}`);
        return printJson(latest);
      }
      const file = traceFile(loaded.dir, runId, flags.traceDir);
      if (!existsSync(file)) fail(`No trace at ${file}`);
      printJson(readTrace(file));
    });
  runs
    .command("watch <flow> [run_id]")
    .description("Follow a run's progress from its trace file until it ends (the latest run if no run_id, or run_id is `latest`)")
    .option("--trace-dir <dir>", "directory holding run traces")
    .option("--json", "stream progress events as NDJSON on stdout")
    .option("--interval <duration>", "how often to poll the trace file", "500ms")
    .action(async (flowPath: string, runId: string | undefined, flags: { traceDir?: string; json?: boolean; interval: string }) => {
      const loaded = loadValidFlow(flowPath);
      let id = runId;
      if (id === undefined || id === "latest") {
        id = recentRuns(loaded.dir, 1, flags.traceDir)[0]?.run_id;
        if (!id) fail(`No runs found under ${runsDir(loaded.dir, flags.traceDir)}`);
      }
      const file = traceFile(loaded.dir, id, flags.traceDir);
      if (!existsSync(file)) fail(`No trace at ${file}`);
      await watchRun(file, {
        json: flags.json ?? false,
        interval: parseDuration(flags.interval),
        history: historicalItemMedians(recentRuns(loaded.dir, 11, flags.traceDir), id),
      });
    });
}

const STDERR_TAIL_LINES = 5;

/** Poll a trace file (written by atomic rename, so fs.watch is unreliable) and render its progress until the run ends. */
async function watchRun(file: string, opts: { json: boolean; interval: number; history: Record<string, number> }): Promise<void> {
  const tty = Boolean(process.stderr.isTTY);
  let mtime = 0;
  let trace: RunTrace | undefined;
  let lastError = "";
  const progressOf = (t: RunTrace): RunProgress => computeProgress(t, { history: opts.history });

  // TTY: the last error and an "updated Ns ago" line stay under the status lines.
  // Non-TTY: the last error is printed once, when it changes.
  const footer = (p: RunProgress): string[] => {
    const lines: string[] = [];
    const err = errorLines(p);
    const key = err.join("\n");
    if (tty || key !== lastError) lines.push(...err);
    lastError = key;
    if (tty && p.status === "running") lines.push(`updated ${formatShortDuration(Date.now() - mtime)} ago`);
    return lines;
  };
  const display = opts.json ? undefined : new ProgressDisplay({ history: opts.history, footer });
  const transitions = display ? stepTransitionLogger((m) => display.log(m)) : undefined;

  try {
    for (;;) {
      let changed = false;
      try {
        const m = statSync(file).mtimeMs;
        if (m !== mtime) {
          trace = readTrace(file);
          mtime = m;
          changed = true;
        }
      } catch {
        /* missing or mid-write; try again next tick */
      }
      if (changed && trace) {
        if (opts.json) printJson({ event: "progress", ...progressOf(trace) }, false);
        else {
          transitions!(trace);
          display!.update(trace);
        }
      }
      if (trace && trace.status !== "running") break;
      await sleep(opts.interval);
    }
  } finally {
    display?.stop();
  }

  const t = trace!;
  if (opts.json) printJson({ event: "end", run_id: t.run_id, status: t.status, duration_ms: t.duration_ms, error: t.error, output: t.output }, false);
  else {
    if (t.status !== "succeeded") for (const l of errorLines(progressOf(t))) log(l);
    log(`Run ${t.run_id} ${t.status}${t.duration_ms !== undefined ? ` in ${formatShortDuration(t.duration_ms)}` : ""}${t.error ? `: ${t.error.type}: ${t.error.message}` : ""}`);
  }
  if (t.status !== "succeeded") process.exitCode = t.status === "interrupted" ? 130 : 1;
}

/** The most recent error across steps/items, with the tail of its stderr. */
function errorLines(p: RunProgress): string[] {
  const s = p.steps.filter((x) => x.last_error).at(-1);
  if (!s?.last_error) return [];
  const e = s.last_error;
  const where = e.item !== undefined ? `${s.name}[${e.item}]` : s.name;
  const tail = (e.stderr ?? "").trimEnd().split("\n").filter(Boolean).slice(-STDERR_TAIL_LINES);
  return [`last error: ${where} ${e.type}: ${e.message}`, ...tail.map((l) => `  | ${l}`)];
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".runs", "dist"]);

export function findFlows(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (FLOW_FILENAMES.some((f) => existsSync(path.join(dir, f)))) {
      out.push(dir);
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const p = path.join(dir, e);
      try {
        if (statSync(p).isDirectory()) walk(p);
      } catch {
        /* ignore */
      }
    }
  };
  walk(root);
  return out;
}
