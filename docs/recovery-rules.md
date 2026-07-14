# dripjson recovery rules

The exact contract for how dripjson turns a truncated JSON prefix into a
value (`snapshot()` / `parsePartial()`) and into valid JSON text
(`complete()`). Both paths apply the **same rules**, so for any prefix:

```
JSON.parse(complete(prefix).text)  deep-equals  parsePartial(prefix).value
```

(whenever the snapshot is not `undefined`; empty input completes to `null`).
This equivalence is enforced by the test suite over every prefix of a
fixture document.

## Scope: truncation, not corruption

dripjson recovers documents that are a **prefix of some valid JSON
document** — the only failure mode of an interrupted stream. Input that no
completion could make valid (a stray character, `[1,]`, `{"a" 1}`, a bad
escape, content after the root value) throws `DripError` with a machine
code and an exact `offset` / `line` / `column`. Recovery never guesses
around corruption; that would silently change data.

## End-state table

What happens depends on what the end of input tears through:

| Input ends… | Example prefix | `snapshot()` (defaults) | `complete()` produces | Repair reported |
|---|---|---|---|---|
| between tokens | `{"a": 1` | `{a: 1}` | `{"a": 1}` | `closed-containers` |
| inside a string value | `{"a": "hel` | `{a: "hel"}` | `{"a": "hel"}` | `closed-string` |
| inside an escape | `{"a": "x\u00` | `{a: "x"}` | `{"a": "x"}` | `dropped-incomplete-escape` |
| inside a number | `[12.` | `[12]` | `[12]` | `trimmed-number` |
| on a bare `-` | `[1, -` | `[1]` | `[1]` | `dropped-partial-value` |
| inside a literal | `{"ok": fal` | `{ok: false}` | `{"ok": false}` | `completed-literal` |
| inside a key string | `{"a": 1, "ke` | `{a: 1}` | `{"a": 1}` | `dropped-partial-key` |
| after a complete key | `{"a": 1, "k":` | `{a: 1}` | `{"a": 1}` | `dropped-dangling-key` |
| after a comma | `[1, 2,` | `[1, 2]` | `[1, 2]` | `removed-trailing-comma` |
| before anything | `` / `   ` | `undefined` | `null` | `empty-input` |

Open containers are always closed innermost-first afterwards
(`closed-containers` with the appended brackets as `detail`).

## Policies

Three judgment calls are configurable via `SnapshotOptions`:

| Option | Default | Alternative |
|---|---|---|
| `onPartialNumber` | `"trim"` — keep the longest valid numeric prefix (`12.` → `12`, `3e` → `3`) | `"omit"` — drop the value |
| `onPartialLiteral` | `"resolve"` — `t`/`tr`/`tru` can only be `true`; first letters differ, so every prefix is unambiguous | `"omit"` — drop the value |
| `onDanglingKey` | `"omit"` — drop a key whose value never arrived | `"null"` — keep it with value `null` |

A key cut off mid-string is always dropped: its name cannot be known.
`complete()` currently always uses the defaults, keeping the printed text
and the default snapshot in agreement.

## Why "cut and close", never invent

`complete()` keeps the input verbatim up to the last salvageable point and
appends only what the grammar forces (a closing quote, missing literal
letters, closing brackets). It never fabricates values, keys or separators.
Consequences worth knowing:

- Formatting of the kept prefix is preserved byte-for-byte — diffs against
  the original stay minimal.
- A container opened just before the cut survives as an empty container:
  `[{"a": 1}, {"b` → `[{"a": 1}, {}]`. The `{` was real; the key was not.
- Everything dropped is reported: `repairs` is empty **iff** the input was
  already complete (`complete: true`).

## Number semantics at end of input

A trailing number is genuinely ambiguous: `42` might become `420` if one
more byte arrives. dripjson resolves this by *proof*: while streaming, a
number is only emitted once a delimiter proves it finished; calling
`end()` declares the input final, at which point a trailing `42` settles
as 42. Before `end()`, `snapshot()` applies `onPartialNumber` to it. The
`done` event, by contrast, needs no `end()`: a root container's closing
bracket is proof by itself.

## Building your own completion

If you hold the input buffer yourself (an SDK accumulating deltas), use
`parser.completionInfo()` + `assemble(text, info)` — that is exactly how
`complete()` is implemented. `CompletionInfo` tells you where the last
append-closable point is (`safeCut`), which brackets are open (`closers`),
and what token the cut tore (`pendingNumber` / `pendingLiteral` / string
state), so custom policies can be layered on without re-parsing.
