import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatDuration, formatShortDuration, isDuration, parseDuration, sleep } from "../../src/duration.js";
import { FlowError } from "../../src/errors.js";
import { LoadError } from "../../src/loader.js";
import { CliError, describeError, fail, loadValidFlow, log, printJson, resolveTrigger } from "../../src/cli/util.js";

describe("duration", () => {
  it("rejects invalid numeric durations and defaults bare numbers to ms", () => {
    expect(() => parseDuration(-1)).toThrow(/Invalid duration: -1/);
    expect(() => parseDuration(Infinity)).toThrow();
    expect(parseDuration(" 250 ")).toBe(250);
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  it("recognises durations", () => {
    expect(isDuration(5)).toBe(true);
    expect(isDuration(-5)).toBe(false);
    expect(isDuration(NaN)).toBe(false);
    expect(isDuration("2m")).toBe(true);
    expect(isDuration("2 weeks")).toBe(false);
    expect(isDuration(null)).toBe(false);
  });

  it("formats each unit", () => {
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(90_000)).toBe("1.5m");
    expect(formatDuration(5_400_000)).toBe("1.5h");
    expect(formatDuration(129_600_000)).toBe("1.5d");
    expect(formatShortDuration(-10)).toBe("0s");
    expect(formatShortDuration(42_000)).toBe("42s");
    expect(formatShortDuration(185_000)).toBe("3m05s");
    expect(formatShortDuration(4_320_000)).toBe("1h12m");
    expect(formatShortDuration(187_200_000)).toBe("2d4h");
  });

  it("sleeps, and rejects with the abort reason when aborted before or during the wait", async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
    const done = new AbortController();
    await expect(sleep(1, done.signal)).resolves.toBeUndefined();
    const before = new AbortController();
    before.abort(new Error("early"));
    await expect(sleep(10_000, before.signal)).rejects.toThrow("early");
    const during = new AbortController();
    const p = sleep(10_000, during.signal);
    during.abort(new Error("late"));
    await expect(p).rejects.toThrow("late");
  });
});

describe("cli util", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fail throws a CliError with an exit code", () => {
    expect(() => fail("nope", 3)).toThrow(expect.objectContaining({ name: "CliError", message: "nope", exitCode: 3 }));
    expect(new CliError("x").exitCode).toBe(1);
  });

  it("prints JSON to stdout and logs to stderr", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    printJson({ a: 1 });
    printJson({ a: 1 }, false);
    log("hello");
    expect(out.mock.calls.map((c) => c[0])).toEqual(['{\n  "a": 1\n}\n', '{"a":1}\n']);
    expect(err.mock.calls.map((c) => c[0])).toEqual(["hello\n"]);
  });

  it("reads the trigger from a file and reports bad JSON", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cli-util-"));
    const f = path.join(dir, "t.json");
    writeFileSync(f, '{"q":"from-file"}');
    expect(resolveTrigger({ inputFile: f })).toEqual({ q: "from-file" });
    expect(() => resolveTrigger({ input: "{oops" })).toThrow(/Invalid JSON in --input/);
    expect(() => resolveTrigger({ input: "null" })).toThrow(/Trigger must be a JSON object/);
  });

  it("describes CLI, load, flow and other errors", () => {
    expect(describeError(new CliError("cli"))).toBe("cli");
    expect(describeError(new LoadError("load", ["a", "b"]))).toBe("load\n  - a\n  - b");
    expect(describeError(new FlowError("timeout", "slow", { step: "s" }))).toBe("timeout [s]: slow");
    expect(describeError(new FlowError("internal", "bare"))).toBe("internal: bare");
    const plain = new Error("plain");
    plain.stack = undefined;
    expect(describeError(plain)).toBe("plain");
    expect(describeError(new Error("with stack"))).toMatch(/^Error: with stack\n/);
    expect(describeError(42)).toBe("42");
  });

  it("loadValidFlow reports load errors, invalid flows and passes other errors through", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cli-util-flow-"));
    expect(() => loadValidFlow(path.join(dir, "missing"))).toThrow(CliError);
    const write = (name: string, yaml: string) => {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, "flow.yaml"), yaml);
      return path.join(dir, name);
    };
    expect(() => loadValidFlow(write("schema", "name: x\n"))).toThrow(/\n {2}- /);
    const bad = write("cyclic", "schema_version: 1\nname: c\nversion: 0.1.0\nsteps:\n  a: { type: pass, needs: [b] }\n  b: { type: pass, needs: [a] }\n");
    expect(() => loadValidFlow(bad)).toThrow(/is invalid:/);
    const good = write("good", "schema_version: 1\nname: g\nversion: 0.1.0\nsteps:\n  a: { type: pass }\n");
    expect(loadValidFlow(good).flow.name).toBe("g");
  });
});
