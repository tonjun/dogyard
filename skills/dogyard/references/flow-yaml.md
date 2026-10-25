# flow.yaml reference

The source of truth is the Zod schema in DogYard's `src/schema/flow.ts`. When
in doubt, run `dogyard validate <flow>` (add `--json` for machine-readable
diagnostics).

## Top level

```yaml
schema_version: 1              # optional, default 1
name: research-and-summarize   # [a-z0-9][a-z0-9_-]*
version: 0.1.0                 # semver
description: optional text

config:                        # all optional; steps override per-step
  default_timeout: 30s         # per command (Nms, Ns, Nm, Nh, Nd)
  default_retry: { max_attempts: 2, backoff: 2s, on: [command_failure] }
  max_concurrency: 8           # steps (and default map items) in flight at once
  run_timeout: 10m             # whole-run guardrail

trigger_schema:                # optional JSON Schema for the trigger; failures are `schema_validation`
  type: object
  required: [query]
  properties: { query: { type: string } }

steps:                         # step names: [a-zA-Z_][a-zA-Z0-9_-]*
  <name>: { type: ..., ... }
```

The trigger is the JSON object a run starts with: `--query X` gives
`{ "query": "X" }`, while `--input '<json>'` and `--input-file f.json` (or `-` for stdin)
pass a whole object. With no flag the trigger is `{}`.

## Step types

| Type | Fields | Output |
|---|---|---|
| `command` | `command` (argv array), `input`, `input_mode` (`stdin` default, `args`, `env`), `output_mode` (`auto` default, `json`, `text`, `lines`), `cwd`, `env`, `mock`, `cache` | Parsed stdout |
| `transform` / `pass` | `input` | The resolved `input` (`{}` if absent) |
| `choice` | `branches: [{when, next}]`, `default` | `{ selected, matched }`; routes execution |
| `map` | `over`, `step` (a `command`, `transform` or `pass`), `max_concurrency` | Ordered array of per-item outputs |

Common fields: `needs`, `input`, `timeout`, `retry`, `catch`, `terminal`
(`success` \| `fail`), `description`.

### Expressions (JSONata)

`input`, `over`, `when`, `cache.key` and argv entries that start with `=` are
JSONata, evaluated over the context:

- `trigger`: the run's trigger object
- `steps.<name>.output`, `steps.<name>.status`: every upstream step's result
- inside a `map`: `item`, `index` (0-based), and `total`

In argv, an array result expands into several arguments, and `null`/`undefined`
drops the argument. Inside a `[...]` predicate the context is the current element,
so reach the root with `$$.trigger...` / `$$.steps...`.

### Command input/output

- `input_mode: stdin` (default) writes the resolved `input` as JSON to stdin.
  `args` appends it as one JSON string argument. `env` sets `WF_INPUT` (JSON)
  plus `WF_INPUT_<KEY>` for each top-level scalar key.
- A map's command sub-step also gets the `WF_ITEM_INDEX` and `WF_ITEM_TOTAL` env vars.
- `output_mode: auto` parses stdout as JSON when it looks like JSON, otherwise it
  returns the trimmed text. `json` fails with `output_parse` if stdout isn't JSON.
  `text` gives raw text and `lines` gives an array of lines.
- cwd is `<flow>/steps/<step>/` when that folder exists, else the flow folder.
  An explicit `cwd` resolves from the flow folder. Relative paths in `command`
  resolve from the cwd, never from where `dogyard` was invoked.
- The engine has no built-in LLM support. To use a model, point a command step
  at any CLI (`llm`, `claude -p`, ...) and pass the prompt on stdin or as args.

## Execution semantics

- Order and concurrency come from the DAG. Independent steps run in parallel,
  up to `max_concurrency`. A step that lists several steps in `needs:` joins them.
- A choice's branch targets depend on the choice implicitly. Unselected
  targets are `skipped`, and so is everything downstream of them.
- `terminal: success` ends the run immediately, and the run's output is that
  step's output. If no terminal step runs, the output is the outputs of
  all sink steps keyed by name (or the bare output when there's a single sink).
  `terminal: fail` ends the run as failed with `terminal_failure`.
- An uncaught error fails the run fast and kills the commands that are still running.
- `retry` re-runs a step for errors matching `on`. `catch` picks the first
  clause whose `error_type` matches, marks the step `caught` and uses `result` as
  its output, so downstream steps keep going.
- Timeouts apply per command. In a `map` they apply to each item and each attempt,
  never to the map as a whole. Use `config.run_timeout` to cap total wall time.
- A command that times out or is interrupted is killed along with its whole process
  group (SIGTERM, then SIGKILL 2s later).

## Error taxonomy

`nonzero_exit`, `timeout`, `spawn_error`, `output_parse` (together:
`command_failure`), `schema_validation`, `expression_error`,
`terminal_failure`, `interrupted`, `internal`. `any` matches all of them. Use these
in `retry.on` and `catch[].error_type`.

## Filtering and map gotchas

- Filter in `over`: `over: 'steps.fetch.output.items[status = "active"]'`.
- Or filter in a `transform` step, wrapped in `[ ... ]` so the result is
  always an array. A bare empty filter result is `null`, and `$count(null)` is `1`.
  A single match is unwrapped to a bare object.
- A `map` has no per-item `when:`, and its sub-step can't be a `choice` or `map`.
  To skip the map entirely, route around it with a `choice` on
  `$count(steps.x.output) > 0`.
- `index` counts the filtered list. Carry an id through the sub-step if you need
  to correlate results with the source.
- `catch` isn't a filter: a caught item still runs first.

## Caching

```yaml
step:
  type: command
  command: ["./recommend.sh"]
  input: "item"
  cache:                                  # or just `cache: true`
    key: '{ "url": $lowercase(url) }'     # JSONata over the resolved input ($); default: input + argv
    files: [config/system.md, "config/*.json", recommend.sh]   # hashed; relative to the step cwd
    env: [RECOMMEND_SYSTEM]               # env var values hashed into the key
    ttl: 90d
```

- Only successes are stored. Failed and caught results run again next time.
- A map caches each item separately.
- Editing the command, the input mapping, `output_mode`, or a hashed file or env var
  invalidates entries. Editing `timeout`, `retry`, `catch`, `needs`, `mock`,
  `description` or `ttl` doesn't.
- The cache lives in `.dogyard/cache/<flow>/<step>/` next to the nearest `workflows.yaml`,
  else in the flow folder.
- A hit skips the command entirely, side effects included, so keep cached steps
  free of side effects.
- `run --no-cache`, `run --refresh a,b`, `dogyard cache ls|clear <flow>`.

## Project defaults (`workflows.yaml`)

DogYard finds a `workflows.yaml` (also `workflows.yml`, `.workflows.yaml`) by walking up
from the flow folder. It supplies `config:` defaults, and the flow's own `config:`
wins key by key. `--no-project` ignores it.

```yaml
schema_version: 1
config:
  default_timeout: 60s
  max_concurrency: 8
flows_dir: flows          # optional
```

## Folder layout

```
flows/<name>/
  flow.yaml
  tests/*.test.yaml        fixture tests
  mocks/*.yaml             recorded or hand-written command mocks
  evals/eval.yaml          graders + dataset reference
  evals/dataset.yaml       (or .jsonl)
  steps/<step>/            per-step cwd, scripts, tests/, evals/
  .runs/<run_id>/          trace.json, and for --detach: run.log, pid, stdout.json, trigger.json
```
