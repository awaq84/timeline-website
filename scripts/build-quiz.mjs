// Generates data/quiz.js -- the event pool behind "Test your knowledge".
//
// The quiz shows four events and a target period, and asks which two fall in it.
// That is a graded question, so the bar for what may enter this pool is higher
// than anywhere else on the site: a wrong or unreadable entry does not just look
// untidy, it marks the player wrong.
//
// Four filters, each rejecting a specific way an event breaks a quiz:
//
//  1. EXACT YEARS ONLY. Events carrying `prec` are dated to a century, decade or
//     millennium and only anchored to a placeholder year -- see
//     migrate-date-precision.mjs. Asking "did this happen in 1150?" about
//     something Wikidata records as "12th century" is exactly the false
//     precision the rest of the site goes out of its way not to claim.
//
//  2. THE TITLE MUST STATE WHAT HAPPENED. Most titles are bare nouns: "Brazil",
//     "Leucippus", "Trapani Cathedral". Shown as a quiz option, "Brazil" gives
//     the player nothing to judge. questionFor() in event-phrasing.mjs turns a
//     title into a clause where it safely can and returns null where it cannot,
//     and null means the event is dropped.
//
//  3. NO "Empires & Countries". Those rows come from Wikidata inception dates
//     and read "United States founded, 1784", "France founded, 1804". As a fact
//     to browse past that is a curiosity; as a graded answer it is indefensible,
//     and it would be the site telling a player they were wrong for saying 1776.
//     The category is otherwise fine, so it stays everywhere else on the site.
//
//  4. FAME, ON TWO TIERS. An event nobody recognises makes an unanswerable
//     question, so entries need a Wikidata sitelink count (how many language
//     Wikipedias carry the article) from enrich-sitelinks.mjs. People get a much
//     higher bar than everything else, because they overwhelm the pool
//     otherwise: at a single threshold of 12 the pool is 84% birth and death
//     dates, which is both the dullest and the hardest kind of question. The
//     split keeps famous people in and turns the pool back into a mix.
//
// Usage:  node scripts/enrich-sitelinks.mjs   (once, populates the cache)
//         node scripts/build-quiz.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { articleTitleFromWiki } from "./wiki-title.mjs";
import { HAND_WRITTEN, questionFor } from "./event-phrasing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "events.js");
const SITELINKS_PATH = path.join(__dirname, "..", "data", ".cache", "sitelinks.json");
const OUT_PATH = path.join(__dirname, "..", "data", "quiz.js");

const MIN_FAME_OTHER = Number(process.env.QUIZ_MIN_FAME_OTHER || 12);
const MIN_FAME_PEOPLE = Number(process.env.QUIZ_MIN_FAME_PEOPLE || 90);

// Wikipedia is densest on the last two centuries, and without a ceiling the pool
// inherits that: every question would land after 1800. This trims the crowded
// centuries rather than padding the empty ones, keeping the sparse eras
// proportionally present instead of pretending they are as well recorded.
const MAX_PER_CENTURY = Number(process.env.QUIZ_MAX_PER_CENTURY || 260);

// Stands in for the Infinity the hand-written phrasings carry through the
// candidate list. They are the moon landing, Pearl Harbor, the fall of the
// Berlin Wall, and they belong on level 1 whatever their sitelink count says;
// this just has to sit above the real maximum (Einstein, 320) to put them there.
const HAND_FAME = 999;

