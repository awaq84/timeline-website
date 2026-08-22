// Generates data/discover.js -- the pool of "Discover what else was going on in
// the world when X" prompts shown above the map.
//
// The list used to be 43 hand-written entries. Getting to 1000+ by hand isn't
// realistic, but the dataset can't just be sampled either, for two reasons:
//
//  1. Most titles aren't event-shaped. Whole categories are bare nouns -- a
//     Science & Technology row is literally "Leucippus", an Economy & Trade row
//     is "Genda Shigyo". "...going on in the world when Leucippus" is broken
//     English, so only titles matching a known pattern are used (see RULES).
//
//  2. Most events aren't famous. "Siege of Naxos" and "Magadha-Kosala War" are
//     real events but nobody has heard of them, and Discover only works if the
//     anchor is recognisable. Fame comes from the Wikidata sitelink count that
//     enrich-sitelinks.mjs caches (how many language Wikipedias carry an
//     article). For calibration: Battle of Hastings 80, WWII 292, Einstein 320.
//
// The 43 hand-written prompts are kept verbatim and always included. Generated
// phrasing is serviceable ("the Battle of Waterloo was fought"), but a human
// wrote "Napoleon was defeated at Waterloo", which is better -- so where a hand
// written question exists it wins.
//
// Usage:  node scripts/enrich-sitelinks.mjs   (once, populates the cache)
//         node scripts/build-discover.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { articleTitleFromWiki } from "./wiki-title.mjs";
import { HAND_WRITTEN, questionFor } from "./event-phrasing.mjs";
import { isBanned } from "./content-bans.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "events.js");
const SITELINKS_PATH = path.join(__dirname, "..", "data", ".cache", "sitelinks.json");
const OUT_PATH = path.join(__dirname, "..", "data", "discover.js");

// Minimum sitelinks for a generated prompt -- roughly "has an article in N
// languages", which is the practical boundary between things a general audience
// recognises and things only a specialist would. 30 rather than 45 because the
// pool needs to clear ~1000 prompts while still leaving room for the per-category
// caps below to do their job; at 45 the non-People categories are too thin to
// balance against.
const MIN_SITELINKS = Number(process.env.DISCOVER_MIN_SITELINKS || 30);
// Keeps any single category from swamping the pool. Without this the list is
// mostly People, since famous individuals far outnumber famous battles: at a
// floor of 30 the raw candidate pool is 14,275 People against 427 wars.
const MAX_PER_CATEGORY = Number(process.env.DISCOVER_MAX_PER_CATEGORY || 300);
// Keeps the pool from collapsing onto the last 200 years, which is where
// Wikipedia coverage (and therefore sitelink counts) is densest.
const MAX_PER_CENTURY = Number(process.env.DISCOVER_MAX_PER_CENTURY || 140);

// The title-to-sentence rules live in event-phrasing.mjs: the quiz builder needs
// exactly the same transformation, and two copies of this many regexes would
// drift the moment either was touched.

const centuryOf = (year) => Math.floor(year / 100);

