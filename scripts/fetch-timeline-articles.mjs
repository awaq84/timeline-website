// Harvests the landmark events of a national history from Wikipedia's own
// timeline articles, and resolves each one to a Wikidata item.
//
// WHY THIS EXISTS
//
// The Wikidata harvest is very good at things that ARE places -- forts, abbeys,
// battlefields -- and blind to the events a person would actually name if asked
// for the history of a country. Roman Britain in this dataset is 55 rows, 41 of
// them distinct, mostly hillforts and the death dates of governors, with dead
// gaps at 150-211, 211-290 and 306-354. Hadrian's Wall was absent. So was the
// Claudian invasion, the end of Roman rule, the Danelaw, Domesday and the
// Dissolution.
//
// Those are not missing from Wikidata for one reason, they are missing for three,
// and only the third needs this script:
//
//   1. Present with coordinates and a date, never queried because no pass asked
//      for their P31. Hadrian's Wall was this. Fixed in fetch-events.mjs.
//   2. Present with coordinates and no date. Sutton Hoo, Lindisfarne, the
//      Danelaw. fetch-infobox-dates.mjs is the tool for those.
//   3. Present with a date and NO COORDINATES, because they are documents or
//      processes rather than places -- Domesday Book, the Dissolution, the Acts
//      of Union, the end of Roman rule in Britain. Nothing that requires a
//      coordinate can find these, and a curated list is the only way in.
//
// Wikipedia's "Timeline of ..." articles are that curated list, written by people
// who know which events matter, and every entry links to the article for the
// thing it describes. This walks those links.
//
// WHAT IS TAKEN, AND WHAT IS NOT
//
// Two rules, both load-bearing, both the same ones fetch-lang-dates.mjs follows:
//
//   Only the YEAR and the LINK are read from Wikipedia. A year is a fact and
//   carries no copyright; a wiki link is an identifier. The prose around them is
//   CC BY-SA and is never copied -- "London is destroyed" does not enter the
//   dataset in any form.
//
//   Everything DISPLAYED comes from Wikidata: the label as the title, the
//   schema:description as the summary. Both are CC0. So a harvested event reads
//   exactly like every other event on the site, because it is made of the same
//   material.
//
// VERIFICATION
//
// A link is kept only when Wikidata independently agrees it is a dated event:
// the item must carry P585/P580/P571 whose year matches the year the timeline
// row states, within a tolerance of one for calendar drift. A row about people
// with no dated event among its links is dropped rather than guessed at. That is
// what stops "Aulus Plautius leads an army" becoming an event called "Aulus
// Plautius" dated to the invasion.
//
// Writes to data/.cache/ only. Nothing reaches data/events.js without
// scripts/merge-events.mjs being run deliberately.
//
// Usage:
//   node scripts/fetch-timeline-articles.mjs            # Britain, report only
//   node scripts/fetch-timeline-articles.mjs --write    # also write the cache

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "data", ".cache");
const OUT_PATH = path.join(CACHE_DIR, "timeline-events.json");
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WD_API = "https://www.wikidata.org/w/api.php";
const UA = "TimelineHistoryBuildScript/1.0 (personal educational project)";
const WRITE = process.argv.includes("--write");

