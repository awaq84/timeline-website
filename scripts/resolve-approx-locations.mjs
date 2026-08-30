// Gives a coordinate to events that have no coordinate of their own, and records
// how good that coordinate is.
//
// WHY
//
// This site is a map, so every event needs a dot, and Wikidata gives a P625 only
// to things that ARE places. That silently excludes an entire class of history:
// of the 42 articles in Category:Treaties of England, exactly 2 carry
// coordinates. The English Civil War, the Glorious Revolution, the Harrying of
// the North, the Dissolution of the Monasteries and Domesday Book are not missing
// because nobody wrote them down. They are missing because a treaty is an
// agreement and a revolution is a process, and neither has a latitude.
//
// So the coordinate is derived from what the item DOES say, in descending order
// of how much it is worth:
//
//   P276 location            the place the thing happened. Good.
//   P131 admin unit          the county or region containing it. Coarse.
//   P17  country             a whole country's centroid. Very coarse.
//
// HONESTY
//
// The dataset already refuses to claim a date it does not have: `prec` marks an
// event as known only to the decade, century or millennium, and the UI says so
// rather than printing the anchor year as fact. A derived coordinate is the same
// problem in space, and gets the same treatment. Every event placed here carries
// `locPrec` naming what it was derived from, so the map and the year pages can
// say "shown at the location of X" instead of asserting a point.
//
// Without that field this script would be a machine for producing confident
// wrong answers: the English Civil War rendered as a dot in Westminster, looking
// exactly like the Battle of Naseby rendered at Naseby.
//
// Usage:
//   node scripts/resolve-approx-locations.mjs <input.json> [--write]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WD_API = "https://www.wikidata.org/w/api.php";
const UA = "TimelineHistoryBuildScript/1.0 (personal educational project)";
const WRITE = process.argv.includes("--write");
const INPUT = process.argv[2];

if (!INPUT) {
  console.error("Usage: node scripts/resolve-approx-locations.mjs <input.json> [--write]");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, attempts = 5) {
  let wait = 1500;
  for (let i = 1; i <= attempts; i++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const text = await res.text();
    if (text.startsWith("{")) {
      try {
        return JSON.parse(text);
      } catch (err) {
        if (i === attempts) throw err;
      }
    } else if (i === attempts) {
      throw new Error(`rate limited after ${attempts} attempts`);
    }
    await sleep(wait);
    wait *= 2;
  }
}

const SOURCES = ["P276", "P131", "P17"];

// How precise a derived coordinate is depends on WHAT IT POINTS AT, not on which
// property pointed there. The first version of this got that wrong and labelled
// by property: P276 was called "place", so "English Civil War, location =
// Kingdom of England" came out as a precise placement, indistinguishable on the
// map from the Battle of Naseby at Naseby. P276 routinely names a whole country.
//
// So the target's own P31 decides. Anything not recognised is treated as a
// place, which is the common case -- towns, abbeys, battlefields, museums.
const COUNTRYISH = new Set([
  "Q6256", "Q3624078", "Q3024240", "Q48349", "Q417175", "Q1250464", "Q133442",
  "Q179164", "Q7275", "Q1520223", "Q5255892", "Q512187",
]);
const REGIONISH = new Set([
  "Q82794", "Q5107", "Q3455524", "Q10864048", "Q56061", "Q1620908", "Q1136601",
  "Q15916867", "Q2352616", "Q186081", "Q484170", "Q13220204",
]);

function precisionOf(entity) {
  const types = (entity.claims?.P31 || [])
    .map((c) => c.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
  if (types.some((t) => COUNTRYISH.has(t))) return "country";
  if (types.some((t) => REGIONISH.has(t))) return "region";
  return "place";
}

// An event with several locations has no single one. World War II lists many and
// the first happened to be Russia, which is how it was about to be pinned there
// and labelled precise. Above this count, the property is describing a spread
// rather than a spot, so it is skipped in favour of a coarser but honest source.
const MAX_LOCATIONS = 2;

const idsOf = (entity, prop) =>
  (entity.claims?.[prop] || [])
    .map((c) => c.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);

const coordsOf = (entity) => {
  const c = entity.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
  if (!c || typeof c.latitude !== "number") return null;
  return { lat: c.latitude, lng: c.longitude };
};

async function getEntities(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    const data = await fetchJson(
      `${WD_API}?action=wbgetentities&ids=${batch.join("|")}&props=claims|labels&languages=en&format=json&formatversion=2`
    );
    for (const [qid, ent] of Object.entries(data.entities || {})) {
      if (ent.claims) out.set(qid, ent);
    }
    await sleep(1200);
  }
  return out;
}

async function main() {
  const events = JSON.parse(await fs.readFile(INPUT, "utf8"));
  const needing = events.filter((e) => e.lat === null || e.lat === undefined);
  console.log(`${events.length} events, ${needing.length} without a coordinate\n`);
  if (!needing.length) return;

  // Pass 1: the events themselves, to read their location properties.
  const subjects = await getEntities(needing.map((e) => e.qid));

  // Pass 2: everything those properties point at, to read ITS coordinate.
  const referenced = new Set();
  for (const e of needing) {
    const ent = subjects.get(e.qid);
    if (!ent) continue;
    for (const prop of SOURCES) for (const id of idsOf(ent, prop)) referenced.add(id);
  }
  console.log(`resolving ${referenced.size} referenced places...`);
  const places = await getEntities([...referenced]);

  const stats = { place: 0, region: 0, country: 0, unplaced: 0 };
  for (const e of needing) {
    const ent = subjects.get(e.qid);
    if (!ent) {
      stats.unplaced++;
      continue;
    }
    let best = null;
    for (const prop of SOURCES) {
      const ids = idsOf(ent, prop);
      if (prop === "P276" && ids.length > MAX_LOCATIONS) continue;
      for (const id of ids) {
        const p = places.get(id);
        const c = p && coordsOf(p);
        if (!c) continue;
        best = { ...c, kind: precisionOf(p), viaLabel: p.labels?.en?.value || "" };
        break;
      }
      if (best) break;
    }
    if (!best) {
      stats.unplaced++;
      continue;
    }
    e.lat = best.lat;
    e.lng = best.lng;
    e.locPrec = best.kind;
    e.locVia = best.viaLabel;
    stats[best.kind]++;
  }

  console.log(`\nplaced at the exact location given  : ${stats.place}`);
  console.log(`placed at a containing region       : ${stats.region}`);
  console.log(`placed at a country centroid        : ${stats.country}`);
  console.log(`could not be placed at all          : ${stats.unplaced}`);

  const placed = events.filter((e) => e.lat !== null && e.lat !== undefined);
  console.log(`\n${placed.length} of ${events.length} events now have a coordinate`);

  if (WRITE) {
    await fs.writeFile(INPUT, JSON.stringify(events, null, 1));
    console.log(`\nWritten back to ${INPUT}`);
  } else {
    console.log(`\nReport only. Re-run with --write to save.`);
  }
}

await main();
