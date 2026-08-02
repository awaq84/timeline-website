// Collapses events that are the same thing recorded twice.
//
// The dedup key everywhere else in this pipeline is year|title|lat|lng, chosen
// to match the D3 data join so anything kept is guaranteed its own marker. That
// is the right key for rendering and the wrong one for identity: the same event
// arrives from more than one query with a different coordinate each time -- once
// from the item's own P625, once via a location fallback -- and the key sees two
// distinct events.
//
// So the map showed the Battle of Nineveh twice at 36.359,43.152 and
// 36.266,43.433, the Treaty of Versailles three times, the Korean War three
// times: 1,305 redundant rows, 1.1% of the dataset. It went unnoticed for a long
// while because stacked markers hid each other. Fanning co-located markers out
// so they can all be clicked is what made it visible.
//
// Identity here is the Wikipedia (or Wikidata) URL plus the year. One article,
// one year, one event -- whatever the coordinates disagree about.
//
// Which copy survives, in order:
//   1. exact date beats an approximate one (no `prec`)
//   2. has a location name beats a blank one
//   3. longer summary, on the assumption it is the more complete record
//   4. first seen, so the result is stable across runs
//
// Usage:  node scripts/dedupe-events.mjs [--dry-run]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "events.js");
const DRY = process.argv.includes("--dry-run");

// Article + year + TITLE.
//
// The title is load-bearing and was missing from the first version of this, at
// real cost. One article legitimately produces more than one event in a single
// year -- a short-lived state is founded and dissolved, an ancient figure's
// birth and death both round to the same century anchor -- and keying on
// article+year alone declared those the same event and deleted one of them.
//
// It removed 152 real rows before anyone noticed. In all 67 founding/dissolution
// collisions the dissolution won and the founding was deleted, so the California
// Republic, the Russian Republic, the Hungarian Soviet Republic, the Republic of
// Formosa and the Shun dynasty each lost their founding and kept only their end.
// 11 more merged a birth into a death. 71 spanned two categories, so the loser's
// category filter stopped showing it at all.
//
// A pure coordinate duplicate has the same title (the Battle of Nineveh at both
// 36.359,43.152 and 36.266,43.433), so adding the title still catches every case
// this script was written for.
const identity = (e) => `${e.year}|${(e.wiki || "no-url").toLowerCase()}|${e.title.toLowerCase()}`;

function better(a, b) {
  if (!!a.prec !== !!b.prec) return a.prec ? b : a;
  if (!!a.location !== !!b.location) return a.location ? a : b;
  const la = (a.summary || "").length;
  const lb = (b.summary || "").length;
  if (la !== lb) return la > lb ? a : b;
  return a;
}

async function main() {
  const src = await fs.readFile(DATA_PATH, "utf8");
  const events = new Function(`${src}\nreturn EVENTS;`)();
  console.log(`Loaded ${events.length.toLocaleString("en-US")} events`);

  const kept = new Map();
  const order = [];
  let collapsed = 0;
  for (const e of events) {
    const k = identity(e);
    const existing = kept.get(k);
    if (!existing) {
      kept.set(k, e);
      order.push(k);
      continue;
    }
    kept.set(k, better(existing, e));
    collapsed++;
  }

  const out = order.map((k) => kept.get(k));
  console.log(`  collapsed ${collapsed.toLocaleString("en-US")} redundant rows`);
  console.log(`  ${out.length.toLocaleString("en-US")} events remain`);

  // A sanity check worth having: collapsing must never remove a year entirely,
  // because a year that loses all its events loses its page and its sitemap
  // entry, and a 404 on a previously-indexed URL is a worse outcome than a
  // duplicate marker.
  const before = new Set(events.map((e) => e.year));
  const after = new Set(out.map((e) => e.year));
  const lost = [...before].filter((y) => !after.has(y));
  if (lost.length) {
    console.error(`  ABORT: ${lost.length} year(s) would lose every event: ${lost.slice(0, 10).join(", ")}`);
    process.exit(1);
  }
  console.log(`  years with events unchanged at ${after.size.toLocaleString("en-US")}`);

  if (DRY) {
    console.log("\n--dry-run: nothing written");
    return;
  }

  out.sort((a, b) => a.year - b.year);
  const header = src.slice(0, src.indexOf("const EVENTS"));
  await fs.writeFile(DATA_PATH, `${header}const EVENTS = ${JSON.stringify(out, null, 1)};\n`);
  console.log(`\nWritten to ${DATA_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
