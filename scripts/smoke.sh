#!/usr/bin/env bash
# Smoke test for dripjson: exercises the real CLI end to end against the
# committed example files. No network, idempotent, runs from a clean
# checkout (after `npm install`). Prints "SMOKE OK" on success.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "SMOKE FAIL: $1" >&2
  exit 1
}

TOOLCALL=examples/tool-call.partial.json
INCIDENT=examples/incident.partial.json

# 1. Build (idempotent).
npm run build >/dev/null 2>&1 || fail "npm run build failed"
CLI="node $ROOT/dist/cli.js"
echo "[smoke] build ok"

# 2. --version matches package.json; --help documents every command.
PKG_VERSION="$(node -p "require('$ROOT/package.json').version")"
CLI_VERSION="$($CLI --version)"
[ "$CLI_VERSION" = "$PKG_VERSION" ] || fail "--version mismatch: $CLI_VERSION != $PKG_VERSION"
HELP="$($CLI --help)"
for word in complete snapshot events status --chunk --deltas --no-resolve "Exit codes"; do
  echo "$HELP" | grep -q -- "$word" || fail "--help missing $word"
done
echo "[smoke] --help/--version ok ($CLI_VERSION)"

# 3. Usage and invalid-JSON errors all exit 2.
set +e
$CLI >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "missing command should exit 2"; }
$CLI frobnicate "$TOOLCALL" >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown command should exit 2"; }
$CLI snapshot "$TOOLCALL" --frobnicate >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown flag should exit 2"; }
$CLI complete "$TOOLCALL" --pretty >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "flag on the wrong command should exit 2"; }
$CLI snapshot missing.json >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "missing file should exit 2"; }
printf '{"a" 1}' | $CLI complete - >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "corrupt JSON should exit 2 (not be repaired)"; }
printf '[1,]' | $CLI snapshot - >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "[1,] should exit 2"; }
set -e
echo "[smoke] error handling ok (exit 2)"

# 4. The flagship repair: a tool call cut off mid-string becomes valid JSON.
REPAIRED="$($CLI complete "$TOOLCALL" 2>"$WORKDIR/repairs.txt")" || fail "complete should exit 0"
echo "$REPAIRED" | node -e "
  const v = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  if (v.arguments.filters.cabin !== 'premium') throw new Error('cabin');
  if (v.arguments.passengers !== 2) throw new Error('passengers');
" || fail "repaired tool call does not parse to the expected value"
grep -q "closed-string" "$WORKDIR/repairs.txt" || fail "closed-string repair not reported"
grep -q "closed-containers (}}})" "$WORKDIR/repairs.txt" || fail "closed-containers repair not reported"
echo "[smoke] complete ok (mid-string tool call repaired)"

# 5. complete is a fixed point: repairing the repaired text changes nothing.
echo "$REPAIRED" | $CLI complete - --json | node -e "
  const r = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  if (r.complete !== true) throw new Error('not complete');
  if (r.repairs.length !== 0) throw new Error('unexpected repairs');
" || fail "complete is not a fixed point"
echo "[smoke] fixed point ok"

# 6. snapshot resolves the truncated literal; --no-resolve drops it.
$CLI snapshot "$INCIDENT" | grep -q '"acknowledged":false' || fail "snapshot should resolve fal -> false"
$CLI snapshot "$INCIDENT" --no-resolve | grep -q '"acknowledged"' && fail "--no-resolve should drop the partial literal"
$CLI snapshot "$INCIDENT" --pretty | grep -q '^  "incident": "checkout-latency",$' || fail "--pretty output malformed"
echo "[smoke] snapshot ok (fal resolved / dropped on request)"

# 7. events: NDJSON, chunking-invariant for settled events, deltas on demand.
$CLI events "$TOOLCALL" > "$WORKDIR/whole.ndjson" || fail "events failed"
$CLI events "$TOOLCALL" --chunk 7 > "$WORKDIR/chunked.ndjson" || fail "events --chunk failed"
diff "$WORKDIR/whole.ndjson" "$WORKDIR/chunked.ndjson" >/dev/null || fail "chunking changed the settled event stream"
grep -q '"type":"delta"' "$WORKDIR/whole.ndjson" && fail "deltas leaked without --deltas"
$CLI events "$TOOLCALL" --chunk 7 --deltas | grep -q '"type":"delta"' || fail "--deltas produced no delta events"
node -e "
  const lines = require('fs').readFileSync('$WORKDIR/whole.ndjson', 'utf8').trim().split('\n');
  for (const line of lines) JSON.parse(line);
  if (lines.some((l) => JSON.parse(l).type === 'done')) throw new Error('done on a partial doc');
" || fail "events output is not clean NDJSON"
echo "[smoke] events ok (NDJSON, chunk-invariant)"

# 8. status is the scriptable gate: exit 1 on partial, 0 on complete.
set +e
STATUS_OUT="$($CLI status "$TOOLCALL")"
[ $? -eq 1 ] || { set -e; fail "status on a partial doc should exit 1"; }
set -e
echo "$STATUS_OUT" | grep -q 'partial · depth 3 · open "}}}" · pending value-string' || fail "status summary wrong: $STATUS_OUT"
printf '{"a": 1}' | $CLI status - >/dev/null || fail "status on a complete doc should exit 0"
printf '{"a": 1}' | $CLI status - --json | grep -q '"done":true' || fail "status --json wrong"
echo "[smoke] status gate ok (1 partial / 0 complete)"

# 9. stdin plumbing and the pipeline the README advertises.
printf '{"reply": "All good so f' | $CLI complete - 2>/dev/null | node -e "
  const v = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  if (v.reply !== 'All good so f') throw new Error('reply');
" || fail "stdin pipeline broken"
echo "[smoke] stdin ok"

# 10. The committed streaming example runs against the built library.
node examples/streaming.mjs | grep -q '/name = "book_meeting"' || fail "streaming example broken"
node examples/streaming.mjs | tail -1 | grep -q "document complete" || fail "streaming example never completed"
echo "[smoke] streaming example ok"

echo "SMOKE OK"