// A run is ten questions, one per level, and both axes tighten together: the
// window narrows from fifty years to five while the fame floor drops, so the
// events stop being ones everybody knows. Either axis alone would be a weaker
// ramp -- a narrow window full of famous events is still easy, and obscure
// events across fifty years are guessable from vibes.
//
// The floors are Wikidata sitelink counts, and the pool's own distribution set
// them: p50 is 34, p75 is 118, p90 is 166. Level 1 at 120 is therefore roughly
// the top quarter of an already-filtered pool, which is where the genuinely
// world-known events live.
//
// This ships in data/quiz.js rather than living in the client, so the build can
// check every level against the pool it just generated. The names are the
// payoff: they run from cheerful ignorance through overconfidence to something
// unbearable, and the one you finish on is the shareable part.
const LEVELS = [
  { n: 1, span: 50, minFame: 120, name: "I Know History Is a Thing" },
  { n: 2, span: 45, minFame: 90, name: "Vaguely Recalls School" },
  { n: 3, span: 40, minFame: 70, name: "Confident at the Pub Quiz" },
  { n: 4, span: 35, minFame: 55, name: "Dangerously Overconfident" },
  { n: 5, span: 30, minFame: 45, name: "Owns Three Documentaries" },
  { n: 6, span: 25, minFame: 35, name: "Actually Reads the Plaques" },
  { n: 7, span: 20, minFame: 28, name: "Unbearable at Dinner Parties" },
  { n: 8, span: 15, minFame: 22, name: "Corrects the Tour Guide" },
  { n: 9, span: 10, minFame: 16, name: "Cited in Footnotes" },
  { n: 10, span: 5, minFame: 0, name: "Were You Personally There?" },
];

// Below this a level starts repeating itself within a few plays.
const MIN_PUZZLES_PER_LEVEL = 200;

// Mirrors CATEGORY_ORDER in app.js. The pool stores a category index rather than
// the name: at several thousand entries the repeated strings are most of the
// file, and the client needs the index anyway to pick the marker colour.
const CATEGORY_ORDER = [
  "Major Events",
  "Wars & Conflicts",
  "Politics & Government",
  "People",
  "Science & Technology",
  "Exploration & Discovery",
  "Religion & Belief Systems",
  "Economy & Trade",
  "Disasters & Pandemics",
  "Social Movements & Revolutions",
  "Architecture & Engineering",
  "Sports & Entertainment",
  "Empires & Countries",
];

// Two options about the same subject ruin a question: "Shakespeare was born" and
// "Shakespeare died" in one puzzle is a giveaway at best and misleading at worst.
// The client needs to spot that, so each entry ships a subject key -- the title
// with any trailing event verb removed, which is what the phrasing rules keyed on
// in the first place.
// A statement that contains a year cannot be used, for two separate reasons.
//
// The obvious one is that it answers itself: "the 1138 Aleppo earthquake struck"
// needs no knowledge at all. The serious one only shows up on inspection --
// sometimes the year in the title disagrees with the year on the record. The
// dataset holds "the Siege of Trebizond in 1461 took place" dated 1460, and "the
// 2011 Yemeni revolution began" dated 2012. Graded against our year, those mark
// a player wrong for being right.
//
// Any standalone 3-4 digit run goes, plus the event's own year at any length, to
// catch the two-digit ancient cases like "the 62 Pompeii earthquake struck".
function statesAYear(q, year) {
  if (new RegExp(`(?:^|[^0-9])${Math.abs(year)}(?:[^0-9]|$)`).test(q)) return true;
  return /(?:^|[^0-9])\d{3,4}(?:[^0-9]|$)/.test(q);
}

