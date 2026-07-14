// Streaming demo: feed a tool-call argument document to DripParser in small
// chunks — the way it actually arrives from a model API — and act on fields
// the moment they settle, long before the document is complete.
//
// Run from a built checkout:  node examples/streaming.mjs
import { DripParser, pathToPointer } from "../dist/index.js";

const document = JSON.stringify({
  name: "book_meeting",
  arguments: {
    title: "Quarterly planning",
    attendees: ["dana@example.test", "kim@example.test"],
    duration_minutes: 45,
    notify: true,
  },
});

// Simulate network arrival: 12-character chunks.
const parser = new DripParser({ stringDeltas: true });
const chunks = [];
for (let i = 0; i < document.length; i += 12) chunks.push(document.slice(i, i + 12));

for (const [n, chunk] of chunks.entries()) {
  for (const event of parser.push(chunk)) {
    if (event.type === "value") {
      console.log(`chunk ${n}: ${pathToPointer(event.path)} = ${JSON.stringify(event.value)}`);
    } else if (event.type === "done") {
      console.log(`chunk ${n}: document complete`);
    }
  }
  // At any moment, a best-effort view of everything so far:
  // console.log(parser.snapshot());
}
parser.end();
