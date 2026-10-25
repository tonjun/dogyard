import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RunControlError,
  continueRun,
  launchDetached,
  pauseRun,
  readRunPid,
  runLogFile,
  runPauseFile,
  runProcessAlive,
  startBackgroundRun,
  stopRun,
  type CliCommand,
} from "../cli/background.js";
import { FlowError } from "../errors.js";
import { prepareResume } from "../executor/checkpoint.js";
import { validateTrigger } from "../executor/run.js";
import { buildGraph, exportGraph, type GraphFormat } from "../graph.js";
import { LoadError, loadFlow, type LoadedFlow } from "../loader.js";
import { computeProgress, historicalItemMedians, runSummary } from "../progress.js";
import { newRunId, readTrace, recentRuns, traceFile, type RunTrace } from "../trace.js";
import { formatDiagnostics, validateFlow } from "../validate.js";
import { describeFlow } from "./flow-info.js";

export interface UiServerOptions {
  /** Flow folder (or flow.yaml) to serve. */
  flowPath: string;
  /** Interface to bind; loopback by default. */
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  traceDir?: string;
  /** Set false to ignore workflows.yaml (also forwarded to runs it starts). */
  project?: boolean;
  /** Fixed API token (tests); random otherwise. */
  token?: string;
  /** How to invoke the CLI for runs the UI starts (default: this process's own CLI). */
  cliCommand?: CliCommand;
  /** How often SSE streams poll the trace and log (default 300ms). */
  pollMs?: number;
}

export interface UiServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

/** Static files served at `/` and `/static/<name>`; nothing else is read from disk. */
const STATIC: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "app.css": "text/css; charset=utf-8",
};
const STATIC_DIR = fileURLToPath(new URL("./static/", import.meta.url));

const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;
const RUN_LIST_LIMIT = 50;
const HISTORY_RUNS = 10;
/** First chunk of a run.log sent to a new SSE subscriber. */
const LOG_BACKLOG_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Serve the run console for one flow. Runs it starts are ordinary `--detach`
 * runs, so they outlive the server and the CLI's `runs` commands work on them.
 */
