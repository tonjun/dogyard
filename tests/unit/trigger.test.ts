import { describe, expect, it } from "vitest";
import { CliError, resolveTrigger } from "../../src/cli/util.js";

describe("resolveTrigger", () => {
  it("defaults to {} when no trigger flag is given", () => {
    expect(resolveTrigger({})).toEqual({});
  });
  it("builds a query trigger and parses --input", () => {
    expect(resolveTrigger({ query: "hi" })).toEqual({ query: "hi" });
    expect(resolveTrigger({ input: '{"a":1}' })).toEqual({ a: 1 });
  });
  it("still rejects multiple flags and non-object input", () => {
    expect(() => resolveTrigger({ query: "a", input: "{}" })).toThrow(CliError);
    expect(() => resolveTrigger({ input: "[1]" })).toThrow(CliError);
  });
});
