// Dates ancient sites that Wikidata knows the place of but not the age of, by
// reading the construction date out of the English Wikipedia infobox.
//
// Why this exists: 2,288 of the 3,000 BC years in this dataset are completely
// empty, and the reason is not our queries. Mohenjo-daro (Q5725) has
// coordinates, forty properties and no date at all -- no P571, no P580, no
// P2348. The Pyramid of Khafre is the same. Yet the Wikipedia article carries
//
//     | built = {{circa|2500 BC}}
//
// hand-typed into the infobox and never migrated to Wikidata. For antiquity that
// is the norm rather than the exception: roughly one in four undated sites has a
// usable date sitting in its infobox. fetch-events.mjs reads the structured
// database, so it cannot see any of them.
//
// LICENSING. What this takes is a date -- a fact, not a sentence. Every word
// displayed on the site still comes from Wikidata under CC0; Wikipedia supplies
// a number and nothing else, and no article prose is copied, stored or rendered.
// That is a different act from reproducing text, but it IS a change from "all
// content is CC0 and Wikipedia is only a link target", so /attribution/ has to
// say where these dates came from before any of them ship.
//
// NOTHING IS MERGED HERE. Output goes to data/.cache/infobox-dates.json for
// review, with the source parameter and the raw wikitext kept against every
// date so a bad value can be traced back to the line it came from.
//
// Usage:  node scripts/fetch-infobox-dates.mjs [max-items]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "data", ".cache");
const OUT_PATH = path.join(CACHE_DIR, "infobox-dates.json");
const SPARQL = "https://query.wikidata.org/sparql";
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const UA = "TimelineHistory/1.0 (https://github.com/awaq84/timeline-website)";

const MAX_ITEMS = Number(process.argv[2] || process.env.INFOBOX_MAX || 6000);
const TITLES_PER_REQUEST = 40; // the API's ceiling for non-bot clients is 50
const PAUSE_MS = 350;

// Parameters that mean "when this thing was made or used".
//
// `date` and `dates` are deliberately absent. On these infoboxes they usually
// carry the publication date of a citation, and including them dated Bank barrow
// to 1984 and Black Grave to 2006 in testing -- an event four thousand years
// wrong, with nothing anywhere to flag it.
const DATE_PARAMS =
  /^\s*\|?\s*(built|founded|established|abandoned|constructed|completed|construction|erected|first_?occupied)\s*=\s*(.+)$/i;

// Types worth asking about: things that are placed and old. Kept narrow on
// purpose -- a modern building's infobox date is already in Wikidata, so casting
// wider costs requests and returns nothing new.
const TYPE_ROOTS = [
  "wd:Q839954", // archaeological site
  "wd:Q4989906", // monument
  "wd:Q44539", // temple
  "wd:Q57821", // fortification
  "wd:Q1081138", // historic site
  "wd:Q2065736", // cultural property
];

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Strips the wikitext furniture that sits between the parameter and the number:
// refs, HTML, templates like {{circa}}, and link brackets. The brackets matter
// more than they look -- "~150 [[BCE]]" left unstripped loses its era marker and
// parses as AD 150, turning a 2,175-year-old mound into a medieval one. A wrong
// sign is worse than a missing date, because nothing downstream can detect it.
function clean(raw) {
  return String(raw)
    // "B.C." and "B.C.E." before anything else. The era regexes below all use
    // \b(BCE?|BC)\b, which does not match "B.C." at all -- so every dotted BC
    // date fell through to the AD branch and came back with the WRONG SIGN.
    // "500 B.C." became AD 500. That is the exact failure this file's own
    // comments call worse than a missing date, and B.C. is standard American
    // Wikipedia style, so it covered most of the classical range.
    .replace(/\bB\.\s?C\.\s?E\./gi, "BCE")
    .replace(/\bB\.\s?C\./gi, "BC")
    .replace(/\bA\.\s?D\./gi, "AD")
    // Comma grouping: "1,200 BC" matched only "200" because (\d{1,4}) cannot
    // span a comma. This already shipped one wrong date into the harvest --
    // Omori Katsuyama, "2,000 - 1,500 BC", was recorded as 500 BC.
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/<ref[^]*?<\/ref>/gi, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\{\{\s*(circa|c\.|ca\.)\s*\|?\s*/gi, "~")
    .replace(/\{\{sfn[^}]*\}\}/gi, "")
    .replace(/\[\[([^\]|]*\|)?/g, "")
    .replace(/\]\]/g, "")
    .replace(/\}\}/g, "")
    .trim();
}

