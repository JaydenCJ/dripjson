/**
 * DripParser: the incremental, event-emitting JSON parser.
 *
 * Feed it chunks with `push()` — any split, mid-token, mid-escape — and it
 * returns typed events for everything the new input settled. At any moment
 * `snapshot()` yields a best-effort value of the document so far, and
 * `status()`/`completionInfo()` describe exactly what is still open.
 *
 * Grammar is strict JSON (RFC 8259). Truncation is a first-class state, but
 * corruption is not: input no completion could make valid throws DripError.
 */

import { DripError } from "./errors.js";
import { Lexer, type Punct } from "./lexer.js";
import {
  cloneJson,
  resolvePending,
  resolveSnapshotOptions,
} from "./snapshot.js";
import type {
  CompletionInfo,
  DripEvent,
  DripOptions,
  DripStatus,
  JsonPrimitive,
  Path,
  PendingKind,
  SnapshotOptions,
} from "./types.js";

interface Frame {
  kind: "object" | "array";
  container: Record<string, unknown> | unknown[];
  /** Absolute path of this container within the document. */
  path: Path;
}

/** What the grammar allows next. */
type Expect =
  | "value" // a value: root start, after `:`, or after `,` in an array
  | "key" // a key string, after `,` in an object
  | "key-or-close" // right after `{`
  | "value-or-close" // right after `[`
  | "colon" // after a key
  | "comma-or-close" // after a value inside a container
  | "eof"; // after the root value

export class DripParser {
  private readonly stringDeltas: boolean;
  private readonly maxDepth: number;
  private readonly lexer: Lexer;

  private stack: Frame[] = [];
  private expect: Expect = "value";
  private root: unknown = undefined;
  private hasValue = false; // root slot written (including an in-progress string)
  private rootDone = false;
  private doneEmitted = false;
  private pendingKey: string | null = null; // complete key awaiting its value
  private strMode: "none" | "key" | "value" = "none";
  private strBuf = "";
  private strPath: Path = [];
  private strFrame: Frame | null = null; // container holding the in-progress value string
  private strSlot: string | number = 0;
  private safeCut = 0; // offset after the last append-closable point
  private events: DripEvent[] = [];
  private ended = false;

  constructor(options: DripOptions = {}) {
    this.stringDeltas = options.stringDeltas ?? false;
    this.maxDepth = options.maxDepth ?? 1000;
    this.lexer = new Lexer({
      punct: (ch, offset) => this.onPunct(ch, offset),
      stringStart: (offset) => this.onStringStart(offset),
      stringChunk: (text) => this.onStringChunk(text),
      stringEnd: (offset) => this.onStringEnd(offset),
      number: (value, raw, start) => this.onScalar(value, start, start + raw.length),
      literal: (value, raw, start) => this.onScalar(value, start, start + raw.length),
    });
  }

  /** Parse the next chunk; returns the events it settled, in order. */
  push(chunk: string): DripEvent[] {
    if (this.ended) throw new Error("dripjson: push() after end()");
    this.events = [];
    this.lexer.push(chunk);
    return this.drain();
  }

  /**
   * Declare the input finished. A trailing number that is already valid
   * settles here (`42` has no earlier proof it will not grow); a truncated
   * document does NOT throw — it simply never emits `done`.
   */
  end(): DripEvent[] {
    this.events = [];
    if (!this.ended) {
      this.ended = true;
      this.lexer.end();
    }
    return this.drain();
  }

  /** Best-effort value of the document so far. `undefined` before any value. */
  snapshot(options: SnapshotOptions = {}): unknown {
    const opts = resolveSnapshotOptions(options);
    const rootClone = cloneJson(this.root);
    const pending = resolvePending(this.lexer.pending(), opts);

    if (this.stack.length === 0) {
      if (this.hasValue) return rootClone;
      return pending.has ? pending.value : undefined;
    }

    // Walk the clone to the innermost open container, then graft on whatever
    // the input left hanging there (pending scalar, dangling key).
    let node: unknown = rootClone;
    for (let i = 1; i < this.stack.length; i++) {
      const p = (this.stack[i] as Frame).path;
      node = (node as Record<string, unknown>)[p[p.length - 1] as string];
    }
    const top = this.stack[this.stack.length - 1] as Frame;
    if (top.kind === "array") {
      if (pending.has) (node as unknown[]).push(pending.value);
    } else {
      const obj = node as Record<string, unknown>;
      if (this.pendingKey !== null) {
        if (pending.has) obj[this.pendingKey] = pending.value;
        else if (opts.onDanglingKey === "null") obj[this.pendingKey] = null;
      }
      // A key cut off mid-string (strMode === "key") is always omitted.
    }
    return rootClone;
  }

