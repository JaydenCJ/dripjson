#!/usr/bin/env node
/**
 * The dripjson CLI: the library's four verbs over files or stdin.
 *
 *   complete   repair a truncated document into valid JSON text
 *   snapshot   print the best-effort parsed value
 *   events     print the typed event stream as NDJSON
 *   status     report completeness (the scriptable gate: exit 1 = partial)
 *
 * Everything here is argument plumbing; all behavior lives in the library.
 * Exit codes: 0 success/complete · 1 partial (status) · 2 usage or bad JSON.
 */

import { readFileSync } from "node:fs";

import { complete } from "./complete.js";
import { DripError } from "./errors.js";
import { DripParser } from "./parser.js";
import type { DripEvent, SnapshotOptions } from "./types.js";
import { VERSION } from "./version.js";

const USAGE = `dripjson ${VERSION} — incremental parser for streaming, partial JSON

Usage: dripjson <command> [file] [options]

Reads JSON — possibly a truncated streaming prefix — from FILE, or from
stdin when FILE is "-" or omitted.

Commands:
  complete     print the input repaired into valid JSON
  snapshot     print the best-effort parsed value as JSON
  events       print the typed event stream as NDJSON
  status       report completeness; exits 1 if the document is partial

Options:
  --json        machine-readable output (complete, status)
  --pretty      pretty-print with two-space indent (snapshot)
  --chunk <n>   feed the input in n-character chunks (events)
  --deltas      include string delta events (events)
  --no-resolve  drop partial numbers/literals instead of resolving (snapshot)
  -h, --help    show this help
  -v, --version print the version

Exit codes: 0 success/complete · 1 partial (status) · 2 usage or invalid JSON`;

interface Args {
  command: string;
  file: string | null;
  json: boolean;
  pretty: boolean;
  deltas: boolean;
  noResolve: boolean;
  chunk: number;
  /** Option flags as written, for per-command validation. */
  given: string[];
}

/** Which options each command accepts — mirrors the annotations in USAGE. */
const ALLOWED_OPTIONS: Record<string, ReadonlySet<string>> = {
  complete: new Set(["--json"]),
  snapshot: new Set(["--pretty", "--no-resolve"]),
  events: new Set(["--chunk", "--deltas"]),
  status: new Set(["--json"]),
};

function usageError(message: string): never {
  process.stderr.write(`dripjson: ${message}\nRun "dripjson --help" for usage.\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "",
    file: null,
    json: false,
    pretty: false,
    deltas: false,
    noResolve: false,
    chunk: 0,
    given: [],
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE + "\n");
      process.exit(0);
    } else if (a === "-v" || a === "--version") {
      process.stdout.write(VERSION + "\n");
      process.exit(0);
    } else if (a === "--json") {
      args.json = true;
      args.given.push(a);
    } else if (a === "--pretty") {
      args.pretty = true;
      args.given.push(a);
    } else if (a === "--deltas") {
      args.deltas = true;
      args.given.push(a);
    } else if (a === "--no-resolve") {
      args.noResolve = true;
      args.given.push(a);
    } else if (a === "--chunk") {
      const raw = argv[++i];
      const n = raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(n) || n < 1) usageError("--chunk expects a positive integer");
      args.chunk = n;
      args.given.push(a);
    } else if (a === "-") positional.push(a);
    else if (a.startsWith("-")) usageError(`unknown option "${a}"`);
    else positional.push(a);
  }
  if (positional.length === 0) usageError("missing command");
  if (positional.length > 2) usageError(`unexpected argument "${positional[2]}"`);
  args.command = positional[0] as string;
  args.file = positional.length > 1 && positional[1] !== "-" ? (positional[1] as string) : null;
  return args;
}

function readInput(file: string | null): string {
  try {
    return readFileSync(file ?? 0, "utf8");
  } catch (err) {
    usageError(`cannot read ${file ?? "stdin"}: ${(err as Error).message}`);
  }
}

function snapshotOptions(args: Args): SnapshotOptions {
  return args.noResolve ? { onPartialNumber: "omit", onPartialLiteral: "omit" } : {};
}

function cmdComplete(args: Args, text: string): number {
  const result = complete(text);
  if (args.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write(result.text + "\n");
    for (const r of result.repairs) {
      process.stderr.write(`repair: ${r.kind}${r.detail !== undefined ? ` (${r.detail})` : ""}\n`);
    }
  }
  return 0;
}

function cmdSnapshot(args: Args, text: string): number {
  const parser = new DripParser();
  parser.push(text);
  parser.end();
  const value = parser.snapshot(snapshotOptions(args));
  if (value === undefined) {
    process.stderr.write("dripjson: no value (empty input)\n");
    return 1;
  }
  process.stdout.write(JSON.stringify(value, null, args.pretty ? 2 : undefined) + "\n");
  return 0;
}

function cmdEvents(args: Args, text: string): number {
  const parser = new DripParser({ stringDeltas: args.deltas });
  const events: DripEvent[] = [];
  const size = args.chunk > 0 ? args.chunk : Math.max(text.length, 1);
  for (let i = 0; i < text.length; i += size) {
    events.push(...parser.push(text.slice(i, i + size)));
  }
  events.push(...parser.end());
  for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
  return 0;
}

function cmdStatus(args: Args, text: string): number {
  const parser = new DripParser();
  parser.push(text);
  parser.end();
  const status = parser.status();
  const consumed = `consumed ${status.consumed} char${status.consumed === 1 ? "" : "s"}`;
  if (args.json) {
    process.stdout.write(JSON.stringify(status) + "\n");
  } else if (status.done) {
    process.stdout.write(`complete · ${consumed}\n`);
  } else {
    const open = status.closers === "" ? "nothing" : JSON.stringify(status.closers);
    process.stdout.write(
      `partial · depth ${status.depth} · open ${open} · pending ${status.pending} · ${consumed}\n`,
    );
  }
  return status.done ? 0 : 1;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const commands: Record<string, (a: Args, text: string) => number> = {
    complete: cmdComplete,
    snapshot: cmdSnapshot,
    events: cmdEvents,
    status: cmdStatus,
  };
  const run = commands[args.command];
  if (run === undefined) usageError(`unknown command "${args.command}"`);
  const allowed = ALLOWED_OPTIONS[args.command] as ReadonlySet<string>;
  for (const flag of args.given) {
    if (!allowed.has(flag)) {
      usageError(`${flag} does not apply to "${args.command}"`);
    }
  }
  const text = readInput(args.file);
  try {
    process.exit(run(args, text));
  } catch (err) {
    if (err instanceof DripError) {
      process.stderr.write(`dripjson: invalid JSON: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}

main();
