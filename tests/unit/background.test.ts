import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { optionArgs } from "../../src/cli/background.js";

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
});
