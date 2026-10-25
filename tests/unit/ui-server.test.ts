import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFlow } from "../../src/loader.js";
import { describeFlow, stepSnippets } from "../../src/ui/flow-info.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";

const ROOT = path.resolve(__dirname, "../..");
const CLI = [process.execPath, path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), path.join(ROOT, "src/cli/index.ts")];

let work: string;
let flowDir: string;
let server: UiServer;

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), "ui-"));
  flowDir = path.join(work, "flows/hello");
  cpSync(path.join(ROOT, "examples/flows/hello"), flowDir, { recursive: true, filter: (src) => path.basename(src) !== ".runs" });
  writeFileSync(path.join(work, "workflows.yaml"), "config:\n  max_concurrency: 3\n");
  server = await startUiServer({ flowPath: flowDir, token: "t0k", cliCommand: CLI, pollMs: 50 });
});

afterAll(async () => {
  await server?.close();
});

interface Reply {
  status: number;
  body: string;
  json: () => any;
}

function call(method: string, urlPath: string, opts: { body?: unknown; token?: string | null; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${server.port}` };
    if (opts.token !== null) headers["x-dogyard-token"] = opts.token ?? "t0k";
    const req = request({ host: "127.0.0.1", port: server.port, method, path: urlPath, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d: string) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, body, json: () => JSON.parse(body) }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

/** Collect SSE events until `done` says stop (or the timeout hits). */
function events(urlPath: string, done: (events: Array<{ event: string; data: any }>) => boolean, ms = 20_000): Promise<Array<{ event: string; data: any }>> {
  return new Promise((resolve, reject) => {
    const seen: Array<{ event: string; data: any }> = [];
    const req = request({ host: "127.0.0.1", port: server.port, path: `${urlPath}?token=t0k`, headers: { host: `localhost:${server.port}` } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`SSE status ${res.statusCode}`));
      let buf = "";
      res.setEncoding("utf8").on("data", (d: string) => {
        buf += d;
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? "message";
          const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? "null");
          seen.push({ event, data });
          if (done(seen)) {
            req.destroy();
            resolve(seen);
          }
        }
      });
    });
    req.on("error", (err) => (seen.length ? resolve(seen) : reject(err)));
    setTimeout(() => {
      req.destroy();
      const lastTrace = seen.filter((e) => e.event === "trace").at(-1)?.data.trace;
      const logText = seen.filter((e) => e.event === "log").map((e) => e.data.text).join("");
      reject(new Error(`timed out; saw ${seen.map((e) => e.event).join(",")}; last trace status=${lastTrace?.status} resume_count=${lastTrace?.resume_count} error=${JSON.stringify(lastTrace?.error)}\n--- log tail ---\n${logText.slice(-2000)}`));
    }, ms).unref();
    req.end();
  });
}

describe("UI server access control", () => {
  it("serves the page without a token but guards the API", async () => {
    const page = await call("GET", "/", { token: null });
    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>DogYard Console</title>");
    expect((await call("GET", "/static/app.js", { token: null })).status).toBe(200);
    expect((await call("GET", "/static/../server.ts", { token: null })).status).toBe(404);
    expect((await call("GET", "/api/flow", { token: null })).status).toBe(401);
    expect((await call("GET", "/api/flow", { token: "wrong" })).status).toBe(401);
    expect((await call("GET", "/api/flow?token=t0k", { token: null })).status).toBe(200);
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    expect((await call("GET", "/", { host: "evil.example:80" })).status).toBe(403);
    expect((await call("GET", "/api/flow", { host: "evil.example" })).status).toBe(403);
  });

  it("returns 404 for unknown routes and 400 for bad run ids", async () => {
    expect((await call("GET", "/api/nope")).status).toBe(404);
    expect((await call("DELETE", "/api/flow")).status).toBe(404);
    expect((await call("GET", "/api/runs/..%2Fx")).status).toBe(400);
    expect((await call("GET", "/api/runs/missing")).status).toBe(404);
    expect((await call("GET", "/api/runs/missing/events")).status).toBe(404);
  });
});

describe("UI server flow info", () => {
  it("describes the flow: steps with YAML, cwd, tests, and config sources", async () => {
    const f = (await call("GET", "/api/flow")).json();
    expect(f).toMatchObject({ name: "hello", description: expect.stringMatching(/Uppercase/), has_tests: true, sinks: ["long", "short"] });
    expect(f.config.max_concurrency).toEqual({ value: 3, source: "project" });
    expect(f.config.default_timeout).toEqual({ value: "10s", source: "flow" });
    expect(f.config.default_retry.source).toBe("default");
    expect(f.project_file).toBe(path.join(work, "workflows.yaml"));
    const shout = f.steps.find((s: { name: string }) => s.name === "shout");
    expect(shout).toMatchObject({ type: "command", cwd: "steps/shout", has_tests: true, needs: [] });
    expect(shout.definition.mock).toBeUndefined();
    expect(shout.yaml).toMatch(/^shout:\n {2}type: command\n/);
    expect(shout.yaml).toContain("# used by `dogyard test`");
    const route = f.steps.find((s: { name: string }) => s.name === "route");
    expect(route.cwd).toBeUndefined();
    expect(f.edges).toContainEqual({ from: "route", to: "short", kind: "choice", label: "default" });
  });

  it("serves the flow source and graph exports", async () => {
    expect((await call("GET", "/api/flow/source")).json().text).toContain("name: hello");
    expect((await call("GET", "/api/flow/export?format=mermaid")).json().text).toMatch(/^flowchart|graph/);
    expect((await call("GET", "/api/flow/export?format=svg")).status).toBe(400);
  });

  it("reports an invalid flow definition as 422 instead of crashing", async () => {
    const bad = path.join(work, "flows/bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(path.join(bad, "flow.yaml"), "name: bad\nversion: 0.1.0\nsteps:\n  a: { type: command, command: [x] }\n");
    const s = await startUiServer({ flowPath: bad, token: "x", cliCommand: CLI });
    try {
      writeFileSync(path.join(bad, "flow.yaml"), "name: bad\nversion: 0.1.0\nsteps:\n  a: { type: command, command: [x], needs: [nope] }\n");
      const r = await new Promise<number>((resolve) => request({ host: "127.0.0.1", port: s.port, path: "/api/flow", headers: { "x-dogyard-token": "x" } }, (res) => resolve(res.statusCode!)).end());
      expect(r).toBe(422);
    } finally {
      await s.close();
    }
  });
});

describe("UI server runs", () => {
  it("validates the trigger and the request body before starting anything", async () => {
    expect((await call("POST", "/api/runs", { body: { trigger: {} } })).json().error).toMatch(/required property 'query'/);
    expect((await call("POST", "/api/runs", { body: "{nope" })).status).toBe(400);
    expect((await call("POST", "/api/runs", { body: "[]" })).status).toBe(400);
    expect((await call("POST", "/api/runs", { body: { trigger: { query: "x" }, max_concurrency: 0 } })).status).toBe(400);
    expect((await call("GET", "/api/runs")).json()).toEqual([]);
  });

  it("starts a background run and streams its trace and log to the end", async () => {
    const started = await call("POST", "/api/runs", { body: { trigger: { query: "hello world" }, max_concurrency: 2 } });
    expect(started.status, started.body).toBe(200);
    const { run_id: runId } = started.json() as { run_id: string };

    const seen = await events(`/api/runs/${runId}/events`, (ev) => ev.some((e) => e.event === "trace" && e.data.trace.status !== "running") && ev.some((e) => e.event === "log" && e.data.text.includes(`Run ${runId} succeeded`)));
    const last = seen.filter((e) => e.event === "trace").at(-1)!.data;
    expect(last.trace.status).toBe("succeeded");
    expect(last.trace.output).toMatchObject({ kind: "long", value: "HELLO WORLD" });
    expect(last.progress.run_id).toBe(runId);
    expect(last.control).toMatchObject({ detached: true, has_log: true, pause_requested: false });
    expect(seen.filter((e) => e.event === "log").map((e) => e.data.text).join("")).toMatch(/--max-concurrency|=== \S+ run /);

    const list = (await call("GET", "/api/runs")).json();
    expect(list[0]).toMatchObject({ run_id: runId, status: "succeeded", paused: false, detached: true, alive: false });
    const view = (await call("GET", `/api/runs/${runId}`)).json();
    expect(view.trace.run_id).toBe(runId);

    // Controls refuse what doesn't apply to a finished run.
    for (const action of ["stop", "pause", "continue", "resume"]) {
      const r = await call("POST", `/api/runs/${runId}/${action}`);
      expect(r.status, action).toBe(409);
    }
  });
});

describe("UI server controls on live and stopped runs", () => {
  const fakeRun = (id: string, trace: Record<string, unknown>, pid?: number) => {
    const runDir = path.join(flowDir, ".runs", id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "trace.json"), JSON.stringify({ schema_version: 1, run_id: id, resume_count: 0, trigger: { query: "hello there" }, started_at: new Date().toISOString(), steps: [], ...trace }));
    if (pid !== undefined) writeFileSync(path.join(runDir, "pid"), `${pid}\n`);
    return runDir;
  };

  it("pauses, continues and stops a running process, reporting control changes over SSE", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const exited = new Promise((r) => child.on("exit", r));
    const runDir = fakeRun("20990101T000000Z-live01", { status: "running", flow: { name: "hello", version: "0.1.0", hash: "x" } }, child.pid);
    const id = path.basename(runDir);
    expect((await call("POST", `/api/runs/${id}/resume`)).json().error).toMatch(/still running/);
    expect((await call("POST", `/api/runs/${id}/pause`)).json().message).toMatch(/Requested pause/);
    const seen = await events(`/api/runs/${id}/events`, (ev) => ev.some((e) => e.event === "trace"));
    expect(seen[0]!.data.control).toMatchObject({ alive: true, detached: true, pause_requested: true, has_log: false });
    expect((await call("POST", `/api/runs/${id}/continue`)).status).toBe(200);
    expect((await call("POST", `/api/runs/${id}/stop`)).status).toBe(200);
    // On Windows stopRun only writes the stop file (the run polls for it); this fake run doesn't, so end it here.
    if (process.platform === "win32") {
      expect(existsSync(path.join(runDir, "stop"))).toBe(true);
      child.kill();
    }
    await exited;
  });

  it("resumes an interrupted run, refusing a changed flow unless forced", async () => {
    const started = (await call("POST", "/api/runs", { body: { trigger: { query: "hi" } } })).json() as { run_id: string };
    await events(`/api/runs/${started.run_id}/events`, (ev) => ev.some((e) => e.event === "trace" && e.data.trace.status === "succeeded"));
    const tracePath = path.join(flowDir, ".runs", started.run_id, "trace.json");
    const done = JSON.parse(readFileSync(tracePath, "utf8"));
    const interrupted = { ...done, status: "interrupted", flow: { ...done.flow, hash: "stale" }, steps: done.steps.map((s: { name: string }) => (s.name === "long" || s.name === "short" || s.name === "route" ? { name: s.name, type: (s as { type: string }).type, status: "pending", attempts: [] } : s)) };
    writeFileSync(tracePath, JSON.stringify(interrupted));
    expect((await call("POST", `/api/runs/${started.run_id}/resume`)).json().error).toMatch(/hash mismatch/);
    const resumed = await call("POST", `/api/runs/${started.run_id}/resume`, { body: { force: true } });
    expect(resumed.status, resumed.body).toBe(200);
    const seen = await events(`/api/runs/${started.run_id}/events`, (ev) => ev.some((e) => e.event === "trace" && e.data.trace.status === "succeeded" && e.data.trace.resume_count === 1));
    expect(seen.filter((e) => e.event === "trace").at(-1)!.data.trace.output).toMatchObject({ kind: "short", value: "HI" });
  });
});

describe("describeFlow", () => {
  it("covers map sub-step cwd, evals and engine defaults without project config", () => {
    const f = describeFlow(loadFlow(path.join(ROOT, "examples/flows/research"), { project: false }));
    expect(f.has_evals).toBe(true);
    expect(f.project_file).toBeUndefined();
    expect(f.config.max_concurrency).toEqual({ value: 8, source: "default" });
    expect(f.trigger_schema).toMatchObject({ required: ["query"] });
    const map = f.steps.find((s) => s.name === "summarize_each")!;
    expect(map.cwd).toBe("steps/summarize_each");
    expect((map.definition.step as Record<string, unknown>).mock).toBeUndefined();
    expect(f.steps.find((s) => s.name === "flag_for_review")!.cwd).toBeUndefined();
  });
});

describe("stepSnippets", () => {
  it("slices each step block, keeping inner comments, and tolerates odd files", () => {
    const file = path.join(work, "snip.yaml");
    writeFileSync(file, "steps:\n  # lead comment\n  a:\n    type: pass   # inline\n\n  b: { type: pass }\n");
    const m = stepSnippets(file);
    expect(m.get("a")).toBe("a:\n  type: pass   # inline");
    expect(m.get("b")).toBe("b: { type: pass }");
    writeFileSync(file, "steps: [1, 2]\n");
    expect(stepSnippets(file).size).toBe(0);
    expect(stepSnippets(path.join(work, "missing.yaml")).size).toBe(0);
  });
});
