// One-off migration: "Historical Figures" -> "People" (death events).
//
// Every event previously filed under "Historical Figures" was produced by
// personQuery() using wdt:P570 (date of death), so each one is really "this
// person died in this year" -- but it was titled with just the person's name,
// which read as though the person merely *existed* then. This relabels them:
//
//   category: "Historical Figures" -> "People"
//   title:    "Marie Curie"        -> "Marie Curie died"
//
// The summary is left alone on purpose. Those rows resolved their coordinate as
// COALESCE(place of death, place of birth), so for an unknown subset the pin is
// actually a birthplace -- writing "Died in {location}." would assert something
// the data doesn't support. Newly fetched birth events don't have this problem
// because they require P19 directly (see requirePlace in fetch-events.mjs).
//
// Idempotent: rerunning is a no-op once no "Historical Figures" events remain.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "events.js");

const OLD_CATEGORY = "Historical Figures";
const NEW_CATEGORY = "People";
const SUFFIX = " died";

const code = await fs.readFile(DATA_PATH, "utf8");
const events = new Function(code + "\nreturn EVENTS;")();
console.log(`Loaded ${events.length} events`);

const header = code.slice(0, code.indexOf("const EVENTS"));
if (!header.trim().startsWith("//")) throw new Error("Unexpected file layout: no leading comment header");

let migrated = 0;
for (const e of events) {
  if (e.category !== OLD_CATEGORY) continue;
  e.category = NEW_CATEGORY;
  // Guard against double-suffixing if this is somehow rerun mid-flight.
  if (!e.title.endsWith(SUFFIX)) e.title += SUFFIX;
  migrated++;
}

console.log(`Relabelled ${migrated} "${OLD_CATEGORY}" events as "${NEW_CATEGORY}" (+ "${SUFFIX.trim()}" suffix)`);
if (migrated === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

// Title collisions would break the map: renderMarkers() keys its D3 data join
// on d.title, so two events sharing a title silently render as one marker.
const counts = new Map();
for (const e of events) counts.set(e.title, (counts.get(e.title) || 0) + 1);
const dupes = [...counts.entries()].filter(([, n]) => n > 1);
if (dupes.length) {
  console.warn(`\nWARNING: ${dupes.length} duplicate titles after migration, e.g.:`);
  dupes.slice(0, 10).forEach(([t, n]) => console.warn(`  ${n}x  ${t}`));
}

events.sort((a, b) => a.year - b.year);
await fs.writeFile(DATA_PATH, `${header}const EVENTS = ${JSON.stringify(events)};\n`);
console.log(`\nWrote ${events.length} events to ${DATA_PATH}`);
