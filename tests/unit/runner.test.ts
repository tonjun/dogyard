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
