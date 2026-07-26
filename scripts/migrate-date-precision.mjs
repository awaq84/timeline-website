// Applies data/.cache/date-precision.json to data/events.js, tagging every event
// whose date is vaguer than a year with a `prec` field.
//
// Run enrich-date-precision.mjs first.
//
// The dataset stores one exact year per event because fetch-events.mjs reads the
// truthy `wdt:` date, which carries no precision. Wikidata renders a
// century-precision claim as a concrete January 1st -- either the century's first
// year or its midpoint, depending on the item -- so "12th century" arrived as
// 1101 or 1150 and those years silently absorbed thousands of events that did not
// happen in them.
//
// What this does NOT do is move or delete events. The anchor year is still the
// best single point we have for placing a marker on the timeline, and dropping
// approximate dates would gut antiquity, where most claims are genuinely vague.
// It only records how much the year can be trusted, so the rest of the site can
// say "12th century" where it currently asserts "1101".
//
//   prec 6 millennium   7 century   8 decade
//   (9 year, 10 month and 11 day pin a year, and are left unmarked)
//
// Matching is per statement, not per item: an item routinely holds several dated
// statements at different precisions -- Fountains Abbey has P571=1101 at century
// precision and P571=1132 at year precision -- so only statements whose year
// equals the year we actually stored are considered. Where several match, the
// most precise wins, which means this can only ever declare an event *more*
// trustworthy than the worst case. Events with no cached entry (a failed batch)
// or no statement at the stored year are left untouched and treated as exact.
//
// Usage:  node scripts/migrate-date-precision.mjs [--dry-run]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { articleTitleFromWiki, qidFromWiki } from "./wiki-title.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "events.js");
const CACHE_PATH = path.join(__dirname, "..", "data", ".cache", "date-precision.json");
const DRY_RUN = process.argv.includes("--dry-run");

const PREC_NAME = { 6: "millennium", 7: "century", 8: "decade" };

const code = await fs.readFile(DATA_PATH, "utf8");
const events = new Function(code + "\nreturn EVENTS;")();
// events.js opens with a provenance comment explaining where the data came from.
// Rebuilding the file from JSON alone would silently drop it.
const header = code.slice(0, code.indexOf("const EVENTS"));
const cache = JSON.parse(await fs.readFile(CACHE_PATH, "utf8"));
console.log(`${events.length.toLocaleString()} events, ${Object.keys(cache).length.toLocaleString()} titles cached`);

// `prec` is only ever set when the site can render a sensible period from it, so
// that "e.prec is set" and "a period label exists" stay the same statement.
// Two cases can't be rendered:
//
//   - Precision 5 and below (10,000 years and coarser). Wikibase writes those as
//     "80000 years BCE", which is not a period this site has any concept of. None
//     currently reach an event -- the fetch clamps to 3001 BC -- but a widened
//     range would let one through, and "78th millennium BC" is not an improvement.
//   - Decade precision inside the decade containing year zero, where Wikibase
//     gives up on the decade and prints the year ("2 BCE"). The two events that
//     land here, Seneca's and Gallio's births, would otherwise be labelled "0s BC".
//
// Both are left unmarked, i.e. treated as year-precise. That slightly over-claims
// on a handful of events, which is a better failure than printing nonsense.
function labelable(prec, year) {
  if (prec < 6) return false;
  if (prec === 8 && Math.abs(year < 0 ? year + 1 : year) < 10) return false;
  return true;
}

const stats = { noKey: 0, notCached: 0, noStatementAtYear: 0, exact: 0, unlabelable: 0, vague: {} };

for (const e of events) {
  // A previous run's field would otherwise survive a re-run against fresh data.
  delete e.prec;

  // Article title where there is one, QID otherwise. The QID half matters more
  // than its size suggests: article-less events are the obscure end of the
  // dataset, and skipping them left /year/1000/ still claiming 139 events when
  // 108 of them had never been checked.
  const title = articleTitleFromWiki(e.wiki);
  const qid = title ? null : qidFromWiki(e.wiki);
  if (!title && !qid) {
    stats.noKey++;
    continue;
  }
  const rows = cache[title ?? `wd:${qid}`];
  if (!rows) {
    stats.notCached++;
    continue;
  }
  let best = null;
  for (const [, year, prec] of rows) {
    if (year === e.year && (best === null || prec > best)) best = prec;
  }
  if (best === null) {
    stats.noStatementAtYear++;
    continue;
  }
  if (best >= 9) {
    stats.exact++;
    continue;
  }
  if (!labelable(best, e.year)) {
    stats.unlabelable++;
    continue;
  }
  e.prec = best;
  stats.vague[best] = (stats.vague[best] || 0) + 1;
}

const marked = Object.values(stats.vague).reduce((a, b) => a + b, 0);
console.log(`\nmarked approximate: ${marked.toLocaleString()}`);
for (const p of Object.keys(stats.vague).sort())
  console.log(`  prec ${p} (${PREC_NAME[p]}): ${stats.vague[p].toLocaleString()}`);
console.log(`confirmed year-or-better: ${stats.exact.toLocaleString()}`);
console.log(`left as-is:`);
console.log(`  too coarse or unlabelable to render: ${stats.unlabelable.toLocaleString()}`);
console.log(`  no Wikipedia article and no QID: ${stats.noKey.toLocaleString()}`);
console.log(`  title not in cache: ${stats.notCached.toLocaleString()}`);
console.log(`  no statement at the stored year: ${stats.noStatementAtYear.toLocaleString()}`);

// What the spikes look like afterwards. This is the number the whole exercise is
// for, so print it rather than making someone go and check.
const byYear = new Map();
for (const e of events) {
  const s = byYear.get(e.year) || { total: 0, exact: 0 };
  s.total++;
  if (!e.prec) s.exact++;
  byYear.set(e.year, s);
}
const worst = [...byYear.entries()]
  .filter(([, s]) => s.total >= 100)
  .sort((a, b) => b[1].total - a[1].total)
  .slice(0, 12);
console.log(`\nbusiest years, exact vs approximate:`);
console.log(`year      total   exact  approx`);
for (const [y, s] of worst.sort((a, b) => a[0] - b[0]))
  console.log(
    String(y < 0 ? Math.abs(y) + " BC" : y).padEnd(9),
    String(s.total).padStart(5),
    String(s.exact).padStart(7),
    String(s.total - s.exact).padStart(7)
  );

if (DRY_RUN) {
  console.log(`\n--dry-run: ${DATA_PATH} not written.`);
} else {
  await fs.writeFile(DATA_PATH, `${header}const EVENTS = ${JSON.stringify(events)};\n`);
  console.log(`\nWrote ${DATA_PATH}`);
}
