// complete(): truncated prefix in, valid JSON text out, every edit reported.
// The keystone is the every-prefix property: for EVERY prefix of a valid
// document, the output must parse and must agree with the snapshot — that is
// the invariant SDKs rely on when they render partial tool arguments.
import test from "node:test";
import assert from "node:assert/strict";

import { complete, parsePartial, DripError } from "../dist/index.js";

const kinds = (result) => result.repairs.map((r) => r.kind);

test("a complete document is returned unchanged with complete: true and no repairs", () => {
  const doc = '  {"a": [1, 2], "b": "x"}\n';
  assert.deepEqual(complete(doc), { text: doc, complete: true, repairs: [] });
});

test("an open string value is closed in place", () => {
  const result = complete('{"city": "Osa');
  assert.equal(result.text, '{"city": "Osa"}');
  assert.deepEqual(kinds(result), ["closed-string", "closed-containers"]);
});

test("a torn escape is dropped before the string is closed", () => {
  const bs = "\\";
  const result = complete('{"s": "x' + bs);
  assert.equal(result.text, '{"s": "x"}');
  assert.deepEqual(kinds(result), ["dropped-incomplete-escape", "closed-string", "closed-containers"]);
  const result2 = complete('{"s": "x' + bs + "u00");
  assert.equal(result2.text, '{"s": "x"}');
  assert.equal(result2.repairs[0].detail, bs + "u00");
});

test("a half-written literal is finished with the letters it must have", () => {
  const result = complete('{"ok": fal');
  assert.equal(result.text, '{"ok": false}');
  assert.deepEqual(kinds(result), ["completed-literal", "closed-containers"]);
  assert.equal(complete("[n").text, "[null]");
});

test("a partial number is trimmed to its longest valid prefix", () => {
  const result = complete('{"n": 12.');
  assert.equal(result.text, '{"n": 12}');
  assert.deepEqual(result.repairs[0], { kind: "trimmed-number", detail: "12. -> 12" });
  assert.equal(complete("[3e").text, "[3]");
  assert.equal(complete("[-0.25e+").text, "[-0.25]");
});

test("a complete trailing number is kept whole, with no trim repair", () => {
  const result = complete('{"n": 42');
  assert.equal(result.text, '{"n": 42}');
  assert.deepEqual(kinds(result), ["closed-containers"]);
});

test("a bare minus is dropped, taking its dangling key with it", () => {
  const result = complete('{"a": 1, "n": -');
  assert.equal(result.text, '{"a": 1}');
  assert.deepEqual(kinds(result), ["dropped-partial-value", "dropped-dangling-key", "closed-containers"]);
});

test("a dangling key is cut back to the last complete member", () => {
  for (const prefix of ['{"a": 1, "k"', '{"a": 1, "k":', '{"a": 1, "k" :  ']) {
    const result = complete(prefix);
    assert.equal(result.text, '{"a": 1}', prefix);
    assert.deepEqual(kinds(result), ["dropped-dangling-key", "closed-containers"]);
  }
});

test("a key cut off mid-string is dropped", () => {
  const result = complete('{"a": 1, "lon');
  assert.equal(result.text, '{"a": 1}');
  assert.deepEqual(kinds(result), ["dropped-partial-key", "closed-containers"]);
});

test("trailing commas are removed in arrays and objects", () => {
  assert.equal(complete("[1, 2,").text, "[1, 2]");
  assert.deepEqual(kinds(complete("[1, 2, ")), ["removed-trailing-comma", "closed-containers"]);
  assert.equal(complete('{"a": 1,').text, '{"a": 1}');
});

test("open containers are closed innermost-first", () => {
  const result = complete('{"a": [1, {"b": [true');
  assert.equal(result.text, '{"a": [1, {"b": [true]}]}');
  assert.deepEqual(result.repairs.at(-1), { kind: "closed-containers", detail: "]}]}" });
});

test("a container opened just before the cut survives as an empty container", () => {
  assert.equal(complete('[{"a": 1}, {"b').text, '[{"a": 1}, {}]');
  assert.equal(complete("[[1], [").text, "[[1], []]");
});

test("empty and whitespace-only input complete to null", () => {
  assert.deepEqual(complete(""), { text: "null", complete: false, repairs: [{ kind: "empty-input" }] });
  assert.equal(complete("  \n ").text, "null");
});

test("a lone root minus leaves nothing: null, with the drop reported first", () => {
  const result = complete("-");
  assert.equal(result.text, "null");
  assert.deepEqual(kinds(result), ["dropped-partial-value", "empty-input"]);
});

test("formatting of the kept prefix is preserved byte-for-byte", () => {
  const prefix = '{\n  "a" : [ 1 ,\n            2 ] ,\n  "b" : "x';
  const result = complete(prefix);
  assert.ok(result.text.startsWith(prefix));
  assert.equal(JSON.parse(result.text).a.length, 2);
});

test("corrupt input throws DripError instead of being 'repaired'", () => {
  for (const bad of ['{"a" 1}', "[1,]", '{"a": 1} extra', "[01]", '{"a": tru2']) {
    assert.throws(() => complete(bad), DripError, bad);
  }
});

test("repairs are empty exactly when the input was complete", () => {
  assert.equal(complete("[1, 2, 3]").repairs.length, 0);
  assert.ok(complete("[1, 2, 3").repairs.length > 0);
});

test("every prefix of a hard fixture completes to parseable JSON that matches the snapshot", () => {
  const doc =
    '{"tool": "book_flight", "args": {"from": "SFO", "legs": [1, -2.5e3, true, false, null], ' +
    '"note": "say \\"hi\\" \\u00e9 ~/x \\uD83D\\uDE00", "deep": {"a": [{"b": 0.25}, []], "ok": true}}, "n": 100}';
  JSON.parse(doc); // the fixture itself must be valid
  for (let i = 0; i <= doc.length; i++) {
    const prefix = doc.slice(0, i);
    const { text } = complete(prefix);
    let parsed;
    assert.doesNotThrow(() => (parsed = JSON.parse(text)), `prefix of length ${i} -> ${text}`);
    const { value } = parsePartial(prefix);
    if (value !== undefined) {
      assert.deepEqual(parsed, value, `complete/snapshot disagree at prefix length ${i}`);
    }
  }
});

test("completing a completed output is a fixed point", () => {
  for (const prefix of ['{"a": [1, {"b": "x', "[1, 2,", '{"k":', "tru", ""]) {
    const once = complete(prefix).text;
    assert.deepEqual(complete(once), { text: once, complete: true, repairs: [] }, prefix);
  }
});
