import { Command } from "commander";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAlive, launchDetached, optionArgs, readRunPid, runLogFile, runPidFile, runProcessAlive, runStopFile } from "../../src/cli/background.js";

describe("optionArgs", () => {
  it("rebuilds only the options given on the command line, minus excluded ones", () => {
    const cmd = new Command("run")
      .exitOverride()
      .argument("<flow>")
      .option("-Q, --query <text>")
      .option("--max-concurrency <n>")
      .option("--run-timeout <duration>", "", "5m")
      .option("--no-project")
      .option("--no-cache")
      .option("-q, --quiet")
      .option("--trace")
      .option("--detach")
      .action(() => {});
    cmd.parse(["node", "x", "flow", "-qQ", "hi", "--max-concurrency=3", "--no-cache", "--detach"]);
    expect(optionArgs(cmd, ["query", "detach"])).toEqual(["--max-concurrency", "3", "--no-cache", "--quiet"]);
  });

  it("forwards optional-value flags with and without a value, and skips negations left on", () => {
    const cmd = new Command("x")
      .exitOverride()
      .option("--color [when]")
      .option("--level [n]")
      .option("--no-project")
      .action(() => {});
    cmd.parse(["node", "x", "--color", "--level", "2"]);
    expect(optionArgs(cmd)).toEqual(["--color", "--level", "2"]);
  });
});

describe("detached run files", () => {
  const flowDir = () => mkdtempSync(path.join(tmpdir(), "bg-"));
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };

  it("places run.log, pid and stop beside the trace, honouring --trace-dir", () => {
    const dir = flowDir();
    expect(runLogFile(dir, "r")).toBe(path.join(dir, ".runs", "r", "run.log"));
    expect(runStopFile(dir, "r")).toBe(path.join(dir, ".runs", "r", "stop"));
    expect(runPidFile(dir, "r", path.join(dir, "t"))).toBe(path.join(dir, "t", "r", "pid"));
  });

  it("reads only positive integer pids", () => {
    const dir = flowDir();
    expect(readRunPid(dir, "none")).toBeUndefined();
    put(runPidFile(dir, "ok"), `${process.pid}\n`);
    expect(readRunPid(dir, "ok")).toBe(process.pid);
    put(runPidFile(dir, "junk"), "abc\n");
    expect(readRunPid(dir, "junk")).toBeUndefined();
    put(runPidFile(dir, "zero"), "0\n");
    expect(readRunPid(dir, "zero")).toBeUndefined();
  });

  it("treats a run as alive unless its recorded pid is gone", () => {
    const dir = flowDir();
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2 ** 22 + 12345)).toBe(false);
    expect(runProcessAlive(dir, "no-pid")).toBe(true);
    put(runPidFile(dir, "me"), `${process.pid}\n`);
    expect(runProcessAlive(dir, "me")).toBe(true);
    put(runPidFile(dir, "gone"), `${2 ** 22 + 12345}\n`);
    expect(runProcessAlive(dir, "gone")).toBe(false);
  });

  it("launches a detached child with stdout/stderr redirected, a pid file, and any stale stop file removed", async () => {
    const dir = flowDir();
    const runDir = path.join(dir, ".runs", "r1");
    put(path.join(runDir, "stop"), "");
    const script = path.join(dir, "child.cjs");
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write('detached=' + process.env.DOGYARD_DETACHED);");
    const argv1 = process.argv[1];
    const execArgv = [...process.execArgv];
    process.argv[1] = script;
    process.execArgv.length = 0;
    let launched;
    try {
      launched = launchDetached({ runDir, runId: "r1", args: ["run", "a b"] });
    } finally {
      process.argv[1] = argv1!;
      process.execArgv.push(...execArgv);
    }
    expect(existsSync(path.join(runDir, "stop"))).toBe(false);
    expect(launched).toEqual({ run_id: "r1", pid: expect.any(Number), log: path.join(runDir, "run.log"), trace: path.join(runDir, "trace.json") });
    expect(readFileSync(path.join(runDir, "pid"), "utf8")).toBe(`${launched.pid}\n`);
    const deadline = Date.now() + 10_000;
    while (isAlive(launched.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(readFileSync(path.join(runDir, "stdout.json"), "utf8")).toBe('["run","a b"]');
    expect(readFileSync(launched.log, "utf8")).toBe("detached=1");
  });
});
