// Asks Wikidata how precise each event's date actually is, and caches the answer
// in data/.cache/date-precision.json.
//
// Why: fetch-events.mjs selects the truthy `wdt:` date value, which is a plain
// xsd:dateTime with no indication of how vague the underlying claim was. Wikidata
// keeps precision on the statement's *value node* -- p:P571 -> psv:P571 ->
// wikibase:timePrecision -- so it is structurally unavailable to a wdt: query and
// was never requested. Every approximate date therefore landed in the dataset as
// an exact year.
//
// The damage is not evenly spread. Wikidata renders a century as either its first
// year or its midpoint depending on the item, so "12th century" arrives as 1101 or
// 1150, and those two years accumulate thousands of events that did not happen in
// them: /year/1150/ claimed 490 events, 51x its neighbours. Millennium-precision
// claims do the same to antiquity -- the oldest event in the dataset, the Maltese
// temple at Debdieba, is a precision-6 (millennium) claim presented as "3001 BC".
//
// Precision codes, from Wikidata's model:
//   6 millennium   7 century   8 decade   9 year   10 month   11 day
// 9 and above pin a year; 8 and below do not.
//
// One item usually carries several dated statements, sometimes at different
// precisions -- Fountains Abbey has P571=1101 at century precision *and*
// P571=1132 at year precision. So this caches every (property, year, precision)
// triple per article and leaves the matching to migrate-date-precision.mjs, which
// knows which year fetch-events.mjs actually stored.
//
// Resumable: re-running picks up whatever isn't cached yet.
//
// Usage:  node scripts/enrich-date-precision.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { articleTitleFromWiki, qidFromWiki } from "./wiki-title.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "events.js");
const CACHE_DIR = path.join(__dirname, "..", "data", ".cache");
const CACHE_PATH = path.join(CACHE_DIR, "date-precision.json");

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "TimelineHistory/1.0 (https://github.com/awaq84/timeline-website)";
const BATCH_SIZE = 300;

// Every date property fetch-events.mjs can coalesce into ?date. A property absent
// from this list would come back with no precision and be treated as exact, so
// keep it in step with the category configs in fetch-events.mjs.
const PROPS = ["P585", "P580", "P571", "P570", "P569", "P575", "P576"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const literal = (s) =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\t]/g, " ")}"@en`;

async function runQuery(query, attempt = 1) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/sparql-results+json",
        // charset=UTF-8 is NOT optional -- without it Blazegraph decodes the body
        // as ISO-8859-1 and every VALUES literal with a diacritic silently fails
        // to join. See the note in enrich-person-kind.mjs.
        "Content-Type": "application/sparql-query; charset=UTF-8",
        "User-Agent": USER_AGENT,
      },
      body: query,
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    if (attempt <= 4) {
      await sleep(4000 * attempt);
      return runQuery(query, attempt + 1);
    }
    throw err;
  }
  if ([429, 502, 503, 504].includes(res.status) && attempt <= 5) {
    await sleep(6000 * attempt);
    return runQuery(query, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).results.bindings;
}

// A UNION rather than seven OPTIONALs. OPTIONAL blocks cross-join, so an item with
// three P571 statements and two P570s would return six rows and a batch of 300
// titles could balloon into tens of thousands; the UNION returns one row per
// statement. It also keeps every predicate concrete -- the generic
// `?prop wikibase:claim ?p` form makes Blazegraph scan every statement in the
// graph and reliably 504s.
function statementUnion() {
  return PROPS.map(
    (p) => `
    { ?item p:${p} ?st . ?st psv:${p} ?vn .
      ?vn wikibase:timeValue ?t ; wikibase:timePrecision ?prec .
      BIND("${p}" AS ?prop) }`
  ).join(" UNION");
}

function buildTitleQuery(titles) {
  return `SELECT ?name ?prop ?t ?prec WHERE {
  VALUES ?name { ${titles.map(literal).join(" ")} }
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?name .
  {${statementUnion()}
  }
}`;
}

