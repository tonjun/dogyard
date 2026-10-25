# Tests and evals

## Flow tests (`tests/*.test.yaml`)

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
      output_jsonata: "output.published > 0"   # over { output, trigger, trace }
      path: [fetch_sources, summarize_each, score_quality, route_on_score, publish]
      skipped: [flag_for_review]
      error_type: command_failure         # for failing runs
```

- A mock is either `{ output: <json> }` or `{ stdout, stderr, exit_code }`.
- **Every command step needs a mock**: a missing mock fails the run, which keeps
  tests deterministic. Mock precedence (highest first): the test's `mocks`, then
  `mocks_file`/`--mocks`, then the step's own `mock:` field.
- Mocks file shape: `mocks: { <step>: <mock> | [<mock>, ...] }`. Create one
  from a real run with `dogyard run <flow> --record mocks/x.yaml`.
- `path` lists steps in completion order, so parallel branches can appear in either
  order. In that case prefer `output_jsonata` over `trace.steps`.
- For a map whose `over` is filtered, give one mock entry per item that survives the filter.

### Mocks on the step

```yaml
shout:
  type: command
  command: [node, shout.js]
  mock: { output: { shouted: "HELLO" } }   # inline
count:
  type: command
  command: [node, count.js]
  mock: mock.yaml                          # file, resolved from the step cwd
```

`mock:` is used only by `test` and `eval`. `run` always executes the command for real.

## Step tests (`steps/<step>/tests/*.test.yaml`)

These run one command step (or a map's command sub-step, once, for one `item`)
against a supplied context. Scaffold them with `dogyard new-step <flow> <step>`.

```yaml
tests:
  - name: limit defaults to 3
    context:
      trigger: { query: "cats" }
      steps:                              # upstream outputs (shorthand for { status: succeeded, output })
        fetch_sources: { results: [] }
      item: { body: "alpha" }             # required when <step> is a map
      index: 0
    mock: { output: { results: [] } }     # exactly one of: mock | mocks_file | real: true
    expect:
      status: succeeded                   # succeeded | caught | failed
      input: { q: "cats", limit: 3 }      # resolved step input
      argv: ["node", "search.js", "--json"]
      output: { results: [] }
      output_jsonata: "$count(output.results) = 0"   # over { output, input, argv, context, step }
      error_type: nonzero_exit
      attempts: 3
```

## Evals (`evals/eval.yaml` + dataset)

```yaml
dataset: dataset.yaml       # or .jsonl; [{ id?, trigger?, expected? }] (or { examples: [...] })
pass_threshold: 1           # an example passes when its mean grader score >= threshold
concurrency: 2
graders:
  - { type: exact, name: exact-output }                              # deep-equal output vs expected
  - { type: jsonata, expression: "output.score >= expected.min" }    # truthy = pass, number = score
  - { type: command, command: ["node", "grade.js"] }                 # {output, expected, trigger} on stdin; exit 0 = pass
```

`dogyard eval <flow>` runs commands for real unless `--mocks` (or `mocks`/`mocks_file`
in the config) is given, and writes `evals/reports/<timestamp>.json`.
`eval --step <name>` uses `steps/<name>/evals/`, where the examples carry a `context`
instead of a `trigger`.
