# Project Spec: `project-no-name` — CLI-First Workflow Engine

Status: Draft v0.1 (high-level)
Owner: (you)
Target use: Input to Claude Code plan mode — this defines *what* to build and *why*; implementation-level design (exact schemas, module layout, algorithms) is left for plan mode to work out.

> Naming note: `project-no-name` is a placeholder used throughout as an example command/binary name. Rename project-wide once a real name is picked.

---

## 1. Overview

### 1.1 Problem
Existing workflow engines (AWS Step Functions, n8n, Temporal) are cloud-locked, UI-first, or heavyweight for local use cases. We want a **local-first, CLI-first workflow engine**: flows that take a query/input, route it through steps — primarily **CLI commands** — plus control-flow logic, and produce structured JSON output — definable, runnable, testable, and evaluable entirely from the terminal.

### 1.2 Goals (v1)
- CLI-first: every capability works via terminal commands and plain files, no server required.
- Flows are declarative, YAML-defined state machines, structurally similar to AWS Step Functions ASL.
- Data selection/transformation between steps uses **JSONata** (in place of ASL's JSONPath).
- Every flow's initial trigger is a **user query** (a JSON object containing at least a query string).
- All step inputs/outputs are JSON.
- The core step primitive is **executing a CLI command**: run an arbitrary external command/binary, pass it structured input, capture its output (stdout/exit code) back into the flow's JSON context. This makes the engine generically useful for orchestrating any CLI tool — not tied to any single backend.
- Each flow lives in its **own self-contained folder** with its own config — runnable, testable, and evaluable independently of any other flow or a central engine process.
- Supports core workflow control constructs: sequential steps, **parallel** branches, **iterate/map** over a collection, and conditional **branching**.
- Every run is inspectable via a structured execution trace.

### 1.3 Non-goals (v1)
- No UI (Phase 2 — see §7).
- No durable/resumable execution across process restarts (Temporal-style durability); a run is expected to complete within a single CLI process lifetime.
- No server, multi-tenancy, auth, or hosted execution.
- No visual/drag-drop flow authoring.
- No built-in scheduler (external cron can call the CLI).
- No built-in, opinionated integration with any particular external tool (LLM runner or otherwise) in v1 — the engine only knows how to run CLI commands generically; any specific tool (including an LLM runner) is just "a command someone points a step at," configured by the flow author, not baked into the engine.
- No human-in-the-loop / wait-for-external-event steps in v1 (would require durability, deferred).

---

## 2. Core Concepts

| Concept | Definition |
|---|---|
| **Flow** | A named, versioned workflow defined in its own folder as a YAML state machine plus config. |
| **Step (State)** | A node in the flow: a CLI command execution, a pure data transform, a conditional branch, a parallel fan-out, an iteration over a collection, or a terminal success/failure. |
| **Execution Context** | The JSON object carrying data through the flow, starting from the initial query input and evolving step by step. |
| **Run** | One execution of a flow against one input, producing an output JSON plus a trace. |
| **Test** | A fixture-based, deterministic check (command execution mocked): given input X, expect output/behavior Y. |
| **Eval** | A dataset-driven, scored assessment of flow quality across many examples, typically using real command execution. |

---

## 3. Scope Areas

### 3.1 Flow definition
- Declarative YAML per flow, describing states and transitions (start state, named states, `next`/branching, one or more terminal states).
- Data flowing between steps is shaped using JSONata expressions at well-defined points (what goes into a step, where its result gets merged, what flows onward) — mirroring the spirit of ASL's InputPath/Parameters/ResultPath/OutputPath, but JSONata instead of JSONPath.
- Step types needed in v1: CLI command task, pure transform, conditional branch, parallel, iterate/map, pass-through, and terminal success/fail.
- Flows should support retry and error-catch semantics around steps that can fail (command failure, timeout, non-zero exit, etc.).

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

---

## 4. Control Flow Requirements (v1)

- **Sequential** step-to-step execution (baseline).
- **Choice/branching**: route based on conditions evaluated against the current context.
- **Parallel**: run multiple branches concurrently against the same input, collect their results.
- **Iterate/Map**: run a sub-flow once per item in a collection, with bounded concurrency, collecting results in order.
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
