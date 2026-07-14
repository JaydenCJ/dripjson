/**
 * Snapshot policies: how unfinished tokens become best-effort values.
 *
 * The parser owns the partially-built tree; this module owns the judgment
 * calls — what a half-written number, literal or key is worth. Policies are
 * deliberately conservative defaults with explicit opt-outs, and the exact
 * same rules drive `complete()`, so a snapshot and a completed text never
 * disagree about the data.
 */

import type { PendingToken } from "./lexer.js";
import type { JsonPrimitive, SnapshotOptions } from "./types.js";

export interface ResolvedSnapshotOptions {
  onPartialNumber: "trim" | "omit";
  onPartialLiteral: "resolve" | "omit";
  onDanglingKey: "omit" | "null";
}

export function resolveSnapshotOptions(options: SnapshotOptions = {}): ResolvedSnapshotOptions {
  return {
    onPartialNumber: options.onPartialNumber ?? "trim",
    onPartialLiteral: options.onPartialLiteral ?? "resolve",
    onDanglingKey: options.onDanglingKey ?? "omit",
  };
}

/** The literal a prefix must become — first letters differ, so any prefix is unambiguous. */
export function resolveLiteral(word: "true" | "false" | "null"): JsonPrimitive {
  return word === "true" ? true : word === "false" ? false : null;
}

/**
 * Apply the pending-token policy. Returns `has: false` when the token should
 * be omitted (policy says so, or nothing salvageable — e.g. a lone `-`).
 */
export function resolvePending(
  pending: PendingToken | null,
  opts: ResolvedSnapshotOptions,
): { has: boolean; value: JsonPrimitive } {
  if (pending === null) return { has: false, value: null };
  if (pending.kind === "number") {
    if (opts.onPartialNumber === "omit" || pending.validPrefix === "") {
      return { has: false, value: null };
    }
    return { has: true, value: Number(pending.validPrefix) };
  }
  if (opts.onPartialLiteral === "omit") return { has: false, value: null };
  return { has: true, value: resolveLiteral(pending.word) };
}

/**
 * Deep-copy a JSON-shaped value. Snapshots must not alias the parser's
 * internal tree: the parser keeps mutating it, and callers may mutate the
 * snapshot. Only plain objects, arrays and primitives ever occur here.
 */
export function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneJson(v);
    return out;
  }
  return value;
}
