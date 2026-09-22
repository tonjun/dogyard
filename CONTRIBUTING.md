# Contributing to DogYard

Thanks for your interest! Bug reports, docs fixes, examples and features are all
welcome. For anything larger than a small fix, please open an issue first so we
can agree on the approach.

## Setup

Requires Node.js 20+.

```bash
git clone https://github.com/tonjun/dogyard.git && cd dogyard
npm ci
npm run typecheck
npm test
npm run dev -- validate examples/flows/research   # run the CLI from source
```

## Where things live

`CLAUDE.md` has a concise architecture tour (loader → graph → validate →
executor, runners, traces, testing/eval). It is written for AI coding tools but
is the best map for humans too. In short:

- `src/schema/*.ts` (Zod) are the source of truth for every YAML file format.
- `src/executor/` runs flows; `src/testing/` and `src/eval/` are built on it.
- `src/cli/` is a thin commander layer over the library API in `src/index.ts`.
- `tests/unit` and `tests/e2e` are vitest; `examples/flows` are runnable and
  also serve as fixtures.

## Making a change

1. Add or update tests. Run one file with `npx vitest run tests/unit/<file>.test.ts`.
2. If you change a schema in `src/schema/`, update `README.md` and
   `docs/spec.md` in the same PR.
3. Keep tests deterministic: no wall-clock ordering between parallel steps
   (see the note on `path` in the README), and every `command` step needs a mock
   under `test`/`eval`.
4. Add a line under "Unreleased" in `CHANGELOG.md` for user-visible changes.
5. Make sure `npm run typecheck && npm test` pass, then open a pull request that
   explains the what and why.

## Scope

DogYard is intentionally small: local, CLI-first, no server or UI (see the
non-goals in `docs/spec.md`). Proposals that add hosted or durable-execution
features are unlikely to be accepted; integrations are usually better as
commands that a flow calls.

## Conduct and security

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in
public issues.

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
