// Splits data/events.js into a small index plus era chunks that the app loads
// on demand.
//
// Why: events.js is 28MB (6MB gzipped) and app.js loaded all of it as a plain
// <script> before painting a single marker -- roughly 10-20 seconds of blank
// screen on a phone. The map only ever displays one year at a time, so all but
// a few hundred of those 111,389 events are dead weight on first load.
//
// Output:
//   data/index.json        manifest: year range, category counts, and for every
//                          year that has events, a bitmask of which categories
//                          are present. This is what drives the slider, the
//                          step/play controls and the category filters, so
//                          those keep working without any chunk being loaded.
//   data/events/NNN.json   the events themselves, grouped into contiguous year
//                          ranges of roughly CHUNK_TARGET events each.
//
// A year is never split across two chunks. That's the invariant the whole
// design rests on: rendering year Y touches exactly one chunk, so the loader
// never has to stitch results together or reason about partial years.
//
// Chunks are sized by event count rather than by a fixed span of years because
// the dataset is wildly skewed -- 3000 BCE to 1500 CE holds fewer events than
// the 1990s alone. Equal-span chunks would be a 4KB file for the Bronze Age and
// a 3MB file for the 20th century.
//
// Usage:  node scripts/build-chunks.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_PATH = path.join(DATA_DIR, "events.js");
const CHUNK_DIR = path.join(DATA_DIR, "events");
const INDEX_PATH = path.join(DATA_DIR, "index.json");

// ~1,500 events lands each chunk near 80KB gzipped: small enough that scrubbing
// to a new era feels instant, large enough that stepping year by year through
// the busy modern end isn't a request per click.
const CHUNK_TARGET = 1500;

const code = await fs.readFile(DATA_PATH, "utf8");
const events = new Function(code + "\nreturn EVENTS;")();
console.log(`Loaded ${events.length.toLocaleString()} events`);

// Group by year first. Sorting the whole array and slicing at CHUNK_TARGET
// would split a year down the middle whenever a boundary landed inside a busy
// one, which breaks the one-year-one-chunk invariant.
const byYear = new Map();
for (const e of events) {
  if (!byYear.has(e.year)) byYear.set(e.year, []);
  byYear.get(e.year).push(e);
}
const years = [...byYear.keys()].sort((a, b) => a - b);
console.log(`${years.length.toLocaleString()} distinct years, ${years[0]} .. ${years[years.length - 1]}`);

// Category order is fixed here and referenced by index from the bitmask below,
// so it has to stay stable between a build and the app reading it. Sorted by
// name rather than by count: counts shift on every refetch, names don't.
const categories = [...new Set(events.map((e) => e.category))].sort();
if (categories.length > 31) throw new Error(`${categories.length} categories exceeds the 31-bit mask`);
const catIndex = new Map(categories.map((c, i) => [c, i]));
const categoryCounts = categories.map(() => 0);
for (const e of events) categoryCounts[catIndex.get(e.category)]++;

// Pack the years into chunks, closing one as soon as it's at or over target.
const chunks = [];
let current = null;
for (const y of years) {
  const rows = byYear.get(y);
  if (!current) current = { firstYear: y, lastYear: y, events: [] };
  current.lastYear = y;
  current.events.push(...rows);
  if (current.events.length >= CHUNK_TARGET) {
    chunks.push(current);
    current = null;
  }
}
if (current) chunks.push(current);

// Every year needs to resolve to a chunk, including years with no events of
// their own -- the slider can sit on one. Chunk N is therefore defined as
// covering everything from its first year up to the next chunk's first year,
// so the ranges tile the timeline with no gaps.
const chunkStarts = chunks.map((c) => c.firstYear);

await fs.rm(CHUNK_DIR, { recursive: true, force: true });
await fs.mkdir(CHUNK_DIR, { recursive: true });

let totalBytes = 0;
let biggest = { n: 0, bytes: 0 };
for (const [i, c] of chunks.entries()) {
  // Sorted within the chunk so the app can render straight from the slice.
  c.events.sort((a, b) => a.year - b.year);
  const json = JSON.stringify(c.events);
  totalBytes += Buffer.byteLength(json);
  if (Buffer.byteLength(json) > biggest.bytes) biggest = { n: i, bytes: Buffer.byteLength(json) };
  await fs.writeFile(path.join(CHUNK_DIR, `${String(i).padStart(3, "0")}.json`), json);
}

// One entry per year that actually has events: [year, bitmask]. The mask lets
// getEventYears() answer "which years have something in the active categories"
// without a single chunk being loaded, which is what keeps the step, play and
// nearest-year controls synchronous.
const yearIndex = years.map((y) => {
  let mask = 0;
  for (const e of byYear.get(y)) mask |= 1 << catIndex.get(e.category);
  return [y, mask];
});

const index = {
  total: events.length,
  minYear: years[0],
  maxYear: years[years.length - 1],
  categories,
  categoryCounts,
  chunkStarts,
  years: yearIndex,
};
const indexJson = JSON.stringify(index);
await fs.writeFile(INDEX_PATH, indexJson);

const kb = (b) => `${(b / 1024).toFixed(0)}KB`;
console.log(`\n${chunks.length} chunks written to ${CHUNK_DIR}`);
console.log(`  average ${kb(totalBytes / chunks.length)}, largest ${kb(biggest.bytes)} (${String(biggest.n).padStart(3, "0")}.json)`);
console.log(`  total ${kb(totalBytes)} across all chunks`);
console.log(`index.json ${kb(Buffer.byteLength(indexJson))} -- this plus one chunk is the whole first load`);

// Self-check on the two things the app takes on faith: nothing was dropped, and
// no year ended up in more than one chunk.
const homeOf = new Map();
for (const [i, c] of chunks.entries()) {
  for (const e of c.events) {
    const prev = homeOf.get(e.year);
    if (prev !== undefined && prev !== i) throw new Error(`year ${e.year} split across chunks ${prev} and ${i}`);
    homeOf.set(e.year, i);
  }
}
const chunkTotal = chunks.reduce((n, c) => n + c.events.length, 0);
if (chunkTotal !== events.length) throw new Error(`chunk total ${chunkTotal} != ${events.length}`);

// Ranges must tile the timeline: resolving any year, including empty ones, has
// to land on the chunk that would hold it.
for (let i = 1; i < chunkStarts.length; i++) {
  if (chunkStarts[i] <= chunkStarts[i - 1]) throw new Error(`chunkStarts not strictly increasing at ${i}`);
  if (chunks[i - 1].lastYear >= chunkStarts[i]) throw new Error(`chunk ${i - 1} overlaps chunk ${i}`);
}
console.log(`\nVerified: all ${chunkTotal.toLocaleString()} events accounted for, no year split across chunks.`);