// Returns { year, prec } or null. prec follows Wikidata's own scale, which the
// rest of the pipeline already understands: 9 year, 7 century, 6 millennium.
// Reporting a millennium as a year would be exactly the false precision the
// migrate-date-precision work went to some trouble to remove.
function parseDate(raw) {
  // Measurements before anything else. A {{convert}} template or a bare unit
  // means this value is a size, not a date -- "{{convert|250|ha|abbr=on}}" reads
  // as the year 250 otherwise. These do not normally appear under a date
  // parameter, but a single wrong ancient date is expensive to notice and this
  // costs one regex.
  if (/\{\{\s*convert\b/i.test(raw)) return null;
  if (/\d\s*(ha|km|mi|ft|acres?|hectares?|metres?|meters?|m2|km2|sq)\b/i.test(raw)) return null;

  const t = clean(raw);
  if (!t) return null;

  const bc = /\b(BCE?|BC)\b/i;
  // "c. 1712" is not the year 1712, it is an estimate. clean() marks circa with
  // ~ so precision can be lowered here rather than silently asserting a year --
  // the same false precision migrate-date-precision.mjs exists to remove.
  const approx = /~|\bc(?:a|irca)?\.?\s*\d/i.test(t);
  const yearPrec = approx ? 7 : 9;
  let m;

  // "2500-1700 BC" and "between 200 and 100 BC" -- take the earlier end, which
  // is when it was built. The "and" form used to fall through to the single
  // -value branch below and return the LATER end, contradicting this rule.
  if ((m = t.match(/(\d{1,5})\s*(?:–|—|-|to|and)\s*(\d{1,5})\s*(?:BCE?|BC)\b/i)))
    return { year: -Math.max(+m[1], +m[2]), prec: yearPrec };

  if ((m = t.match(/(\d{1,2})(?:st|nd|rd|th)\s+millennium\s+(?:BCE?|BC)\b/i)))
    return { year: -(+m[1] * 1000), prec: 6 };

  // Hyphenated "5th-century BC" is very common and was matching nothing.
  if ((m = t.match(/(\d{1,2})(?:st|nd|rd|th)[-\s]centur(?:y|ies)\s+(?:BCE?|BC)\b/i)))
    return { year: -(+m[1] * 100), prec: 7 };
  // "AD 79" / "79 AD" / "79 CE" -- the AD branch below needs 3-4 digits, so the
  // whole of AD 1-99 was unreachable.
  if ((m = t.match(/\bAD\s*(\d{1,4})\b/i)) || (m = t.match(/\b(\d{1,4})\s*(?:AD|CE)\b/i))) {
    const y = +m[1];
    if (y >= 1 && y <= 2026) return { year: y, prec: yearPrec };
  }

  if ((m = t.match(/(\d{1,5})\s*(?:BCE?|BC)\b/i))) return { year: -(+m[1]), prec: yearPrec };
  // Era marker first: "BC 300", "BCE 1200".
  if ((m = t.match(/\b(?:BCE?|BC)\s*(\d{1,5})\b/i))) return { year: -(+m[1]), prec: yearPrec };

  // AD side. Only accepted when no BC marker appears anywhere in the value, so a
  // stray number in "2500 BC (excavated 1922)" cannot win.
  if (bc.test(t)) return null;

  // The 5th century AD is 401-500, so the first year is (n-1)*100+1. Returning
  // n*100 put it on the LAST year and made "21st century" the year 2100, which
  // is in the future and slipped past the <=2026 guard on the branch below.
  if ((m = t.match(/(\d{1,2})(?:st|nd|rd|th)\s+centur(?:y|ies)\b/i))) {
    const y = (+m[1] - 1) * 100 + 1;
    return y <= 2026 ? { year: y, prec: 7 } : null;
  }
  if ((m = t.match(/\b(\d{3,4})\b/))) {
    const y = +m[1];
    if (y >= 1 && y <= 2026) return { year: y, prec: yearPrec };
  }
  return null;
}

// Retried, because the failure mode here is not a clean HTTP error. Wikidata
// answers 200 and then truncates the body mid-stream when a query runs long, so
// the first sign of trouble is JSON.parse throwing on a half-written object --
// which cost us the archaeological-site results, the single most important type
// root, on the first run.
async function sparql(query, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${SPARQL}?query=${encodeURIComponent(query)}`, {
        headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return JSON.parse(text).results.bindings;
    } catch (err) {
      lastErr = err;
      const wait = 5000 * (i + 1);
      console.warn(`    attempt ${i + 1}/${attempts} failed (${err.message}); retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// Everything of an interesting type that has a place but no date, and an English
// article to read the infobox from.
async function undatedItems() {
  const out = new Map();
  for (const root of TYPE_ROOTS) {
    const q = `SELECT ?item ?itemLabel ?article ?coord ?sl WHERE {
  ?item wdt:P31/wdt:P279* ${root} ; wdt:P625 ?coord ; wikibase:sitelinks ?sl .
  FILTER NOT EXISTS { ?item wdt:P571 ?a }
  FILTER NOT EXISTS { ?item wdt:P580 ?b }
  FILTER NOT EXISTS { ?item wdt:P585 ?c }
  FILTER(?sl >= 3)
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 4000`;
    try {
      const rows = await sparql(q);
      for (const r of rows) {
        const qid = r.item.value.split("/").pop();
        if (out.has(qid)) continue;
        const c = r.coord.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
        if (!c) continue;
        out.set(qid, {
          qid,
          title: decodeURIComponent(r.article.value.split("/wiki/")[1]).replace(/_/g, " "),
          label: r.itemLabel?.value || "",
          lat: +c[2],
          lng: +c[1],
          sitelinks: +r.sl.value,
        });
      }
      console.log(`  ${root}: ${rows.length} rows, ${out.size} unique so far`);
    } catch (err) {
      console.warn(`  ${root}: ${err.message} -- skipped`);
    }
    await sleep(1500);
  }
  return [...out.values()].sort((a, b) => b.sitelinks - a.sitelinks).slice(0, MAX_ITEMS);
}

async function main() {
  await fs.mkdir(CACHE_DIR, { recursive: true });

  console.log("Finding placed-but-undated items in Wikidata...");
  const items = await undatedItems();
  console.log(`\n${items.length} candidates with an English article\n`);

  const byTitle = new Map(items.map((i) => [i.title, i]));
  const found = [];
  let checked = 0;
  let noDate = 0;

  for (let i = 0; i < items.length; i += TITLES_PER_REQUEST) {
    const batch = items.slice(i, i + TITLES_PER_REQUEST);
    const url = `${WIKI_API}?action=query&prop=revisions&rvprop=content&rvslots=main&titles=${encodeURIComponent(
      batch.map((b) => b.title).join("|")
    )}&format=json&formatversion=2`;
    let pages;
    try {
      pages = (await (await fetch(url, { headers: { "User-Agent": UA } })).json()).query?.pages || [];
    } catch (err) {
      console.warn(`  batch at ${i}: ${err.message} -- skipped`);
      await sleep(2000);
      continue;
    }

    for (const p of pages) {
      checked++;
      const item = byTitle.get(p.title);
      const text = p.revisions?.[0]?.slots?.main?.content;
      if (!item || !text) {
        noDate++;
        continue;
      }
      // Only the infobox, which is the top of the article. Reading further would
      // start picking dates out of prose, which is both less reliable and a
      // different licensing question entirely.
      let hit = null;
      for (const line of text.slice(0, 5000).split("\n")) {
        const m = line.match(DATE_PARAMS);
        if (!m) continue;
        const d = parseDate(m[2]);
        if (d) {
          hit = { param: m[1].toLowerCase(), raw: clean(m[2]).slice(0, 90), ...d };
          break;
        }
      }
      if (hit) found.push({ ...item, ...hit });
      else noDate++;
    }

    if (i % 400 === 0) console.log(`  ${checked}/${items.length} checked, ${found.length} dated`);
    await sleep(PAUSE_MS);
  }

  found.sort((a, b) => a.year - b.year);
  await fs.writeFile(OUT_PATH, JSON.stringify(found, null, 1));

  const bc = found.filter((f) => f.year < 0);
  console.log(`\n${checked} articles read`);
  console.log(`  dated from infobox : ${found.length} (${((found.length / checked) * 100).toFixed(0)}%)`);
  console.log(`  no usable date     : ${noDate}`);
  console.log(`\n  BC events gained   : ${bc.length}`);
  console.log(`  before 1000 BC     : ${found.filter((f) => f.year < -1000).length}`);
  console.log(`  before 2000 BC     : ${found.filter((f) => f.year < -2000).length}`);

  const byParam = {};
  for (const f of found) byParam[f.param] = (byParam[f.param] || 0) + 1;
  console.log("\n  by source parameter:");
  for (const [k, v] of Object.entries(byParam).sort((a, b) => b[1] - a[1]))
    console.log(`    ${String(v).padStart(5)}  ${k}`);

  const byPrec = { 9: 0, 7: 0, 6: 0 };
  for (const f of found) byPrec[f.prec]++;
  console.log(`\n  precision: ${byPrec[9]} year, ${byPrec[7]} century, ${byPrec[6]} millennium`);

  console.log(`\nWritten to ${OUT_PATH} -- nothing merged. Review before using.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