  /** A point-in-time report: completeness, depth, position, what's pending. */
  status(): DripStatus {
    return {
      done: this.rootDone,
      started: this.started(),
      depth: this.stack.length,
      closers: this.closers(),
      consumed: this.lexer.offset,
      line: this.lexer.line,
      column: this.lexer.column,
      pending: this.pendingKind(),
    };
  }

  /** Everything `complete()` needs; public for callers with their own buffer. */
  completionInfo(): CompletionInfo {
    const pending = this.lexer.pending();
    const inValueString = this.strMode === "value";
    const escStart = this.lexer.escapeStart;
    const top = this.stack[this.stack.length - 1];
    return {
      done: this.rootDone,
      started: this.started(),
      safeCut: this.safeCut,
      closers: this.closers(),
      inValueString,
      inKeyString: this.strMode === "key",
      stringCut: inValueString && escStart >= 0 ? escStart : this.lexer.offset,
      escapeDropped: inValueString && escStart >= 0,
      pendingNumber: pending?.kind === "number" ? { start: pending.start, raw: pending.raw, validPrefix: pending.validPrefix } : null,
      pendingLiteral: pending?.kind === "literal" ? { raw: pending.raw, word: pending.word } : null,
      danglingKey: this.pendingKey !== null,
      afterComma: this.expect === "key" || (this.expect === "value" && top?.kind === "array"),
    };
  }

  // ---------------------------------------------------------------- internals

  private drain(): DripEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private started(): boolean {
    return this.hasValue || this.stack.length > 0 || this.strMode !== "none" || this.lexer.pending() !== null;
  }

  private closers(): string {
    let out = "";
    for (let i = this.stack.length - 1; i >= 0; i--) {
      out += (this.stack[i] as Frame).kind === "object" ? "}" : "]";
    }
    return out;
  }

  private pendingKind(): PendingKind {
    if (this.strMode === "key") return "key-string";
    if (this.strMode === "value") return "value-string";
    const pending = this.lexer.pending();
    if (pending !== null) return pending.kind;
    if (this.pendingKey !== null) return "dangling-key";
    return "none";
  }

  /** Grammar errors report the position where the violation was detected. */
  private fail(code: DripError["code"], message: string): never {
    throw new DripError(code, message, this.lexer.offset, this.lexer.line, this.lexer.column);
  }

  private requireValue(what: string): void {
    if (this.expect === "value" || this.expect === "value-or-close") return;
    if (this.expect === "eof") {
      this.fail("trailing-content", `unexpected ${what} after the root value`);
    }
    this.fail("unexpected-token", `unexpected ${what} (expected ${this.expected()})`);
  }

  private expected(): string {
    switch (this.expect) {
      case "value": return "a value";
      case "key": return "an object key";
      case "key-or-close": return 'an object key or "}"';
      case "value-or-close": return 'a value or "]"';
      case "colon": return '":"';
      case "comma-or-close": return '"," or a closing bracket';
      case "eof": return "end of input";
    }
  }

  /**
   * Place a value in the tree and return its path. When `settled` is false
   * the value is a container or an in-progress string: it occupies its slot
   * (consuming any pending key) but does not advance the grammar yet.
   */
  private attach(value: unknown, settled: boolean): Path {
    const top = this.stack[this.stack.length - 1];
    let path: Path;
    if (top === undefined) {
      this.root = value;
      this.hasValue = true;
      path = [];
      if (settled) this.finishRoot();
    } else if (top.kind === "object") {
      const key = this.pendingKey as string; // guaranteed by the expect machine
      this.pendingKey = null;
      (top.container as Record<string, unknown>)[key] = value;
      path = [...top.path, key];
      if (settled) this.expect = "comma-or-close";
    } else {
      const arr = top.container as unknown[];
      path = [...top.path, arr.length];
      arr.push(value);
      if (settled) this.expect = "comma-or-close";
    }
    return path;
  }

