import { describe, expect, it } from "vitest";
import { FlowError, errorMatches, errorMatchesAny, toFlowError } from "../../src/errors.js";
import { parseDuration, formatDuration } from "../../src/duration.js";
import { evaluateExpression, resolveTemplatedArgs, checkExpressionSyntax } from "../../src/expr.js";

describe("errors", () => {
  it("matches exact and category patterns", () => {
    expect(errorMatches("timeout", "timeout")).toBe(true);
    expect(errorMatches("timeout", "command_failure")).toBe(true);
    expect(errorMatches("expression_error", "command_failure")).toBe(false);
    expect(errorMatches("expression_error", "any")).toBe(true);
    expect(errorMatchesAny("nonzero_exit", ["timeout", "nonzero_exit"])).toBe(true);
  });
  it("round-trips through JSON", () => {
    const e = new FlowError("nonzero_exit", "boom", { step: "s", details: { code: 2 } });
    expect(FlowError.fromJSON(JSON.parse(JSON.stringify(e))).toJSON()).toEqual(e.toJSON());
  });
  it("wraps unknown errors as internal", () => {
    expect(toFlowError(new Error("x"), "s").type).toBe("internal");
    expect(toFlowError("str").message).toBe("str");
  });
});

describe("duration", () => {
  it("parses units", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("1.5s")).toBe(1500);
    expect(parseDuration(42)).toBe(42);
    expect(() => parseDuration("abc")).toThrow();
  });
  it("formats", () => {
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(3000)).toBe("3s");
  });
});

describe("expr", () => {
  it("evaluates JSONata against a context", async () => {
    const ctx = { trigger: { query: "hi" }, steps: { a: { output: { results: [1, 2, 3] } } } };
    expect(await evaluateExpression('{ "q": trigger.query, "n": $count(steps.a.output.results) }', ctx)).toEqual({ q: "hi", n: 3 });
    expect(await evaluateExpression("steps.missing.output", ctx)).toBeUndefined();
  });
  it("wraps syntax and runtime errors", async () => {
    expect(checkExpressionSyntax("{")?.type).toBe("expression_error");
    await expect(evaluateExpression("$error('nope')", {})).rejects.toMatchObject({ type: "expression_error" });
  });
  it("resolves templated argv", async () => {
    const args = await resolveTemplatedArgs(["grep", "=trigger.query", "--n", "=trigger.n", "=trigger.missing", "=trigger.list"], {
      trigger: { query: "needle", n: 5, list: ["a", "b"] },
    });
    expect(args).toEqual(["grep", "needle", "--n", "5", "a", "b"]);
  });
});
