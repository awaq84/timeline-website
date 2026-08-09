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
// Resume state. The first Americas run lost 42 of its 96 discovery queries to
// Wikidata 500s -- including Mexican archaeological sites, the single richest
// source of pre-Columbian dates -- and retrying them meant repeating the 54 that
// had worked and re-reading all 7,351 Wikipedia articles, about two hours to
// recover six minutes of lost work. Both phases now record what they finished:
//   discovery: which (type root, country) pairs returned, and what they held
//   articles:  which QIDs have been read, whether or not a date was found
// A failed pair simply isn't recorded, so the next run retries exactly the gaps.
const DISCOVERY_PATH = path.join(CACHE_DIR, "infobox-discovery.json");
const CHECKED_PATH = path.join(CACHE_DIR, "infobox-checked.json");
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
// The full list crossed with a 22-country set is 220 queries, and the public
// endpoint does not sustain that -- the first succeeds and the rest fail on
// every retry, at roughly four minutes per failure cycle. TYPE_ROOTS_MIN keeps
// the roots that actually hold the undated backlog for pre-Columbian work.
const TYPE_ROOTS_MIN = ["wd:Q839954", "wd:Q4989906", "wd:Q44539", "wd:Q57821"];

const TYPE_ROOTS_ALL = [
  "wd:Q839954", // archaeological site
  "wd:Q4989906", // monument
  "wd:Q44539", // temple
  "wd:Q57821", // fortification
  "wd:Q1081138", // historic site
  "wd:Q2065736", // cultural property
  "wd:Q23413", // castle
  "wd:Q16970", // church building
  "wd:Q32815", // mosque
  "wd:Q515", // city
];

const TYPE_ROOTS = process.env.INFOBOX_ALL_TYPES === "1" ? TYPE_ROOTS_ALL : TYPE_ROOTS_MIN;