function subjectKey(title) {
  return title
    .replace(/\s+(born|died|founded|dissolved|completed|opened)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const centuryOf = (year) => Math.floor((year < 0 ? year + 1 : year) / 100);

async function main() {
  const events = new Function((await fs.readFile(DATA_PATH, "utf8")) + "\nreturn EVENTS;")();

  let sitelinks;
  try {
    sitelinks = JSON.parse(await fs.readFile(SITELINKS_PATH, "utf8"));
  } catch {
    console.error(`Missing ${SITELINKS_PATH}. Run: node scripts/enrich-sitelinks.mjs`);
    process.exit(1);
  }

  const fameOf = (e) => {
    const t = articleTitleFromWiki(e.wiki);
    return t ? sitelinks[t] || 0 : 0;
  };

  const rejected = { approx: 0, country: 0, unphrasable: 0, obscure: 0, dated: 0 };
  const candidates = [];

  for (const e of events) {
    if (e.prec) { rejected.approx++; continue; }
    if (e.category === "Empires & Countries") { rejected.country++; continue; }

    // The hand-written phrasings come first and are exempt from everything
    // below. They cover the moon landing, Pearl Harbor, the fall of the Berlin
    // Wall -- the most answerable questions in the dataset, and precisely the
    // ones the generic rules cannot phrase, since their titles are prose rather
    // than "X born" or "Battle of Y". Left to the normal path they were dropped
    // as unphrasable, which cost the pool nearly every iconic event it had.
    const hand = HAND_WRITTEN[e.title];
    if (hand) { candidates.push({ e, q: hand, fame: Infinity, hand: true }); continue; }

    const q = questionFor(e.title, e.category);
    if (!q) { rejected.unphrasable++; continue; }
    if (statesAYear(q, e.year)) { rejected.dated++; continue; }
    const fame = fameOf(e);
    if (fame < (e.category === "People" ? MIN_FAME_PEOPLE : MIN_FAME_OTHER)) { rejected.obscure++; continue; }
    candidates.push({ e, q, fame });
  }

  console.log(`${events.length.toLocaleString("en-US")} events`);
  console.log(`  dropped ${rejected.approx.toLocaleString("en-US")} approximate-date`);
  console.log(`  dropped ${rejected.country.toLocaleString("en-US")} Empires & Countries`);
  console.log(`  dropped ${rejected.unphrasable.toLocaleString("en-US")} whose title states no event`);
  console.log(`  dropped ${rejected.dated.toLocaleString("en-US")} whose statement contains a year`);
  console.log(`  dropped ${rejected.obscure.toLocaleString("en-US")} below the fame floor`);
  console.log(`  ${candidates.length.toLocaleString("en-US")} candidates`);

  // Keep the most recognisable first, so the per-century ceiling cuts the
  // obscure tail rather than an arbitrary slice.
  candidates.sort((a, b) => b.fame - a.fame);

  const perCentury = new Map();
  const seenSubjectYear = new Set();
  const pool = [];

  for (const { e, q, hand, fame } of candidates) {
    const c = centuryOf(e.year);
    const used = perCentury.get(c) || 0;
    if (!hand && used >= MAX_PER_CENTURY) continue;

    // The dataset carries the same event more than once in places (a person with
    // both a Wikidata and a Wikipedia row, say). Same subject in the same year is
    // a duplicate for quiz purposes whatever the titles say.
    const sub = subjectKey(e.title);
    const key = `${sub}|${e.year}`;
    if (seenSubjectYear.has(key)) continue;
    seenSubjectYear.add(key);

    perCentury.set(c, used + 1);

    // Fame ships with each entry because the client needs it: the quiz is a
    // ten-level ladder and the level is what sets the fame floor, so level 1
    // draws only from events with a Wikipedia article in 120+ languages and
    // level 10 from anything here. Categories are the wrong axis for that --
    // "Major Events" is a filing label, not a measure of what people know, and
    // it holds only 56 of these entries. Hastings is filed under wars, Einstein
    // under people, and both belong on level 1.
    //
    // The hand-written entries come in at Infinity, which does not survive
    // JSON, so they are pinned to a value above the real maximum instead.
    pool.push({ y: e.year, q, c: CATEGORY_ORDER.indexOf(e.category), s: sub, f: Number.isFinite(fame) ? fame : HAND_FAME });
  }

  pool.sort((a, b) => a.y - b.y || a.q.localeCompare(b.q));

  // --- Reporting ------------------------------------------------------------

  const byCat = {};
  for (const p of pool) byCat[CATEGORY_ORDER[p.c]] = (byCat[CATEGORY_ORDER[p.c]] || 0) + 1;
  console.log(`\nPool: ${pool.length.toLocaleString("en-US")} events`);
  for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(5)}  ${k}  (${((v / pool.length) * 100).toFixed(0)}%)`);
  }

  const eras = { "BC": 0, "1-999": 0, "1000-1499": 0, "1500-1799": 0, "1800-1899": 0, "1900-1949": 0, "1950+": 0 };
  for (const p of pool) {
    const y = p.y;
    const k = y < 0 ? "BC" : y < 1000 ? "1-999" : y < 1500 ? "1000-1499" : y < 1800 ? "1500-1799" : y < 1900 ? "1800-1899" : y < 1950 ? "1900-1949" : "1950+";
    eras[k]++;
  }
  console.log("\nEra spread:");
  for (const [k, v] of Object.entries(eras)) console.log(`  ${String(v).padStart(5)}  ${k}  (${((v / pool.length) * 100).toFixed(0)}%)`);

  // Density is what decides whether a level is playable. A question needs two
  // pool events inside the window AND two outside it but near enough to be
  // plausible distractors, so a level whose window is narrow and whose fame
  // floor is high can simply have no valid puzzles. Counted here against the
  // pool that was actually just built, so a data change that starves a level
  // shows up in the build output rather than as an empty question in someone's
  // browser.
  const countPuzzles = (span, minFame) => {
    const sub = pool.filter((p) => p.f >= minFame);
    const byYear = new Map();
    for (const p of sub) byYear.set(p.y, (byYear.get(p.y) || 0) + 1);
    const reach = Math.max(40, span * 5);
    const gap = Math.max(1, Math.round(span / 2));
    let n = 0;
    for (const start of byYear.keys()) {
      let inW = 0;
      for (let v = start; v < start + span; v++) inW += byYear.get(v) || 0;
      if (inW < 2) continue;
      let band = 0;
      for (const [y, c] of byYear) {
        const d = y < start ? start - y : y >= start + span ? y - (start + span - 1) : 0;
        if (d >= gap && d <= reach) band += c;
      }
      if (band >= 2) n++;
    }
    return n;
  };

  console.log("\nLevel ladder:");
  let starved = 0;
  for (const lv of LEVELS) {
    const n = countPuzzles(lv.span, lv.minFame);
    const eligible = pool.filter((p) => p.f >= lv.minFame).length;
    if (n < MIN_PUZZLES_PER_LEVEL) starved++;
    console.log(
      `  L${String(lv.n).padStart(2)}  ${String(lv.span).padStart(2)}y  fame>=${String(lv.minFame).padStart(3)}` +
        `  eligible ${String(eligible).padStart(5)}  puzzles ${String(n).padStart(5)}` +
        `${n < MIN_PUZZLES_PER_LEVEL ? "  <-- TOO FEW" : ""}  ${lv.name}`
    );
  }
  if (starved) {
    console.error(`\n${starved} level(s) below ${MIN_PUZZLES_PER_LEVEL} distinct puzzles -- players would see repeats.`);
    process.exitCode = 1;
  }

  const header = `// GENERATED by scripts/build-quiz.mjs -- do not edit by hand.
//
// Pool for the "Test your knowledge" quiz. Every entry is dated to an exact year
// in Wikidata, phrased as a statement, and famous enough to be a fair question.
// See the script for what is deliberately excluded and why.
//
// Fields: y year, q the statement, c index into CATEGORY_ORDER, s subject key
// (used to keep two options about the same subject out of one question), f fame
// as a Wikidata sitelink count -- how many language Wikipedias carry the
// article. The client uses f as its difficulty axis: level 1 draws only from
// the most recognisable entries here, level 10 from all of them.
//
// Regenerate with:  node scripts/build-quiz.mjs
// A run is ten questions, one per level. span is the width of the target period
// in years; minFame is the sitelink floor an event must clear to appear at that
// level. Both tighten as you climb.
const QUIZ_LEVELS = ${JSON.stringify(LEVELS, null, 2)};

const QUIZ_EVENTS = [
${pool.map((p) => JSON.stringify(p)).join(",\n")}
];
`;

  await fs.writeFile(OUT_PATH, header);
  console.log(`\nWritten to ${OUT_PATH} (${(header.length / 1024).toFixed(0)}KB uncompressed)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
