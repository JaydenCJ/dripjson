// snapshot() and parsePartial(): best-effort values from unfinished input,
// the three recovery policies, and isolation guarantees (a snapshot is a
// deep copy that later input never mutates). These rules are the contract
// documented in docs/recovery-rules.md.
import test from "node:test";
import assert from "node:assert/strict";

import { DripParser, parsePartial } from "../dist/index.js";
import { parserFor } from "./helpers.mjs";

test("a string cut off mid-value is included with the content so far", () => {
  assert.deepEqual(parserFor('{"city": "Osa').snapshot(), { city: "Osa" });
});

test("a dangling key is omitted by default and kept as null on request", () => {
  const parser = parserFor('{"a": 1, "b":');
  assert.deepEqual(parser.snapshot(), { a: 1 });
  assert.deepEqual(parser.snapshot({ onDanglingKey: "null" }), { a: 1, b: null });
});

test("a key cut off mid-string is always omitted — its name cannot be known", () => {
  const parser = parserFor('{"a": 1, "lon');
  assert.deepEqual(parser.snapshot(), { a: 1 });
  assert.deepEqual(parser.snapshot({ onDanglingKey: "null" }), { a: 1 });
});

test("a partial number is trimmed to its longest valid prefix by default", () => {
  assert.deepEqual(parserFor('{"n": 12.').snapshot(), { n: 12 });
  assert.deepEqual(parserFor('{"n": 3e').snapshot(), { n: 3 });
  assert.deepEqual(parserFor('{"n": -0.25e+').snapshot(), { n: -0.25 });
});

test("onPartialNumber omit drops the value — and with it the key it belonged to", () => {
  const parser = parserFor('{"a": 1, "n": 12.');
  assert.deepEqual(parser.snapshot({ onPartialNumber: "omit" }), { a: 1 });
  // The key is dangling once its value is dropped; the key policy applies.
  assert.deepEqual(parser.snapshot({ onPartialNumber: "omit", onDanglingKey: "null" }), { a: 1, n: null });
});

test("a bare minus has nothing salvageable even under trim", () => {
  assert.deepEqual(parserFor("[1, -").snapshot(), [1]);
});

test("partial literals resolve — every prefix is unambiguous", () => {
  assert.deepEqual(parserFor('{"ok": tru').snapshot(), { ok: true });
  assert.deepEqual(parserFor('{"ok": f').snapshot(), { ok: false });
  assert.deepEqual(parserFor('{"ok": n').snapshot(), { ok: null });
});

test("onPartialLiteral omit drops the half-written literal", () => {
  assert.deepEqual(parserFor("[true, fal").snapshot({ onPartialLiteral: "omit" }), [true]);
});

test("pending scalars attach to the innermost open container", () => {
  assert.deepEqual(parserFor('{"a": [1, [2, 3.').snapshot(), { a: [1, [2, 3]] });
});

test("root-level partial values follow the same policies", () => {
  assert.equal(parserFor('"hel').snapshot(), "hel");
  assert.equal(parserFor("12.").snapshot(), 12);
  assert.equal(parserFor("tru").snapshot(), true);
  assert.equal(parserFor("tru").snapshot({ onPartialLiteral: "omit" }), undefined);
});

test("empty and whitespace-only input snapshot to undefined", () => {
  assert.equal(parserFor("").snapshot(), undefined);
  assert.equal(parserFor("  \n ").snapshot(), undefined);
});

test("a complete document snapshots exactly to JSON.parse of the same text", () => {
  const doc = '{"a": [1, {"b": "x"}, null], "c": {"d": false}}';
  assert.deepEqual(parserFor(doc).snapshot(), JSON.parse(doc));
});

test("snapshots are deep copies: later input never mutates an earlier snapshot", () => {
  const parser = new DripParser();
  parser.push('{"xs": [1');
  const early = parser.snapshot();
  assert.deepEqual(early, { xs: [1] });
  parser.push(", 2], \"y\": 3}");
  assert.deepEqual(early, { xs: [1] }); // unchanged
  assert.deepEqual(parser.snapshot(), { xs: [1, 2], y: 3 });
});

test("mutating a snapshot never corrupts the parser's tree", () => {
  const parser = new DripParser();
  parser.push('{"cfg": {"level": 1}');
  const snap = parser.snapshot();
  snap.cfg.level = 999;
  snap.injected = true;
  parser.push("}");
  assert.deepEqual(parser.snapshot(), { cfg: { level: 1 } });
});

test("the snapshot grows as a document streams in, ending at JSON.parse", () => {
  const doc = '{"name": "run", "args": {"path": "/srv/app", "dry": false}, "n": 3}';
  const at = (prefix) => {
    const parser = new DripParser();
    parser.push(prefix);
    return parser.snapshot();
  };
  assert.deepEqual(at('{"name'), {}); // key not settled yet
  assert.deepEqual(at('{"name": "ru'), { name: "ru" });
  assert.deepEqual(at('{"name": "run", "args": {"path": "/srv/app", "dry": fa'), {
    name: "run",
    args: { path: "/srv/app", dry: false },
  });
  assert.deepEqual(at(doc), JSON.parse(doc));
});

test("parsePartial is the one-call form: value plus completeness", () => {
  assert.deepEqual(parsePartial('{"a": [1, 2'), { value: { a: [1, 2] }, complete: false });
  assert.deepEqual(parsePartial('{"a": [1, 2]}'), { value: { a: [1, 2] }, complete: true });
  assert.deepEqual(parsePartial(""), { value: undefined, complete: false });
  assert.deepEqual(parsePartial('[fal', { onPartialLiteral: "omit" }), { value: [], complete: false });
});

test("parsePartial passes maxDepth through to the parser", () => {
  assert.throws(() => parsePartial("[[[[", { maxDepth: 2 }), (err) => err.code === "max-depth");
});
