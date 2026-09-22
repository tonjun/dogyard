# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). DogYard is pre-1.0:
the flow schema may change between minor versions.

## [Unreleased]

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

[Unreleased]: https://github.com/tonjun/dogyard/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/tonjun/dogyard/releases/tag/v0.3.0