// Optional country restriction, because the undated backlog is not evenly
// spread. Archaeological sites with coordinates but no date: Mexico 279 of 289,
// Peru 552 of 567, Bolivia 28 of 28. Ninety-seven per cent of pre-Columbian
// sites in those three countries are invisible to a pipeline that requires a
// date, which is why this dataset holds 42 events in North America and 50 in
// South America before 1492.
//
//   node scripts/fetch-infobox-dates.mjs 6000 americas
const COUNTRY_SETS = {
  americas: [
    "wd:Q96", "wd:Q419", "wd:Q750", "wd:Q736", "wd:Q298", "wd:Q739", // Mexico, Peru, Bolivia, Ecuador, Chile, Colombia
    "wd:Q155", "wd:Q414", "wd:Q77", "wd:Q733", // Brazil, Argentina, Uruguay, Paraguay
    "wd:Q774", "wd:Q242", "wd:Q783", "wd:Q792", "wd:Q811", "wd:Q800", "wd:Q804", // Central America
    "wd:Q241", "wd:Q790", "wd:Q786", "wd:Q766", "wd:Q1183", // Caribbean
    "wd:Q30", "wd:Q16", // USA, Canada
  ],
  // Asia was missing, and it is the set this script was written for: Mohenjo-daro
  // is the example in the header, it is in Pakistan, and no country set reached
  // it. The undated backlog is heaviest exactly here -- these are the oldest
  // built places on Earth and the ones whose dates were typed into an infobox
  // decades before anyone thought to put them in a structured database.
  "south-asia": [
    "wd:Q668", "wd:Q843", "wd:Q902", "wd:Q854", "wd:Q837", "wd:Q889", // India, Pakistan, Bangladesh, Sri Lanka, Nepal, Afghanistan
  ],
  "east-asia": ["wd:Q148", "wd:Q17"], // China, Japan
  "southeast-asia": [
    "wd:Q881", "wd:Q869", "wd:Q252", "wd:Q928", "wd:Q836", "wd:Q424", // Vietnam, Thailand, Indonesia, Philippines, Myanmar, Cambodia
  ],
  // The Fertile Crescent and the Nile: the densest concentration of dated-only
  // -in-prose ancient sites anywhere.
  "middle-east": [
    "wd:Q794", "wd:Q796", "wd:Q43", "wd:Q858", "wd:Q851", "wd:Q822", "wd:Q810", // Iran, Iraq, Turkey, Syria, Saudi Arabia, Lebanon, Jordan
    "wd:Q79", "wd:Q1016", "wd:Q262", // Egypt, Libya, Algeria
    "wd:Q265", "wd:Q232", "wd:Q863", // Uzbekistan, Kazakhstan, Tajikistan
  ],
  africa: [
    "wd:Q1033", "wd:Q117", "wd:Q912", "wd:Q1041", "wd:Q1032", "wd:Q1006", "wd:Q962", "wd:Q1008", // West
    "wd:Q115", "wd:Q114", "wd:Q924", "wd:Q1036", "wd:Q1049", "wd:Q1045", "wd:Q986", // East
    "wd:Q258", "wd:Q954", "wd:Q953", "wd:Q1029", "wd:Q916", "wd:Q1019", // Southern
  ],
};
const COUNTRY_SET = COUNTRY_SETS[process.argv[3]] || null;

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

  let t = clean(raw);
  if (!t) return null;

  // "1745, 1834-1835" is a build date followed by later additions, not a range.
  // The range branches below scan for the first range-shaped pair anywhere in
  // the string, so they skipped the 1745 entirely and dated Kentland Farm to
  // 1834 -- and Fort Roberdeau, built 1778, to its 1939 reconstruction. Take
  // the first segment, which is the original construction.
  //
  // Only when that segment actually carries a year: "March 15, 1901" splits
  // into a first segment with no year at all, and must fall through whole.
  const head = t.split(/[;,]/)[0];
  if (head !== t && /\d{3,5}/.test(head)) t = head;

  const bc = /\b(BCE?|BC)\b/i;
  // "c. 1712" is not the year 1712, but it is much closer to it than "the 18th
  // century". Circa drops precision by ONE step, to the decade -- so the site
  // renders it "1710s", which is what the source actually said.
  //
  // This was century precision at first, and that was wrong in the other
  // direction: a source saying "about 1712" was displayed as "18th century",
  // discarding almost everything it told us in the name of caution. Refusing to
  // state what a source says is not more honest than stating it with its
  // uncertainty attached.
  // "approx.", "around", "estimated" mean exactly what "c." means, and were not
  // being read that way: "approx. 4000 BC - 2000 BC" came back as the year 4000
  // BC at exact-year precision, which the site then prints as a flat "4000 BC".
  const approx = /~|\bc(?:a|irca)?\.?\s*\d/i.test(t) || /\b(?:approx|approximately|around|about|estimated?|probably)\b/i.test(t);
  // AD circa becomes a decade, BC circa a century.
  //
  // "c. 1712" means within a few years, and "1710s" says that. "c. 2500 BC"
  // means within a lifetime or two, and rendering it as a decade produces
  // "2490s BC" -- which is both a precision nobody claimed and, because the
  // decade label is derived from the astronomical year, not even the decade the
  // source named. "25th century BC" is what that source is actually asserting.
  const bcCirca = approx && /\b(BCE?|BC)\b/i.test(t);
  const yearPrec = bcCirca ? 7 : approx ? 8 : 9;
  let m;

  // A range is not an exact year, and saying so is the whole point of prec.
  // Both range branches below used to return yearPrec, so "1800-1500 BC" was
  // stored as the year 1800 BC at exact-year precision and rendered as a flat
  // "1800 BC" -- a confidence the source never offered. 319 of the 4,229 dates
  // in the first Americas harvest were ranges recorded this way.
  //
  // The returned year stays the earlier end (when building began); the span is
  // what sets how loudly to hedge it.
  const precForSpan = (span) => (span <= 25 ? 8 : span <= 250 ? 7 : 6);

  // "2500-1700 BC" and "between 200 and 100 BC" -- take the earlier end, which
  // is when it was built. The "and" form used to fall through to the single
  // -value branch below and return the LATER end, contradicting this rule.
  // The era marker is optional on the FIRST end because both spellings occur:
  // "2500-1700 BC" and "4000 BC - 2000 BC". Without it the second spelling fell
  // past this branch to the single-value one and kept only its earlier number,
  // losing the span that says how uncertain it is.
  if ((m = t.match(/(\d{1,5})\s*(?:BCE?|BC)?\s*(?:–|—|-|to|and)\s*(\d{1,5})\s*(?:BCE?|BC)\b/i))) {
    const [lo, hi] = [Math.min(+m[1], +m[2]), Math.max(+m[1], +m[2])];
    return { year: -hi, prec: Math.min(yearPrec, precForSpan(hi - lo)) };
  }

  if ((m = t.match(/(\d{1,2})(?:st|nd|rd|th)\s+millennium\s+(?:BCE?|BC)\b/i)))
    return { year: -(+m[1] * 1000), prec: 6 };

  // Hyphenated "5th-century BC" is very common and was matching nothing.
  if ((m = t.match(/(\d{1,2})(?:st|nd|rd|th)[-\s]centur(?:y|ies)\s+(?:BCE?|BC)\b/i)))
    return { year: -(+m[1] * 100), prec: 7 };
  // The AD side had no range branch at all, so "0-499 AD" was read by the "79
  // AD" branch below as the year 499 -- the LATER end, the opposite of the rule
  // the BC branch follows, and at exact-year precision. Pinson Mounds and Old
  // Stone Fort both came back as built in exactly AD 499.
  //
  // Guarded on bc so an era-first "BC 300-200" cannot land here, and requires
  // hi > lo so an ISO date ("1980-01-01" -> 1980, 1) falls through instead of
  // being read as a range running backwards.
  if (!bc.test(t) && (m = t.match(/\b(\d{1,4})\s*(?:–|—|-|to|and)\s*(\d{1,4})\b/i))) {
    const [lo, hi] = [+m[1], +m[2]];
    if (hi > lo && hi <= 2026) return { year: Math.max(1, lo), prec: Math.min(yearPrec, precForSpan(hi - lo)) };
  }

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
// One country at a time when a country set is given.
//
// The natural form -- one VALUES clause holding all 22 countries, crossed with
// wdt:P279* over the type root -- fails outright on the public endpoint: it
// returns 502 or drops the socket on every retry, while a trivial query against
// the same endpoint answers in 0.27s. It is query cost, not availability. The
// per-country shape is proven: it returned Mexico 279, Peru 552 and Bolivia 28
// while the combined one was still failing.
async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function undatedItems() {
  const out = new Map();
  const cache = await readJson(DISCOVERY_PATH, {});
  const countries = COUNTRY_SET || [null];
  let reused = 0;
  let queried = 0;
  let failed = 0;
  for (const root of TYPE_ROOTS) {
    for (const country of countries) {
      const cacheKey = `${root}|${country || "world"}`;
      if (cache[cacheKey]) {
        for (const it of cache[cacheKey]) if (!out.has(it.qid)) out.set(it.qid, it);
        reused++;
        continue;
      }
      const countryClause = country ? `?item wdt:P17 ${country} .` : "";
    const q = `SELECT ?item ?itemLabel ?article ?coord ?sl WHERE {
  ?item wdt:P31/wdt:P279* ${root} ; wdt:P625 ?coord ; wikibase:sitelinks ?sl .
  ${countryClause}
  FILTER NOT EXISTS { ?item wdt:P571 ?a }
  FILTER NOT EXISTS { ?item wdt:P580 ?b }
  FILTER NOT EXISTS { ?item wdt:P585 ?c }
  FILTER(?sl >= ${COUNTRY_SET ? 1 : 3})
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 4000`;
      try {
        const rows = await sparql(q);
        const batch = [];
        for (const r of rows) {
          const qid = r.item.value.split("/").pop();
          const c = r.coord.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
          if (!c) continue;
          const item = {
            qid,
            title: decodeURIComponent(r.article.value.split("/wiki/")[1]).replace(/_/g, " "),
            label: r.itemLabel?.value || "",
            lat: +c[2],
            lng: +c[1],
            sitelinks: +r.sl.value,
          };
          batch.push(item);
          if (!out.has(qid)) out.set(qid, item);
        }
        // Written per pair, not at the end, so a crash or a kill keeps every
        // query that already succeeded. An empty result is still a completed
        // query and must be recorded, or it is retried forever.
        cache[cacheKey] = batch;
        await fs.writeFile(DISCOVERY_PATH, JSON.stringify(cache));
        queried++;
        if (rows.length) console.log(`  ${root} ${country || "world"}: ${rows.length} rows, ${out.size} unique`);
      } catch (err) {
        failed++;
        console.warn(`  ${root} ${country || "world"}: ${err.message} -- skipped (will retry next run)`);
      }
      await sleep(3000);
    }
  }
  console.log(`\n  discovery: ${reused} pairs from cache, ${queried} queried, ${failed} failed`);
  return [...out.values()].sort((a, b) => b.sitelinks - a.sitelinks).slice(0, MAX_ITEMS);
}

