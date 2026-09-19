# DogYard

A local-first, CLI-first workflow engine. Flows are YAML DAGs of named steps
(GitHub Actions style `needs:`), data moves between steps through addressable
outputs (`steps.<name>.output`) selected with [JSONata](https://jsonata.org),
and the core step primitive is **running a CLI command**. Everything works from
the terminal against plain files: no server, no UI, no cloud.

## Install

```bash
npm install
npm run build       # compiles to dist/, exposes the `dogyard` bin
npm test            # unit + end-to-end tests
```

During development run the CLI without building: `npm run dev <command> ...`
(alias for `tsx src/cli/index.ts`).

## Quick start

```bash
npm run dev new my-flow --dir flows           # scaffold flows/my-flow/
npm run dev validate flows/my-flow
npm run dev run flows/my-flow --query "hello"
npm run dev test flows/my-flow                # fixture tests with mocked commands
npm run dev eval flows/my-flow                # dataset + graders -> scored report
npm run dev graph flows/my-flow --format mermaid
```

Three runnable examples live under `examples/flows/` (`hello`, `research`, `flaky`).
The `research` flow mirrors the sample in `docs/spec.md`; its "tools" are tiny
Node scripts in `examples/bin/`.

## Concepts

| Concept | Meaning |
|---|---|
| **Flow** | A folder with `flow.yaml` plus its tests, mocks and evals. Self-contained and versioned. |
| **Step** | A named node: `command`, `transform`, `pass`, `choice` or `map`. `needs:` places it in the DAG. |
| **Trigger** | The JSON object a run starts with. Available in expressions as `trigger`. Optional: with no trigger it is `{}`, so a first step can fetch its own input (a file, a database). |
| **Execution context** | `trigger` plus `steps.<name>.output` / `steps.<name>.status` for every step so far. Step outputs are never mutated. |
| **Run** | One execution of a flow. Produces an output JSON and a trace at `<flow>/.runs/<run_id>/trace.json`. |
| **Test** | Deterministic fixture: trigger + mocked command output, assertions on output and path. Step tests (`steps/<step>/tests/`) run one command step against a supplied context. |
| **Eval** | Dataset of (trigger, expected) pairs run through the flow (usually for real) and scored by graders. Step evals (`steps/<step>/evals/`) do the same for one step. |

## Flow definition (`flow.yaml`)

```yaml
schema_version: 1              # optional, default 1
name: research-and-summarize   # [a-z0-9][a-z0-9_-]*
version: 0.1.0                 # semver
description: optional text

config:                        # all optional; steps override per-step
  default_timeout: 30s         # per command (Ns, Nms, Nm, Nh)
  default_retry: { max_attempts: 2, backoff: 2s, on: [command_failure] }
  max_concurrency: 8           # steps (and default map items) in flight at once
  run_timeout: 10m             # whole-run guardrail

trigger_schema:                # optional JSON Schema; failures are `schema_validation` errors (use `required` to demand input)
  type: object
  required: [query]
  properties: { query: { type: string } }

steps:
  fetch_sources:
    type: command
    command: ["search-cli", "--json", "=trigger.query"]   # "=expr" entries are JSONata
    input: '{ "q": trigger.query, "limit": 5 }'          # JSONata -> stdin by default
    retry: { max_attempts: 3, backoff: 1s, on: [timeout, nonzero_exit] }

  summarize_each:
    type: map
    needs: [fetch_sources]
    over: "steps.fetch_sources.output.results"            # must evaluate to an array
    max_concurrency: 4
    step:                                                 # command | transform | pass
      type: command
      command: ["llm-run", "--prompt-file", "../../prompts/summarize.md"]
      input: '{ "text": item.body, "i": index }'         # `item` and `index` are bound
      catch:
        - { error_type: command_failure, result: { summary: "" } }

  score_quality:                                          # fan-in: needs several steps
    type: command
    needs: [fetch_sources, summarize_each]
    command: ["quality-scorer"]
    input: '{ "n": $count(steps.fetch_sources.output.results), "s": steps.summarize_each.output }'

  route_on_score:
    type: choice
    needs: [score_quality]
    branches:                                             # first truthy `when` wins
      - { when: "steps.score_quality.output.score >= 0.7", next: publish }
    default: flag_for_review

  publish:
    type: command
    command: ["publish-cli"]
    input: "steps.summarize_each.output"
    terminal: success                                     # ends the run; output = this step's output

  flag_for_review:
    type: pass
    input: '{ "reason": "low quality score" }'
    terminal: success
```

### Step types

| Type | Fields | Output |
|---|---|---|
| `command` | `command` (argv array), `input`, `input_mode` (`stdin` default, `args`, `env`), `output_mode` (`auto` default, `json`, `text`, `lines`), `cwd`, `env` | Parsed stdout |
| `transform` / `pass` | `input` | The resolved `input` (`{}` if absent) |
| `choice` | `branches: [{when, next}]`, `default` | `{ selected, matched }`; routes execution |
| `map` | `over`, `step`, `max_concurrency` | Ordered array of per-item outputs |

Common fields: `needs`, `input`, `timeout`, `retry`, `catch`, `terminal` (`success` | `fail`), `description`.

**Command input modes.** `stdin` writes the resolved input as JSON to stdin.
`args` appends it as one JSON string argument. `env` sets `WF_INPUT` (JSON) plus
`WF_INPUT_<KEY>` for each top-level scalar key. In every mode, argv entries
beginning with `=` are JSONata expressions; arrays expand to several arguments,
`undefined`/`null` drops the argument. A command runs with its working directory
set to the step's own `steps/<step>/` folder when that folder exists, otherwise
the flow folder; an explicit `cwd` overrides this and resolves from the flow
folder. Relative paths in `command` resolve from that working directory.

**Output parsing.** `auto` parses stdout as JSON when it looks like JSON, else
returns the trimmed text. `json` fails with `output_parse` if stdout is not JSON.

### Execution semantics

- Execution order and concurrency come from the DAG. Steps with no dependency
  path between them run in parallel, up to `max_concurrency`. A step naming
  several steps in `needs:` is the join point.
- A choice's branch targets implicitly depend on the choice. Targets it did not
  select are `skipped`, and anything downstream of a skipped step is skipped too.
- A `terminal: success` step ends the run immediately with its output. If no
  terminal step runs, the output is the outputs of all sink steps keyed by name
  (or the single sink's output when there is only one). `terminal: fail` ends
  the run as failed with a `terminal_failure` error.
- An uncaught error fails the run fast: in-flight commands are killed.
- `retry` re-runs a step for errors matching `on`. `catch` matches the first
  clause whose `error_type` fits, marks the step `caught` and uses `result` as
  its output so downstream steps continue.

### Error taxonomy

`nonzero_exit`, `timeout`, `spawn_error`, `output_parse` (together the
`command_failure` category), `schema_validation`, `expression_error`,
`terminal_failure`, `interrupted`, `internal`. `any` matches everything. Use these
in `retry.on` and `catch.error_type`.

## Folder layout

```
flows/<name>/
  flow.yaml
  tests/*.test.yaml      fixture tests
  mocks/*.yaml           recorded or hand-written command mocks
  evals/eval.yaml        graders + dataset reference
  evals/dataset.yaml     (or .jsonl) examples
  evals/reports/         written by `eval`
  steps/<step>/          one folder per command step (or map whose sub-step is a command)
    tests/*.test.yaml    step tests: run only this step against a context
    evals/eval.yaml      step eval config (same shape as evals/eval.yaml)
    evals/dataset.yaml   (or .jsonl) { id?, context, expected? } examples
    evals/reports/       written by `eval --step <step>`
  .runs/<run_id>/trace.json
workflows.yaml           optional project-level defaults (discovered by walking up)
```

A `workflows.yaml` above a flow supplies `config:` defaults; the flow's own
`config:` wins key by key. Pass `--no-project` to ignore it.

## CLI

| Command | Purpose |
|---|---|
| `new <name> [--dir flows]` | Scaffold a flow folder with a sample test, eval and `steps/shout/` step folder. |
| `new-step <flow> <step> [--force]` | Scaffold `steps/<step>/` (starter test + eval) for an existing command step. |
| `validate <flow>` | Structural + reference + DAG + expression-syntax checks. `--json` for machine output. |
| `run <flow> [--query <text> \| --input <json> \| --input-file <path>]` | Run once; the trigger is optional (defaults to `{}`). `--trace` prints the trace, `--mocks <file>` replays mocks, `--record <file>` saves real command output as mocks, `--max-concurrency`, `--run-timeout`, `--trace-dir`, `--no-trace-file`, `-q`. |
| `resume <flow> <run_id> [--force]` | Continue a failed or interrupted run from its trace. Also `run --resume <run_id>`. |
| `runs <flow>` / `runs show <flow> [run_id]` | List persisted runs / print one trace (the latest run when `run_id` is omitted or `latest`). |
| `test <flow> [-k filter] [--step <name>] [--no-steps]` | Run `tests/*.test.yaml` with mocked commands plus every `steps/<step>/tests/*.test.yaml`. `--step` runs one step's tests only; `--no-steps` skips step tests. |
| `eval <flow> [--step <name>] [--dataset] [--mocks] [--concurrency] [--limit] [--report] [--json]` | Score a dataset and write a report. With `--step`, evaluate that step alone using `steps/<name>/evals/`. |
| `list [root]` | Find flows under a directory. |
| `describe <flow>` | Print metadata, config and steps. |
| `graph <flow> --format json\|dot\|mermaid` | Export the DAG. `json` is the canonical form for a future UI. |

Exit codes: `0` success, `1` failure or validation error, `130` interrupted.

## Tests (`tests/*.test.yaml`)

```yaml
tests:
  - name: high score publishes
    trigger: { query: "cats" }            # optional, default {}
    mocks_file: ../mocks/good.yaml        # optional base mocks
    mocks:                                # per-step overrides
      score_quality: { output: { score: 0.9 } }
      summarize_each:                     # map sub-steps: one entry per item
        - { output: { summary: "a" } }
        - { stdout: "", stderr: "boom", exit_code: 2 }
    expect:
      status: succeeded                   # default: succeeded (failed when error_type set)
      output: { published: 2 }
      output_jsonata: "output.published > 0"   # evaluated over { output, trigger, trace }
      path: [fetch_sources, summarize_each, score_quality, route_on_score, publish]
      skipped: [flag_for_review]
      error_type: command_failure         # for failing runs
```

A mock is either `{ output: <json> }` or `{ stdout, stderr, exit_code }`. Every
command step needs a mock in tests; a missing one fails the run so tests stay
deterministic. Create mocks from a real run with `run ... --record mocks/x.yaml`.

## Step tests (`steps/<step>/tests/*.test.yaml`)

Flow tests always run the whole DAG. A step test runs **one command step** (or
the command sub-step of a map, once, for one `item`) against a context you
supply, so you can pin down its input expression, argv templating, output
parsing, retry/catch behaviour, and the real tool behind it. The folder name
must be a step name in `flow.yaml`; `test <flow>` runs flow tests and step tests
together.

```yaml
tests:
  - name: limit defaults to 3
    context:                              # what the step's expressions see
      trigger: { query: "cats" }          # default {}
      steps:                              # upstream outputs (shorthand for { status: succeeded, output })
        fetch_sources: { results: [] }
      item: { body: "alpha alpha" }       # required when <step> is a map
      index: 0                            # selects the entry of an array mock
    mock: { output: { results: [] } }     # exactly one of: mock | mocks_file | real: true
    # mocks_file: ../../../mocks/good.yaml   # uses mocks[<step>] from a flow mocks file
    # real: true                             # spawn the real command (cwd = steps/<step>/, else flow folder)
    expect:
      status: succeeded                   # succeeded | caught | failed (default: failed when error_type set)
      input: { q: "cats", limit: 3 }      # the resolved step input
      argv: ["node", "../../../../bin/search-cli.cjs", "--json"]
      output: { results: [] }
      output_jsonata: "$count(output.results) = 0"   # over { output, input, argv, context, step }
      error_type: nonzero_exit
      attempts: 3                         # attempts made (checks the retry policy)
```

Every case must say how the command runs (`mock`, `mocks_file` or `real: true`),
so step tests stay deterministic unless you opt in to the real tool. Only
`command` steps (and maps of command steps) get step folders; `choice`
steps cannot run in isolation.

## Evals (`evals/eval.yaml` + dataset)

```yaml
dataset: dataset.yaml       # or .jsonl; [{ id?, trigger?, expected? }] (trigger defaults to {})
pass_threshold: 1           # example passes when mean grader score >= threshold
concurrency: 2
graders:
  - { type: exact, name: exact-output }                 # deep-equal output vs expected
  - { type: jsonata, expression: "output.score >= expected.min" }   # truthy = pass, number = score
  - { type: command, command: ["node", "grade.js"] }    # {output, expected, trigger} on stdin; exit 0 = pass, optional {score} on stdout
```

Reports (`evals/reports/<timestamp>.json`) include the pass rate, per-grader
breakdown and the full trace of every example.

### Step evals (`steps/<step>/evals/`)

`eval <flow> --step <name>` evaluates one step with the same config format;
only the dataset differs: examples carry a `context` (as in step tests) instead
of a `trigger`. Commands run for real unless `mocks`/`mocks_file` (keyed by
step name) are set. Graders see `trigger` (= `context.trigger`) and `step`
(the step result: `output`, `input`, `argv`, `attempts`, `exit_code`,
`stderr`, `status`) instead of `trace`. Reports go to
`steps/<name>/evals/reports/`.

```yaml
# steps/fetch_sources/evals/eval.yaml
dataset: dataset.yaml
graders:
  - { type: jsonata, name: result-count, expression: "$count(output.results) = expected.count" }
# steps/fetch_sources/evals/dataset.yaml
examples:
  - { id: default-limit, context: { trigger: { query: cats } }, expected: { count: 3 } }
```

## Traces and resume

Every run writes `trace.json` after each step or map-item state change
(atomic rename), so a crash or Ctrl-C always leaves an accurate checkpoint.
The trace records each step's status, input, output, attempts, errors, exit
code, stderr, the selected choice branch and per-item map results.

`resume <flow> <run_id>` reloads the flow, refuses if its definition changed
(override with `--force`), keeps every `succeeded`/`caught` step and map item,
and re-executes only what was pending, running, failed or interrupted. The run
keeps its id and `resume_count` increments.

## Using an LLM (or any tool)

The engine has no notion of an LLM. Point a command step at whatever CLI you
use and pass the prompt as an argument or on stdin:

```yaml
summarize:
  type: command
  command: ["llm", "-m", "claude-sonnet-5", "--system-file", "../../prompts/summarize.md"]
  input: "steps.fetch.output.text"
  input_mode: stdin
  output_mode: text
  timeout: 2m
  retry: { max_attempts: 3, backoff: 5s, on: [timeout, nonzero_exit] }
```

## Library use

Everything the CLI does is exported from `src/index.ts`: `loadFlow`,
`validateFlow`, `buildGraph`, `exportGraph`, `runFlow`, `prepareResume`,
`runStep`, `runTests`, `runStepTests`, `runEval`, `runStepEval`,
`scaffoldFlow`, `scaffoldStep`, and the runner classes (`RealRunner`,
`MockRunner`, `RecordingRunner`).
