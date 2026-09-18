import { spawn } from "node:child_process";
import { FlowError } from "../errors.js";
import type { MockResult, Mocks } from "../schema/test.js";

export interface CommandRequest {
  /** Fully-resolved argv (argv[0] is the executable). */
  argv: string[];
  /** Data written to stdin, if any. */
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
  /** Milliseconds; undefined = no timeout. */
  timeout?: number;
  signal?: AbortSignal;
  /** Identity of the step (and map item) issuing the request; used by mock/record runners. */
  step: string;
  itemIndex?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface CommandRunner {
  run(req: CommandRequest): Promise<CommandResult>;
}

/** Runs real subprocesses (no shell). Nonzero exit, timeout and spawn failures become FlowErrors. */
export class RealRunner implements CommandRunner {
  run(req: CommandRequest): Promise<CommandResult> {
    const start = Date.now();
    return new Promise<CommandResult>((resolve, reject) => {
      if (req.signal?.aborted) return reject(new FlowError("interrupted", "Run aborted before command started", { step: req.step }));
      const [cmd, ...args] = req.argv;
      if (!cmd) return reject(new FlowError("spawn_error", "Empty command", { step: req.step }));

      const spawnOpts: Parameters<typeof spawn>[2] = { env: { ...process.env, ...req.env }, stdio: ["pipe", "pipe", "pipe"] };
      if (req.cwd) spawnOpts.cwd = req.cwd;
      const child = spawn(cmd, args, spawnOpts);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const timer = req.timeout !== undefined && req.timeout > 0 ? setTimeout(() => { timedOut = true; kill(); }, req.timeout) : undefined;
      const onAbort = () => { aborted = true; kill(); };
      req.signal?.addEventListener("abort", onAbort, { once: true });

      const kill = () => {
        if (child.exitCode === null && !child.killed) {
          child.kill("SIGTERM");
          setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2000).unref();
        }
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (err: FlowError) => { if (settled) return; settled = true; cleanup(); reject(err); };

      child.stdout?.setEncoding("utf8").on("data", (d: string) => { stdout += d; });
      child.stderr?.setEncoding("utf8").on("data", (d: string) => { stderr += d; });
      child.on("error", (err: NodeJS.ErrnoException) => {
        fail(new FlowError("spawn_error", `Failed to start "${cmd}": ${err.message}`, { step: req.step, details: { code: err.code, argv: req.argv }, cause: err }));
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        const durationMs = Date.now() - start;
        const details = { argv: req.argv, exitCode: code, signal, stdout: tail(stdout), stderr: tail(stderr), durationMs };
        if (aborted) return reject(new FlowError("interrupted", `Command "${cmd}" was interrupted`, { step: req.step, details }));
        if (timedOut) return reject(new FlowError("timeout", `Command "${cmd}" timed out after ${req.timeout}ms`, { step: req.step, details }));
        if (code !== 0) return reject(new FlowError("nonzero_exit", `Command "${cmd}" exited with code ${code ?? `signal ${signal}`}`, { step: req.step, details }));
        resolve({ stdout, stderr, exitCode: code ?? 0, durationMs });
      });

      if (req.stdin !== undefined) {
        child.stdin?.on("error", () => { /* EPIPE when the child exits early; the close handler reports the real outcome */ });
        child.stdin?.end(req.stdin);
      } else {
        child.stdin?.end();
      }
    });
  }
}

function tail(s: string, max = 4000): string {
  return s.length > max ? `…${s.slice(-max)}` : s;
}

/** Serves canned results keyed by step name (and item index for map sub-steps). */
export class MockRunner implements CommandRunner {
  constructor(private readonly mocks: Mocks) {}

  async run(req: CommandRequest): Promise<CommandResult> {
    const entry = this.mocks[req.step];
    if (entry === undefined) {
      throw new FlowError("spawn_error", `No mock defined for step "${req.step}"`, { step: req.step, details: { argv: req.argv, available: Object.keys(this.mocks) } });
    }
    let result: MockResult | undefined;
    if (Array.isArray(entry)) {
      result = req.itemIndex !== undefined ? entry[req.itemIndex] : entry[0];
      if (result === undefined) {
        throw new FlowError("spawn_error", `No mock for step "${req.step}" item ${req.itemIndex}`, { step: req.step });
      }
    } else {
      result = entry;
    }
    if ("output" in result) {
      const stdout = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      return { stdout, stderr: "", exitCode: 0, durationMs: 0 };
    }
    if (result.exit_code !== 0) {
      throw new FlowError("nonzero_exit", `Command "${req.argv[0]}" exited with code ${result.exit_code} (mock)`, {
        step: req.step,
        details: { argv: req.argv, exitCode: result.exit_code, stdout: result.stdout, stderr: result.stderr, mock: true },
      });
    }
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, durationMs: 0 };
  }
}

/** Wraps another runner and records every result as a mock (successful or not). */
export class RecordingRunner implements CommandRunner {
  readonly mocks: Mocks = {};

  constructor(private readonly inner: CommandRunner) {}

  async run(req: CommandRequest): Promise<CommandResult> {
    try {
      const res = await this.inner.run(req);
      this.record(req, { stdout: res.stdout, stderr: res.stderr, exit_code: res.exitCode });
      return res;
    } catch (err) {
      if (err instanceof FlowError && err.type === "nonzero_exit") {
        const d = (err.details ?? {}) as { stdout?: string; stderr?: string; exitCode?: number };
        this.record(req, { stdout: d.stdout ?? "", stderr: d.stderr ?? "", exit_code: d.exitCode ?? 1 });
      }
      throw err;
    }
  }

  private record(req: CommandRequest, result: MockResult): void {
    if (req.itemIndex === undefined) {
      this.mocks[req.step] = result;
      return;
    }
    const existing = this.mocks[req.step];
    const arr: MockResult[] = Array.isArray(existing) ? existing : [];
    arr[req.itemIndex] = result;
    this.mocks[req.step] = arr;
  }
}
