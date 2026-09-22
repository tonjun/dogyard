# Security notes

DogYard runs commands you describe in YAML. Treat a flow the way you would treat
a shell script.

## Flows are code

- `dogyard run`, `resume` and `eval` (and `test` for steps marked `real: true`)
  execute the commands named in `flow.yaml` with **your user's permissions**.
  Only run flows you wrote or have read, just as you would with a script from the
  internet.
- Read a flow before running it: `dogyard describe <flow>` prints its steps and
  `dogyard graph <flow>` shows the structure, but neither replaces reading
  `flow.yaml` and any scripts in `steps/`.
- `dogyard test` uses mocked command output, so it does not run the flow's
  commands (except step tests that say `real: true`).

## How commands are executed

- Commands are spawned **without a shell**: `command` is an argv array, so shell
  metacharacters in JSONata-resolved values are not interpreted. (A command can
  of course launch a shell itself, e.g. `["sh", "-c", "..."]`; interpolating
  untrusted input into such a string is on you.)
- A command inherits the **full environment** of the `dogyard` process, plus any
  step-level `env`. If your shell holds credentials in environment variables,
  every command in the flow can read them.
- Relative paths in `command` resolve from the step's working directory
  (`steps/<step>/` when it exists, else the flow folder). An explicit `cwd`
  can point anywhere.

## Sensitive data on disk

- Every run writes `<flow>/.runs/<run_id>/trace.json`, which contains each step's
  resolved `input`, `output`, `stderr` and `argv`. If a step handles a secret
  (an API key in an argument, a token in a response body), it will be in the
  trace.
- `dogyard run --record <file>` writes real command stdout/stderr to a mocks
  file. Review recorded mocks before committing them.
- `dogyard eval` writes reports to `evals/reports/`, which can include outputs.
- `dogyard new` scaffolds a `.gitignore` that excludes `.runs/` and
  `evals/reports/`. Keep those entries in your own flow repositories.
- Prefer passing secrets through the environment rather than argv or step
  input, so they do not land in traces. Use `--no-trace-file` to skip writing
  traces for a run.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
