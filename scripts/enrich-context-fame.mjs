// Caches how well known the WARS AND PERIODS that event descriptions refer to
// are, in data/.cache/context-fame.json.
//
// Why this exists: the quiz gates entry on a sitelink count, which asks "is this
// event famous?" For a large class of events that is the wrong question. Nobody
// has heard of the Battle of Torrence's Tavern -- it has two language Wikipedias
// -- but its description reads "Battle of the American Revolutionary War", and
// the year is strippable from the description before it is shown. A player does
// not need to know the battle. They need to know when the American Revolutionary
// War was, which is a fair thing to ask.
//
// So the answerability of such an event tracks the fame of the war it names, not
// its own. That number is not in data/.cache/sitelinks.json, because that cache
// is keyed by the articles of events we actually hold, and "Taiping Rebellion"
// is a period rather than a dated point and never entered the dataset.
//
// 569 distinct contexts are cited across the dataset and 355 are missing, so
// this is a small pass. Resumable: re-running fetches only what is absent.
//
// Usage:  node scripts/enrich-context-fame.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contextName } from "./quiz-context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "events.js");
const CACHE_DIR = path.join(__dirname, "..", "data", ".cache");
const OUT_PATH = path.join(CACHE_DIR, "context-fame.json");
const SITELINKS_PATH = path.join(CACHE_DIR, "sitelinks.json");
const API = "https://www.wikidata.org/w/api.php";
const UA = "TimelineHistoryBuildScript/1.0 (personal educational project)";
const BATCH = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const code = await fs.readFile(DATA_PATH, "utf8");
const events = new Function(code + "\nreturn EVENTS;")();

// Seed from the sitelinks cache: a context that is already an event here needs
// no second lookup.
let sitelinks = {};
try {
  sitelinks = JSON.parse(await fs.readFile(SITELINKS_PATH, "utf8"));
} catch {
  console.warn("No sitelinks.json yet -- every context will be fetched.");
}

let cache = {};
try {
  cache = JSON.parse(await fs.readFile(OUT_PATH, "utf8"));
  console.log(`Resuming: ${Object.keys(cache).length} contexts already cached`);
} catch {
  /* first run */
}

const wanted = new Set();
for (const e of events) {
  if (!e.summary) continue;
  const name = contextName(e.summary);
  if (!name) continue;
  if (name in cache) continue;
  if (name in sitelinks) {
    cache[name] = sitelinks[name];
    continue;
  }
  wanted.add(name);
}

console.log(`${events.length.toLocaleString("en-US")} events -> ${wanted.size} contexts to look up`);
if (!wanted.size) {
  await fs.writeFile(OUT_PATH, JSON.stringify(cache, null, 1));
  console.log(`Nothing to fetch. Cache holds ${Object.keys(cache).length} contexts.`);
  process.exit(0);
}

// Wikidata's wbgetentities resolves English Wikipedia titles directly via
// sites=enwiki, so no search step and no guessing which item a name refers to.
const names = [...wanted];
let resolved = 0;
for (let i = 0; i < names.length; i += BATCH) {
  const batch = names.slice(i, i + BATCH);
  const url =
    `${API}?action=wbgetentities&sites=enwiki&titles=${encodeURIComponent(batch.join("|"))}` +
    `&props=sitelinks&format=json&formatversion=2`;
  let data;
  try {
    data = await (await fetch(url, { headers: { "User-Agent": UA } })).json();
  } catch (err) {
    console.warn(`  batch at ${i}: ${err.message} -- skipped`);
    await sleep(2000);
    continue;
  }
  for (const ent of Object.values(data.entities || {})) {
    const title = ent.sitelinks?.enwiki?.title;
    if (!title) continue;
    const n = Object.keys(ent.sitelinks || {}).length;
    // Key by the name as it was cited, and by the resolved article title, so a
    // redirect ("First World War" -> "World War I") is found either way.
    cache[title] = n;
    const cited = batch.find((b) => b.toLowerCase() === title.toLowerCase());
    if (cited) cache[cited] = n;
    resolved++;
  }
  // Anything the API did not return is recorded as 0 so it is not retried
  // forever; a name that resolves to nothing is not a usable context.
  for (const b of batch) if (!(b in cache)) cache[b] = 0;
  console.log(`  ${Math.min(i + BATCH, names.length)}/${names.length} (${resolved} resolved)`);
  await sleep(400);
}

await fs.mkdir(CACHE_DIR, { recursive: true });
await fs.writeFile(OUT_PATH, JSON.stringify(cache, null, 1));
const usable = Object.values(cache).filter((n) => n >= 12).length;
console.log(`\nCache holds ${Object.keys(cache).length} contexts, ${usable} of them well enough known to vouch for an event.`);
console.log(`Written to ${OUT_PATH}`);
