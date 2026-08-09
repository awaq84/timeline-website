// Turns the reviewed harvest in data/.cache/infobox-dates.json into events and
// appends them to data/events.js.
//
// This is deliberately a separate script from fetch-infobox-dates.mjs, which
// refuses to merge anything itself. The dates it collects are parsed out of
// hand-typed wikitext, and the parser has been wrong in expensive ways before
// -- "500 B.C." read as AD 500, a 2,000-year range recorded as an exact year.
// Fetching and merging are separate acts so the output can be inspected, and
// re-inspected after a parser fix, before any of it reaches the site.
//
// WHAT THIS ADDS THAT WIKIDATA DOES NOT HAVE. Every item here already exists in
// Wikidata with coordinates; what it lacks is any date at all (no P571, no P580,
// no P2348). Mohenjo-daro is the type case. So these are not duplicates of rows
// the main fetcher could have found -- the main fetcher requires a date, and by
// construction none of these have one.
//
// PROVENANCE. Each merged event carries dateSource: "wikipedia-infobox", which
// is what /attribution/ counts. The existing `source` field is NOT that: it
// records whether an event links to Wikipedia or to Wikidata, and 64,541 events
// already say "wikipedia" for that reason alone. Conflating the two would make
// the attribution page overstate by an order of magnitude.
//
// The displayed TEXT still comes from Wikidata: labels and schema:description,
// both CC0, fetched here for the items being merged. Wikipedia supplies a
// number and nothing else. No article prose is copied, stored or rendered.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "events.js");
const CACHE = path.join(__dirname, "..", "data", ".cache", "infobox-dates.json");
const API = "https://www.wikidata.org/w/api.php";
const UA = "TimelineHistory/1.0 (https://github.com/awaq84/timeline-website)";

// P31 -> category. Only types that actually occur in this harvest, each checked
// against the Wikidata API rather than guessed -- an earlier guess in another
// script put Q1076486 in a list of polities on the assumption that it meant a
// form of government, when it means "sports venue".
const CATEGORY_BY_TYPE = new Map(
  Object.entries({
    Q839954: "Exploration & Discovery", // archaeological site
    Q19850823: "Exploration & Discovery", // tell
    Q1341387: "Exploration & Discovery", // shell midden
    Q1149652: "Exploration & Discovery", // burial mound
    Q5393157: "Exploration & Discovery", // earthwork
    Q44539: "Religion & Belief Systems", // temple
    Q16970: "Religion & Belief Systems", // church building
    Q32815: "Religion & Belief Systems", // mosque
    Q842402: "Religion & Belief Systems", // Hindu temple
    Q44613: "Religion & Belief Systems", // monastery
    Q39614: "Religion & Belief Systems", // cemetery
    Q162875: "Religion & Belief Systems", // mausoleum
    Q57821: "Wars & Conflicts", // fortification
    Q23413: "Wars & Conflicts", // castle
    Q1785071: "Wars & Conflicts", // fort
    Q1076486: "Sports & Entertainment", // sports venue -- yes, really
  })
);
// Everything else is a built thing with a construction date, which is what the
// "built"/"founded"/"completed" parameters this harvest reads actually describe.
const DEFAULT_CATEGORY = "Architecture & Engineering";

async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: "json", origin: "*", ...params })}`;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

const rows = JSON.parse(await fs.readFile(CACHE, "utf8"));
console.log(`Harvest holds ${rows.length} dated items`);

// --- Descriptions and types, 50 QIDs at a time (the API's batch ceiling) ---
const meta = new Map();
const qids = [...new Set(rows.map((r) => r.qid))];
for (let i = 0; i < qids.length; i += 50) {
  const batch = qids.slice(i, i + 50);
  const data = await api({
    action: "wbgetentities",
    ids: batch.join("|"),
    props: "descriptions|claims",
    languages: "en",
  });
  for (const [qid, ent] of Object.entries(data.entities || {})) {
    const desc = ent.descriptions?.en?.value || "";
    const types = (ent.claims?.P31 || [])
      .map((c) => c.mainsnak?.datavalue?.value?.id)
      .filter(Boolean);
    meta.set(qid, { desc, types });
  }
  if ((i / 50) % 10 === 0 || i + 50 >= qids.length)
    console.log(`  ${Math.min(i + 50, qids.length)}/${qids.length} items described`);
}

// --- Build events ---
const code = await fs.readFile(DATA_PATH, "utf8");
const events = new Function(code + "\nreturn EVENTS;")();
const header = code.slice(0, code.indexOf("const EVENTS"));
if (!header.trim().startsWith("//")) throw new Error("Unexpected file layout: no leading comment header");
console.log(`Loaded ${events.length} existing events`);

// Same identity the deduper and renderMarkers() use, so nothing added here can
// collide with an existing marker or with another row in this batch.
const identity = (e) => `${e.year}|${(e.wiki || "no-url").toLowerCase()}|${e.title.toLowerCase()}`;
const seen = new Set(events.map(identity));

const added = [];
let noDescription = 0;
let duplicate = 0;
for (const r of rows) {
  const m = meta.get(r.qid) || { desc: "", types: [] };
  // A row with no description would render as a bare title with nothing to read.
  // The date is the contribution here, but an event still has to say something.
  if (!m.desc) {
    noDescription++;
    continue;
  }
  const category = m.types.map((t) => CATEGORY_BY_TYPE.get(t)).find(Boolean) || DEFAULT_CATEGORY;
  const e = {
    year: r.year,
    lat: r.lat,
    lng: r.lng,
    title: r.label || r.title,
    category,
    location: "",
    summary: m.desc,
    wiki: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, "_"))}`,
    source: "wikipedia",
    dateSource: "wikipedia-infobox",
  };
  if (r.prec != null && r.prec !== 9) e.prec = r.prec;
  const k = identity(e);
  if (seen.has(k)) {
    duplicate++;
    continue;
  }
  seen.add(k);
  added.push(e);
}

console.log(`\n  ${added.length} new events`);
console.log(`  ${noDescription} skipped: no Wikidata description to display`);
console.log(`  ${duplicate} skipped: already present`);

const byCat = {};
for (const e of added) byCat[e.category] = (byCat[e.category] || 0) + 1;
console.log("\n  by category:");
for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1]))
  console.log(`    ${String(n).padStart(5)}  ${c}`);
console.log(`\n  BC events: ${added.filter((e) => e.year < 0).length}`);
console.log(`  before 1000 BC: ${added.filter((e) => e.year < -1000).length}`);

// Loop rather than push(...added): spread passes every element as its own
// argument and overflows the call stack at this dataset's size.
for (const e of added) events.push(e);
events.sort((a, b) => a.year - b.year);

await fs.writeFile(DATA_PATH, `${header}const EVENTS = ${JSON.stringify(events, null, 1)};\n`);
console.log(`\nWrote ${events.length} events to ${DATA_PATH}`);