  private finishRoot(): void {
    this.rootDone = true;
    this.expect = "eof";
    if (!this.doneEmitted) {
      this.doneEmitted = true;
      this.events.push({ type: "done", value: this.root });
    }
  }

  private onPunct(ch: Punct, offset: number): void {
    switch (ch) {
      case "{":
      case "[": {
        this.requireValue(`"${ch}"`);
        if (this.stack.length >= this.maxDepth) {
          this.fail("max-depth", `nesting exceeds maxDepth (${this.maxDepth})`);
        }
        const kind = ch === "{" ? "object" : "array";
        const container = ch === "{" ? {} : [];
        const path = this.attach(container, false);
        this.stack.push({ kind, container, path });
        this.expect = ch === "{" ? "key-or-close" : "value-or-close";
        this.events.push({ type: kind === "object" ? "openObject" : "openArray", path });
        this.safeCut = offset + 1;
        break;
      }
      case "}":
      case "]": {
        const want = ch === "}" ? "object" : "array";
        const top = this.stack[this.stack.length - 1];
        const openOk = ch === "}" ? this.expect === "key-or-close" : this.expect === "value-or-close";
        const closeOk = openOk || this.expect === "comma-or-close";
        if (top === undefined || top.kind !== want || !closeOk) {
          this.requireValue(`"${ch}"`); // throws when anything but a value is expected
          this.fail("unexpected-token", `unexpected "${ch}" (expected ${this.expected()})`);
        }
        this.stack.pop();
        this.events.push({ type: want === "object" ? "closeObject" : "closeArray", path: top.path });
        if (this.stack.length === 0) this.finishRoot();
        else this.expect = "comma-or-close";
        this.safeCut = offset + 1;
        break;
      }
      case ":": {
        if (this.expect !== "colon") {
          this.fail("unexpected-token", `unexpected ":" (expected ${this.expected()})`);
        }
        this.expect = "value";
        break;
      }
      case ",": {
        if (this.expect !== "comma-or-close") {
          this.fail("unexpected-token", `unexpected "," (expected ${this.expected()})`);
        }
        const top = this.stack[this.stack.length - 1] as Frame;
        this.expect = top.kind === "object" ? "key" : "value";
        break;
      }
    }
  }

  private onScalar(value: JsonPrimitive, start: number, endOffset: number): void {
    this.requireValue("value");
    const path = this.attach(value, false);
    this.events.push({ type: "value", path, value });
    this.settleValue();
    this.safeCut = endOffset;
  }

  /** Advance the grammar after a scalar completed (attach ran unsettled). */
  private settleValue(): void {
    if (this.stack.length === 0) this.finishRoot();
    else this.expect = "comma-or-close";
  }

  private onStringStart(offset: number): void {
    if (this.expect === "key" || this.expect === "key-or-close") {
      this.strMode = "key";
      this.strBuf = "";
      return;
    }
    this.requireValue("string");
    this.strMode = "value";
    this.strBuf = "";
    this.strFrame = this.stack[this.stack.length - 1] ?? null;
    this.strPath = this.attach("", false);
    this.strSlot = this.strPath.length > 0 ? (this.strPath[this.strPath.length - 1] as string | number) : 0;
  }

  private onStringChunk(text: string): void {
    this.strBuf += text;
    if (this.strMode !== "value") return;
    // Keep the tree current so snapshots see the string as it grows.
    if (this.strFrame === null) this.root = this.strBuf;
    else (this.strFrame.container as Record<string | number, unknown>)[this.strSlot] = this.strBuf;
    if (this.stringDeltas) this.events.push({ type: "delta", path: this.strPath, text });
  }

  private onStringEnd(offset: number): void {
    if (this.strMode === "key") {
      this.pendingKey = this.strBuf;
      this.strMode = "none";
      this.expect = "colon";
      const top = this.stack[this.stack.length - 1] as Frame;
      this.events.push({ type: "key", path: [...top.path, this.strBuf], key: this.strBuf });
      return;
    }
    // Value string: the tree already holds every chunk; settle and announce.
    if (this.strFrame === null) this.root = this.strBuf;
    else (this.strFrame.container as Record<string | number, unknown>)[this.strSlot] = this.strBuf;
    this.events.push({ type: "value", path: this.strPath, value: this.strBuf });
    this.strMode = "none";
    this.strFrame = null;
    this.settleValue();
    this.safeCut = offset + 1;
  }
}
