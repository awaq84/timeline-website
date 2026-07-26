// One-off migration: move person life-events out of the five topical categories
// that were populated by personQuery() and into "People".
//
// Five categories in fetch-events.mjs run a mode:"person" sub-query (date of
// death, P570) but never set a titleSuffix, so those rows are titled with a bare
// name and filed under a topic. "Giovanni Battista Calvi", an Italian military
// engineer who died in 1564, sits in Science & Technology reading as though he
// *were* a technology. Same defect "Historical Figures" had before
// migrate-people.mjs; this is the general fix.
//
// Those categories also hold genuine events ("Mytilenean revolt"), and no title
// pattern separates the two, so membership is decided by Wikidata's own answer:
// P31 = Q5 (instance of human), cached by scripts/enrich-person-kind.mjs.
//
//   category: "Science & Technology"  -> "People"
//   title:    "Giovanni Battista Calvi" -> "Giovanni Battista Calvi died"
//
// Which suffix a row gets is decided by comparing the row's year against the
// person's cached birth and death years rather than assuming, because a handful
// of these rows came from earlier fetch configs that used P569.
//
// Summaries are left alone: these rows resolved their coordinate as
// COALESCE(place of death, place of birth), so the pin may be a birthplace and
// "Died in {location}." would assert more than the data supports.
//
// Set DRY_RUN=1 to print the report without touching data/events.js.
//
// Idempotent: rows already carrying a suffix are counted but not re-suffixed,
// and once moved they're no longer in a person-query category at all.
//
// Usage:  node scripts/migrate-person-events.mjs
//         DRY_RUN=1 node scripts/migrate-person-events.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { articleTitleFromWiki } from "./wiki-title.mjs";
import { PERSON_QUERY_CATEGORIES } from "./enrich-person-kind.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "events.js");
const CACHE_PATH = path.join(__dirname, "..", "data", ".cache", "person-kind.json");

const NEW_CATEGORY = "People";
const DRY_RUN = process.env.DRY_RUN === "1";

const key = (e) => `${e.year}|${e.title}|${e.lat}|${e.lng}`;

const code = await fs.readFile(DATA_PATH, "utf8");
const events = new Function(code + "\nreturn EVENTS;")();
console.log(`Loaded ${events.length} events`);

const header = code.slice(0, code.indexOf("const EVENTS"));
if (!header.trim().startsWith("//")) throw new Error("Unexpected file layout: no leading comment header");

let cache;
try {
  cache = JSON.parse(await fs.readFile(CACHE_PATH, "utf8"));
} catch {
  console.error(`No classification cache at ${CACHE_PATH}.\nRun: node scripts/enrich-person-kind.mjs`);
  process.exit(1);
}
console.log(`Classification cache: ${Object.keys(cache).length} titles`);

// Report per category before deciding anything, so the scale of the move is
// visible even in a dry run.
const stats = new Map();
const bump = (cat, field) => {
  if (!stats.has(cat)) stats.set(cat, { total: 0, human: 0, event: 0, unknown: 0, born: 0, died: 0, ambiguous: 0 });
  stats.get(cat)[field]++;
};

const pending = [];
for (const e of events) {
  if (!PERSON_QUERY_CATEGORIES.includes(e.category)) continue;
  bump(e.category, "total");
  const t = articleTitleFromWiki(e.wiki);
  const kind = t ? cache[t] : undefined;
  if (!kind) {
    bump(e.category, "unknown");
    continue;
  }
  if (!kind.human) {
    bump(e.category, "event");
    continue;
  }
  bump(e.category, "human");

  // Prefer whichever cached year the row actually sits on. The ±1 pass exists
  // because BCE years are off by one between the two sources: astronomical year
  // numbering has a year 0, the displayed BCE year doesn't, so Pythagoras is
  // row year -491 against a cached death of -490. An exact match is tried first
  // for both dates so the tolerance can never override a precise hit.
  const near = (a, b) => a != null && Math.abs(a - b) <= 1;
  let suffix;
  if (kind.death === e.year) suffix = " died";
  else if (kind.birth === e.year) suffix = " born";
  else if (near(kind.death, e.year)) suffix = " died";
  else if (near(kind.birth, e.year)) suffix = " born";
  else {
    // Every one of these categories queried P570, so death is the right default.
    suffix = " died";
    bump(e.category, "ambiguous");
  }
  bump(e.category, suffix === " born" ? "born" : "died");
  pending.push({ event: e, suffix });
}

console.log("\nPer-category breakdown of the person-query categories:");
const pad = (s, n) => String(s).padEnd(n);
console.log(`  ${pad("category", 34)}${pad("total", 8)}${pad("human", 8)}${pad("event", 8)}${pad("unclassified", 13)}`);
for (const cat of PERSON_QUERY_CATEGORIES) {
  const s = stats.get(cat);
  if (!s) continue;
  console.log(`  ${pad(cat, 34)}${pad(s.total, 8)}${pad(s.human, 8)}${pad(s.event, 8)}${pad(s.unknown, 13)}`);
  console.log(`  ${pad("", 34)}-> born ${s.born}, died ${s.died}${s.ambiguous ? ` (${s.ambiguous} year matched neither cached date)` : ""}`);
}

const totalHuman = pending.length;
console.log(`\n${totalHuman} events would move to "${NEW_CATEGORY}"`);
for (const cat of PERSON_QUERY_CATEGORIES) {
  const s = stats.get(cat);
  if (!s) continue;
  console.log(`  ${pad(cat, 34)}${s.total} -> ${s.total - s.human} remaining`);
}

if (DRY_RUN) {
  console.log("\nDRY_RUN=1 -- nothing written.");
  process.exit(0);
}
if (totalHuman === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

for (const { event: e, suffix } of pending) {
  e.category = NEW_CATEGORY;
  if (!e.title.endsWith(" born") && !e.title.endsWith(" died")) e.title += suffix;
}

// Renaming can collide with a row People already holds -- the same death
// harvested by two different fetch configs. renderMarkers() keys its D3 join on
// year|title|lat|lng, so an exact collision renders as a single marker and the
// duplicate is invisible dead weight; drop it here instead.
const seen = new Set();
const deduped = [];
let removed = 0;
for (const e of events) {
  const k = key(e);
  if (seen.has(k)) {
    removed++;
    continue;
  }
  seen.add(k);
  deduped.push(e);
}
if (removed) console.log(`Dropped ${removed} events that became exact duplicates`);

// Same title at a different coordinate survives the dedupe above but still reads
// as a repeat in the events list, so surface it rather than hiding it.
const counts = new Map();
for (const e of deduped) counts.set(e.title, (counts.get(e.title) || 0) + 1);
const dupeTitles = [...counts.entries()].filter(([, n]) => n > 1);
if (dupeTitles.length) {
  console.warn(`\nWARNING: ${dupeTitles.length} titles appear more than once (different coordinates), e.g.:`);
  dupeTitles.slice(0, 10).forEach(([t, n]) => console.warn(`  ${n}x  ${t}`));
}

deduped.sort((a, b) => a.year - b.year);
await fs.writeFile(DATA_PATH, `${header}const EVENTS = ${JSON.stringify(deduped)};\n`);
console.log(`\nWrote ${deduped.length} events to ${DATA_PATH}`);
