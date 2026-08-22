// Clears the fabricated summaries already sitting in data/events.js.
//
// fetch-events.mjs used to fall back to `${title} (${category}).` whenever
// Wikidata had no schema:description for an item. That is not a description --
// it is the title repeated with the category label that already appears directly
// above it on every card:
//
//   "Siege of Sarlat (Wars & Conflicts)."
//   "Mulisko Gaina (Architecture & Engineering)."
//   "Aslankaya (Religion & Belief Systems)."
//
// The fallback is gone from the fetcher, but 5,341 of these are committed, and
// they render on the map tooltip, the event list and every year page as though
// they were real text. This blanks them so the render sites can omit the element.
//
// Only an exact match is cleared. A real Wikidata description that happens to
// end in a parenthetical -- "Church in Kraków (now a museum)." -- does not match
// the title-plus-category shape and is left alone.
//
// Idempotent: re-running finds nothing once it has been applied.
//
// Usage:  node scripts/clear-placeholder-summaries.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "events.js");

const code = await fs.readFile(DATA_PATH, "utf8");
const events = new Function(code + "\nreturn EVENTS;")();
const header = code.slice(0, code.indexOf("const EVENTS"));
if (!header.trim().startsWith("//")) throw new Error("Unexpected file layout: no leading comment header");

console.log(`Loaded ${events.length.toLocaleString("en-US")} events`);

let cleared = 0;
const byCategory = {};
for (const e of events) {
  if (e.summary !== `${e.title} (${e.category}).`) continue;
  e.summary = "";
  cleared++;
  byCategory[e.category] = (byCategory[e.category] || 0) + 1;
}

if (!cleared) {
  console.log("No placeholder summaries found -- nothing to do.");
  process.exit(0);
}

console.log(`\nCleared ${cleared.toLocaleString("en-US")} placeholder summaries:`);
for (const [cat, n] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${cat}`);
}

const withSummary = events.filter((e) => e.summary).length;
console.log(
  `\n${withSummary.toLocaleString("en-US")} of ${events.length.toLocaleString("en-US")} events still carry a real description ` +
    `(${((withSummary / events.length) * 100).toFixed(1)}%)`
);

await fs.writeFile(DATA_PATH, `${header}const EVENTS = ${JSON.stringify(events)};\n`);
console.log(`\nWritten to ${DATA_PATH}`);
