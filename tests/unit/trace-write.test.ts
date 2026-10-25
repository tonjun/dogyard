import { describe, expect, it } from "vitest";
import { renameWithRetry } from "../../src/trace.js";

const fail = (code: string) => Object.assign(new Error(code), { code });

describe("renameWithRetry", () => {
  it("retries transient lock errors until the rename succeeds", () => {
    let calls = 0;
    renameWithRetry("a", "b", () => {
      if (++calls < 3) throw fail("EPERM");
    });
    expect(calls).toBe(3);
  });

  it("rethrows non-transient errors immediately", () => {
    let calls = 0;
    expect(() =>
      renameWithRetry("a", "b", () => {
        calls++;
        throw fail("ENOENT");
      }),
    ).toThrow("ENOENT");
    expect(calls).toBe(1);
  });

  it("gives up on a persistent lock after the timeout", () => {
    expect(() =>
      renameWithRetry("a", "b", () => {
        throw fail("EBUSY");
      }, undefined, 30),
    ).toThrow("EBUSY");
  });
});
