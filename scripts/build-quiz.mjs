// Generates data/quiz.js -- the event pool behind "Test your knowledge".
//
// The quiz shows four events and a target period, and asks which two fall in it.
// That is a graded question, so the bar for what may enter this pool is higher
// than anywhere else on the site: a wrong or unreadable entry does not just look
// untidy, it marks the player wrong.
//
// Five filters, each rejecting a specific way an event breaks a quiz:
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
//     Wikipedias carry the article) from enrich-sitelinks.mjs. People keep a
//     much higher bar than everything else even now that births and deaths are
//     excluded outright, because it is the backstop if a person ever reaches the
//     pool by some other phrasing.
//
//  5. THREE QUESTION SHAPES ARE BARRED regardless of how well they score on
//     everything above: births and deaths, university foundings, and land masses
//     being discovered. See the constants below for what each one is and why.
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
const PRECISION_PATH = path.join(__dirname, "..", "data", ".cache", "date-precision.json");
const OUT_PATH = path.join(__dirname, "..", "data", "quiz.js");

const MIN_FAME_OTHER = Number(process.env.QUIZ_MIN_FAME_OTHER || 12);
const MIN_FAME_PEOPLE = Number(process.env.QUIZ_MIN_FAME_PEOPLE || 90);

// Wikipedia is densest on the last two centuries, and without a ceiling the pool
// inherits that: every question would land after 1800. This trims the crowded
// centuries rather than padding the empty ones, keeping the sparse eras
// proportionally present instead of pretending they are as well recorded.
const MAX_PER_CENTURY = Number(process.env.QUIZ_MAX_PER_CENTURY || 260);

// --- Excluded question shapes ---
//
// Three kinds of statement are barred outright. All three are phraseable, dated,
// famous enough and otherwise perfectly valid -- they are excluded because they
// make bad questions, not bad data, and they stay everywhere else on the site.

// "X was born" / "X died". The title suffix, not the finished statement: these
// are the same two words the phrasing rules and subjectKey() key on, so matching
// here cannot drift away from what the phrasing actually produces.
const BIO_TITLE = /\s+(born|died)$/i;

// Universities and colleges. Deliberately not Institute, Academy, Observatory,
// Museum or Hospital, which the same phrasing rule also sends to "was founded":
// those are 17 entries including MIT and the Royal Observatory, and the request
// was about university foundings.
const FOUNDED_SCHOOL = /\b(?:Universit(?:y|ies|é|ät|à|a|ad|eit|ä)|College|Polytechnic)\b.*\bwas founded$/i;

// Land masses. 62 of the 69 "was discovered" statements are islands and the rest
// are caves -- "Coche Island was discovered", "Fingal's Cave was discovered" --
// which ask which voyage happened to sight a rock, not anything about history.
// Tombs, hoards, fossils and meteorites are left in: "Tutankhamun's tomb was
// discovered" and "Staffordshire Hoard was discovered" are events people know.
const DISCOVERED_LANDMASS = /\b(?:Islands?|Isles?|Atolls?|Reefs?|Caves?|Rocks?|Skerry|Skerries)\b.*\bwas discovered$/i;

// Stands in for the Infinity the hand-written phrasings carry through the
// candidate list. They are the moon landing, Pearl Harbor, the fall of the
// Berlin Wall, and they belong on level 1 whatever their sitelink count says;
// this just has to sit above the real maximum (Einstein, 320) to put them there.
const HAND_FAME = 999;

