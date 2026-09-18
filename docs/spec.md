# Project Spec: `DogYard` — CLI-First Workflow Engine

Status: Draft v0.2 (high-level; v0.2 adds step-granular resume, see §1.3/§3.7)
Owner: (you)
Target use: Input to Claude Code plan mode — this defines *what* to build and *why*; implementation-level design (exact schemas, module layout, algorithms) is left for plan mode to work out.

---

## 1. Overview

### 1.1 Problem
Existing workflow engines (AWS Step Functions, n8n, Temporal) are cloud-locked, UI-first, or heavyweight for local use cases. We want a **local-first, CLI-first workflow engine**: flows that take a query/input, route it through steps — primarily **CLI commands** — plus control-flow logic, and produce structured JSON output — definable, runnable, testable, and evaluable entirely from the terminal.

### 1.2 Goals (v1)
- CLI-first: every capability works via terminal commands and plain files, no server required.
- Flows are declarative, YAML-defined workflows: named steps connected by explicit dependencies (a DAG), patterned after GitHub Actions' jobs/`needs` model rather than AWS Step Functions' flat named-state + `next` graph — see §3.1 for rationale.
- Data flows step-to-step via **addressable named outputs** (`steps.<name>.output`, à la GitHub Actions' `steps.<id>.outputs`), not a single mutable context blob threaded through ASL-style InputPath/Parameters/ResultPath/OutputPath.
- Data selection/transformation is expressed with **JSONata** (richer than GitHub Actions' `${{ }}` expression syntax, and avoids ASL's JSONPath).
- Every flow's initial trigger is a **user query** (a JSON object containing at least a query string).
- All step inputs/outputs are JSON.
- The core step primitive is **executing a CLI command**: run an arbitrary external command/binary, pass it structured input, capture its output (stdout/exit code) back into the flow's JSON context. This makes the engine generically useful for orchestrating any CLI tool — not tied to any single backend.
- Each flow lives in its **own self-contained folder** with its own config — runnable, testable, and evaluable independently of any other flow or a central engine process.
- Supports core workflow control constructs: sequential steps, **parallel** branches, **iterate/map** over a collection, and conditional **branching**.
- Every run is inspectable via a structured execution trace.

### 1.3 Non-goals (v1)
- No UI (Phase 2 — see §7).
- No Temporal-style in-process durability (no persistent workers, event history replay, or wait-for-external-event steps). A run executes within a single CLI process, but its trace is checkpointed after every step and map item, so a failed or interrupted run can be **resumed** by a later `resume <flow> <run_id>` invocation that reuses completed step/item outputs and re-executes only the rest (see §3.7).
- No server, multi-tenancy, auth, or hosted execution.
- No visual/drag-drop flow authoring.
- No built-in scheduler (external cron can call the CLI).
- No built-in, opinionated integration with any particular external tool (LLM runner or otherwise) in v1 — the engine only knows how to run CLI commands generically; any specific tool (including an LLM runner) is just "a command someone points a step at," configured by the flow author, not baked into the engine.
- No human-in-the-loop / wait-for-external-event steps in v1. Step-granular resume (§3.7) covers the "fix the tool, then continue" case; a true blocking wait step remains deferred.

---

## 2. Core Concepts

| Concept | Definition |
|---|---|
| **Flow** | A named, versioned workflow defined in its own folder as a YAML DAG of named steps plus config. |
| **Step** | A node in the flow's dependency graph, identified by a unique name: a CLI command execution, a pure data transform, a conditional branch, a fan-out over a collection (map), or a terminal success/failure. Declares `needs:` (zero or more upstream step names) to place itself in the DAG; steps with no dependency between them run concurrently. |
| **Execution Context** | The initial query input plus the addressable, growing collection of each completed step's output (`steps.<name>.output`) — not a single blob progressively reshaped in place. JSONata expressions read from this context; a step never mutates another step's recorded output. |
| **Run** | One execution of a flow against one input, producing an output JSON plus a trace. |
| **Test** | A fixture-based, deterministic check (command execution mocked): given input X, expect output/behavior Y. |
| **Eval** | A dataset-driven, scored assessment of flow quality across many examples, typically using real command execution. |

---

## 3. Scope Areas

### 3.1 Flow definition
- Declarative YAML per flow: a map of named steps, each optionally declaring `needs:` (upstream step names it depends on). The engine derives execution order and concurrency by topologically sorting this DAG — steps with no dependency path between them run in parallel automatically, up to a configurable concurrency limit. This replaces ASL's flat named-state + `next`/goto graph (built for durable, checkpoint-resumable execution, which is a non-goal here — see §1.3) and is closer to GitHub Actions' `jobs`/`needs` model.
- Each step declares `input:` (a JSONata expression evaluated against the execution context, producing what the step receives) and, implicitly, an `output:` (the step's result, recorded as `steps.<name>.output` for downstream steps to reference). This two-hook model replaces ASL's four-stage InputPath/Parameters/ResultPath/OutputPath pipeline, which exists to minimize payloads across opaque network-service boundaries — a non-issue for a single local in-process context.
- Step types needed in v1: CLI command task, pure transform, conditional branch (choice), map (fan-out over a collection with bounded concurrency, itself just a step whose `needs` graph runs N times), pass-through, and terminal success/fail. There is no separate "parallel" step type — concurrency falls out naturally from the DAG (§3.1 above); a fan-in/join is just a downstream step whose `needs:` lists multiple upstream steps.
- Conditional branching uses an explicit `choice:` step (multi-way, JSONata-evaluated conditions) rather than GitHub Actions' per-step `if:` strings, which don't scale past simple skip logic.
- Flows should support retry and error-catch semantics around steps that can fail (command failure, timeout, non-zero exit, etc.), kept from ASL's Retry/Catch model since neither GitHub Actions' `continue-on-error` nor `if: failure()` offers equivalent structured fallback routing.

**Rationale summary (Step Functions vs. GitHub Actions as a pattern):** keep ASL's Retry/Catch and explicit multi-way Choice; drop ASL's flat state+`next` graph and its 4-stage data-selection pipeline in favor of GitHub Actions' named-step DAG (`needs:`) and addressable step outputs, since this engine runs single-process, non-durable, and locally (§1.3) — the machinery ASL needs for durable/async/opaque-service execution has no job to do here.

### 3.1.1 Sample flow definition (illustrative — exact keys/schema TBD in plan mode)

```yaml
# flows/research-and-summarize/flow.yaml
name: research-and-summarize
version: 0.1.0

config:
  default_timeout: 30s
  default_retry:
    max_attempts: 2
    backoff: 2s

# Every flow's initial trigger is a JSON object containing at least a query string.
# Available in expressions as `trigger`, e.g. trigger.query
trigger_schema:
  type: object
  required: [query]
  properties:
    query: { type: string }

steps:

  # No `needs:` -> runs first, in parallel with any other root step.
  fetch_sources:
    type: command
    command: ["search-cli", "--json"]
    input: "{ \"q\": trigger.query, \"limit\": 5 }"   # JSONata -> stdin (default)
    retry:
      max_attempts: 3
      on: [timeout, nonzero_exit]

  # Map: runs the sub-step once per item, bounded concurrency, ordered results.
  summarize_each:
    type: map
    needs: [fetch_sources]
    over: "steps.fetch_sources.output.results"   # JSONata collection expression
    max_concurrency: 4
    step:
      type: command
      command: ["llm-run", "--prompt-file", "prompts/summarize.md"]
      input: "{ \"text\": item.body }"            # `item` = current element
      catch:
        - error_type: command_failure
          result: { summary: "" }                 # fallback value, flow continues

  # Fan-in: depends on multiple upstream steps -> runs after both complete.
  score_quality:
    type: command
    needs: [fetch_sources, summarize_each]
    command: ["quality-scorer"]
    input: >
      {
        "sourceCount": $count(steps.fetch_sources.output.results),
        "summaries": steps.summarize_each.output
      }

  # Multi-way conditional branch (JSONata conditions), replaces per-step `if:`.
  route_on_score:
    type: choice
    needs: [score_quality]
    branches:
      - when: "steps.score_quality.output.score >= 0.7"
        next: publish
      - when: "steps.score_quality.output.score < 0.7"
        next: flag_for_review
    default: flag_for_review

  publish:
    type: command
    command: ["publish-cli"]
    input: "steps.summarize_each.output"
    terminal: success

  flag_for_review:
    type: pass
    input: "{ \"reason\": \"low quality score\", \"score\": steps.score_quality.output.score }"
    terminal: success
```

Notes on the sample:
- `fetch_sources` has no `needs:` and starts immediately; if another root step existed alongside it, both would run concurrently — concurrency is inferred from the DAG, not declared with a separate "parallel" construct.
- `summarize_each` is the map/iterate construct: `over` selects a collection via JSONata, `step` defines the per-item sub-step, and `item` is bound to the current element inside it.
- `score_quality` depends on two upstream steps (`needs: [fetch_sources, summarize_each]`) — this is the fan-in/join pattern, expressed as an ordinary dependency rather than a nested Parallel-state's implicit join.
- `steps.<name>.output` is how any step reads another's result — no ResultPath/OutputPath merging into a shared blob.
- `route_on_score` is the explicit Choice construct for multi-way branching.
- `catch` on `summarize_each.step` shows per-step fallback routing/value on failure, kept from ASL's Catch semantics.

### 3.2 Folder-per-flow convention
- Each flow is self-contained: its definition, its config (default timeouts, retry policy), its tests, and its eval dataset all live together.
- A flow must be runnable/testable/evaluable by pointing the CLI at its folder alone — no hard dependency on a shared/global engine state, though flows may optionally opt into shared project-level defaults.

### 3.3 CLI command step (core primitive)
- A step can execute an arbitrary external CLI command/binary as its unit of work.
- The flow definition specifies: the command/binary to run, how the step's resolved JSON input is passed to it (e.g. stdin, args, env), and how its output is captured back into the context (parsed as JSON where possible, with a raw-text fallback).
- Non-zero exit codes / timeouts map to catchable, retryable errors within the flow, same as any other step failure.
- This primitive is intentionally generic — an LLM runner, a build tool, a linter, a data-fetch script, etc. are all just "a command" from the engine's point of view. No specific external tool is special-cased in v1.

### 3.4 CLI surface (of the engine itself)
Core capabilities the CLI needs to expose (exact command names/flags TBD in plan mode):
- Scaffold a new flow.
- Validate a flow definition (structural + reference checks).
- Run a flow once against an input (with options for tracing and for mocking/replaying command output instead of executing for real).
- Run a flow's test suite.
- Run a flow's eval dataset and produce a scored report.
- List/describe available flows.
- Export/print a flow's graph in a visualizable form (for later reuse by Phase 2 UI).

### 3.5 Testing
- Fixture-based tests per flow: given an input and mocked command output (keyed by step), assert on the output and/or on which path through the flow was taken (important for validating branching logic without depending on real command execution).
- A way to record real command output from an actual run and save it as reusable mocks for tests.

### 3.6 Evaluation
- Dataset of (input, expected) pairs per flow, run through the flow (typically with real command execution), scored via configurable graders (exact/structural match, JSONata-expressed assertions, and optionally other scoring strategies).
- Aggregate report: pass rate, per-grader breakdown, and access to failing examples' full traces.

### 3.7 Observability
- Every run produces a structured, inspectable trace (steps visited, inputs/outputs/errors per step) — used for debugging, for test/eval assertions, and reusable later by the Phase 2 UI.
- The trace is also the run's **checkpoint**: it is rewritten atomically on every step and map-item state change, and SIGINT/SIGTERM mark the run `interrupted` rather than leaving a stale `running` status.
- **Resume**: `resume <flow> <run_id>` (or `run --resume`) reloads the flow, verifies its definition hash matches the one recorded in the trace (overridable with `--force`), keeps every `succeeded`/`caught` step and map item, and re-executes only pending, failed or interrupted work. The run keeps its id; `resume_count` increments. `runs <flow>` lists persisted runs.

---

## 4. Control Flow Requirements (v1)

- **Sequential** step-to-step execution (baseline): expressed as a chain of `needs:` dependencies.
- **Choice/branching**: an explicit `choice` step type, routing based on JSONata conditions evaluated against the execution context.
- **Parallel fan-out/fan-in**: not a distinct step type — falls out of the DAG itself. Steps with no dependency path between them run concurrently; a step naming multiple steps in `needs:` is the join/fan-in point, collecting each upstream step's output by name (see §3.1.1 sample).
- **Iterate/Map**: a `map` step type — run a sub-step once per item in a collection, with bounded concurrency, collecting results in order.
- **Retry/Catch**: per-step retry policy on specific error types, and fallback routing on unhandled errors.

---

## 5. Versioning & Config

- Each flow declares its own version (semver).
- Flow-level config holds defaults (timeouts, retry policy) that steps can override; flows may optionally extend a shared project-level config, but must still work standalone without one.
- The flow schema itself should be versioned so the engine can evolve without breaking existing flows outright.

---

## 6. Error Handling

- A small, well-defined error taxonomy (e.g. command failure, timeout, schema validation error, expression evaluation error, generic catch-all) that retry/catch logic in flows can target.
- Every run (success or failure) leaves behind a trace artifact for later inspection.

---

## 7. Phase 2 (Future): UI

Not built in v1, but v1 should avoid decisions that would block it later:
- Config/flow editor, ideally generated from/validated against the same definitions the CLI uses (no duplicated schema).
- Visualization that reuses the CLI's own graph-export output rather than a second implementation.
- A run/trace viewer that reads the same trace artifacts the CLI already produces.
- Likely a local web app launched from the CLI, consistent with the local-first approach — exact form is a Phase 2 decision.

---

## 8. Open Questions (for plan mode to resolve)

1. How exactly is a CLI command step's input passed to the subprocess (stdin vs. args vs. env), and is this configurable per step or fixed engine-wide?
2. Parallel branch result shape: ordered array vs. named-by-branch-key object.
3. Should command steps support templated argument lists (e.g. JSONata-resolved values interpolated into an argv array), or just a fixed command plus JSON-over-stdin?
4. Should there be engine-level guardrails for concurrency limits and/or timeouts per run, beyond per-step settings?
5. Where does shared/project-level config live relative to individual flow folders, and how is it discovered?
6. How should an LLM runner (or any other specific tool) be layered on top of this generic CLI-command primitive later, without special-casing it in the engine — e.g. is it just a flow-author convention (a particular command + prompt-file argument pattern), or does it warrant its own step "resource type" on top of the generic command step?

---
