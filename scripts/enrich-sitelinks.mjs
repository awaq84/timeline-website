// Looks up a Wikidata sitelink count for every event in data/events.js and
// caches it in data/.cache/sitelinks.json.
//
// Why: the dataset has no notability signal. fetch-events.mjs sorts candidates
// by wikibase:sitelinks (how many language Wikipedias carry an article, a decent
// proxy for "how famous is this") but strips the number before writing, so once
// an event is in the file there's no way to tell the Battle of Hastings apart
// from the Siege of Naxos. build-discover.mjs needs exactly that distinction.
//
// Keyed on the en.wikipedia article title parsed out of each event's `wiki` URL,
// NOT on event.title. Event titles come from Wikidata labels and often disagree
// with the article name ("Siege of Naxos" vs "Siege of Naxos (499 BC)"), plus
// this script's whole job is resolving titles to items -- so it has to use the
// identifier that actually round-trips.
//
// Deliberately no ORDER BY in the query: that's what makes it fast. Sorting is
// what pushes fetch-events.mjs's broad queries past Wikidata's 60s limit; here
// each batch is a plain VALUES lookup and returns in well under a second.
//
// Resumable. Already-cached titles are skipped, so an interrupted run (or a run
// after new events are merged) only fetches what's missing.
//
// Usage:  node scripts/enrich-sitelinks.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { articleTitleFromWiki } from "./wiki-title.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "events.js");
const CACHE_DIR = path.join(__dirname, "..", "data", ".cache");
const CACHE_PATH = path.join(CACHE_DIR, "sitelinks.json");

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "TimelineHistory/1.0 (https://github.com/awaq84/timeline-website)";
const BATCH_SIZE = 400;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// POST, not GET. A 400-title VALUES clause is an ~8.5KB query, and sending that
// as a ?query= parameter makes a URL long enough that Wikidata answers 503 for
// every single batch. Same query in a POST body succeeds in under two seconds.
async function runQuery(query, attempt = 1) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/sparql-results+json",
        // charset=UTF-8 is NOT optional: without it Blazegraph decodes the body
        // as ISO-8859-1, so every VALUES literal containing a non-ASCII
        // character is mangled and silently fails to join. The batch still
        // returns 200 -- the titles just come back missing and get recorded as
        // sitelinks 0, which reads as "obscure" rather than "never asked".
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
  if ([429, 502, 503, 504].includes(res.status)) {
    if (attempt <= 5) {
      await sleep(6000 * attempt);
      return runQuery(query, attempt + 1);
    }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).results.bindings;
}

// SPARQL string literals: escape backslashes and quotes, and drop control
// characters outright. A single unescaped quote in an article title would
// otherwise break the whole batch of 400.
const literal = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\t]/g, " ")}"@en`;

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
    const t = articleTitleFromWiki(e.wiki);
    if (t && !(t in cache)) wanted.add(t);
  }
  const todo = [...wanted];
  console.log(`${events.length} events -> ${todo.length} article titles to look up`);
  if (!todo.length) {
    console.log("Nothing to do.");
    return;
  }

  let found = 0;
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    const query = `
SELECT ?name ?sitelinks WHERE {
  VALUES ?name { ${batch.map(literal).join(" ")} }
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?name .
  ?item wikibase:sitelinks ?sitelinks .
}`;
    let bindings;
    try {
      bindings = await runQuery(query);
    } catch (err) {
      console.error(`  batch ${i / BATCH_SIZE + 1} FAILED (${err.message}) -- skipping`);
      continue;
    }
    for (const b of bindings) cache[b.name.value] = parseInt(b.sitelinks.value, 10);
    // Record misses as 0 so a resumed run doesn't retry them forever. A title
    // can legitimately miss: redirects, or an article that no longer exists.
    for (const t of batch) if (!(t in cache)) cache[t] = 0;
    found += bindings.length;

    const done = Math.min(i + BATCH_SIZE, todo.length);
    console.log(`  ${done}/${todo.length} titles (${bindings.length}/${batch.length} resolved)`);
    // Flush as we go so an interrupted run keeps its progress.
    await fs.writeFile(CACHE_PATH, JSON.stringify(cache));
    if (done < todo.length) await sleep(700);
  }

  console.log(`\nResolved ${found}/${todo.length}; cache now holds ${Object.keys(cache).length} titles`);
  console.log(`Written to ${CACHE_PATH}`);
}

await main();