// A run is ten questions, one per level, and both axes tighten together: the
// window narrows from fifteen centuries to a decade while the fame floor drops,
// so the events stop being ones everybody knows. Either axis alone would be a
// weaker ramp -- a narrow window full of famous events is still easy, and
// obscure events across a wide one are guessable from vibes.
//
// The spans are deliberately generous at the top. An earlier ladder ran 50y down
// to 5y and was simply too hard to start on: knowing the Council of Trent from
// the Livonian War to within fifty years is expert-level, not a warm-up. At 1500
// years level 1 asks little more than which millennium something belongs to,
// which is the right question for someone who has just arrived.
//
// This ships in data/quiz.js rather than living in the client, so the build can
// check every level against the pool it just generated. The names are the
// payoff: they run from cheerful ignorance through overconfidence to something
// unbearable, and the one you finish on is the shareable part.
// The floors are nearly flat at ~38 through level 6 because that is the highest
// the data supports while still leaving 200+ distinct puzzles per level; the
// difficulty over that stretch comes from the window narrowing, not the fame
// floor. From level 7 the floor resumes falling, which is where the ramp gets
// its bite.
//
// These levels used to carry a noBio flag that barred births and deaths from the
// first six. That flag is gone because births and deaths are now barred from the
// pool outright -- see BIO_TITLE above -- so there was nothing left for it to
// exclude.
const LEVELS = [
  { n: 1, span: 1500, minFame: 39, name: "I Know History Is a Thing" },
  { n: 2, span: 1000, minFame: 39, name: "Vaguely Recalls School" },
  { n: 3, span: 800, minFame: 38, name: "Confident at the Pub Quiz" },
  { n: 4, span: 600, minFame: 38, name: "Dangerously Overconfident" },
  { n: 5, span: 400, minFame: 37, name: "Owns Three Documentaries" },
  { n: 6, span: 300, minFame: 36, name: "Actually Reads the Plaques" },
  { n: 7, span: 200, minFame: 28, name: "Unbearable at Dinner Parties" },
  { n: 8, span: 100, minFame: 22, name: "Corrects the Tour Guide" },
  { n: 9, span: 50, minFame: 16, name: "Cited in Footnotes" },
  { n: 10, span: 10, minFame: 0, name: "Were You Personally There?" },
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

// The description is shown with the options, before the player answers, so it
// has to say what a thing was without saying when. Wikidata descriptions are
// full of dates -- 70% of the ones in this pool carry a year, a century or a
// decade -- and "1485 last significant battle of the Wars of the Roses" next to
// the question "which two happened between 956 and 1755?" is not a quiz.
//
// Stripping rather than dropping, because the description is most of what makes
// an unfamiliar option guessable at all: knowing the Battle of Pharsalus was
// part of Caesar's Civil War is exactly the thread a player can pull on.
const MONTH = "January|February|March|April|May|June|July|August|September|October|November|December";
const PREP = "in|of|from|during|around|circa|by|between|since|until|till|to|and|or";
const FILLER = `c|r|ca|circa|after|before|reigned|ruled|or|and|to|from|${MONTH}`;

function stripDates(text) {
  let s = text;

  // Full calendar dates first, before anything else takes the year and strands
  // the month: "March 22, 1185", "22 March 1185".
  s = s.replace(new RegExp(`\\b(?:${MONTH})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s*\\d{3,4}\\b`, "gi"), "");
  s = s.replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH})\\s+\\d{3,4}\\b`, "gi"), "");

  // Spans stated as prose, removed whole so no orphan preposition is left:
  // "from 161 to 180", "between 1914 and 1918".
  s = s.replace(
    /\b(?:from|between)\s+c?\.?\s*\d{1,4}\s*(?:BCE?|AD|CE)?\s*(?:to|and|[–—-])\s*c?\.?\s*\d{1,4}\s*(?:BCE?|AD|CE)?/gi,
    ""
  );

  // Parenthetical date blobs: "(c.586–c.526 BC)", "(1802-1885)", "(37–41)".
  // Removed when what is inside is essentially a date -- stripping digits, era
  // markers and connectives leaves almost nothing. Keeps "(now Istanbul)".
  const parenIsDate = (m) =>
    m.replace(/[()\d\s.,;:/–—-]/g, "").replace(new RegExp(`(?:BCE?|AD|CE|${FILLER})`, "gi"), "").length <= 2;
  s = s.replace(/\s*\([^)]*\d[^)]*\)/g, (m) => (parenIsDate(m) ? "" : m));

  // "Nth century" / "Nth-century", and decades: "440s BCE", "1920s".
  s = s.replace(/\b\d{1,2}(?:st|nd|rd|th)[-\s]centur(?:y|ies)(?:\s+(?:BCE?|AD|CE))?\b/gi, "");
  s = s.replace(/\b\d{2,4}s(?:\s*(?:BCE?|AD|CE))?\b/gi, "");

  // Years carrying an era marker, either order, any spacing.
  s = s.replace(/\b(?:BCE?|AD|CE)\s*\d{1,4}(?:\s*(?:[–—/-]|\bor\b)\s*\d{1,4})*/gi, "");
  s = s.replace(/\bc?\.?\s*\d{1,4}(?:\s*(?:[–—/-]|\bor\b)\s*c?\.?\s*\d{1,4})*\s*(?:BCE?|AD|CE)\b/gi, "");

  // Bare years. Three digits or more anywhere; one or two digits only when they
  // open the text, where in this dataset they are always a year ("43 battle").
  // The lookahead spares ordinals -- "264th pope" is not a date.
  s = s.replace(/\b\d{3,4}\s*[–—-]\s*\d{2,4}\b(?!\s*(?:st|nd|rd|th))/g, "");
  s = s.replace(/\b\d{3,4}\b(?!\s*(?:st|nd|rd|th))/g, "");
  s = s.replace(/^\s*\d{1,4}\s+(?=[a-z])/i, "");

  // Tidy up. Parentheses emptied by the removals go now rather than earlier,
  // because it is those removals that empty them: "(c. AD 46 – after AD 119)"
  // survives the date test on its words and only then becomes "(c. – after )".
  s = s.replace(new RegExp(`\\((?:[\\s,.;:/–—-]|\\b(?:${FILLER})\\b)*\\)`, "gi"), "");
  s = s.replace(/\s*\(\s*\)\s*/g, " ");
  for (let i = 0; i < 3; i++) {
    s = s.replace(new RegExp(`\\b(?:${PREP})\\s+(?=(?:${PREP})\\b)`, "gi"), "");
    s = s.replace(new RegExp(`\\b(?:${PREP})\\s*(?=[,.;)]|$)`, "gi"), "");
  }
  s = s.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1");
  s = s.replace(/^[\s,.;:–—-]+/, "").replace(/[\s,;:–—-]+$/, "").replace(/\.{2,}/g, ".");

  if (s) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.trim();
}

// What survives stripping is only usable if it still reads as English and still
// says something. A handful of descriptions are nothing but a date, and a
// handful more use abbreviated months the rules above do not catch and come out
// with an empty bracket in them. Both are dropped rather than chased with more
// regex: the option simply shows no description, which costs nothing.
const MIN_DESC = 12;

function usableDescription(text) {
  const s = stripDates(text);
  if (s.length < MIN_DESC) return null;
  if (/\(\s*[,.;]?\s*\)|\(\s|\s\)/.test(s)) return null;
  if (new RegExp(`\\b(?:${PREP})\\s+(?:${PREP})\\b`, "i").test(s)) return null;
  // Belt and braces: if a date survived all of that, the description is unusable
  // for a question whose whole point is guessing the date.
  const noOrdinals = s.replace(/\b\d+\s?(?:st|nd|rd|th)\b/g, "");
  if (/(?:^|[^0-9])\d{3,4}(?:[^0-9]|$)/.test(noOrdinals)) return null;
  if (/\b\d{1,4}\s?(?:BCE?|AD|CE)\b/i.test(s) || /\b(?:BCE?|AD|CE)\s?\d/i.test(s)) return null;
  if (/\b\d{1,2}(?:st|nd|rd|th)[-\s]century\b/i.test(s) || /\b\d{2,4}s\b/.test(s)) return null;
  return s;
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

  // Which Wikidata property supplied each stored year, from the same cache
  // enrich-date-precision.mjs writes. questionFor() needs it to phrase a bare
  // proper noun: "Bent Pyramid" says nothing on its own, but knowing the year
  // came from P571 (inception) rather than P575 (discovery) makes it "the Bent
  // Pyramid was built". Optional -- without it questionFor falls back to the
  // title-only rules and the pool is simply smaller.
  let precision = {};
  try {
    precision = JSON.parse(await fs.readFile(PRECISION_PATH, "utf8"));
  } catch {
    console.warn(`No ${PRECISION_PATH} -- bare-name events will be skipped. Run: node scripts/enrich-date-precision.mjs`);
  }

  // A subject usually carries several dated statements. Take the property whose
  // year matches the one actually stored, so the verb describes the date being
  // asked about rather than some other milestone in the same article. Medici
  // Bank has P571=1397 and P576=1499; at 1397 that is a founding, at 1499 a
  // closure, and phrasing either with the other's verb would be a false claim.
  const datePropOf = (e) => {
    const t = articleTitleFromWiki(e.wiki);
    const rows = t && precision[t];
    if (!rows) return null;
    const hit = rows.find((r) => r[1] === e.year);
    return hit ? hit[0] : null;
  };

  // null means "not in the cache", 0 means "in the cache with no sitelinks".
  const fameOf = (e) => {
    const t = articleTitleFromWiki(e.wiki);
    if (!t) return 0;
    return t in sitelinks ? sitelinks[t] : null;
  };

  // `uncached` is counted separately from `obscure` because they look identical
  // in the output and mean opposite things. An event below the fame floor was
  // judged and rejected; an event with no cache entry was never judged at all.
  //
  // After a backfill added 28,947 events, the quiz pool grew by three. Every new
  // event scored fame 0 -- not because it was obscure, but because
  // enrich-sitelinks.mjs had not been run, so none of their articles were in the
  // cache. It presented as "71,019 below the fame floor" and looked like a
  // threshold working as intended.
  //
  // Build order is fetch -> merge -> dedupe -> enrich-sitelinks -> build-quiz,
  // and nothing enforces it. This at least makes a skipped step loud.
  // --- Which polities may be asked about ---
  //
  // "Empires & Countries" used to be barred entirely, because Wikidata inception
  // dates give "United States founded, 1784" and "France founded, 1804" -- and
  // grading someone wrong for answering 1776 is indefensible. That reasoning is
  // sound for currently-existing sovereign states and wrong for everything else
  // in the category, which is 5,249 rows of Troy, Tyre, Phoenicia, the Xia
  // dynasty, the Kingdom of Kush and the Ottoman Empire.
  //
  // Two tests separate them, and both are structural rather than a list of names:
  //
  //  1. A title claiming more than one year is contradictory on its face. The
  //     dataset holds "Italy founded" at 476, 1861 AND 1946, and "France founded"
  //     at both 481 and 1804. Whatever the right answer is, this data does not
  //     know it, so the subject is dropped.
  //
  //  2. A founding is only asked about when the same polity also has a recorded
  //     dissolution. A state that ended is a historical one with a settled date;
  //     a founding with no end is usually a country that still exists, which is
  //     exactly where Wikidata's legal inception fights the popular answer.
  //     "Kingdom of Great Britain founded, 1707" is admitted because it also
  //     dissolved in 1801. "United States founded" is not.
  //
  // Dissolutions are admitted on their own: the end of a polity is a definite
  // dated event, and nothing still-existing has one.
  const polityYears = new Map();
  const polityEnded = new Set();
  for (const e of events) {
    if (e.category !== "Empires & Countries" || e.prec) continue;
    if (!polityYears.has(e.title)) polityYears.set(e.title, new Set());
    polityYears.get(e.title).add(e.year);
    if (/\s+dissolved$/.test(e.title)) polityEnded.add(e.title.replace(/\s+dissolved$/, ""));
  }
  const polityAllowed = (e) => {
    if (polityYears.get(e.title)?.size !== 1) return false;
    if (/\s+dissolved$/.test(e.title)) return true;
    return polityEnded.has(e.title.replace(/\s+founded$/, ""));
  };

  const rejected = { approx: 0, country: 0, unphrasable: 0, obscure: 0, dated: 0, uncached: 0, bio: 0, dull: 0 };
  const candidates = [];

  for (const e of events) {
    if (e.prec) { rejected.approx++; continue; }
    if (e.category === "Empires & Countries" && !polityAllowed(e)) { rejected.country++; continue; }

    // The hand-written phrasings come first and are exempt from everything
    // below. They cover the moon landing, Pearl Harbor, the fall of the Berlin
    // Wall -- the most answerable questions in the dataset, and precisely the
    // ones the generic rules cannot phrase, since their titles are prose rather
    // than "X born" or "Battle of Y". Left to the normal path they were dropped
    // as unphrasable, which cost the pool nearly every iconic event it had.
    const hand = HAND_WRITTEN[e.title];
    if (hand) { candidates.push({ e, q: hand, fame: Infinity, hand: true }); continue; }

    // Births and deaths are out. They made 1,231 of a 3,349 pool -- 37%, the
    // largest single category -- and they are the weakest questions in it: the
    // year a person was born is a lookup, not something you can reason toward
    // from anything else you know, and a run that keeps offering them feels like
    // a memory test rather than a history quiz. Matched on the title suffix
    // rather than on the finished statement, so a change to the phrasing rules
    // cannot silently stop catching them.
    if (BIO_TITLE.test(e.title)) { rejected.bio++; continue; }

    const q = questionFor(e.title, e.category, datePropOf(e), e.summary || "");
    if (!q) { rejected.unphrasable++; continue; }
    if (statesAYear(q, e.year)) { rejected.dated++; continue; }
    // University foundings and "X island was discovered" go for the same reason.
    // A university's founding year is arbitrary to anyone who did not attend it,
    // and the discovery set is a list of small islands -- "the Cayman Islands
    // was discovered", "Coche Island was discovered" -- which asks the player to
    // recall the itinerary of a voyage rather than anything about history.
    //
    // These two are matched on the STATEMENT, not the title, because the title
    // carries no verb: both arrive as bare names ("University of Oxford",
    // "Cayman Islands") and it is questionFor() that decides, from the category
    // and the head noun, that one was founded and the other discovered. The
    // statement is the only place the distinction exists. assertNoneRemain()
    // below re-checks the built pool so a phrasing change cannot quietly let
    // them back in.
    if (FOUNDED_SCHOOL.test(q) || DISCOVERED_LANDMASS.test(q)) { rejected.dull++; continue; }
    const fame = fameOf(e);
    if (fame === null) { rejected.uncached++; continue; }
    if (fame < (e.category === "People" ? MIN_FAME_PEOPLE : MIN_FAME_OTHER)) { rejected.obscure++; continue; }
    candidates.push({ e, q, fame });
  }

  console.log(`${events.length.toLocaleString("en-US")} events`);
  console.log(`  dropped ${rejected.approx.toLocaleString("en-US")} approximate-date`);
  console.log(`  dropped ${rejected.country.toLocaleString("en-US")} polities with a contested or open-ended founding`);
  console.log(`  dropped ${rejected.unphrasable.toLocaleString("en-US")} whose title states no event`);
  console.log(`  dropped ${rejected.dated.toLocaleString("en-US")} whose statement contains a year`);
  console.log(`  dropped ${rejected.bio.toLocaleString("en-US")} births and deaths`);
  console.log(`  dropped ${rejected.dull.toLocaleString("en-US")} university foundings and island discoveries`);
  console.log(`  dropped ${rejected.obscure.toLocaleString("en-US")} below the fame floor`);
  if (rejected.uncached) {
    console.warn(
      `  dropped ${rejected.uncached.toLocaleString("en-US")} with NO sitelink data -- run scripts/enrich-sitelinks.mjs first`
    );
  }
  console.log(`  ${candidates.length.toLocaleString("en-US")} candidates`);

  // Keep the most recognisable first, so the per-century ceiling cuts the
  // obscure tail rather than an arbitrary slice.
  candidates.sort((a, b) => b.fame - a.fame);

  const perCentury = new Map();
  const seenSubjectYear = new Set();
  const seenFamily = new Set();
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

    // Two DIFFERENT subjects can still make the same question. The pool held 18
    // separate "COVID-19 pandemic in <country> broke out" entries at 2020, each
    // with its own subject key, so the client's per-puzzle duplicate guard saw
    // four distinct subjects and would happily deal them into one question.
    //
    // Only a trailing " in <Place>" is stripped, never " of <Name>". That
    // distinction is the whole rule: Salamis and Artemisium were both fought in
    // 480 BC and are two perfectly good separate questions, and an earlier
    // version of this that also stripped "of" collapsed 238 entries, most of
    // them real battles.
    const family = `${e.year}|${q.replace(/\s+in\s+(?:the\s+)?[A-Z][^,]*?\s+(was|were|broke|took|opened|closed|began)\b/, " $1").toLowerCase()}`;
    if (seenFamily.has(family)) continue;
    seenFamily.add(family);

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
    const entry = { y: e.year, q, c: CATEGORY_ORDER.indexOf(e.category), s: sub, f: Number.isFinite(fame) ? fame : HAND_FAME };

    // w and d turn the reveal into something you can learn from rather than just
    // be marked against. w is the article title, not the full URL: every one of
    // them starts with the same 30 characters, and 3,012 copies of that prefix
    // is 90KB for nothing.
    //
    // d is the Wikidata description, which is CC0 like everything else here.
    // Wikipedia's own article extract would read better and cannot be used: the
    // attribution page states plainly that no Wikipedia article text is
    // reproduced on this site, which is what keeps CC BY-SA off the whole
    // dataset. Wikipedia stays a link target.
    const title = decodeURIComponent((e.wiki || "").split("/wiki/")[1] || "");
    if (title) entry.w = title;
    const desc = e.summary ? usableDescription(e.summary) : null;
    if (desc) entry.d = desc;

    pool.push(entry);
  }

  pool.sort((a, b) => a.y - b.y || a.q.localeCompare(b.q));

  // The three exclusions are enforced on the way in -- births and deaths on the
  // title, the other two on the statement -- so this re-checks the finished pool
  // against what a player would actually read. It is not belt-and-braces for its
  // own sake: two of the three match on text that questionFor() generates, and a
  // new phrasing rule for, say, "was established" would route universities
  // straight past FOUNDED_SCHOOL without anything failing. Fail the build loudly
  // instead of shipping a quiz that quietly asks the questions again.
  const barred = [
    ["births and deaths", /\b(?:was born|died)$/i],
    ["university foundings", FOUNDED_SCHOOL],
    ["land mass discoveries", DISCOVERED_LANDMASS],
  ];
  let leaked = false;
  for (const [what, re] of barred) {
    const hits = pool.filter((p) => re.test(p.q));
    if (!hits.length) continue;
    leaked = true;
    console.error(`\n${hits.length} ${what} reached the pool despite being excluded. First few:`);
    for (const h of hits.slice(0, 5)) console.error(`  ${h.y}  ${h.q}`);
  }
  if (leaked) {
    console.error("\nA phrasing rule probably changed. Fix the pattern or the rule; not writing data/quiz.js.");
    process.exit(1);
  }

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
// article, and b marking a birth or a death (absent otherwise). The client uses
// both as difficulty axes: the early levels bar births and deaths entirely and
// the fame floor falls as you climb.
//
// w is the Wikipedia article title (append it to
// https://en.wikipedia.org/wiki/) and d the Wikidata description with every
// date stripped out of it. The description is shown alongside the options
// BEFORE the player answers -- it is context to reason from -- so it must not
// state the year it is asking about. Entries whose description could not be
// cleaned safely simply have no d.
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
