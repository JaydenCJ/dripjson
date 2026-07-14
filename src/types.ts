/**
 * Public types for dripjson: paths, events, options and results.
 *
 * The whole library speaks in these shapes; nothing here depends on Node.js,
 * so the types (and the parser behind them) work in any ES2022 runtime.
 */

/** A completed JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;

/** One step into a document: an object key or an array index. */
export type PathSegment = string | number;

/** Where a node lives, from the root down. `[]` is the root itself. */
export type Path = PathSegment[];

/** Options accepted by {@link DripParser}. */
export interface DripOptions {
  /**
   * Emit a `delta` event for every fragment of a string *value* as it
   * arrives, before the final `value` event. Off by default because most
   * consumers only want settled values; turn it on to stream text fields
   * (e.g. a model's `"content"`) character-for-character.
   */
  stringDeltas?: boolean;
  /** Maximum container nesting before parsing fails. Default 1000. */
  maxDepth?: number;
}

/** Policies for how {@link DripParser.snapshot} treats unfinished input. */
export interface SnapshotOptions {
  /**
   * A number cut off mid-token (`"12."`, `"3e"`): `"trim"` keeps the longest
   * valid numeric prefix (`12`, `3`), `"omit"` drops the value. Default `"trim"`.
   */
  onPartialNumber?: "trim" | "omit";
  /**
   * A literal cut off mid-word (`tru`, `fal`, `n`): `"resolve"` completes it —
   * every prefix is unambiguous — `"omit"` drops it. Default `"resolve"`.
   */
  onPartialLiteral?: "resolve" | "omit";
  /**
   * An object key parsed completely but whose value never arrived:
   * `"omit"` drops the key, `"null"` keeps it with a `null` value.
   * Default `"omit"`. Keys cut off mid-string are always dropped.
   */
  onDanglingKey?: "omit" | "null";
}

/**
 * The typed event stream. Events are emitted eagerly, as soon as the input
 * settles them — a later syntax error does not retract earlier events.
 */
export type DripEvent =
  | { type: "openObject"; path: Path }
  | { type: "closeObject"; path: Path }
  | { type: "openArray"; path: Path }
  | { type: "closeArray"; path: Path }
  /** A key completed inside an object. `path` addresses the value it introduces. */
  | { type: "key"; path: Path; key: string }
  /** A fragment of an in-progress string value (only with `stringDeltas`). */
  | { type: "delta"; path: Path; text: string }
  /** A scalar completed. For strings, `value` is the full decoded string. */
  | { type: "value"; path: Path; value: JsonPrimitive }
  /** The root value completed. Fires exactly once, even before `end()`. */
  | { type: "done"; value: unknown };

/** What the parser is in the middle of, if anything. */
export type PendingKind =
  | "none"
  | "key-string"
  | "value-string"
  | "dangling-key"
  | "number"
  | "literal";

/** A point-in-time report from {@link DripParser.status}. */
export interface DripStatus {
  /** True once the root value is complete. */
  done: boolean;
  /** True once any non-whitespace input has been consumed. */
  started: boolean;
  /** Current container nesting depth. */
  depth: number;
  /** The brackets that would close every open container, innermost first. */
  closers: string;
  /** UTF-16 code units consumed so far. */
  consumed: number;
  /** 1-based position of the next character. */
  line: number;
  column: number;
  /** The construct currently left hanging by the input. */
  pending: PendingKind;
}

/** One edit {@link complete} applied to turn a prefix into valid JSON. */
export interface Repair {
  kind:
    | "closed-string"
    | "dropped-incomplete-escape"
    | "completed-literal"
    | "trimmed-number"
    | "dropped-partial-value"
    | "dropped-dangling-key"
    | "dropped-partial-key"
    | "removed-trailing-comma"
    | "closed-containers"
    | "empty-input";
  /** Human-oriented specifics, e.g. the brackets appended or the word completed. */
  detail?: string;
}

/** The result of {@link complete}. */
export interface CompletionResult {
  /** Valid JSON text: the input, minimally cut and closed. */
  text: string;
  /** True when the input was already a complete document (no repairs). */
  complete: boolean;
  /** Every edit applied, in the order applied. Empty when `complete`. */
  repairs: Repair[];
}

/**
 * Low-level completion state, for callers that keep their own input buffer
 * and want to assemble repaired text themselves (see docs/recovery-rules.md).
 */
export interface CompletionInfo {
  done: boolean;
  started: boolean;
  /** Offset after the last point the document can be closed by appending only. */
  safeCut: number;
  /** Brackets that close every open container, innermost first. */
  closers: string;
  /** True while inside a string in value position. */
  inValueString: boolean;
  /** True while inside a string in key position. */
  inKeyString: boolean;
  /** When `inValueString`: cut here, then append `"` (excludes a torn escape). */
  stringCut: number;
  /** When `inValueString`: true if `stringCut` drops a torn `\` escape. */
  escapeDropped: boolean;
  /** A number token cut off by end of input, with its longest valid prefix. */
  pendingNumber: { start: number; raw: string; validPrefix: string } | null;
  /** A literal cut off by end of input, with the word it must become. */
  pendingLiteral: { raw: string; word: "true" | "false" | "null" } | null;
  /** True when a complete key is still waiting for its value. */
  danglingKey: boolean;
  /** True when the last significant character was a separating comma. */
  afterComma: boolean;
}
