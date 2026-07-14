# Contributing to dripjson

Issues, discussions and pull requests are all welcome — this project aims
to stay small, zero-dependency at runtime, fully offline, and strict about
one thing: recover truncation, never guess around corruption.

## Getting started

Requirements: Node.js >= 22.13 (for the stable `node:test` runner used by the suite).

```bash
git clone https://github.com/JaydenCJ/dripjson.git
cd dripjson
npm install            # installs typescript, the only devDependency
npm run build          # compile TypeScript to dist/
npm test               # build + 91 node:test tests
bash scripts/smoke.sh  # end-to-end CLI check against examples/
```

`scripts/smoke.sh` exercises the real CLI (complete/snapshot/events/status,
exit codes, stdin input, chunked event streams, `--no-resolve`, and the
invalid-JSON path) against the committed example files and must print
`SMOKE OK`.

## Before you open a pull request

1. `npx tsc -p tsconfig.json --noEmit` — the tree must type-check clean (strict mode is enforced).
2. `npm test` — all tests must pass.
3. `bash scripts/smoke.sh` — must print `SMOKE OK`.
4. Add tests for behavior changes; keep logic in pure, unit-testable
   modules (only `cli.ts` touches the filesystem or the process — the
   parser, completer and policies are plain ES2022).
5. Changes to recovery rules change what users' code *sees* in partial
   data: update [docs/recovery-rules.md](docs/recovery-rules.md), and keep
   the `complete()`/`snapshot()` equivalence intact — the every-prefix
   property test will catch you if you don't.

## Ground rules

- **No runtime dependencies.** The zero-dependency install is a core
  feature; adding one needs justification in the PR and will usually be
  declined. The incremental lexer is in-repo on purpose.
- Truncation is recovered; corruption throws. Never make the parser accept
  input that `JSON.parse` would reject unless it is a prefix of something
  `JSON.parse` would accept. Looser dialects belong behind future options,
  not in the default grammar.
- Events are emitted eagerly and never retracted; anything already
  reported as a `value` must survive verbatim in every later snapshot.
- Determinism is API: no clocks, no randomness, no locale-dependent
  behavior. The same bytes produce the same events regardless of how they
  are chunked — the split-invariance tests enforce this.
- No network calls, ever — dripjson transforms local data only.
- Code comments and doc comments are written in English.

## Reporting bugs

Please include: `dripjson --version` output, the exact input (a truncated
prefix pastes fine — that's the tool's whole job), and what you expected
versus what happened. The gold standard repro: a prefix where
`complete()` output fails `JSON.parse`, or where two chunkings of the same
bytes produce different results.

## Security

Do not open public issues for security problems (e.g. an input that makes
the parser hang or recurse unboundedly); use GitHub private vulnerability
reporting on this repository instead.
