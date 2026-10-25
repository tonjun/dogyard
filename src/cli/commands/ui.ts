import { spawn } from "node:child_process";
import type { Command } from "commander";
import { startUiServer } from "../../ui/server.js";
import { log } from "../util.js";

export function registerUi(program: Command): void {
  program
    .command("ui <flow>")
    .description("Serve a local web console for a flow: live DAG, logs, and start/pause/continue/stop/resume of runs")
    .option("--port <n>", "port to listen on (default: a free one)", "0")
    .option("--host <host>", "interface to bind", "127.0.0.1")
    .option("--trace-dir <dir>", "directory for run traces (default: <flow-dir>/.runs)")
    .option("--no-project", "ignore project-level workflows.yaml config")
    .option("--open", "open the console in the default browser")
    .action(async (flowPath: string, flags: { port: string; host: string; traceDir?: string; project?: boolean; open?: boolean }) => {
      const server = await startUiServer({
        flowPath,
        host: flags.host,
        port: Number(flags.port),
        ...(flags.traceDir ? { traceDir: flags.traceDir } : {}),
        project: flags.project !== false,
      });
      log(`DogYard UI: ${server.url}`);
      log("Runs started here keep going after you quit (Ctrl-C stops only the UI).");
      if (flags.open) openBrowser(server.url);
      await new Promise<void>((resolve) => {
        const quit = () => void server.close().then(resolve);
        process.once("SIGINT", quit);
        process.once("SIGTERM", quit);
      });
    });
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => log(`Could not open a browser; visit ${url}`)).unref();
}