// Events without an English Wikipedia article are joined on their QID instead.
// BIND(STR(...)) so the result comes back as a plain "Q42" string and both passes
// can share one cache shape.
function buildQidQuery(qids) {
  return `SELECT ?name ?prop ?t ?prec WHERE {
  VALUES ?item { ${qids.map((q) => `wd:${q}`).join(" ")} }
  BIND(STRAFTER(STR(?item), "entity/") AS ?name)
  {${statementUnion()}
  }
}`;
}

// Wikidata uses astronomical year numbering (year 0 = 1 BC) and the dataset stores
// BC years as negatives (776 BC -> -776). This must stay identical to
// toDisplayYear() in fetch-events.mjs or the years won't match up.
function toDisplayYear(isoDate) {
  const m = /^(-?\d+)-/.exec(isoDate);
  if (!m) return null;
  const astronomical = parseInt(m[1], 10);
  return astronomical <= 0 ? astronomical - 1 : astronomical;
}

async function main() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const events = new Function((await fs.readFile(DATA_PATH, "utf8")) + "\nreturn EVENTS;")();

  let cache = {};
  try {
    cache = JSON.parse(await fs.readFile(CACHE_PATH, "utf8"));
    console.log(`Resuming: ${Object.keys(cache).length} titles already cached`);
  } catch {
    /* first run */
  }

  // Two join keys, one cache. An article-less event carries its QID in the wiki
  // URL, so it's keyed "wd:Q42" -- prefixed so it can never collide with an
  // article whose title happens to look like a QID.
  const wantedTitles = new Set();
  const wantedQids = new Set();
  for (const e of events) {
    const t = articleTitleFromWiki(e.wiki);
    if (t) {
      if (!(t in cache)) wantedTitles.add(t);
      continue;
    }
    const q = qidFromWiki(e.wiki);
    if (q && !(`wd:${q}` in cache)) wantedQids.add(q);
  }

  const passes = [
    { label: "article titles", keys: [...wantedTitles], build: buildTitleQuery, keyOf: (k) => k },
    { label: "Wikidata QIDs", keys: [...wantedQids], build: buildQidQuery, keyOf: (k) => `wd:${k}` },
  ].filter((p) => p.keys.length);

  if (!passes.length) {
    console.log("Nothing to do.");
    return;
  }

  let failed = 0;
  for (const pass of passes) {
    const todo = pass.keys;
    console.log(`\n${todo.length} ${pass.label} to look up (${Math.ceil(todo.length / BATCH_SIZE)} batches)`);
    const started = Date.now();

    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
      const batch = todo.slice(i, i + BATCH_SIZE);
      let bindings;
      try {
        bindings = await runQuery(pass.build(batch));
      } catch (err) {
        // Leave the batch out of the cache entirely so a re-run retries it.
        // Writing an empty result would look identical to "no dated statements"
        // and bake the failure in permanently.
        console.error(`  batch ${i / BATCH_SIZE + 1} FAILED (${err.message}) -- will retry on re-run`);
        failed += batch.length;
        continue;
      }

      // Seed every key in the batch, so a subject with no dated statement is
      // recorded as "checked, nothing found" rather than looking unqueried.
      for (const k of batch) cache[pass.keyOf(k)] = [];
      for (const b of bindings) {
        const year = toDisplayYear(b.t.value);
        if (year === null) continue;
        const row = [b.prop.value, year, parseInt(b.prec.value, 10)];
        const list = cache[pass.keyOf(b.name.value)] || (cache[pass.keyOf(b.name.value)] = []);
        // The same property can repeat the same year at the same precision across
        // several statements (different sources); one entry is enough.
        if (!list.some((r) => r[0] === row[0] && r[1] === row[1] && r[2] === row[2])) list.push(row);
      }

      const done = Math.min(i + BATCH_SIZE, todo.length);
      const eta = Math.round((((Date.now() - started) / done) * (todo.length - done)) / 1000);
      console.log(`  ${done}/${todo.length}, ${bindings.length} statements (eta ${Math.floor(eta / 60)}m${eta % 60}s)`);
      await fs.writeFile(CACHE_PATH, JSON.stringify(cache));
      if (done < todo.length) await sleep(400);
    }
  }

  console.log(`\n${Object.keys(cache).length} subjects cached to ${CACHE_PATH}`);
  if (failed) console.log(`${failed} failed -- re-run to pick them up.`);
}

await main();