async function main() {
  const events = new Function((await fs.readFile(DATA_PATH, "utf8")) + "\nreturn EVENTS;")();
  let sitelinks;
  try {
    sitelinks = JSON.parse(await fs.readFile(SITELINKS_PATH, "utf8"));
  } catch {
    console.error(`Missing ${SITELINKS_PATH}. Run: node scripts/enrich-sitelinks.mjs`);
    process.exit(1);
  }
  console.log(`${events.length} events, ${Object.keys(sitelinks).length} sitelink counts`);

  const fameOf = (e) => {
    const t = articleTitleFromWiki(e.wiki);
    return t ? sitelinks[t] || 0 : 0;
  };

  // Everything the app needs to act on a prompt without any event data loaded.
  // jumpToEvent() re-activates the event's category and moves the slider, then
  // spotlightMarker() finds the marker by its year|title|lat|lng key -- so those
  // five fields, and nothing else, have to travel with the prompt. Before the
  // dataset was chunked this was resolved at runtime against the full in-memory
  // EVENTS array; now the Discover panel has to be usable before a single chunk
  // has arrived, which means the answer ships with the question.
  const promptFor = (e, question) => ({
    title: e.title,
    year: e.year,
    question,
    category: e.category,
    lat: e.lat,
    lng: e.lng,
  });

  // --- Hand-written entries: always in, and loudly flagged if they've drifted.
  const chosen = [];
  const takenKeys = new Set();
  const byTitle = new Map();
  for (const e of events) if (!byTitle.has(e.title)) byTitle.set(e.title, e);

  // The same content bans the quiz applies, from the one shared file. This panel
  // shipped 100 university foundings -- "Charles University was founded", "the
  // University of Oxford was founded" -- long after the quiz stopped showing any,
  // because the rules lived inside build-quiz.mjs and nothing here imported them.
  let banned = 0;
  for (const [title, question] of Object.entries(HAND_WRITTEN)) {
    const e = byTitle.get(title);
    if (!e) {
      console.warn(`  WARN hand-written prompt has no matching event: "${title}"`);
      continue;
    }
    if (isBanned({ statement: question, title: e.title, description: e.summary || "" })) {
      banned++;
      continue;
    }
    chosen.push(promptFor(e, question));
    takenKeys.add(`${e.year}|${e.title}`);
  }
  console.log(`Kept ${chosen.length}/${Object.keys(HAND_WRITTEN).length} hand-written prompts`);

  // --- Generated candidates.
  const candidates = [];
  let phrasable = 0;
  let vague = 0;
  for (const e of events) {
    const key = `${e.year}|${e.title}`;
    if (takenKeys.has(key)) continue;
    // A prompt reads "...when X (1150)?" and jumps the slider to that year, so an
    // event whose date is only good to the century would state a year the source
    // never claimed and land the reader somewhere arbitrary. There are 104k
    // year-precise events to draw 200 prompts from, so dropping these is free.
    if (e.prec) {
      vague++;
      continue;
    }
    const question = questionFor(e.title, e.category);
    if (!question) continue;
    phrasable++;
    if (isBanned({ statement: question, title: e.title, description: e.summary || "" })) {
      banned++;
      continue;
    }
    const fame = fameOf(e);
    if (fame < MIN_SITELINKS) continue;
    candidates.push({ event: e, question, category: e.category, year: e.year, fame });
  }
  console.log(`${phrasable} phrasable titles -> ${candidates.length} above ${MIN_SITELINKS} sitelinks (${vague} skipped for an imprecise date, ${banned} banned by content rules)`);

  // Most famous first, then thinned by category and century so the pool stays
  // varied rather than 200 modern celebrities.
  candidates.sort((a, b) => b.fame - a.fame || a.year - b.year);
  const perCategory = new Map();
  const perCentury = new Map();
  const seenQuestions = new Set(chosen.map((c) => c.question.toLowerCase()));

  for (const c of candidates) {
    const cat = perCategory.get(c.category) || 0;
    if (cat >= MAX_PER_CATEGORY) continue;
    const cent = perCentury.get(centuryOf(c.year)) || 0;
    if (cent >= MAX_PER_CENTURY) continue;
    const q = c.question.toLowerCase();
    if (seenQuestions.has(q)) continue;
    perCategory.set(c.category, cat + 1);
    perCentury.set(centuryOf(c.year), cent + 1);
    seenQuestions.add(q);
    chosen.push(promptFor(c.event, c.question));
  }

  chosen.sort((a, b) => a.year - b.year);

  console.log(`\n${chosen.length} prompts total`);
  console.log("per category:");
  for (const [k, v] of [...perCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }

  const header = `// GENERATED by scripts/build-discover.mjs -- do not edit by hand.
//
// Prompts for the "Discover" jump-to-year feature. Each entry carries the year,
// category and coordinate of the event it refers to, so the panel works before
// any event chunk has loaded. Regenerate whenever data/events.js changes --
// these are a copy, and a stale one will jump to the wrong year.
//
// Regenerate with:  node scripts/build-discover.mjs
`;
  const body = chosen.map((c) => `  ${JSON.stringify(c)},`).join("\n");
  await fs.writeFile(OUT_PATH, `${header}const DISCOVERY_PROMPTS = [\n${body}\n];\n`);
  console.log(`\nWritten to ${OUT_PATH}`);
}

await main();
