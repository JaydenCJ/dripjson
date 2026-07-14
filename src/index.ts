/**
 * dripjson — incremental parser for streaming, partial JSON with typed
 * events and best-effort completion.
 *
 * Three entry points, smallest first:
 *
 *   parsePartial(text)      one call: best-effort value + completeness flag
 *   complete(text)          repair a truncated prefix into valid JSON text
 *   new DripParser(opts)    the streaming engine: push chunks, get events
 */

import { DripParser } from "./parser.js";
import type { DripOptions, SnapshotOptions } from "./types.js";

export { DripParser } from "./parser.js";
export { complete, assemble } from "./complete.js";
export { DripError, type DripErrorCode } from "./errors.js";
export { pathToPointer, escapePointerSegment } from "./pointer.js";
export { VERSION } from "./version.js";
export type {
  CompletionInfo,
  CompletionResult,
  DripEvent,
  DripOptions,
  DripStatus,
  JsonPrimitive,
  Path,
  PathSegment,
  PendingKind,
  Repair,
  SnapshotOptions,
} from "./types.js";

/** Options for {@link parsePartial}: snapshot policies plus `maxDepth`. */
export type ParsePartialOptions = SnapshotOptions & Pick<DripOptions, "maxDepth">;

/**
 * Parse a possibly-truncated JSON document in one call.
 *
 * Returns the best-effort value (`undefined` for empty input) and whether
 * the document was actually complete. Throws DripError on corrupt input —
 * truncation is recovered, invalid JSON is not.
 */
export function parsePartial(
  text: string,
  options: ParsePartialOptions = {},
): { value: unknown; complete: boolean } {
  const parser = new DripParser({ maxDepth: options.maxDepth });
  parser.push(text);
  parser.end();
  return { value: parser.snapshot(options), complete: parser.status().done };
}
