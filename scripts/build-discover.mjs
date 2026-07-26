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

// Prefix a lowercase "the" unless the title already carries its own article.
// Safe for event nouns (a Battle/Siege/Treaty always takes "the").
const withThe = (t) => (/^(the|a|an)\s/i.test(t) ? t : `the ${t}`);

// Polities are different: "the Khmer Empire" is right but "the Hungary" and
// "the Francia" are not. English takes an article only when the name has a
// common-noun head ("... Empire", "... Dynasty") or is an "X of Y" construction;
// a bare toponym takes none. Plurals like "the Netherlands" also take one but
// can't be detected structurally, so they're listed.
const POLITY_HEAD =
  /(?:empire|kingdom|republic|dynasty|caliphate|sultanate|khanate|shogunate|emirate|duchy|principality|confederacy|confederation|union|federation|league|commonwealth|protectorate|colony|territory|province|state|states|horde|raj|reich|dominion|regency|khaganate|tsardom|despotate|hegemony)$/i;
const ARTICLE_PLURALS = /^(?:Netherlands|Philippines|United\s|Papal States|Two Sicilies)/i;

const withTheIfPolity = (t) => {
  if (/^(the|a|an)\s/i.test(t)) return t;
  if (POLITY_HEAD.test(t) || / of /.test(t) || ARTICLE_PLURALS.test(t)) return `the ${t}`;
  return t;
};

// "the Papal States were founded", not "was". Only names whose head noun is
// itself plural take a plural verb -- "the United States of America" is
// conventionally singular, so the test looks at the final word only.
const isPluralPolity = (t) => /(?:States|Sicilies|Netherlands|Philippines|Provinces|Emirates)$/i.test(t.trim());
const wasWere = (t) => (isPluralPolity(t) ? "were" : "was");

// Institutions and buildings follow the same article rule as polities, just with
// a different set of head nouns. "the University of Ferrara" and "the Paris
// Observatory" are right because the name leads with (or is built around) a
// common noun; "the Babeș-Bolyai University" and "the St. Lawrence Island" are
// not, because there the common noun is a trailing tag on a proper name.
const COMMON_HEAD =
  /^(?:University|College|Institute|Institution|Academy|School|Polytechnic|Museum|Observatory|Laboratory|Hospital|Infirmary|Cathedral|Basilica|Mosque|Synagogue|Temple|Abbey|Priory|Shrine|Pagoda|Monastery|Theatre|Theater|Playhouse|Opera House|Council|Synod|Conclave|Isle|Island)\b/i;

const withTheIfCommonHead = (t) => {
  if (/^(the|a|an)\s/i.test(t)) return t;
  if (/ of /i.test(t) || COMMON_HEAD.test(t)) return `the ${t}`;
  return t;
};

const ORDINAL = String.raw`(?:First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth)\s`;

// First match wins. Each rule turns a title into a clause that reads naturally
// after "Discover what else was going on in the world when ...".
const RULES = [
  { re: new RegExp(String.raw`^(.+) born$`), q: (m) => `${m[1]} was born` },
  { re: new RegExp(String.raw`^(.+) died$`), q: (m) => `${m[1]} died` },
  { re: new RegExp(String.raw`^(.+) founded$`), q: (m) => `${withTheIfPolity(m[1])} ${wasWere(m[1])} founded` },
  { re: new RegExp(String.raw`^(.+) dissolved$`), q: (m) => `${withTheIfPolity(m[1])} ${wasWere(m[1])} dissolved` },
  { re: new RegExp(String.raw`^(?:${ORDINAL})?Battle of `), q: (m) => `${withThe(m.input)} was fought` },
  { re: new RegExp(String.raw`^(?:${ORDINAL})?Siege of `), q: (m) => `${withThe(m.input)} took place` },
  { re: new RegExp(String.raw`^(?:Treaty|Peace|Pact|Convention) of `), q: (m) => `${withThe(m.input)} was signed` },
  { re: /(?:earthquake|flood|tsunami|eruption|cyclone|hurricane)$/i, q: (m) => `${withThe(m.input)} struck` },
  { re: /(?:plague|pandemic|epidemic|famine)$/i, q: (m) => `${withThe(m.input)} broke out` },
  { re: /\bWar$/, q: (m) => `${withThe(m.input)} began` },
  { re: /(?:Revolt|Rebellion|Uprising|Revolution|Insurrection)$/i, q: (m) => `${withThe(m.input)} began` },
  { re: /(?:Crusade|Massacre|Mutiny)$/i, q: (m) => `${withThe(m.input)} took place` },
];

