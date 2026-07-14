/**
 * Incremental JSON tokenizer.
 *
 * The lexer accepts input in arbitrary chunks and never requires a token to
 * fit in one chunk: strings, escapes (including `\uXXXX` split anywhere),
 * numbers and literals may straddle any boundary. Numbers and literals are
 * open-ended tokens, so they are held until a delimiter or `end()` proves
 * them finished; strings stream out as decoded fragments.
 *
 * The lexer knows nothing about grammar — it reports tokens to a
 * {@link LexerSink} (the parser) and exposes just enough position state for
 * best-effort completion (`pending()`, `escapeStart`, `stringIsOpen`).
 */

import { DripError } from "./errors.js";

export type Punct = "{" | "}" | "[" | "]" | ":" | ",";

/** Where tokens go. Offsets are 0-based over the whole stream. */
export interface LexerSink {
  punct(ch: Punct, offset: number): void;
  stringStart(offset: number): void;
  /** A decoded fragment of the current string; fragments concatenate. */
  stringChunk(text: string): void;
  /** The current string closed; `offset` is the closing quote. */
  stringEnd(offset: number): void;
  /** A complete number token. `start` is the offset of its first character. */
  number(value: number, raw: string, start: number): void;
  literal(value: true | false | null, raw: string, start: number): void;
}

/** A token cut off by the end of input, recoverable by policy. */
export type PendingToken =
  | { kind: "number"; raw: string; start: number; validPrefix: string }
  | { kind: "literal"; raw: string; start: number; word: "true" | "false" | "null" };

type Mode = "ws" | "string" | "escape" | "unicode" | "number" | "literal";

/** States of the JSON number grammar. */
type NumState = "sign" | "intZero" | "int" | "dot" | "frac" | "e" | "eSign" | "exp";

