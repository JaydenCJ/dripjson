/**
 * Best-effort completion: turn a truncated JSON prefix into valid JSON text.
 *
 * The strategy is "cut and close", never invent: keep the input verbatim up
 * to the last salvageable point, resolve the one token torn by the cut
 * (close the string, trim the number, finish the literal), then append the
 * brackets that close every open container. Formatting of the kept prefix
 * is preserved byte-for-byte, and every edit is reported as a typed Repair.
 *
 * The rules are the same ones `snapshot()` uses, so
 * `JSON.parse(complete(prefix).text)` and `parsePartial(prefix).value`
 * always agree. The full contract lives in docs/recovery-rules.md.
 */

import { DripParser } from "./parser.js";
import type { CompletionInfo, CompletionResult, Repair } from "./types.js";

/**
 * Repair a (possibly truncated) JSON document into valid JSON text.
 *
 * Throws DripError when the input is corrupt rather than merely cut off —
 * no completion can fix `{"a" 1}`. Empty or whitespace-only input yields
 * `"null"` with an `empty-input` repair, so the result always parses.
 */
export function complete(text: string): CompletionResult {
  const parser = new DripParser();
  parser.push(text);
  parser.end();
  return assemble(text, parser.completionInfo());
}

/** Assemble repaired text from completion state (exposed for buffer-owners). */
export function assemble(text: string, info: CompletionInfo): CompletionResult {
  if (info.done) return { text, complete: true, repairs: [] };
  if (!info.started) {
    return { text: "null", complete: false, repairs: [{ kind: "empty-input" }] };
  }

  const repairs: Repair[] = [];
  let base: string;

  if (info.inValueString) {
    // Close the string in place, minus any escape torn by the cut.
    base = text.slice(0, info.stringCut);
    if (info.escapeDropped) {
      repairs.push({ kind: "dropped-incomplete-escape", detail: text.slice(info.stringCut) });
    }
    base += '"';
    repairs.push({ kind: "closed-string" });
  } else if (info.pendingLiteral !== null) {
    // `tru` can only ever be `true`: append the missing letters.
    base = text + info.pendingLiteral.word.slice(info.pendingLiteral.raw.length);
    repairs.push({ kind: "completed-literal", detail: info.pendingLiteral.word });
  } else if (info.pendingNumber !== null && info.pendingNumber.validPrefix !== "") {
    // Trim `12.` to `12`; a complete trailing number keeps itself whole.
    const n = info.pendingNumber;
    base = text.slice(0, n.start + n.validPrefix.length);
    if (n.validPrefix.length < n.raw.length) {
      repairs.push({ kind: "trimmed-number", detail: `${n.raw} -> ${n.validPrefix}` });
    }
  } else {
    // Nothing at the very end is salvageable: cut back to the last point
    // that closing brackets alone can finish, and say why.
    base = text.slice(0, info.safeCut);
    if (info.pendingNumber !== null) {
      repairs.push({ kind: "dropped-partial-value", detail: info.pendingNumber.raw });
    }
    if (info.inKeyString) {
      repairs.push({ kind: "dropped-partial-key" });
    } else if (info.danglingKey) {
      repairs.push({ kind: "dropped-dangling-key" });
    } else if (info.afterComma && text.slice(info.safeCut).trim() !== "") {
      repairs.push({ kind: "removed-trailing-comma" });
    }
  }

  if (info.closers !== "") {
    base += info.closers;
    repairs.push({ kind: "closed-containers", detail: info.closers });
  }

  if (base.trim() === "") {
    // e.g. the whole input was a lone `-`: nothing survived the cut.
    return { text: "null", complete: false, repairs: [...repairs, { kind: "empty-input" }] };
  }
  return { text: base, complete: false, repairs };
}
