import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockRunner, RealRunner, RecordingRunner } from "../../src/executor/command-runner.js";

const node = process.execPath;

describe("RealRunner", () => {
  const r = new RealRunner();
  it("captures stdout and passes stdin", async () => {
    const res = await r.run({ step: "s", argv: [node, "-e", "process.stdin.on('data',d=>process.stdout.write(d.toString().toUpperCase()))"], stdin: "hi" });
    expect(res.stdout).toBe("HI");
    expect(res.exitCode).toBe(0);
  });
  it("maps nonzero exit", async () => {
    await expect(r.run({ step: "s", argv: [node, "-e", "console.error('bad');process.exit(3)"] })).rejects.toMatchObject({ type: "nonzero_exit", details: { exitCode: 3, stderr: "bad\n" } });
  });
  it("maps timeout", async () => {
    await expect(r.run({ step: "s", argv: [node, "-e", "setTimeout(()=>{},5000)"], timeout: 100 })).rejects.toMatchObject({ type: "timeout" });
  });
  it("maps spawn error", async () => {
    await expect(r.run({ step: "s", argv: ["definitely-not-a-binary-xyz"] })).rejects.toMatchObject({ type: "spawn_error" });
  });
  it("maps abort", async () => {
    const ac = new AbortController();
    const p = r.run({ step: "s", argv: [node, "-e", "setTimeout(()=>{},5000)"], signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ type: "interrupted" });
  });
});

describe.skipIf(process.platform === "win32")("RealRunner kills the whole process group", () => {
  const r = new RealRunner();
  // Each command keeps bash alive past the grandchild (`; true`) so bash can't just exec it.
  const settleTime = async (p: Promise<unknown>) => {
    const t0 = Date.now();
    const err = await p.then(() => undefined, (e: unknown) => e);
    return { err, elapsed: Date.now() - t0 };
  };
  const pidAlive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
  };

  it("timeout doesn't wait for a grandchild", async () => {
    const { err, elapsed } = await settleTime(r.run({ step: "s", argv: ["bash", "-c", "sleep 30; true"], timeout: 200 }));
    expect(err).toMatchObject({ type: "timeout" });
    expect(elapsed).toBeLessThan(3000);
    expect((err as { details: { durationMs: number } }).details.durationMs).toBeLessThan(3000);
  });
  it("timeout with command substitution and a pipeline", async () => {
    const { err, elapsed } = await settleTime(r.run({ step: "s", argv: ["bash", "-c", "x=$(sleep 30 | cat); echo $x"], timeout: 200 }));
    expect(err).toMatchObject({ type: "timeout" });
    expect(elapsed).toBeLessThan(3000);
  });
  it("abort doesn't wait for a grandchild", async () => {
    const ac = new AbortController();
    const p = r.run({ step: "s", argv: ["bash", "-c", "sleep 30; true"], signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const { err, elapsed } = await settleTime(p);
    expect(err).toMatchObject({ type: "interrupted" });
    expect(elapsed).toBeLessThan(3000);
  });
  it("leaves no orphaned grandchild behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dogyard-runner-"));
    const pidFile = join(dir, "pid");
    try {
      await expect(r.run({ step: "s", argv: ["bash", "-c", 'sh -c "echo \\$\\$ > \\"$F\\"; exec sleep 30"; true'], env: { F: pidFile }, timeout: 300 })).rejects.toMatchObject({ type: "timeout" });
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pid).toBeGreaterThan(0);
      const deadline = Date.now() + 3000;
      while (pidAlive(pid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
      expect(pidAlive(pid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("settles even when a descendant ignores SIGTERM", async () => {
    const { err, elapsed } = await settleTime(r.run({ step: "s", argv: ["bash", "-c", 'trap "" TERM; sleep 30; true'], timeout: 200 }));
    expect(err).toMatchObject({ type: "timeout" });
    expect(elapsed).toBeLessThan(4000);
  });
});

describe("MockRunner", () => {
  it("serves output/stdout/exit mocks and per-item arrays", async () => {
    const m = new MockRunner({ a: { output: { x: 1 } }, b: { stdout: "raw", stderr: "", exit_code: 0 }, c: { stdout: "", stderr: "e", exit_code: 2 }, d: [{ output: 1 }, { output: 2 }] });
    expect((await m.run({ step: "a", argv: ["x"] })).stdout).toBe('{"x":1}');
    expect((await m.run({ step: "b", argv: ["x"] })).stdout).toBe("raw");
    await expect(m.run({ step: "c", argv: ["x"] })).rejects.toMatchObject({ type: "nonzero_exit" });
    expect((await m.run({ step: "d", argv: ["x"], itemIndex: 1 })).stdout).toBe("2");
    await expect(m.run({ step: "d", argv: ["x"], itemIndex: 5 })).rejects.toMatchObject({ type: "spawn_error" });
    await expect(m.run({ step: "zz", argv: ["x"] })).rejects.toMatchObject({ type: "spawn_error" });
  });
});

describe("RecordingRunner", () => {
  it("records successes, failures and map items", async () => {
    const rec = new RecordingRunner(new RealRunner());
    await rec.run({ step: "a", argv: [node, "-e", "console.log('{\"k\":1}')"] });
    await rec.run({ step: "m", argv: [node, "-e", "console.log(1)"], itemIndex: 0 });
    await rec.run({ step: "m", argv: [node, "-e", "console.log(2)"], itemIndex: 1 });
    await rec.run({ step: "f", argv: [node, "-e", "process.exit(1)"] }).catch(() => {});
    expect(rec.mocks).toEqual({
      a: { stdout: '{"k":1}\n', stderr: "", exit_code: 0 },
      m: [{ stdout: "1\n", stderr: "", exit_code: 0 }, { stdout: "2\n", stderr: "", exit_code: 0 }],
      f: { stdout: "", stderr: "", exit_code: 1 },
    });
  });
});