// Verbatim from the original hand-authored list. Keyed by title only: these are
// famous enough to be unambiguous, and their titles are unique in the dataset.
const HAND_WRITTEN = {
  "Great Pyramid of Giza completed": "the Pyramids of Giza were built",
  "First Olympic Games": "the first Olympic Games were held",
  "Founding of the Roman Republic": "Rome became a republic",
  "Qin Shi Huang unifies China": "China was first unified",
  "Assassination of Julius Caesar": "Julius Caesar was assassinated",
  "Crucifixion of Jesus": "Jesus was crucified",
  "Eruption of Mount Vesuvius": "Pompeii was buried by Mount Vesuvius",
  "Fall of the Western Roman Empire": "the Roman Empire fell",
  "The Hijra": "the Hijra took place and the Islamic calendar began",
  "Battle of Hastings": "the Battle of Hastings was fought",
  "Genghis Khan founds the Mongol Empire": "Genghis Khan founded the Mongol Empire",
  "Signing of the Magna Carta": "the Magna Carta was signed",
  "The Black Death reaches Europe": "the Black Death swept through Europe",
  "Gutenberg's Printing Press": "Gutenberg invented the printing press",
  "Fall of Constantinople": "Constantinople fell to the Ottomans",
  "Columbus reaches the Americas": "Columbus reached the Americas",
  "Luther's 95 Theses": "Martin Luther sparked the Reformation",
  "Great Fire of London": "the Great Fire of London broke out",
  "Newton publishes the Principia": "Newton published his laws of motion",
  "US Declaration of Independence": "the US Declaration of Independence was signed",
  "Storming of the Bastille": "the French Revolution began",
  "Battle of Waterloo": "Napoleon was defeated at Waterloo",
  "Darwin publishes On the Origin of Species": "Darwin published On the Origin of Species",
  "American Civil War begins": "the American Civil War began",
  "Telephone invented": "the telephone was invented",
  "Eiffel Tower completed": "the Eiffel Tower was built",
  "First powered flight": "the Wright brothers achieved the first powered flight",
  "Sinking of the Titanic": "the Titanic sank",
  "End of World War I": "World War I ended",
  "Tutankhamun's tomb discovered": "Tutankhamun's tomb was discovered",
  "Wall Street Crash": "the Wall Street Crash triggered the Great Depression",
  "Germany invades Poland": "World War II began",
  "Attack on Pearl Harbor": "Pearl Harbor was attacked",
  "D-Day landings": "the D-Day landings took place",
  "Atomic bombing of Hiroshima": "the atomic bomb was dropped on Hiroshima",
  "Launch of Sputnik": "Sputnik launched the Space Age",
  "Assassination of John F. Kennedy": "JFK was assassinated",
  "Apollo 11 Moon Landing": "humans first walked on the Moon",
  "Fall of the Berlin Wall": "the Berlin Wall fell",
  "World Wide Web goes public": "the World Wide Web went public",
  "September 11 attacks": "the September 11 attacks happened",
  "First iPhone released": "the first iPhone was released",
  "COVID-19 declared a pandemic": "COVID-19 was declared a pandemic",
};

// Rules that are only safe to apply within a given category. Most of the
// dataset's institutions, venues and places of worship are titled with a bare
// proper noun ("Chapman University", "Trapani Cathedral"), which says nothing
// about what happened -- but the category plus the query that produced it does:
// those rows are dated by inception (P571), so the event is the founding or
// opening. Applying these globally would be wrong; "Victoria Theatre" in another
// category is not necessarily a theatre opening.
const CATEGORY_RULES = {
  "Science & Technology": [
    { re: /\b(?:University|College|Institute|Institution|Academy|Observatory|Laboratory|Museum|Hospital|Infirmary|Polytechnic)\b/i, q: (m) => `${withTheIfCommonHead(m.input)} was founded` },
    { re: /\b(?:Botanical Garden|Botanic Garden|Arboretum|Planetarium)s?\b/i, q: (m) => `${withTheIfCommonHead(m.input)} opened` },
    { re: /\b(?:Power Station|Power Plant|Nuclear Power Plant)\b/i, q: (m) => `${withTheIfCommonHead(m.input)} started up` },
  ],
  "Religion & Belief Systems": [
    { re: /\b(?:Cathedral|Basilica|Mosque|Synagogue|Temple|Abbey|Priory|Shrine|Pagoda|Monastery)\b/i, q: (m) => `${withTheIfCommonHead(m.input)} was founded` },
    { re: /\b(?:Council|Synod|Conclave)\b/i, q: (m) => `${withTheIfCommonHead(m.input)} was convened` },
  ],
  "Sports & Entertainment": [
    { re: /\b(?:Theatre|Theater|Opera House|Playhouse|Amusement Park|Theme Park|Gardens)\b/i, q: (m) => `${withTheIfCommonHead(m.input)} opened` },
    { re: /\b(?:Championship|Championships|Cup|Games|Festival|Grand Prix|Open|Olympiad)\b/i, q: (m) => `${withTheIfCommonHead(m.input)} was held` },
  ],
  "Exploration & Discovery": [
    // Only titles that name a found *thing*. Expeditions and shipwrecks also
    // live in this category and "the Rodi disaster was discovered" is nonsense.
    { re: /\b(?:Cave|Caves|Island|Islands|Hoard|Tomb|Meteorite|Skeleton|Fossil|Artefact|Artifact)\b/i, q: (m) => `${withTheIfCommonHead(m.input)} was discovered` },
  ],
};

function questionFor(title, category) {
  // General rules first: a title that already says what happened ("... born",
  // "Battle of ...") should phrase the same way regardless of category.
  for (const rule of RULES) {
    const m = rule.re.exec(title);
    if (m) {
      // m.input is the whole title; rules that use it want the title intact.
      return rule.q(m);
    }
  }
  for (const rule of CATEGORY_RULES[category] || []) {
    const m = rule.re.exec(title);
    if (m) return rule.q(m);
  }
  return null;
}

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

  for (const [title, question] of Object.entries(HAND_WRITTEN)) {
    const e = byTitle.get(title);
    if (!e) {
      console.warn(`  WARN hand-written prompt has no matching event: "${title}"`);
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
    const fame = fameOf(e);
    if (fame < MIN_SITELINKS) continue;
    candidates.push({ event: e, question, category: e.category, year: e.year, fame });
  }
  console.log(`${phrasable} phrasable titles -> ${candidates.length} above ${MIN_SITELINKS} sitelinks (${vague} skipped for an imprecise date)`);

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
