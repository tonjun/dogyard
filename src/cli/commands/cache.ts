import type { Command } from "commander";
import { formatDuration } from "../../duration.js";
import { clearCache, listCacheEntries } from "../../executor/cache.js";
import { loadValidFlow, log, printJson } from "../util.js";

export function registerCache(program: Command): void {
  const cache = program.command("cache").description("Inspect or clear the step result cache (.dogyard/cache)");
  cache
    .command("ls <flow>")
    .description("List cached step results for a flow")
    .option("--step <name>", "only entries of this step")
    .option("--json", "print as JSON")
    .option("--no-project", "ignore project-level workflows.yaml config")
    .action((flowPath: string, flags: { step?: string; json?: boolean; project?: boolean }) => {
      const loaded = loadValidFlow(flowPath, { project: flags.project !== false });
      const entries = listCacheEntries(loaded, flags.step);
      if (flags.json) return printJson(entries.map(({ output: _output, ...e }) => e));
      if (!entries.length) return log("No cache entries");
      for (const e of entries) {
        const age = formatDuration(Math.max(0, Date.now() - Date.parse(e.created_at)));
        const item = e.item_index !== undefined ? `[${e.item_index}]` : "";
        process.stdout.write(`${`${e.step}${item}`.padEnd(24)} ${e.key.slice(0, 12)}  ${e.created_at}  age=${age}  run=${e.run_id}${e.expired ? "  EXPIRED" : ""}\n`);
      }
      log(`${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
    });
  cache
    .command("clear <flow>")
    .description("Delete cached step results for a flow")
    .option("--step <name>", "only entries of this step")
    .option("--expired", "only entries older than their step's ttl")
    .option("--no-project", "ignore project-level workflows.yaml config")
    .action((flowPath: string, flags: { step?: string; expired?: boolean; project?: boolean }) => {
      const loaded = loadValidFlow(flowPath, { project: flags.project !== false });
      const opts: Parameters<typeof clearCache>[1] = { expiredOnly: flags.expired ?? false };
      if (flags.step !== undefined) opts.step = flags.step;
      const n = clearCache(loaded, opts);
      log(`Removed ${n} cache entr${n === 1 ? "y" : "ies"}`);
    });
}
