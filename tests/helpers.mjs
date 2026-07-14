// Shared test helpers: a sink recorder for the lexer, parser drivers and a
// runner for the built CLI. Everything is deterministic — no clocks, no
// randomness, no network; CLI tests run the compiled dist/cli.js as a child
// process, exactly like a user would.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DripParser } from "../dist/index.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Parse `text` in one push (+ end) and return every event. */
export function eventsOf(text, options) {
  const parser = new DripParser(options);
  return [...parser.push(text), ...parser.end()];
}

/** Parse `text` fully and return the parser for snapshot/status inspection. */
export function parserFor(text, options) {
  const parser = new DripParser(options);
  parser.push(text);
  parser.end();
  return parser;
}

/** Feed `text` in fixed-size chunks; returns { parser, events }. */
export function pushChunked(text, size, options) {
  const parser = new DripParser(options);
  const events = [];
  for (let i = 0; i < text.length; i += size) {
    events.push(...parser.push(text.slice(i, i + size)));
  }
  events.push(...parser.end());
  return { parser, events };
}

/** A lexer sink that records every callback as a plain tuple. */
export function recordingSink() {
  const calls = [];
  return {
    calls,
    punct: (ch, offset) => calls.push(["punct", ch, offset]),
    stringStart: (offset) => calls.push(["stringStart", offset]),
    stringChunk: (text) => calls.push(["stringChunk", text]),
    stringEnd: (offset) => calls.push(["stringEnd", offset]),
    number: (value, raw, start) => calls.push(["number", value, raw, start]),
    literal: (value, raw, start) => calls.push(["literal", value, raw, start]),
  };
}

/**
 * Run the built CLI with the given argv (and optional stdin), returning
 * { status, stdout, stderr }.
 */
export function runCli(argv, stdin) {
  const result = spawnSync(process.execPath, [join(ROOT, "dist", "cli.js"), ...argv], {
    cwd: ROOT,
    encoding: "utf8",
    input: stdin,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
