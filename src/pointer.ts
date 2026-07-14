/**
 * RFC 6901 JSON Pointers from dripjson paths.
 *
 * Event paths are arrays (`["choices", 0, "delta"]`); logs, config and
 * assertions usually want the pointer string (`/choices/0/delta`). The
 * escaping rules are the RFC's two: `~` -> `~0`, `/` -> `~1`, in that order.
 */

import type { Path } from "./types.js";

/** Encode one path segment per RFC 6901. */
export function escapePointerSegment(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

/** `[]` is the whole document: the empty pointer `""`. */
export function pathToPointer(path: Path): string {
  if (path.length === 0) return "";
  return "/" + path.map(escapePointerSegment).join("/");
}
