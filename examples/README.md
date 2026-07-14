# dripjson examples

Runnable inputs and scripts for the CLI and the library. Everything works
offline from a built checkout (`npm install && npm run build`).

## Files

| File | What it is |
|---|---|
| `tool-call.partial.json` | A tool-call argument document cut off mid-string — the classic streaming prefix. |
| `incident.partial.json` | A status report cut off mid-literal (`fal`), with complete nested structure before it. |
| `streaming.mjs` | Library demo: push 12-character chunks, act on `value` events as fields settle. |

The `.partial.json` files are deliberately **not** valid JSON — that is the
point. Editors will complain; `dripjson` will not.

## Try them

```bash
# Repair the truncated tool call into valid JSON (repairs listed on stderr)
node dist/cli.js complete examples/tool-call.partial.json

# Best-effort value: `fal` resolves to false (drop it instead with --no-resolve)
node dist/cli.js snapshot examples/incident.partial.json --pretty

# The typed event stream, fed 40 characters at a time
node dist/cli.js events examples/tool-call.partial.json --chunk 40 --deltas

# Scriptable gate: exit 1 because the document is partial
node dist/cli.js status examples/tool-call.partial.json

# The streaming library demo
node examples/streaming.mjs
```
