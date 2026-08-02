// Replaces raw Wikidata QIDs that leaked into user-visible text with their
// English labels.
//
// 380 events carry a bare QID as their `location`, and 63 more have one inside
// `summary`, because fetch-events.mjs takes ?locLabel from the label service and
// the service returns the QID unchanged when an item has no English label. That
// value then goes straight into the page. 269 year pages currently show lines
// like:
//
//     People · Q6021337
//     Died in Q6021337. King of Leon.
//
// which reads as a bug to anyone who sees it, and is one.
//
// Labels are looked up once and cached. Where Wikidata has no English label
// either, the location is cleared rather than shown -- a blank is better than an
// identifier, and precisionLabel()/the summary templates already handle an empty
// location.
//
// Usage:  node scripts/resolve-qid-labels.mjs [--dry-run]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "events.js");
const CACHE_PATH = path.join(__dirname, "..", "data", ".cache", "qid-labels.json");
const UA = "TimelineHistory/1.0 (https://github.com/awaq84/timeline-website)";
const DRY = process.argv.includes("--dry-run");

const BARE_QID = /^Q\d+$/;
const EMBEDDED_QID = /\bQ\d{4,}\b/g;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolve(qids, cache) {
  const todo = qids.filter((q) => !(q in cache));
  console.log(`  ${qids.length} distinct QIDs, ${todo.length} not cached`);
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch.join(
      "|"
    )}&props=labels&languages=en&format=json`;
    try {
      const j = await (await fetch(url, { headers: { "User-Agent": UA } })).json();
      for (const q of batch) cache[q] = j.entities?.[q]?.labels?.en?.value || null;
    } catch (err) {
      console.warn(`    batch ${i}: ${err.message}`);
      for (const q of batch) cache[q] = cache[q] ?? null;
    }
    if (i % 250 === 0) console.log(`    ${Math.min(i + 50, todo.length)}/${todo.length}`);
    await sleep(300);
  }
  return cache;
}

async function main() {
  const src = await fs.readFile(DATA_PATH, "utf8");
  const events = new Function(`${src}\nreturn EVENTS;`)();

  const qids = new Set();
  for (const e of events) {
    if (BARE_QID.test(e.location || "")) qids.add(e.location);
    for (const m of (e.summary || "").match(EMBEDDED_QID) || []) qids.add(m);
  }
  console.log(`${events.length.toLocaleString("en-US")} events`);

  let cache = {};
  try {
    cache = JSON.parse(await fs.readFile(CACHE_PATH, "utf8"));
  } catch {
    /* first run */
  }
  cache = await resolve([...qids], cache);
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 1));

  let fixedLoc = 0;
  let clearedLoc = 0;
  let fixedSum = 0;
  for (const e of events) {
    if (BARE_QID.test(e.location || "")) {
      const label = cache[e.location];
      if (label) {
        e.location = label;
        fixedLoc++;
      } else {
        e.location = "";
        clearedLoc++;
      }
    }
    if (e.summary && EMBEDDED_QID.test(e.summary)) {
      const before = e.summary;
      e.summary = e.summary
        .replace(EMBEDDED_QID, (q) => cache[q] || "")
        // "Died in . King of Leon." once the QID is gone with no replacement.
        .replace(/\b(in|at|of|near)\s+\./gi, ".")
        .replace(/\s{2,}/g, " ")
        .replace(/\s+\./g, ".")
        .trim();
      if (e.summary !== before) fixedSum++;
    }
  }

  const resolved = Object.values(cache).filter(Boolean).length;
  console.log(`\n  QIDs resolved to a label : ${resolved}/${Object.keys(cache).length}`);
  console.log(`  locations replaced       : ${fixedLoc}`);
  console.log(`  locations cleared        : ${clearedLoc}`);
  console.log(`  summaries cleaned        : ${fixedSum}`);

  if (DRY) {
    console.log("\n--dry-run: nothing written");
    return;
  }
  const header = src.slice(0, src.indexOf("const EVENTS"));
  await fs.writeFile(DATA_PATH, `${header}const EVENTS = ${JSON.stringify(events)};\n`);
  console.log(`\nWritten to ${DATA_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
