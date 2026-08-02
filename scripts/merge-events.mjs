// Merges freshly fetched events from data/.cache/<Category>.json into the
// committed dataset at data/events.js, without disturbing anything else.
//
// Why a merge rather than just using events.generated.json: the committed
// dataset was accumulated over many scoped fetch runs (different era windows,
// different sitelink thresholds), so it holds far more than any single run
// produces. Regenerating wholesale would silently throw that away.
//
// Usage:  node scripts/merge-events.mjs "People" ["Another Category" ...]
//
// Dedup key is year|title|lat|lng -- the same identity renderMarkers() uses for
// its D3 join, so anything this script keeps is guaranteed to render as its own
// marker. Existing events always win; only genuinely new rows are appended.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "events.js");
const CACHE_DIR = path.join(__dirname, "..", "data", ".cache");

const categories = process.argv.slice(2);
if (!categories.length) {
  console.error('Usage: node scripts/merge-events.mjs "Category Name" [...]');
  process.exit(1);
}

const code = await fs.readFile(DATA_PATH, "utf8");
const events = new Function(code + "\nreturn EVENTS;")();
const header = code.slice(0, code.indexOf("const EVENTS"));
if (!header.trim().startsWith("//")) throw new Error("Unexpected file layout: no leading comment header");
console.log(`Loaded ${events.length} existing events`);

const key = (e) => `${e.year}|${e.title}|${e.lat}|${e.lng}`;

// The committed dataset accumulated across many fetch runs, and some rows are
// exact duplicates of each other -- same year, same title, same coordinate --
// usually a Roman consul or a repeatedly-besieged city matched by two different
// sub-queries. renderMarkers() joins on this same key, so D3 keeps only the
// first of each group and the rest have never rendered at all. Drop them here
// so the file matches what the map can actually show.
const deduped = [];
const seen = new Set();
let removedDupes = 0;
for (const e of events) {
  const k = key(e);
  if (seen.has(k)) {
    removedDupes++;
    continue;
  }
  seen.add(k);
  deduped.push(e);
}
if (removedDupes) console.log(`Dropped ${removedDupes} pre-existing exact duplicates`);
// Rewritten in place with a loop rather than `events.push(...deduped)`. Spread
// passes every element as a separate argument, and at 111,389 events that
// overflows the call stack -- the merge died with "Maximum call stack size
// exceeded" before writing anything. Same for any later bulk append here.
events.length = 0;
for (const e of deduped) events.push(e);

let totalAdded = 0;
for (const cat of categories) {
  const cachePath = path.join(CACHE_DIR, `${cat.replace(/[^a-z0-9]/gi, "_")}.json`);
  let incoming;
  try {
    incoming = JSON.parse(await fs.readFile(cachePath, "utf8"));
  } catch (err) {
    console.error(`  SKIP "${cat}": cannot read ${cachePath} (${err.message})`);
    continue;
  }

  let added = 0;
  let dupes = 0;
  for (const e of incoming) {
    if (seen.has(key(e))) {
      dupes++;
      continue;
    }
    seen.add(key(e));
    events.push(e);
    added++;
  }
  console.log(`  "${cat}": ${incoming.length} fetched -> ${added} new, ${dupes} already present`);
  totalAdded += added;
}

if (totalAdded === 0 && removedDupes === 0) {
  console.log("\nNothing new to merge; leaving data/events.js untouched.");
  process.exit(0);
}

events.sort((a, b) => a.year - b.year);
await fs.writeFile(DATA_PATH, `${header}const EVENTS = ${JSON.stringify(events)};\n`);
console.log(
  `\nAdded ${totalAdded}, removed ${removedDupes} duplicates -> ${events.length} total, written to ${DATA_PATH}`
);
