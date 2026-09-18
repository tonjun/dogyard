# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DogYard is a local-first, CLI-first workflow engine. Flows are YAML DAGs of
named steps (GitHub Actions style `needs:`), data moves between steps through
addressable outputs (`steps.<name>.output`) selected with JSONata expressions,
and the core step primitive is running a CLI command. No server, no UI, no
cloud — everything operates on plain files in a terminal.

## Commands

```bash
npm run build         # tsc -> dist/, produces the `dogyard` bin
npm run dev <args>     # run the CLI from source: tsx src/cli/index.ts <args>
npm test               # vitest run (unit + e2e)
npm run test:watch     # vitest watch mode
npm run typecheck      # tsc --noEmit
```

Run a single test file or case with vitest directly, e.g.:
```bash
npx vitest run tests/unit/executor.test.ts
npx vitest run -t "name of test"
```

Exercise the CLI itself against the bundled example flows:
```bash
npm run dev validate examples/flows/research
npm run dev run examples/flows/hello --query "hello"
npm run dev test examples/flows/research
npm run dev eval examples/flows/research
```

## Architecture

**Pipeline:** `loader.ts` reads a flow folder (`flow.yaml` + optional
`workflows.yaml` project defaults found by walking up directories) and
produces a validated `Flow`. `graph.ts` builds a DAG from `needs:` and exposes
export formats (`json`/`dot`/`mermaid`). `validate.ts` runs structural,
reference, DAG-cycle, and expression-syntax checks independent of execution.
`executor/run.ts` is the run loop: it walks the graph respecting
`max_concurrency`, dispatches each step to a handler in `executor/steps/`
(`command`, `transform`/`pass`, `choice`, `map`), and resolves step
input/routing via `expr.ts` (JSONata against `{ trigger, steps, item, index }`).

**Step execution:** `executor/command-runner.ts` defines the `Runner`
interface with three implementations selected by CLI flags: `RealRunner`
(spawns the actual command), `MockRunner` (replays a mocks file for `test`/
`--mocks`), and `RecordingRunner` (runs for real while writing a mocks file
for `--record`). `executor/retry.ts` implements the `retry`/`catch` error
handling against the error taxonomy in `errors.ts`
(`nonzero_exit`, `timeout`, `spawn_error`, `output_parse` → `command_failure`;
plus `schema_validation`, `expression_error`, `terminal_failure`,
`interrupted`, `internal`, and the wildcard `any`).

**Persistence/resume:** every run writes `trace.json` under
`<flow>/.runs/<run_id>/` after each step/map-item state change (atomic
rename) — see `trace.ts`. `executor/checkpoint.ts` + `run.ts`'s resume path
reload a flow, refuse to resume if the flow definition changed (unless
`--force`), and only re-execute steps that were pending/running/failed/
interrupted.

**Testing and eval are built on the executor, not separate engines:**
`testing/run-tests.ts` runs `tests/*.test.yaml` fixtures through the real
executor with a `MockRunner`, asserting on output/path/skipped/error_type.
`eval/run-eval.ts` runs a dataset of trigger/expected pairs through the
executor (for real, or mocked) and scores results with graders from
`eval/graders.ts` (`exact`, `jsonata`, `command`); `eval/report.ts` writes
the JSON report to `evals/reports/`.

**Per-step tests and evals:** `executor/run-step.ts` (`runStep`) runs a
single command step (or a map's command sub-step for one `item`) against a
supplied context, reusing `executeCommandStep`, `withRetry` and the `catch`
logic. `testing/run-step-tests.ts` discovers `steps/<step>/tests/*.test.yaml`
(schema in `schema/step-test.ts`; each case needs exactly one of `mock`,
`mocks_file`, `real: true`) and `eval/run-step-eval.ts` runs
`steps/<step>/evals/` datasets (`schema/step-eval.ts`) through it. The CLI
surfaces these as `test --step/--no-steps`, `eval --step`, and `new-step`.

**Schemas:** `src/schema/*.ts` (Zod) define `flow.yaml`, `workflows.yaml`
(project defaults), `*.test.yaml`, and `eval.yaml`/dataset shapes; these are
the source of truth for what's valid in each YAML file, not the README.

**CLI:** `src/cli/index.ts` wires up commander subcommands; handlers live in
`src/cli/commands/`. `src/index.ts` re-exports the whole public API for
library use (`loadFlow`, `validateFlow`, `buildGraph`, `exportGraph`,
`runFlow`, `prepareResume`, `runTests`, `runEval`, plus the runner classes).

## Flow folder convention

```
flows/<name>/
  flow.yaml
  tests/*.test.yaml
  mocks/*.yaml
  evals/eval.yaml
  evals/dataset.yaml (or .jsonl)
  evals/reports/
  steps/<step>/tests/*.test.yaml     per-step tests (folder name = step name)
  steps/<step>/evals/eval.yaml       per-step eval config + dataset.yaml
  steps/<step>/evals/reports/
  .runs/<run_id>/trace.json
```

Three runnable examples live under `examples/flows/` (`hello`, `research`,
`flaky`); `research` mirrors the sample flow documented in `docs/spec.md`,
with its "tools" implemented as small Node scripts in `examples/bin/`.

## Notes for making changes

- `docs/spec.md` is the detailed spec; the README has the practical/condensed
  version (flow syntax, step types, execution semantics, error taxonomy,
  CLI reference, test/eval file formats). Keep both in sync with schema
  changes in `src/schema/`.
- Relative paths in `command`/`cwd` fields resolve from the flow folder, not
  the process cwd.
- Every `command` step needs a mock when run under `test`/`--mocks`; a
  missing mock is a hard failure by design (keeps tests deterministic).
  Step tests follow the same principle: a case must say `mock`, `mocks_file`
  or `real: true` explicitly.
