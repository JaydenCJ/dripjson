// DripParser grammar and events: order, paths, deltas, done semantics,
// chunk-split invariance, strictness, and status reporting. These are the
// behaviors SDKs build on, so the failure cases matter as much as the happy
// path — a parser that accepts `[1,]` silently changes user data.
import test from "node:test";
import assert from "node:assert/strict";

import { DripParser, DripError } from "../dist/index.js";
import { eventsOf, parserFor, pushChunked } from "./helpers.mjs";

test("a nested document produces the full event sequence with correct paths", () => {
  assert.deepEqual(eventsOf('{"a": [1, {"b": null}], "c": true}'), [
    { type: "openObject", path: [] },
    { type: "key", path: ["a"], key: "a" },
    { type: "openArray", path: ["a"] },
    { type: "value", path: ["a", 0], value: 1 },
    { type: "openObject", path: ["a", 1] },
    { type: "key", path: ["a", 1, "b"], key: "b" },
    { type: "value", path: ["a", 1, "b"], value: null },
    { type: "closeObject", path: ["a", 1] },
    { type: "closeArray", path: ["a"] },
    { type: "key", path: ["c"], key: "c" },
    { type: "value", path: ["c"], value: true },
    { type: "closeObject", path: [] },
    { type: "done", value: { a: [1, { b: null }], c: true } },
  ]);
});

test("string values emit no delta events unless stringDeltas is on", () => {
  const events = eventsOf('{"msg": "hello"}');
  assert.deepEqual(events.filter((e) => e.type === "delta"), []);
  assert.deepEqual(
    events.find((e) => e.type === "value"),
    { type: "value", path: ["msg"], value: "hello" },
  );
});

test("with stringDeltas, each push yields a delta and the final value is complete", () => {
  const parser = new DripParser({ stringDeltas: true });
  const first = parser.push('{"msg": "hel');
  assert.deepEqual(first.at(-1), { type: "delta", path: ["msg"], text: "hel" });
  const second = parser.push('lo"}');
  assert.deepEqual(second, [
    { type: "delta", path: ["msg"], text: "lo" },
    { type: "value", path: ["msg"], value: "hello" },
    { type: "closeObject", path: [] },
    { type: "done", value: { msg: "hello" } },
  ]);
});

test("keys never produce delta events, even when split across pushes", () => {
  const parser = new DripParser({ stringDeltas: true });
  const events = [...parser.push('{"long_ke'), ...parser.push('y_name": 1}')];
  assert.deepEqual(events.filter((e) => e.type === "delta"), []);
  assert.deepEqual(
    events.find((e) => e.type === "key"),
    { type: "key", path: ["long_key_name"], key: "long_key_name" },
  );
});

test("done fires the moment the root container closes, before end()", () => {
  const parser = new DripParser();
  const events = parser.push('{"a": 1}');
  assert.deepEqual(events.at(-1), { type: "done", value: { a: 1 } });
  assert.equal(parser.status().done, true);
  assert.deepEqual(parser.end(), []); // end() after done adds nothing
});

test("a root scalar emits value then done, in that order", () => {
  assert.deepEqual(eventsOf('"hi"'), [
    { type: "value", path: [], value: "hi" },
    { type: "done", value: "hi" },
  ]);
});

test("a root number settles only at end(), because it could still grow", () => {
  const parser = new DripParser();
  assert.deepEqual(parser.push("42"), []);
  assert.equal(parser.status().done, false);
  assert.deepEqual(parser.end(), [
    { type: "value", path: [], value: 42 },
    { type: "done", value: 42 },
  ]);
});

test("events are identical regardless of how the input is chunked", () => {
  const doc = '{"s": "caf\\u00e9", "xs": [12345, -0.5, 3e2], "ok": true, "z": null}';
  const whole = eventsOf(doc);
  for (const size of [1, 2, 3, 5, 7, 11]) {
    assert.deepEqual(pushChunked(doc, size).events, whole, `chunk size ${size}`);
  }
});

test("the final value equals JSON.parse for every two-chunk split of a document", () => {
  const doc = '{"tool": "notify", "args": {"to": ["a@example.test"], "level": 3, "urgent": false}}';
  const expected = JSON.parse(doc);
  for (let i = 0; i <= doc.length; i++) {
    const parser = new DripParser();
    parser.push(doc.slice(0, i));
    parser.push(doc.slice(i));
    parser.end();
    assert.deepEqual(parser.snapshot(), expected, `split at ${i}`);
  }
});