export async function startUiServer(opts: UiServerOptions): Promise<UiServer> {
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token ?? randomBytes(16).toString("hex");
  const pollMs = opts.pollMs ?? 300;
  const project = opts.project !== false;
  // Fail fast on a bad path; the definition itself is re-read per request so edits show up.
  const flowDir = loadFlow(opts.flowPath, { project }).dir;
  const forwarded = [...(opts.traceDir ? ["--trace-dir", path.resolve(opts.traceDir)] : []), ...(project ? [] : ["--no-project"])];
  const streams = new Set<() => void>();

  const load = (): LoadedFlow => {
    let loaded: LoadedFlow;
    try {
      loaded = loadFlow(flowDir, { project });
    } catch (err) {
      if (err instanceof LoadError) throw new HttpError(422, [err.message, ...err.issues.map((i) => `  - ${i}`)].join("\n"));
      throw err;
    }
    const v = validateFlow(loaded.flow, { dir: loaded.dir });
    if (!v.ok) throw new HttpError(422, `Flow ${loaded.file} is invalid:\n${formatDiagnostics(v)}`);
    return loaded;
  };

  const traceOf = (runId: string): RunTrace => {
    if (!RUN_ID_RE.test(runId)) throw new HttpError(400, "Invalid run id");
    const file = traceFile(flowDir, runId, opts.traceDir);
    if (!existsSync(file)) throw new HttpError(404, `No run ${runId}`);
    return readTrace(file);
  };

  /** What the controls need besides the trace: whether a process is behind it and can be signalled. */
  const controlState = (trace: RunTrace) => {
    const id = trace.run_id;
    const detached = readRunPid(flowDir, id, opts.traceDir) !== undefined;
    return {
      detached,
      alive: trace.status === "running" && runProcessAlive(flowDir, id, opts.traceDir),
      pause_requested: existsSync(runPauseFile(flowDir, id, opts.traceDir)),
      has_log: existsSync(runLogFile(flowDir, id, opts.traceDir)),
    };
  };

  const runView = (trace: RunTrace) => ({
    trace,
    progress: computeProgress(trace, { history: historicalItemMedians(recentRuns(flowDir, HISTORY_RUNS + 1, opts.traceDir), trace.run_id) }),
    control: controlState(trace),
  });

  const control = (act: (dir: string, id: string, traceDir?: string) => string, runId: string) => {
    traceOf(runId);
    try {
      return { message: act(flowDir, runId, opts.traceDir) };
    } catch (err) {
      if (err instanceof RunControlError) throw new HttpError(409, err.message);
      throw err;
    }
  };

  const launchOpts = opts.cliCommand ? { command: opts.cliCommand } : {};

  const routes: Array<[method: string, pattern: RegExp, handler: (m: string[], req: IncomingMessage, res: ServerResponse) => Promise<unknown> | unknown]> = [
    ["GET", /^\/api\/flow$/, () => describeFlow(load())],
    ["GET", /^\/api\/flow\/source$/, () => ({ text: readFileSync(load().file, "utf8") })],
    [
      "GET",
      /^\/api\/flow\/export$/,
      (_m, req) => {
        const format = (new URL(req.url!, "http://x").searchParams.get("format") ?? "mermaid") as GraphFormat;
        if (!["json", "dot", "mermaid"].includes(format)) throw new HttpError(400, `Unknown format ${format}`);
        return { format, text: exportGraph(buildGraph(load().flow), format) };
      },
    ],
    [
      "GET",
      /^\/api\/runs$/,
      () =>
        recentRuns(flowDir, RUN_LIST_LIMIT, opts.traceDir).map((t) => ({
          run_id: t.run_id,
          status: t.status,
          paused: Boolean(t.paused_at),
          started_at: t.started_at,
          ended_at: t.ended_at,
          resume_count: t.resume_count,
          error: t.error,
          ...runSummary(t),
          ...controlState(t),
        })),
    ],
    ["GET", /^\/api\/runs\/([^/]+)$/, (m) => runView(traceOf(m[1]!))],
    ["GET", /^\/api\/runs\/([^/]+)\/events$/, (m, req, res) => streamRun(m[1]!, req, res)],
    [
      "POST",
      /^\/api\/runs$/,
      async (_m, req) => {
        const body = (await readJson(req)) as { trigger?: unknown; max_concurrency?: number };
        const loaded = load();
        const trigger = body.trigger ?? {};
        try {
          validateTrigger(loaded.flow, trigger);
        } catch (err) {
          if (err instanceof FlowError) throw new HttpError(400, err.message);
          throw err;
        }
        const extraArgs = [...forwarded];
        if (body.max_concurrency !== undefined) {
          if (!Number.isInteger(body.max_concurrency) || body.max_concurrency < 1) throw new HttpError(400, "max_concurrency must be a positive integer");
          extraArgs.push("--max-concurrency", String(body.max_concurrency));
        }
        const runId = newRunId();
        const launched = startBackgroundRun({ flowDir, runId, trigger, extraArgs, ...(opts.traceDir ? { traceDir: opts.traceDir } : {}), ...launchOpts });
        return { run_id: runId, pid: launched.pid };
      },
    ],
    ["POST", /^\/api\/runs\/([^/]+)\/stop$/, (m) => control(stopRun, m[1]!)],
    ["POST", /^\/api\/runs\/([^/]+)\/pause$/, (m) => control(pauseRun, m[1]!)],
    ["POST", /^\/api\/runs\/([^/]+)\/continue$/, (m) => control(continueRun, m[1]!)],
    [
      "POST",
      /^\/api\/runs\/([^/]+)\/resume$/,
      async (m, req) => {
        const body = (await readJson(req)) as { force?: boolean };
        const runId = m[1]!;
        const trace = traceOf(runId);
        if (trace.status === "succeeded") throw new HttpError(409, `Run ${runId} already succeeded`);
        if (trace.status === "running" && runProcessAlive(flowDir, runId, opts.traceDir)) throw new HttpError(409, `Run ${runId} is still running`);
        try {
          prepareResume(trace, load(), { force: body.force === true });
        } catch (err) {
          if (err instanceof FlowError) throw new HttpError(409, err.message);
          throw err;
        }
        const runDir = path.dirname(traceFile(flowDir, runId, opts.traceDir));
        const args = ["resume", flowDir, runId, ...forwarded, ...(body.force ? ["--force"] : [])];
        const launched = launchDetached({ runDir, runId, args, ...launchOpts });
        return { run_id: runId, pid: launched.pid };
      },
    ],
  ];

  /** SSE: `trace` whenever trace.json changes, `log` with new run.log bytes. Stays open across resumes. */
  function streamRun(runId: string, req: IncomingMessage, res: ServerResponse): void {
    if (!RUN_ID_RE.test(runId)) throw new HttpError(400, "Invalid run id");
    const file = traceFile(flowDir, runId, opts.traceDir);
    // A run just started from the UI has its folder (trigger.json, pid) before the child writes trace.json.
    if (!existsSync(path.dirname(file))) throw new HttpError(404, `No run ${runId}`);
    const logFile = runLogFile(flowDir, runId, opts.traceDir);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let mtime = 0;
    let lastControl = "";
    let offset: number | undefined;
    const tick = () => {
      try {
        const m = statSync(file).mtimeMs;
        const trace = m !== mtime ? readTrace(file) : undefined;
        if (trace) {
          mtime = m;
          const view = runView(trace);
          lastControl = JSON.stringify(view.control);
          send("trace", view);
        } else {
          // Pause requests and process exits don't touch trace.json; report them anyway.
          const c = JSON.stringify(controlState(readTrace(file)));
          if (c !== lastControl) {
            lastControl = c;
            send("control", JSON.parse(c));
          }
        }
      } catch {
        /* missing or mid-write; next tick */
      }
      if (existsSync(logFile)) {
        const size = statSync(logFile).size;
        if (offset === undefined) offset = Math.max(0, size - LOG_BACKLOG_BYTES);
        if (size < offset) offset = 0;
        if (size > offset) {
          send("log", { text: readRange(logFile, offset, size), offset });
          offset = size;
        }
      }
    };
    tick();
    const timer = setInterval(tick, pollMs);
    const stop = () => {
      clearInterval(timer);
      streams.delete(stop);
      res.end();
    };
    streams.add(stop);
    req.on("close", stop);
  }

  const allowedHosts = new Set(["127.0.0.1", "localhost", "[::1]", host]);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://x");
        // DNS rebinding: a hostile page resolving its own name to 127.0.0.1 would send its own Host.
        const hostname = (req.headers.host ?? "").replace(/:\d+$/, "");
        if (!allowedHosts.has(hostname)) throw new HttpError(403, "Forbidden host");
        if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res);
        // Cross-site pages cannot read the token, so it doubles as CSRF protection for the POSTs.
        const given = req.headers["x-dogyard-token"] ?? url.searchParams.get("token");
        if (given !== token) throw new HttpError(401, "Missing or wrong token");
        for (const [method, pattern, handler] of routes) {
          const m = pattern.exec(url.pathname);
          if (!m || req.method !== method) continue;
          const result = await handler(m.slice(0), req, res);
          if (!res.headersSent) json(res, 200, result);
          return;
        }
        throw new HttpError(404, "Not found");
      } catch (err) {
        if (res.headersSent) return void res.end();
        if (err instanceof HttpError) return json(res, err.status, { error: err.message });
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${urlHost}:${port}/?token=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of [...streams]) s();
        server.close(() => resolve());
      }),
  };
}

function serveStatic(pathname: string, res: ServerResponse): void {
  const name = pathname === "/" ? "index.html" : pathname.replace(/^\/static\//, "");
  const type = STATIC[name];
  if (!type) throw new HttpError(404, "Not found");
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(readFileSync(path.join(STATIC_DIR, name)));
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value ?? null));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
    return value;
  } catch (err) {
    throw new HttpError(400, `Invalid JSON body: ${(err as Error).message}`);
  }
}

function readRange(file: string, start: number, end: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(end - start);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
