---
name: dogyard
description: Author, validate, test, run and monitor DogYard workflows — YAML DAGs of CLI command steps (flow.yaml) run by the local `dogyard` CLI. Use when the user mentions dogyard, flow.yaml or workflows.yaml, or wants to turn a multi-step shell/LLM/scripting job into a repeatable pipeline, fan a command out over many items, or run a long or batch task in the background that can be watched, paused, stopped and resumed instead of babysat in one terminal.
---

# DogYard

DogYard is a local-first, CLI-first workflow engine. A **flow** is a folder with
a `flow.yaml`: named steps wired into a DAG with `needs:`, where the main step
type runs a CLI command. Data moves between steps as JSON
(`steps.<name>.output`) selected with JSONata expressions. There's no server: every
run writes a checkpointed `trace.json`, so runs can be inspected and resumed.

Check that the CLI is there with `dogyard --version`. If it isn't installed, use
`npx dogyard ...` or `npm install -g dogyard` (Node 20+).

## When to reach for it

- A job that has several dependent steps (fetch → process → score → publish)
  and that the user wants to run again, test, or hand off.
- Running one command per item over hundreds of inputs (`map`), with bounded
  concurrency, per-item retry/catch, and per-item caching so reruns only do
  the new or failed items.
- Long-running work (minutes to hours, LLM batch jobs) that should survive the
  terminal closing, report progress and an ETA, and pick up where it stopped
  after a crash.

## Core loop

```bash
dogyard new my-flow --dir flows      # scaffold flows/my-flow/ (flow.yaml, tests, evals, steps/shout/)
# edit flows/my-flow/flow.yaml
dogyard validate flows/my-flow       # structure, references, DAG cycles, JSONata syntax
dogyard test flows/my-flow           # fixture tests with mocked commands (deterministic)
dogyard run flows/my-flow --query "hello"          # trigger = { "query": "hello" }
dogyard run flows/my-flow --input '{"n": 3}'       # or --input-file trigger.json
```

Always run `validate` after editing `flow.yaml`, and before any `run`. A run prints the flow's output JSON on
stdout and its status/trace path on stderr. Exit codes: `0` succeeded, `1`
failed or invalid, `130` interrupted.

Before writing a flow, look at its neighbours. If there's an existing flow nearby
or a `workflows.yaml` higher up the tree (it holds project defaults), follow their
conventions. Read [references/flow-yaml.md](references/flow-yaml.md) for the full
step schema and [references/examples.md](references/examples.md) for working
patterns.

## Writing flow.yaml — the essentials

```yaml
schema_version: 1
name: my-flow                 # [a-z0-9][a-z0-9_-]*
version: 0.1.0
config: { default_timeout: 30s, max_concurrency: 4 }
trigger_schema: { type: object, required: [query], properties: { query: { type: string } } }
steps:
  fetch:
    type: command
    command: ["node", "fetch.js", "=trigger.query"]   # "=expr" argv entries are JSONata
    output_mode: json
  each:
    type: map
    needs: [fetch]
    over: "steps.fetch.output.items"                  # must be an array
    max_concurrency: 4
    step:
      type: command
      command: ["./process.sh"]
      input: "item"                                   # JSON on stdin by default
      retry: { max_attempts: 3, backoff: 5s, on: [timeout, nonzero_exit] }
      catch: [{ error_type: command_failure, result: null }]
  report:
    type: transform
    needs: [each]
    input: '{ "ok": $count(steps.each.output[$ != null]) }'
```

- Step types: `command`, `transform`/`pass` (output = resolved `input`),
  `choice` (routing on `branches: [{when, next}]` + `default`), `map`.
- Expressions see `trigger`, `steps.<name>.output|status`, and inside a map
  `item`, `index`, `total`.
- A command runs with cwd `<flow>/steps/<step>/` if that folder exists, else
  the flow folder. Relative paths in `command` resolve from there.
- Command output must go to **stdout**. Send logs and progress to **stderr**,
  which is streamed and kept in the trace.
- Put `cache: true` (or `cache: { files: [...], key: ... }`) on expensive,
  deterministic command steps, so they aren't rerun when nothing changed.

## Long-running tasks

Start the run detached, so it outlives the session, then monitor it from separate
commands. Every `runs` subcommand defaults to the latest run when you leave out
`run_id`.

```bash
dogyard run flows/my-flow --input-file trigger.json --detach
#  -> prints { run_id, pid, log, trace } and returns immediately
dogyard runs flows/my-flow                 # list runs: status, duration, items done/total
dogyard runs watch flows/my-flow --json    # NDJSON progress events + final `end` event; exits with the run's code
dogyard runs logs flows/my-flow -f         # follow stderr (step transitions, command stderr)
dogyard runs show flows/my-flow            # full trace JSON (step outputs, errors, stderr tails)
dogyard runs pause flows/my-flow           # drain: running items finish, nothing new starts
dogyard runs continue flows/my-flow
dogyard runs stop flows/my-flow            # interrupt; trace records `interrupted`
dogyard resume flows/my-flow <run_id> --detach   # re-run only pending/failed/interrupted work
```

Guidance for agents:
- Don't hold the session open waiting on a long run. Start it with `--detach`,
  then check it from time to time with `dogyard runs flows/my-flow` or a bounded
  `runs show`. Only use `runs watch` when you actually want to block until the run ends.
- If a run fails, read the failing step in `runs show` (its `error`, `stderr`,
  `exit_code`), fix the command or flow, then `resume` it. `resume`
  refuses if `flow.yaml` changed. Pass `--force` only when the change keeps
  earlier outputs valid, otherwise start a fresh `run`.
- Thanks to `cache:`, starting a fresh run after a fix is cheap. Cached
  items are reused. `--refresh <step>` recomputes a step and `--no-cache` turns
  the cache off.
- `dogyard ui flows/my-flow` gives a human a live web console (DAG, logs,
  controls). Mention it when the user wants to watch visually.

## Testing and evals

Tests never run real commands. Each command step needs a mock, either in the test
case, in a `mocks/*.yaml` file, or as the step's own `mock:` field. A
missing mock fails the test on purpose. Record real outputs as mocks with
`dogyard run <flow> --record mocks/real.yaml`. Evals score a dataset of
trigger/expected pairs. See [references/testing-evals.md](references/testing-evals.md).

```bash
dogyard test flows/my-flow                # flow tests + steps/<step>/tests
dogyard test flows/my-flow --step fetch   # one step's tests
dogyard new-step flows/my-flow fetch      # scaffold steps/fetch/ tests + evals
dogyard eval flows/my-flow                # writes evals/reports/<ts>.json
```

## Safety

A flow is code. `run` executes its commands with the user's permissions and
environment. Read any flow you didn't write before you run it, and prefer
`dogyard test` or `run --mocks <file>` while you iterate. Add `.runs/` and
`.dogyard/` to `.gitignore`.

## Reference

- [references/flow-yaml.md](references/flow-yaml.md): the full flow schema,
  execution semantics, error taxonomy, caching, and `workflows.yaml`
- [references/cli.md](references/cli.md): every command and flag
- [references/testing-evals.md](references/testing-evals.md): test, step test
  and eval file formats
- [references/examples.md](references/examples.md): complete example flows