test("whitespace-heavy formatting parses identically to compact form", () => {
  const compact = eventsOf('{"a":[1,2],"b":{"c":true}}');
  const airy = eventsOf('  {\r\n  "a" : [ 1 ,\t2 ] ,\n  "b" : { "c" : true }\n}\n');
  assert.deepEqual(airy, compact);
});

test("duplicate keys: the last value wins in the tree, both are announced as events", () => {
  const events = eventsOf('{"a": 1, "a": 2}');
  assert.deepEqual(events.filter((e) => e.type === "key").length, 2);
  assert.deepEqual(events.at(-1), { type: "done", value: { a: 2 } });
});

test("empty containers work at every level", () => {
  assert.deepEqual(eventsOf("[{}, []]").at(-1), { type: "done", value: [{}, []] });
});

test("content after the root value fails with trailing-content", () => {
  assert.throws(() => eventsOf('{"a": 1} {"b": 2}'), (err) => err.code === "trailing-content");
  assert.throws(() => eventsOf("1 2"), (err) => err.code === "trailing-content");
});

test("structural corruption fails with unexpected-token and a helpful message", () => {
  assert.throws(() => eventsOf('{"a" 1}'), (err) => err.code === "unexpected-token" && /":"/.test(err.message));
  assert.throws(() => eventsOf("[1,]"), (err) => err.code === "unexpected-token");
  assert.throws(() => eventsOf('{"a": 1,}'), (err) => /object key/.test(err.message));
  assert.throws(() => eventsOf("[}"), (err) => err.code === "unexpected-token");
  assert.throws(() => eventsOf(':"a"'), (err) => err instanceof DripError);
});

test("events already emitted are not retracted by a later error", () => {
  const parser = new DripParser();
  const events = parser.push("[1, 2");
  assert.deepEqual(events.map((e) => e.type), ["openArray", "value"]);
  assert.throws(() => parser.push(", }"), DripError);
});

test("maxDepth bounds nesting and reports the code", () => {
  const parser = new DripParser({ maxDepth: 3 });
  assert.throws(
    () => parser.push("[[[["),
    (err) => err.code === "max-depth" && err.offset === 3,
  );
  // Depth 3 itself is fine.
  assert.deepEqual(eventsOf("[[[1]]]").at(-1), { type: "done", value: [[[1]]] });
});

test("push after end() is a usage error", () => {
  const parser = new DripParser();
  parser.push("[1]");
  parser.end();
  assert.throws(() => parser.push(" "), /push\(\) after end\(\)/);
});

test("status reports depth, closers and the pending construct as input arrives", () => {
  const parser = new DripParser();
  parser.push('{"a": [1, {"b": "hel');
  assert.deepEqual(parser.status(), {
    done: false,
    started: true,
    depth: 3,
    closers: "}]}", // innermost first
    consumed: 20,
    line: 1,
    column: 21,
    pending: "value-string",
  });
});

test("status pending distinguishes key strings, dangling keys, numbers and literals", () => {
  assert.equal(parserFor('{"ke').status().pending, "key-string");
  assert.equal(parserFor('{"k":').status().pending, "dangling-key");
  assert.equal(parserFor("[12.").status().pending, "number");
  assert.equal(parserFor("[tru").status().pending, "literal");
  // Before end(), a trailing "1" is still an open number; end() settles it.
  const mid = new DripParser();
  mid.push("[1");
  assert.equal(mid.status().pending, "number");
  assert.deepEqual(mid.end().map((e) => e.type), ["value"]);
  assert.equal(mid.status().pending, "none");
  assert.equal(parserFor("[1,").status().pending, "none");
  assert.equal(parserFor('{"a":1}').status().pending, "none");
});

test("status on pristine and whitespace-only input reports not started", () => {
  const parser = new DripParser();
  assert.deepEqual(parser.status(), {
    done: false,
    started: false,
    depth: 0,
    closers: "",
    consumed: 0,
    line: 1,
    column: 1,
    pending: "none",
  });
  parser.push("  \n ");
  assert.equal(parser.status().started, false);
  assert.equal(parser.status().line, 2);
});
