/**
 * DripError: the single error type thrown for malformed input.
 *
 * dripjson recovers from *truncation* — a valid document cut off anywhere —
 * but it does not guess around *corruption*. Anything that no completion
 * could make valid (a stray character, a bad escape, `[1,]`, trailing
 * content after the root value) throws a DripError with an exact position.
 */

export type DripErrorCode =
  | "unexpected-char"
  | "unexpected-token"
  | "bad-escape"
  | "bad-unicode-escape"
  | "bad-number"
  | "bad-token"
  | "control-char"
  | "trailing-content"
  | "max-depth";

export class DripError extends Error {
  /** Machine-readable category, stable across releases. */
  readonly code: DripErrorCode;
  /** 0-based UTF-16 offset in the full stream where the problem was detected. */
  readonly offset: number;
  /** 1-based line of the detection point. */
  readonly line: number;
  /** 1-based column of the detection point. */
  readonly column: number;

  constructor(code: DripErrorCode, message: string, offset: number, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = "DripError";
    this.code = code;
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}
