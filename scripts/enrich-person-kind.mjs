// Asks Wikidata which events in the dataset are actually a person's life event,
// and caches the answer in data/.cache/person-kind.json.
//
// Why: five categories run personQuery() (date of death, P570) but never set a
// titleSuffix, so they produce rows titled with a bare name and filed under a
// topic -- "Giovanni Battista Calvi", an Italian military engineer who died in
// 1564, sits in Science & Technology reading as though he *were* a technology.
// This is the same defect "Historical Figures" had before migrate-people.mjs.
//
// Those categories mix people with genuine events ("Mytilenean revolt" and
// "Andrew the Apostle" are both filed under a topic), and no title pattern can
// separate them, so the only reliable test is Wikidata's own: P31 = Q5 (instance
// of human). Birth and death years come back too, so the migration can tell
// which life event a given row represents rather than assuming.
//
// Only humans are returned by the query, so a title absent from the results is
// recorded as { human: false }.
//
// Usage:  node scripts/enrich-person-kind.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { articleTitleFromWiki } from "./wiki-title.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "events.js");
const CACHE_DIR = path.join(__dirname, "..", "data", ".cache");
const CACHE_PATH = path.join(CACHE_DIR, "person-kind.json");

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "HistoricalAtlas/1.0 (https://github.com/awaq84/timeline-website)";
const BATCH_SIZE = 300;

// The categories whose fetch config includes a mode:"person" sub-query. Anything
// outside these was never produced by a person query, so it can't be affected.
export const PERSON_QUERY_CATEGORIES = [
  "Science & Technology",
  "Exploration & Discovery",
  "Religion & Belief Systems",
  "Social Movements & Revolutions",
  "Sports & Entertainment",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const literal = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\t]/g, " ")}"@en`;

async function runQuery(query, attempt = 1) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/sparql-results+json",
        // charset=UTF-8 is NOT optional. Without it Blazegraph decodes the body
        // as ISO-8859-1, so every non-ASCII character in a VALUES literal is
        // mangled and the title silently fails to join -- "Kātyāyana" (a human,
        // Q1196778) came back unmatched and was cached as { human: false }. The
        // query looks fine and returns 200; you just quietly lose every title
        // with a diacritic, which here meant most of classical Indian, Persian
        // and Greek science.
        "Content-Type": "application/sparql-query; charset=UTF-8",
        "User-Agent": USER_AGENT,
      },
      body: query,
      signal: AbortSignal.timeout(90000),
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

// Wikidata dates are ISO-ish and may be negative for BCE ("-0044-03-15T..."),
// so the year is the leading signed portion rather than a slice at a fixed index.
function yearOf(value) {
  if (!value) return null;
  const m = /^(-?\d+)/.exec(value);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  return Number.isFinite(y) ? y : null;
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

  const wanted = new Set();
  for (const e of events) {
    if (!PERSON_QUERY_CATEGORIES.includes(e.category)) continue;
    const t = articleTitleFromWiki(e.wiki);
    if (t && !(t in cache)) wanted.add(t);
  }
  const todo = [...wanted];
  console.log(`${todo.length} article titles to classify`);
  if (!todo.length) {
    console.log("Nothing to do.");
    return;
  }

  let humans = 0;
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    const query = `
SELECT ?name ?birth ?death WHERE {
  VALUES ?name { ${batch.map(literal).join(" ")} }
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?name .
  ?item wdt:P31 wd:Q5 .
  OPTIONAL { ?item wdt:P569 ?birth }
  OPTIONAL { ?item wdt:P570 ?death }
}`;
    let bindings;
    try {
      bindings = await runQuery(query);
    } catch (err) {
      console.error(`  batch ${i / BATCH_SIZE + 1} FAILED (${err.message}) -- skipping`);
      continue;
    }
    for (const b of bindings) {
      cache[b.name.value] = {
        human: true,
        birth: yearOf(b.birth?.value),
        death: yearOf(b.death?.value),
      };
    }
    // The query only returns humans, so anything still unset is not a person.
    for (const t of batch) if (!(t in cache)) cache[t] = { human: false };
    humans += bindings.length;

    const done = Math.min(i + BATCH_SIZE, todo.length);
    console.log(`  ${done}/${todo.length} titles (${bindings.length}/${batch.length} human)`);
    await fs.writeFile(CACHE_PATH, JSON.stringify(cache));
    if (done < todo.length) await sleep(700);
  }

  console.log(`\n${humans}/${todo.length} classified as human; written to ${CACHE_PATH}`);
}

// Only enrich when run directly. migrate-person-events.mjs imports
// PERSON_QUERY_CATEGORIES from here, and an unguarded top-level await main()
// would launch a full Wikidata run as a side effect of that import.
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
