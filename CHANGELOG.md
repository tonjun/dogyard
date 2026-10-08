# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). DogYard is pre-1.0:
the flow schema may change between minor versions.

## [Unreleased]

### Added
- Live progress on stderr for `run`/`resume`: one status line per running
  step, e.g. `analyze_posts  142/300  ● 3 failed  ● 2 caught  ● 40 cached
  ETA 1h12m`. On a terminal it redraws in place with command stderr scrolling
  above it. Otherwise a map's line is printed every 10 items or 30s, and once
  when it ends. `-q` turns it off.
- The ETA is the median wall time of the last 20 executed (not cached) items,
  including retries and backoff, times the items left, divided by the map's
  concurrency. Until the first item finishes it is seeded from earlier runs'
  traces, and is shown as `~`.
- `dogyard runs watch <flow> [run_id|latest]` follows a run from another
  terminal by polling its trace. It shows the last error with its stderr tail
  and exits with the run's exit code. `--json` streams NDJSON `progress` and
  `end` events.
- Map sub-steps see `total` (the item count) in JSONata, next to `item` and
  `index`. Command sub-steps also get `WF_ITEM_INDEX` and `WF_ITEM_TOTAL` in
  their environment. Step tests accept `context.total` (default `index + 1`).
- `runs <flow>` shows each run's duration and map items done/total; `--json`
  adds a `progress` field.
- Traces record `started_at`/`ended_at` per map item and the map's effective
  `max_concurrency`.
- Library exports: `computeProgress`, `historicalItemMedians`, `runSummary`,
  `formatStepLine`, `formatShortDuration`, `recentRuns`.

### Fixed
- Streamed command stderr is colored gray line by line, so the color no
  longer spills onto the next line written to the terminal.

## [0.4.0] - 2026-10-09

### Added
- Step result cache: `cache:` on a `command` step (or a map's command
  sub-step, cached per item) reuses an earlier successful output when its key
  (input or a JSONata `key`, step definition, hashed `files`, `env` values) is
  unchanged, with an optional `ttl`. Stored under `.dogyard/cache/`; only
  successes are cached. Hits are recorded as `cache` in the trace.
- `run`/`resume` flags `--no-cache` and `--refresh <steps>`, a
  `Cache: N cached / M executed` summary, and cached/executed counts in
  `runs <flow>`.
- `dogyard cache ls|clear <flow> [--step] [--expired]`.
- `eval --cache` to use the cache during flow evals with real execution.
- Durations accept a `d` (days) unit.

### Fixed
- A timed-out or interrupted command is now killed with everything it started:
  each command runs in its own process group (POSIX), which gets SIGTERM and
  then SIGKILL after 2s, so a wrapper script's subprocesses can no longer delay
  a map item's `timeout` or outlive the step. Failed map items now record
  `duration_ms`. (Shipped as 0.3.1 without a changelog entry.)

## [0.3.0] - 2026-09-22

First public release.

### Added
- MIT license, contributing guide, code of conduct, security policy and
  `docs/security.md`.
- GitHub Actions CI (Node 20, 22 and 24 on Linux, macOS and Windows, plus a
  packed-tarball smoke test), a tag-triggered release workflow, and issue and
  pull request templates.
- Package metadata; the bundled `examples/` now ship in the npm package.

### Changed
- README reorganized around installing and using the published CLI.
- `docs/spec.md` reframed as a design-rationale document; former open
  questions are recorded as decisions.

### Fixed
- The `hello` example's routing test no longer depends on the completion order
  of two parallel steps (it failed intermittently).
- `dogyard test` output prints step test file paths with `/` on every platform.
- Test suite is portable to Windows (spawns tsx via node; native-path assertions).

## 0.2.0

Initial development version: YAML DAG flows, command/transform/pass/choice/map
steps, JSONata data flow, retry/catch, traces and resume, fixture tests, evals,
per-step tests and evals, and step-level `mock:`.

[Unreleased]: https://github.com/tonjun/dogyard/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/tonjun/dogyard/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tonjun/dogyard/releases/tag/v0.3.0
