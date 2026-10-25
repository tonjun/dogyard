# dogyard CLI reference

`<flow>` is a flow folder (or its `flow.yaml`). Run `dogyard <command> --help`
for the exact flags of the installed version.

| Command | Purpose |
|---|---|
| `new <name> [--dir flows] [--force]` | Scaffold a flow folder with a sample test, eval and a `steps/shout/` step folder. |
| `new-step <flow> <step> [--force]` | Scaffold `steps/<step>/` (a starter test and eval) for an existing command step. |
| `validate <flow> [--json]` | Structural, reference, DAG and expression-syntax checks. |
| `run <flow> [--query <text> \| --input <json> \| --input-file <path>]` | Run once. Prints the output JSON on stdout. Flags: `--trace` (print the trace instead), `--mocks <file>`, `--record <file>`, `--max-concurrency`, `--run-timeout`, `--trace-dir`, `--no-trace-file`, `--no-cache`, `--refresh <steps>`, `-q`, `--detach`, `--resume <run_id>`. |
| `resume <flow> <run_id> [--force] [--detach]` | Continue a failed or interrupted run, re-executing only unfinished work. |
| `runs <flow>` | List persisted runs (status, duration, map items done/total, cache counts). |
| `runs show <flow> [run_id]` | Print one trace (defaults to the latest run). |
| `runs watch <flow> [run_id] [--json] [--interval 500ms]` | Follow a run live. `--json` streams NDJSON `progress` events and a final `end` event. Exits with the run's exit code. |
| `runs logs <flow> [run_id] [-f]` | Print or follow a `--detach` run's `run.log`. |
| `runs stop <flow> [run_id]` | Interrupt a `--detach` run (it can be resumed). |
| `runs pause <flow> [run_id]` / `runs continue <flow> [run_id]` | Drain-pause a running run, then let it go on. |
| `ui <flow> [--port 0] [--host 127.0.0.1] [--open]` | Local web console: live DAG, logs, start/pause/resume/stop. |
| `cache ls <flow> [--step] [--json]` / `cache clear <flow> [--step] [--expired]` | Inspect or delete cached step results. |
| `test <flow> [-k filter] [--step <name>] [--no-steps]` | Run `tests/*.test.yaml` with mocked commands, plus every `steps/<step>/tests/*.test.yaml`. |
| `eval <flow> [--step <name>] [--dataset] [--mocks] [--concurrency] [--limit] [--cache] [--report] [--json]` | Score a dataset and write a report. |
| `list [root]` | Find flows under a directory. |
| `describe <flow> [--json]` | Print a flow's metadata, config and steps. |
| `graph <flow> --format json\|dot\|mermaid` | Export the DAG. |
| `skills install [--global \| --dir <path>] [--force]` | Install this skill (default `./.claude/skills/dogyard`). |
| `skills uninstall [--global \| --dir <path>]` / `skills path` | Remove an installed copy / print the bundled skill folder. |

Most flow commands accept `--no-project` to ignore `workflows.yaml`.

Exit codes: `0` success, `1` failure or validation error, `130` interrupted.

## Output conventions

- Commands put their result on **stdout**: `run` prints the flow output JSON
  (or `{ status, run_id, error }` on failure), `--json` flags print JSON, and `--detach` prints
  `{ run_id, pid, log, trace }`.
- Human-readable status (trace path, `Run <id> succeeded`, progress lines) goes to
  **stderr**. Use `-q` to quiet it.
