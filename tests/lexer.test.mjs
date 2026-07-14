// Incremental tokenizer: tokens must survive any chunk boundary — strings,
// escapes (incl. \uXXXX split anywhere), numbers and literals — and malformed
// input must fail with an exact position. The lexer is tested directly here;
// grammar-level behavior lives in parser.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";

import { Lexer } from "../dist/lexer.js";
import { DripError } from "../dist/index.js";
import { recordingSink } from "./helpers.mjs";

function lex(chunks, { end = true } = {}) {
  const sink = recordingSink();
  const lexer = new Lexer(sink);
  for (const chunk of chunks) lexer.push(chunk);
  if (end) lexer.end();
  return { calls: sink.calls, lexer };
}

test("tokenizes punctuation, strings, numbers and literals in one push", () => {
  const { calls } = lex(['{"a": [1, true, null]}']);
  assert.deepEqual(calls, [
    ["punct", "{", 0],
    ["stringStart", 1],
    ["stringChunk", "a"],
    ["stringEnd", 3],
    ["punct", ":", 4],
    ["punct", "[", 6],
    ["number", 1, "1", 7],
    ["punct", ",", 8],
    ["literal", true, "true", 10],
    ["punct", ",", 14],
    ["literal", null, "null", 16],
    ["punct", "]", 20],
    ["punct", "}", 21],
  ]);
});

test("string content split across pushes arrives as concatenable fragments", () => {
  const { calls } = lex(['"hel', "lo wo", 'rld"']);
  const chunks = calls.filter((c) => c[0] === "stringChunk").map((c) => c[1]);
  assert.deepEqual(chunks, ["hel", "lo wo", "rld"]);
  assert.equal(calls.at(-1)[0], "stringEnd");
});

test("an escape split at the backslash decodes correctly", () => {
  const { calls } = lex(['"a\\', 'nb"']);
  const text = calls.filter((c) => c[0] === "stringChunk").map((c) => c[1]).join("");
  assert.equal(text, "a\nb");
});

test("a \\u escape split across three pushes decodes correctly", () => {
  const { calls } = lex(['"x\\u', "00", 'e9!"']);
  const text = calls.filter((c) => c[0] === "stringChunk").map((c) => c[1]).join("");
  assert.equal(text, "xé!");
});

test("a surrogate pair written as two \\u escapes decodes to one astral character", () => {
  const { calls } = lex(['"\\uD83D\\uDE00"']);
  const text = calls.filter((c) => c[0] === "stringChunk").map((c) => c[1]).join("");
  assert.equal(text, "\u{1F600}");
  assert.equal([...text].length, 1);
});

test("a number is held at a chunk boundary until a delimiter proves it finished", () => {
  const sink = recordingSink();
  const lexer = new Lexer(sink);
  lexer.push("[12");
  // No number yet: "12" might still grow into "123".
  assert.deepEqual(sink.calls.filter((c) => c[0] === "number"), []);
  lexer.push("3]");
  assert.deepEqual(sink.calls.filter((c) => c[0] === "number"), [["number", 123, "123", 1]]);
});

test("end() settles a trailing number that is valid as it stands", () => {
  const { calls } = lex(["-12.5e3"]);
  assert.deepEqual(calls, [["number", -12500, "-12.5e3", 0]]);
});

test("end() keeps an unfinished number pending, with its longest valid prefix", () => {
  const { lexer, calls } = lex(["12.5e"]);
  assert.deepEqual(calls, []);
  assert.deepEqual(lexer.pending(), { kind: "number", raw: "12.5e", start: 0, validPrefix: "12.5" });
});

test("a bare minus has no valid prefix", () => {
  const { lexer } = lex(["-"]);
  assert.deepEqual(lexer.pending(), { kind: "number", raw: "-", start: 0, validPrefix: "" });
});

test("a literal split across pushes is emitted once complete", () => {
  const { calls } = lex(["tr", "u", "e"]);
  assert.deepEqual(calls, [["literal", true, "true", 0]]);
});

test("an unfinished literal stays pending with the word it must become", () => {
  const { lexer, calls } = lex(["fal"]);
  assert.deepEqual(calls, []);
  assert.deepEqual(lexer.pending(), { kind: "literal", raw: "fal", start: 0, word: "false" });
});

test("a wrong literal continuation fails with code bad-token", () => {
  assert.throws(() => lex(["trux"]), (err) => err instanceof DripError && err.code === "bad-token");
});

test("leading zeros are rejected as in strict JSON", () => {
  assert.throws(() => lex(["01"]), (err) => err.code === "bad-number" && err.offset === 1);
});

test("malformed number bodies fail at the offending character", () => {
  assert.throws(() => lex(["1.."]), (err) => err.code === "bad-number" && err.offset === 2);
  assert.throws(() => lex(["1e+ "]), (err) => err.code === "bad-number");
  assert.throws(() => lex(["1.e3"]), (err) => err.code === "bad-number");
});

test("invalid escapes and bad \\u digits fail with position", () => {
  assert.throws(() => lex(['"\\q"']), (err) => err.code === "bad-escape" && err.offset === 2);
  assert.throws(() => lex(['"\\u12G4"']), (err) => err.code === "bad-unicode-escape");
});

test("raw control characters in strings are rejected", () => {
  assert.throws(() => lex(['"a\tb"']), (err) => err.code === "control-char");
  assert.throws(() => lex(['"a\nb"']), (err) => err.code === "control-char");
});

test("unexpected characters report 1-based line and column across newlines", () => {
  assert.throws(
    () => lex(["[1,\n  x]"]),
    (err) => err.code === "unexpected-char" && err.offset === 6 && err.line === 2 && err.column === 3,
  );
});

test("escapeStart tracks the backslash of a torn escape and clears on completion", () => {
  const sink = recordingSink();
  const lexer = new Lexer(sink);
  lexer.push('"ab\\u0');
  assert.equal(lexer.escapeStart, 3);
  assert.equal(lexer.stringIsOpen, true);
  const lexer2 = new Lexer(recordingSink());
  lexer2.push('"ab\\u00e9');
  assert.equal(lexer2.escapeStart, -1);
  assert.equal(lexer2.stringIsOpen, true);
});
