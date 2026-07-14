# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-13

### Added

- The incremental parser `DripParser`: `push()` accepts input in arbitrary
  chunks — tokens, escapes (`\uXXXX` split anywhere), numbers and literals
  may straddle any boundary — and returns typed events (`openObject`,
  `key`, `value`, `delta`, `closeArray`, `done`, …) with full paths for
  everything the new input settled. Events are identical regardless of how
  the same bytes are chunked.
- Best-effort snapshots: `snapshot()` returns a deep, isolated copy of the
  document so far at any moment, with three explicit recovery policies —
  `onPartialNumber` (`trim`/`omit`), `onPartialLiteral` (`resolve`/`omit`,
  every literal prefix is unambiguous) and `onDanglingKey` (`omit`/`null`).
- `parsePartial(text)`: the one-call form — best-effort value plus a
  `complete` flag.
- `complete(text)`: repair a truncated JSON prefix into valid JSON text by
  "cut and close", never inventing data: close the torn string, drop a torn
  escape, trim `12.` to `12`, finish `fal` to `false`, drop dangling keys
  and trailing commas, close open containers innermost-first. Formatting of
  the kept prefix is preserved byte-for-byte and every edit is reported as
  a typed `Repair`. `JSON.parse(complete(p).text)` always deep-equals
  `parsePartial(p).value` — enforced by an every-prefix property test.
- Strict-JSON honesty: truncation is recovered, corruption is not. Input no
  completion could make valid (`{"a" 1}`, `[1,]`, bad escapes, trailing
  content) throws `DripError` with a machine code and exact
  offset/line/column.
- `status()` and `completionInfo()` + `assemble()`: introspect what is open
  (depth, closers, pending construct) and build custom completion on top of
  a caller-owned buffer without re-parsing.
- `pathToPointer()`: RFC 6901 JSON Pointers from event paths.
- String deltas (`stringDeltas: true`): per-push `delta` events for string
  values, for streaming text fields as they grow.
- A `maxDepth` guard (default 1000) against pathological nesting.
- The `dripjson` CLI: `complete` (repaired text or `--json` with repairs),
  `snapshot` (`--pretty`, `--no-resolve`), `events` (NDJSON, `--chunk n`,
  `--deltas`) and `status` (a scriptable gate: exit 1 while partial);
  reads files or stdin; exit codes 0 ok/complete, 1 partial, 2 usage or
  invalid JSON.
- Committed truncated example documents, a runnable streaming demo, and
  [docs/recovery-rules.md](docs/recovery-rules.md) specifying the exact
  recovery contract.
- Test suite: 91 node:test tests (lexer, parser, snapshot, completion,
  pointer, CLI integration) and an end-to-end `scripts/smoke.sh` against
  the bundled examples.

[0.1.0]: https://github.com/JaydenCJ/dripjson/releases/tag/v0.1.0
