// CLI integration: the built dist/cli.js run as a child process against the
// committed example files and inline stdin — commands, flags, exit codes
// (0 ok/complete · 1 partial · 2 usage or invalid JSON) and output shapes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { VERSION } from "../dist/index.js";
import { ROOT, runCli } from "./helpers.mjs";

const TOOLCALL = "examples/tool-call.partial.json";
const INCIDENT = "examples/incident.partial.json";

test("--version matches package.json and the library constant; --help documents every command, option and the exit-code contract", () => {
  const v = runCli(["--version"]);
  assert.equal(v.status, 0);
  assert.equal(v.stdout.trim(), VERSION);
  assert.equal(
    v.stdout.trim(),
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
  );
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  for (const word of ["complete", "snapshot", "events", "status", "--chunk", "--deltas", "--no-resolve", "Exit codes"]) {
    assert.ok(r.stdout.includes(word), `help missing ${word}`);
  }
});

test("usage errors all exit 2: no command, unknown command, unknown flag, bad --chunk, missing file", () => {
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(["frobnicate", TOOLCALL]).status, 2);
  assert.equal(runCli(["snapshot", TOOLCALL, "--frobnicate"]).status, 2);
  assert.equal(runCli(["events", TOOLCALL, "--chunk", "0"]).status, 2);
  assert.equal(runCli(["events", TOOLCALL, "--chunk", "x"]).status, 2);
  const missing = runCli(["snapshot", "does-not-exist.json"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read/);
});

test("complete repairs the truncated tool call into JSON that parses", () => {
  const r = runCli(["complete", TOOLCALL]);
  assert.equal(r.status, 0);
  const value = JSON.parse(r.stdout);
  assert.equal(value.arguments.filters.cabin, "premium");
  assert.match(r.stderr, /repair: closed-string/);
  assert.match(r.stderr, /repair: closed-containers \(\}\}\}\)/);
});

test("complete --json reports the text, completeness and typed repairs", () => {
  const r = runCli(["complete", TOOLCALL, "--json"]);
  assert.equal(r.status, 0);
  const result = JSON.parse(r.stdout);
  assert.equal(result.complete, false);
  assert.deepEqual(result.repairs.map((x) => x.kind), ["closed-string", "closed-containers"]);
  assert.doesNotThrow(() => JSON.parse(result.text));
});

test("complete echoes an already-complete document and repairs nothing", () => {
  const r = runCli(["complete", "-"], '{"done": true}\n');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{"done": true}\n\n');
  assert.equal(r.stderr, "");
});

test("snapshot resolves the truncated literal in the incident example", () => {
  const r = runCli(["snapshot", INCIDENT]);
  assert.equal(r.status, 0);
  const value = JSON.parse(r.stdout);
  assert.equal(value.acknowledged, false); // `fal` resolved
  assert.equal(value.metrics.p99_ms, 840);
});

test("snapshot --no-resolve drops the partial literal (and its key) instead", () => {
  const r = runCli(["snapshot", INCIDENT, "--no-resolve"]);
  assert.equal(r.status, 0);
  assert.ok(!("acknowledged" in JSON.parse(r.stdout)));
});

test("snapshot --pretty indents with two spaces", () => {
  const r = runCli(["snapshot", INCIDENT, "--pretty"]);
  assert.match(r.stdout, /^\{\n  "incident": "checkout-latency",\n/);
});

test("snapshot of empty input exits 1 with a note on stderr", () => {
  const r = runCli(["snapshot", "-"], "");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no value/);
});

test("events prints one JSON event per line, ending in done for complete input", () => {
  const r = runCli(["events", "-"], '{"a": [1, 2]}');
  assert.equal(r.status, 0);
  const events = r.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((e) => e.type), [
    "openObject", "key", "openArray", "value", "value", "closeArray", "closeObject", "done",
  ]);
  assert.deepEqual(events.at(-1).value, { a: [1, 2] });
});

test("events --chunk and --deltas stream string fragments", () => {
  const r = runCli(["events", TOOLCALL, "--chunk", "7", "--deltas"]);
  assert.equal(r.status, 0);
  const events = r.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const deltas = events.filter((e) => e.type === "delta" && e.path.join(".") === "name");
  assert.ok(deltas.length > 1, "expected the name to arrive in several deltas");
  assert.equal(deltas.map((d) => d.text).join(""), "search_flights");
  // Chunking must not change what settles.
  const whole = runCli(["events", TOOLCALL]);
  const settled = (out) =>
    out.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type !== "delta");
  assert.deepEqual(settled(r.stdout), settled(whole.stdout));
});

test("status is the scriptable gate: exit 1 and a summary for partial input", () => {
  const r = runCli(["status", TOOLCALL]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^partial · depth 3 · open "\}\}\}" · pending value-string/);
  const ok = runCli(["status", "-"], '{"a": 1}');
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^complete · consumed 8 chars/);
  // A single consumed character reads "1 char", not "1 chars".
  const one = runCli(["status", "-"], "5");
  assert.equal(one.status, 0);
  assert.match(one.stdout, /^complete · consumed 1 char\n$/);
});

test("options are validated per command: a flag on the wrong command exits 2 with a pointer", () => {
  // --help annotates every option with the commands it applies to; the
  // parser must enforce that instead of silently ignoring the flag.
  const r = runCli(["complete", TOOLCALL, "--pretty"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--pretty does not apply to "complete"/);
  assert.match(r.stderr, /--help/);
  assert.equal(runCli(["snapshot", INCIDENT, "--chunk", "3"]).status, 2);
  assert.equal(runCli(["status", TOOLCALL, "--deltas"]).status, 2);
  assert.equal(runCli(["events", TOOLCALL, "--json"]).status, 2);
});

test("status --json exposes the full structured status", () => {
  const r = runCli(["status", INCIDENT, "--json"]);
  assert.equal(r.status, 1);
  const status = JSON.parse(r.stdout);
  assert.equal(status.done, false);
  assert.equal(status.pending, "literal");
  assert.equal(status.closers, "}");
});

test("invalid JSON exits 2 with the position in the message", () => {
  const r = runCli(["snapshot", "-"], '{"a" 1}');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid JSON: .*line 1, column 7/);
  const r2 = runCli(["complete", "-"], "[1,]");
  assert.equal(r2.status, 2);
});

test("the committed streaming example runs and reports fields as they settle", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [join(ROOT, "examples", "streaming.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\/name = "book_meeting"/);
  assert.match(r.stdout, /\/arguments\/attendees\/1 = "kim@example\.test"/);
  assert.match(r.stdout, /document complete\n$/);
});