/** States in which the raw text so far is a complete, valid JSON number. */
const NUM_FINAL: ReadonlySet<NumState> = new Set(["intZero", "int", "frac", "exp"]);

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isHex(c: string): boolean {
  return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

/**
 * One character of the number grammar. Returns the next state, or null when
 * `c` cannot legally extend a number in `state` (an error, not a delimiter —
 * delimiters never reach this function).
 */
function nextNumState(state: NumState, c: string): NumState | null {
  switch (state) {
    case "sign":
      if (c === "0") return "intZero";
      if (isDigit(c)) return "int";
      return null;
    case "intZero":
      if (c === ".") return "dot";
      if (c === "e" || c === "E") return "e";
      return null; // "01" — leading zeros are invalid JSON
    case "int":
      if (isDigit(c)) return "int";
      if (c === ".") return "dot";
      if (c === "e" || c === "E") return "e";
      return null;
    case "dot":
      return isDigit(c) ? "frac" : null;
    case "frac":
      if (isDigit(c)) return "frac";
      if (c === "e" || c === "E") return "e";
      return null;
    case "e":
      if (c === "+" || c === "-") return "eSign";
      return isDigit(c) ? "exp" : null;
    case "eSign":
      return isDigit(c) ? "exp" : null;
    case "exp":
      return isDigit(c) ? "exp" : null;
  }
}

export class Lexer {
  /** UTF-16 code units consumed across all pushes. */
  offset = 0;
  /** 1-based position of the next character. */
  line = 1;
  column = 1;

  private mode: Mode = "ws";
  private acc = ""; // decoded string content accumulated within the current push
  private numRaw = "";
  private numStart = 0;
  private numState: NumState = "sign";
  private numValidLen = 0; // length of the longest valid-number prefix of numRaw
  private litRaw = "";
  private litStart = 0;
  private litWord: "true" | "false" | "null" = "true";
  private hex = "";
  private escStart = -1; // offset of the `\` of an in-progress escape
  private ended = false;

  constructor(private readonly sink: LexerSink) {}

  /** True while inside a string (including inside an escape sequence). */
  get stringIsOpen(): boolean {
    return this.mode === "string" || this.mode === "escape" || this.mode === "unicode";
  }

  /** Offset of the `\` of a torn escape, or -1 when no escape is open. */
  get escapeStart(): number {
    return this.escStart;
  }

  push(chunk: string): void {
    if (this.ended) throw new Error("dripjson: push() after end()");
    for (let i = 0; i < chunk.length; i++) {
      this.step(chunk.charAt(i));
    }
    this.flushChunk();
  }

  /**
   * Declare the input finished. A pending number that is valid as it stands
   * is emitted (a document like `42` only settles here); a pending token
   * that is *not* a complete value stays reported by `pending()` so
   * snapshot/completion policies can decide what to do with it.
   */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.mode === "number" && NUM_FINAL.has(this.numState)) {
      this.sink.number(Number(this.numRaw), this.numRaw, this.numStart);
      this.mode = "ws";
      this.numRaw = "";
    }
  }

  /** The token cut off by the current end of input, if any. */
  pending(): PendingToken | null {
    if (this.mode === "number") {
      return {
        kind: "number",
        raw: this.numRaw,
        start: this.numStart,
        validPrefix: this.numRaw.slice(0, this.numValidLen),
      };
    }
    if (this.mode === "literal") {
      return { kind: "literal", raw: this.litRaw, start: this.litStart, word: this.litWord };
    }
    return null;
  }

  private fail(code: DripError["code"], message: string): never {
    throw new DripError(code, message, this.offset, this.line, this.column);
  }

  /** Emit accumulated string content as one fragment. */
  private flushChunk(): void {
    if (this.acc !== "" && this.stringIsOpen) {
      this.sink.stringChunk(this.acc);
      this.acc = "";
    }
  }

  private advance(c: string): void {
    this.offset += 1;
    if (c === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
  }

  private step(c: string): void {
    switch (this.mode) {
      case "ws":
        this.stepWs(c);
        break;
      case "string":
        this.stepString(c);
        break;
      case "escape":
        this.stepEscape(c);
        break;
      case "unicode":
        this.stepUnicode(c);
        break;
      case "number":
        this.stepNumber(c);
        return; // stepNumber advances (or re-dispatches) itself
      case "literal":
        this.stepLiteral(c);
        break;
    }
    this.advance(c);
  }

  private stepWs(c: string): void {
    if (c === " " || c === "\t" || c === "\n" || c === "\r") return;
    if (c === "{" || c === "}" || c === "[" || c === "]" || c === ":" || c === ",") {
      this.sink.punct(c, this.offset);
      return;
    }
    if (c === '"') {
      this.sink.stringStart(this.offset);
      this.mode = "string";
      this.acc = "";
      return;
    }
    if (c === "-" || isDigit(c)) {
      this.mode = "number";
      this.numStart = this.offset;
      this.numRaw = c;
      this.numState = c === "-" ? "sign" : c === "0" ? "intZero" : "int";
      this.numValidLen = NUM_FINAL.has(this.numState) ? 1 : 0;
      return;
    }
    if (c === "t" || c === "f" || c === "n") {
      this.mode = "literal";
      this.litStart = this.offset;
      this.litRaw = c;
      this.litWord = c === "t" ? "true" : c === "f" ? "false" : "null";
      return;
    }
    this.fail("unexpected-char", `unexpected character ${JSON.stringify(c)}`);
  }

  private stepString(c: string): void {
    if (c === '"') {
      this.flushChunk();
      this.sink.stringEnd(this.offset);
      this.mode = "ws";
      return;
    }
    if (c === "\\") {
      this.mode = "escape";
      this.escStart = this.offset;
      return;
    }
    if (c < " ") {
      this.fail("control-char", "raw control character in string (use \\u escapes)");
    }
    this.acc += c;
  }

  private stepEscape(c: string): void {
    const mapped = ESCAPES[c];
    if (mapped !== undefined) {
      this.acc += mapped;
      this.mode = "string";
      this.escStart = -1;
      return;
    }
    if (c === "u") {
      this.mode = "unicode";
      this.hex = "";
      return;
    }
    this.fail("bad-escape", `invalid escape \\${c}`);
  }

  private stepUnicode(c: string): void {
    if (!isHex(c)) {
      this.fail("bad-unicode-escape", `invalid \\u escape digit ${JSON.stringify(c)}`);
    }
    this.hex += c;
    if (this.hex.length === 4) {
      // Surrogate halves concatenate naturally in UTF-16; a pair of \u
      // escapes therefore decodes to the astral character it encodes.
      this.acc += String.fromCharCode(parseInt(this.hex, 16));
      this.mode = "string";
      this.escStart = -1;
    }
  }

  private stepNumber(c: string): void {
    if (isDigit(c) || c === "." || c === "e" || c === "E" || c === "+" || c === "-") {
      const next = nextNumState(this.numState, c);
      if (next === null) {
        this.fail("bad-number", `invalid number ${JSON.stringify(this.numRaw + c)}`);
      }
      this.numRaw += c;
      this.numState = next;
      if (NUM_FINAL.has(next)) this.numValidLen = this.numRaw.length;
      this.advance(c);
      return;
    }
    // Any other character terminates the number; it must be complete here.
    if (!NUM_FINAL.has(this.numState)) {
      this.fail("bad-number", `incomplete number ${JSON.stringify(this.numRaw)}`);
    }
    this.sink.number(Number(this.numRaw), this.numRaw, this.numStart);
    this.mode = "ws";
    this.numRaw = "";
    this.step(c); // re-dispatch the delimiter in whitespace mode
  }

  private stepLiteral(c: string): void {
    if (c !== this.litWord.charAt(this.litRaw.length)) {
      this.fail("bad-token", `invalid token ${JSON.stringify(this.litRaw + c)}`);
    }
    this.litRaw += c;
    if (this.litRaw.length === this.litWord.length) {
      const value = this.litWord === "true" ? true : this.litWord === "false" ? false : null;
      this.sink.literal(value, this.litWord, this.litStart);
      this.mode = "ws";
      this.litRaw = "";
    }
  }
}