// Only these carry real entries. The 1700-1799, 1800-1899 and 20th-century
// articles are navigation stubs -- bodies of "{{years in decade|1720|England}}"
// pointing at "1720 in England" -- with no events of their own, so they are not
// listed. The per-year articles they point to are a separate and much larger
// harvest.
const ARTICLES = [
  "Timeline of British history",
  "Timeline of British history (before 1000)",
  "Timeline of British history (1000–1499)",
  "Timeline of British history (1600–1699)",
  "Timeline of conflict in Anglo-Saxon Britain",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Both APIs answer a burst with a plain-text "You are making too many requests"
// rather than JSON or a 429, so a naive JSON.parse throws something that looks
// like a parser bug. Back off and retry instead of losing the batch.
async function fetchJson(url, attempts = 5) {
  let wait = 1500;
  for (let i = 1; i <= attempts; i++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const text = await res.text();
    if (text.startsWith("{") || text.startsWith("[")) {
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
  throw new Error("unreachable");
}

// --- Parsing ---

// The twelve articles use two different layouts and the parser has to read both.
//
// The overview article is a table:
//   |-
//   |43
//   |?
//   |[[Aulus Plautius]] leads an army of forty thousand to invade [[Great Britain]].
//
// The per-era articles are bullet lists, and these are the ones that matter --
// they are where Hadrian's Wall and the Antonine Wall actually live:
//   *122: Construction of [[Hadrian's Wall]] begins.
//   *c. 84: Romans defeat [[Caledonians]] at the [[battle of Mons Graupius]]
//
// Neither layout is guaranteed per article, so both are attempted on every one.
const YEAR_CELL = /^\|?\s*(?:\{\{[^}]*\}\}\s*)?(\d{1,4})\s*(?:BCE?|BC)?\s*$/i;
// "*43:", "*c. 84:", "*c.500 BC –", "* 1066 –". The circa marker is accepted and
// then ignored: the year is still the year the article is asserting, and the
// Wikidata cross-check below is what decides whether to believe it.
const BULLET = /^\*+\s*(?:c\.?\s*|circa\s+|about\s+)?(\d{1,4})\s*(BCE?|BC)?\s*[:–—-]/i;
const LINK = /\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g;

// Refs and comments carry links that are citations, not subjects: a
// "[[Great Britain]]" inside a <ref> is a source, not the event.
const stripFurniture = (t) =>
  t
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

function linksIn(text) {
  const out = [];
  for (const m of text.matchAll(LINK)) {
    const t = m[1].trim();
    // Namespaced links are files, categories and templates, never subjects.
    if (/^(File|Image|Category|Template|Wikipedia|Help|Portal|wikt):/i.test(t)) continue;
    if (t) out.push(t.replace(/_/g, " "));
  }
  return out;
}

function parseRows(wikitext) {
  const rows = [];
  const clean = stripFurniture(wikitext);

  // --- bullet lists ---
  // A "=== BC ===" heading flips the sign for everything under it, because the
  // bullets below it write "*500:" and mean 500 BC.
  let bcSection = false;
  for (const line of clean.split("\n")) {
    const heading = line.match(/^=+\s*(.+?)\s*=+$/);
    if (heading) {
      const h = heading[1];
      if (/\bBCE?\b|\bBC\b|Prehistor/i.test(h)) bcSection = true;
      else if (/\bAD\b|\bCE\b|century|^\d/i.test(h)) bcSection = false;
      continue;
    }
    const m = line.match(BULLET);
    if (!m) continue;
    const links = linksIn(line);
    if (!links.length) continue;
    const bc = Boolean(m[2]) || bcSection;
    const year = bc ? -Number(m[1]) : Number(m[1]);
    rows.push({ year, links: [...new Set(links)] });
  }

  // --- tables ---
  for (const block of clean.split(/^\|-.*$/m)) {
    const cells = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("|") && l !== "|}" && l !== "|-");
    if (!cells.length) continue;
    let year = null;
    const links = [];
    for (const cell of cells) {
      const y = cell.match(YEAR_CELL);
      if (y && year === null) {
        year = Number(y[1]);
        continue;
      }
      links.push(...linksIn(cell));
    }
    if (year === null || !links.length) continue;
    rows.push({ year, links: [...new Set(links)] });
  }

  return rows.filter((r) => r.year >= -4000 && r.year <= 2100 && r.year !== 0);
}

// --- Wikidata resolution ---

// Things that are not events, however confidently Wikidata dates them.
//
// A timeline row links to everything it mentions, and the date check below only
// proves that a linked item HAS a date near the stated year -- not that it is a
// piece of history. "Sherlock Holmes" is a fictional human dated 1887, and it
// passed every other test. So did EastEnders and a preserved locomotive.
//
// Deliberately narrow. Newspapers, banks and political parties are NOT rejected:
// the founding of the Bank of England in 1694 or the Labour Party in 1900 is the
// same kind of fact as every other institution founding already in the dataset,
// and dropping them would be an editorial judgement rather than a correctness
// one. Only things that cannot be an event at all are listed.
const NOT_AN_EVENT = new Set([
  "Q15632617", // fictional human
  "Q3658341", // literary character
  "Q15773317", // television character
  "Q15773347", // film character
  "Q5398426", // television series
  "Q20650761", // tender locomotive
  "Q1114461", // comics character
  "Q95074", // fictional character
]);

const isNotAnEvent = (ent) =>
  (ent.claims?.P31 || [])
    .map((c) => c.mainsnak?.datavalue?.value?.id)
    .some((t) => NOT_AN_EVENT.has(t));

const DATE_PROPS = ["P585", "P580", "P571", "P571"];

function claimYear(entity, prop) {
  for (const c of entity.claims?.[prop] || []) {
    const t = c.mainsnak?.datavalue?.value?.time;
    if (!t) continue;
    const m = t.match(/^([+-])(\d{4})/);
    if (!m) continue;
    const y = Number(m[2]);
    return m[1] === "-" ? -y : y;
  }
  return null;
}

function coordsOf(entity) {
  const c = entity.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
  if (!c || typeof c.latitude !== "number") return null;
  return { lat: c.latitude, lng: c.longitude };
}

async function resolveBatch(titles) {
  const url =
    `${WD_API}?action=wbgetentities&sites=enwiki&titles=${encodeURIComponent(titles.join("|"))}` +
    `&props=claims|labels|descriptions|sitelinks&languages=en&format=json&formatversion=2`;
  const data = await fetchJson(url);
  const out = new Map();
  for (const [qid, ent] of Object.entries(data.entities || {})) {
    if (!ent.claims) continue;
    const article = ent.sitelinks?.enwiki?.title;
    if (!article) continue;
    out.set(article, { qid, ent });
  }
  return out;
}

// --- Main ---

async function main() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  console.log(`Reading ${ARTICLES.length} timeline articles...\n`);

  const allRows = [];
  for (const title of ARTICLES) {
    const url =
      `${WIKI_API}?action=query&prop=revisions&rvprop=content&rvslots=main` +
      `&titles=${encodeURIComponent(title)}&format=json&formatversion=2`;
    let page;
    try {
      page = (await fetchJson(url)).query?.pages?.[0];
    } catch (err) {
      console.warn(`  ${title}: ${err.message} -- skipped`);
      continue;
    }
    const text = page?.revisions?.[0]?.slots?.main?.content;
    if (!text) {
      console.warn(`  ${title}: no content -- skipped`);
      continue;
    }
    const rows = parseRows(text);
    console.log(`  ${String(rows.length).padStart(4)} rows  ${title}`);
    allRows.push(...rows);
    await sleep(1200);
  }

  // One candidate per (year, link). The same article is linked from many rows,
  // and only the row whose year matches its Wikidata date should survive.
  const candidates = new Map();
  for (const r of allRows) {
    for (const link of r.links) {
      const key = `${r.year}|${link}`;
      if (!candidates.has(key)) candidates.set(key, { year: r.year, link });
    }
  }
  const titles = [...new Set([...candidates.values()].map((c) => c.link))];
  console.log(`\n${allRows.length} rows -> ${candidates.size} (year, link) pairs across ${titles.length} articles`);
  console.log(`Resolving against Wikidata...`);

  const resolved = new Map();
  for (let i = 0; i < titles.length; i += 40) {
    const batch = titles.slice(i, i + 40);
    try {
      const got = await resolveBatch(batch);
      for (const [k, v] of got) resolved.set(k, v);
    } catch (err) {
      console.warn(`  batch at ${i}: ${err.message} -- skipped`);
    }
    if (i % 200 === 0) console.log(`  ${Math.min(i + 40, titles.length)}/${titles.length}`);
    await sleep(1200);
  }
  console.log(`  resolved ${resolved.size}/${titles.length}`);

  // Keep only pairs where Wikidata independently confirms a dated event at the
  // year the timeline claims.
  const kept = [];
  const reasons = { unresolved: 0, noDate: 0, yearMismatch: 0, noLabel: 0, noCoords: 0, notAnEvent: 0 };
  for (const { year, link } of candidates.values()) {
    const hit = resolved.get(link);
    if (!hit) {
      reasons.unresolved++;
      continue;
    }
    const { qid, ent } = hit;
    if (isNotAnEvent(ent)) {
      reasons.notAnEvent++;
      continue;
    }
    let matched = null;
    for (const p of DATE_PROPS) {
      const y = claimYear(ent, p);
      if (y === null) continue;
      if (Math.abs(y - year) <= 1) {
        matched = { prop: p, year: y };
        break;
      }
    }
    if (!matched) {
      const anyDate = DATE_PROPS.some((p) => claimYear(ent, p) !== null);
      if (anyDate) reasons.yearMismatch++;
      else reasons.noDate++;
      continue;
    }
    const label = ent.labels?.en?.value;
    if (!label) {
      reasons.noLabel++;
      continue;
    }
    const coords = coordsOf(ent);
    if (!coords) reasons.noCoords++;
    kept.push({
      year: matched.year,
      title: label,
      summary: ent.descriptions?.en?.value
        ? ent.descriptions.en.value.charAt(0).toUpperCase() + ent.descriptions.en.value.slice(1)
        : "",
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      wiki: `https://en.wikipedia.org/wiki/${encodeURIComponent(link.replace(/ /g, "_"))}`,
      qid,
      dateProp: matched.prop,
    });
  }

  // Same subject can be confirmed by several rows; keep one per QID+year.
  const unique = new Map();
  for (const k of kept) unique.set(`${k.qid}|${k.year}`, k);
  const events = [...unique.values()].sort((a, b) => a.year - b.year);

  console.log(`\nConfirmed by Wikidata at the stated year: ${events.length}`);
  console.log(`  rejected -- no Wikidata item      : ${reasons.unresolved}`);
  console.log(`  rejected -- item has no date      : ${reasons.noDate}`);
  console.log(`  rejected -- date disagrees        : ${reasons.yearMismatch}`);
  console.log(`  rejected -- not an event at all   : ${reasons.notAnEvent}`);
  const withCoords = events.filter((e) => e.lat !== null).length;
  console.log(`\n  with coordinates   : ${withCoords}`);
  console.log(`  without coordinates: ${events.length - withCoords}  (documents and processes)`);

  if (WRITE) {
    await fs.writeFile(OUT_PATH, JSON.stringify(events, null, 1));
    console.log(`\nWritten to ${OUT_PATH}`);
  } else {
    console.log(`\nReport only. Re-run with --write to save to ${OUT_PATH}`);
  }
  return events;
}

export { parseRows };

if (import.meta.url === `file://${process.argv[1]}`) await main();
