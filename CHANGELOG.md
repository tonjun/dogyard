# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). DogYard is pre-1.0:
the flow schema may change between minor versions.

## [Unreleased]

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
