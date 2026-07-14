// RFC 6901 pointer rendering: the escaping rules are tiny but easy to get
// backwards (~ must be escaped before /), so they get pinned here.
import test from "node:test";
import assert from "node:assert/strict";

import { pathToPointer, escapePointerSegment } from "../dist/index.js";

test("paths render as RFC 6901 pointers: root, nesting, escaping, edge keys", () => {
  // The empty path is the whole-document pointer.
  assert.equal(pathToPointer([]), "");
  // Keys and indexes join with slashes.
  assert.equal(pathToPointer(["choices", 0, "delta", "content"]), "/choices/0/delta/content");
  // ~ and / are escaped per the RFC, in the right order.
  assert.equal(pathToPointer(["a/b", "m~n"]), "/a~1b/m~0n");
  assert.equal(escapePointerSegment("~/"), "~0~1");
  assert.equal(escapePointerSegment("~1"), "~01"); // must NOT double-decode
  // Empty-string keys and numeric-looking keys survive.
  assert.equal(pathToPointer([""]), "/");
  assert.equal(pathToPointer(["0"]), "/0"); // same text as index 0 — as the RFC intends
});