async function main() {
  await fs.mkdir(CACHE_DIR, { recursive: true });

  console.log("Finding placed-but-undated items in Wikidata...");
  const items = await undatedItems();
  console.log(`\n${items.length} candidates with an English article\n`);

  // Articles already read on a previous run, whether or not they yielded a date.
  // Without this the retry of a handful of failed discovery queries re-reads
  // every article again -- 7,351 of them last time, for six minutes of new work.
  const checkedBefore = new Set(await readJson(CHECKED_PATH, []));
  const previous = await readJson(OUT_PATH, []);
  const pending = items.filter((i) => !checkedBefore.has(i.qid));
  console.log(
    `  ${items.length} candidates, ${items.length - pending.length} already read, ${pending.length} to read\n`
  );

  const byTitle = new Map(pending.map((i) => [i.title, i]));
  const found = [];
  let checked = 0;
  let noDate = 0;

  for (let i = 0; i < pending.length; i += TITLES_PER_REQUEST) {
    const batch = pending.slice(i, i + TITLES_PER_REQUEST);
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

    if (i % 400 === 0) console.log(`  ${checked}/${pending.length} checked, ${found.length} dated`);
    await sleep(PAUSE_MS);
  }

  // Merged with the previous harvest rather than replacing it: this run only
  // read the articles the last one missed, so `found` alone is not the dataset.
  const byQid = new Map(previous.map((p) => [p.qid, p]));
  for (const f of found) byQid.set(f.qid, f);
  const all = [...byQid.values()].sort((a, b) => a.year - b.year);
  await fs.writeFile(OUT_PATH, JSON.stringify(all, null, 1));
  for (const it of pending) checkedBefore.add(it.qid);
  await fs.writeFile(CHECKED_PATH, JSON.stringify([...checkedBefore]));
  console.log(`\n  harvest now holds ${all.length} dated items (${found.length} new this run)`);

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
