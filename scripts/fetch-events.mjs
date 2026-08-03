// Pulls real historical events from Wikidata's SPARQL endpoint for each
// focus-area category, and writes the combined dataset to data/events.js.
//
// Run with: node scripts/fetch-events.mjs
//
// Two query shapes are used:
//  - "event": items of given P31 type(s) with a point-in-time/start-time date
//    and coordinates (own or via a location property).
//  - "person": notable people holding a position/occupation, using their
//    date of death as the event and place of death/birth for coordinates.
//
// A public endpoint is used, so requests are serialized with a delay and
// retried with backoff on 429/timeout responses.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENDPOINT = "https://query.wikidata.org/sparql";
const RULER_POSITIONS_PATH = path.join(__dirname, "..", "data", ".cache", "ruler-positions.json");
const USER_AGENT = "TimelineHistoryBuildScript/1.0 (personal educational project)";
// These can be overridden via env vars to run a scoped pass over a narrower
// year window (e.g. to backfill a historically underrepresented era) without
// touching the default full-range behavior.
const MIN_YEAR = Number(process.env.FETCH_MIN_YEAR ?? -500);
const MAX_YEAR = Number(process.env.FETCH_MAX_YEAR ?? 2026);
const TARGET_PER_CATEGORY = Number(process.env.FETCH_TARGET ?? 550);
const RAW_LIMIT = Number(process.env.FETCH_RAW_LIMIT ?? 900);
// Caps how strict a sub-query's own minSitelinks can be for this run; pass a
// low number to relax quality thresholds when scanning a sparse era.
const MINSITELINKS_CAP = process.env.FETCH_MINSITELINKS_CAP != null ? Number(process.env.FETCH_MINSITELINKS_CAP) : null;

// --- People category shared config ---
// Shared between the birth and death passes of the People category so the two
// halves can't silently drift apart (a QID added to only one pass would give a
// person a death event but no birth event, or vice versa).

// Positions held (P39): head of state, monarch, pope, emperor, pharaoh, etc.
const PERSON_POSITION_QIDS = [
  "wd:Q116",
  "wd:Q12097",
  "wd:Q19643",
  "wd:Q39018",
  "wd:Q842606",
  "wd:Q37110",
  "wd:Q65997",
  "wd:Q30461",
  "wd:Q14212",
  "wd:Q48352",
  "wd:Q2285706",
];

// Ruler titles beyond the eleven listed above, read from a cache built by a one
// -off Wikidata query for everything that is transitively a subclass of monarch
// (?p wdt:P279* wd:Q116) and has more than eight dated holders. 228 of them.
//
// The list above reaches eleven of roughly 1,867 such titles, and which eleven
// is the problem: it has "Roman emperor" and "pharaoh" but not "Mughal emperor",
// "Emperor of China", "Emperor of Japan", "khan", "Emperor of Ethiopia", "King
// of Kush" or "Abbasid caliph". So Akbar, Aurangzeb, Jahangir, Humayun and Shah
// Jahan were absent from the dataset entirely -- not filtered on notability,
// never queried. Akbar has 166 sitelinks, twice the quiz's own floor for people.
//
// The subclass traversal is not done inline because combining wdt:P279* with the
// person query reliably 502s on Wikidata's public endpoint. Resolving it once
// and caching the QIDs keeps the per-run queries as cheap as a flat VALUES list
// while removing the editorial judgement about whose rulers count.
//
// Regenerate the cache with the query documented in data/.cache/README-rulers.md
function loadRulerPositions() {
  try {
    const rows = JSON.parse(fsSync.readFileSync(RULER_POSITIONS_PATH, "utf8"));
    return rows.sort((a, b) => b.n - a.n).map((r) => `wd:${r.qid}`);
  } catch {
    console.warn(`No ${RULER_POSITIONS_PATH} -- ruler titles beyond the built-in list will be skipped.`);
    return [];
  }
}

// Batched rather than one VALUES clause for the reason given on
// PERSON_OCCUPATIONS: every query ends in ORDER BY DESC(?sitelinks), so cost
// scales with how many items match, not with LIMIT. The commonest titles get a
// pass to themselves; the long tail is grouped.
function rulerPositionBatches(qids) {
  const solo = qids.slice(0, 12).map((q) => [q]);
  const rest = qids.slice(12);
  const grouped = [];
  for (let i = 0; i < rest.length; i += 25) grouped.push(rest.slice(i, i + 25));
  return [...solo, ...grouped];
}

// --- Regional partitioning ---
//
// Every query in this file ends in ORDER BY DESC(?sitelinks) and is then capped,
// twice: RAW_LIMIT per sub-query and TARGET_PER_CATEGORY on the result. That is a
// global fame ranking with a guillotine on the end, and it is why the dataset is
// 55.9% Europe and 3.5% Indian subcontinent.
//
// The giveaway is that the events already held are equally obscure everywhere --
// median sitelink count is 9 in Europe, 9 in Africa, 9 in China, 8 in India, 7 in
// South America. So the cut is not taking better events from Europe. It is taking
// FAR MORE of them, because the top 900 "castles" worldwide are mostly European
// and every one of the fifty-odd sub-queries repeats that bias.
//
// Raising the caps cannot fix a ratio: a bigger slice of the same ranking is
// still mostly Europe. What fixes it is not making regions compete -- each gets
// its own pass and its own row budget, so a Chinese temple is ranked against
// other Chinese temples rather than against French chateaux.
//
// Regions are matched on the item's country (P17), or on the country's continent
// (P30) where a continent is the right grain. Country lists are used where a
// continent is too coarse: "Asia" would put Japan and Yemen in one bucket, which
// is the same mistake at a larger scale.
const REGIONS = [
  {
    key: "south-asia",
    // India, Pakistan, Bangladesh, Sri Lanka, Nepal, Bhutan, Afghanistan, Maldives
    countries: ["wd:Q668", "wd:Q843", "wd:Q902", "wd:Q854", "wd:Q837", "wd:Q917", "wd:Q889", "wd:Q826"],
  },
  {
    key: "east-asia",
    // China, Japan, South Korea, North Korea, Mongolia, Taiwan
    countries: ["wd:Q148", "wd:Q17", "wd:Q884", "wd:Q423", "wd:Q711", "wd:Q865"],
  },
  {
    key: "southeast-asia",
    // Vietnam, Thailand, Indonesia, Philippines, Malaysia, Myanmar, Cambodia, Laos
    countries: ["wd:Q881", "wd:Q869", "wd:Q252", "wd:Q928", "wd:Q833", "wd:Q836", "wd:Q424", "wd:Q819"],
  },
  {
    key: "mesoamerica",
    // Mexico, Guatemala, Belize, Honduras, El Salvador, Nicaragua, Costa Rica, Panama
    countries: ["wd:Q96", "wd:Q774", "wd:Q242", "wd:Q783", "wd:Q792", "wd:Q811", "wd:Q800", "wd:Q804"],
  },
  {
    key: "caribbean",
    // Cuba, Haiti, Dominican Republic, Jamaica, Puerto Rico, Trinidad, Bahamas
    countries: ["wd:Q241", "wd:Q790", "wd:Q786", "wd:Q766", "wd:Q1183", "wd:Q754", "wd:Q778"],
  },
  {
    key: "andes",
    // Peru, Bolivia, Ecuador, Chile, Colombia -- split out of south-america
    // because the continent bucket is dominated by Brazil and Argentina, where
    // the record is overwhelmingly post-1500.
    countries: ["wd:Q419", "wd:Q750", "wd:Q736", "wd:Q298", "wd:Q739"],
  },
  { key: "south-america", continent: "wd:Q18" },
  // Africa split four ways. As a single continent bucket it is dominated by
  // Egypt and the Maghreb: this dataset holds 6,007 events in North Africa
  // against 1,487 in West Africa, 1,395 in East Africa, 945 in Southern Africa
  // and 622 in Central Africa. One quota for the continent means the Nile valley
  // spends it.
  {
    key: "west-africa",
    // Nigeria, Ghana, Mali, Senegal, Burkina Faso, Niger, Guinea, Benin, Ivory Coast, Sierra Leone, Liberia, Togo
    countries: ["wd:Q1033", "wd:Q117", "wd:Q912", "wd:Q1041", "wd:Q965", "wd:Q1032", "wd:Q1006", "wd:Q962", "wd:Q1008", "wd:Q1044", "wd:Q1014", "wd:Q945"],
  },
  {
    key: "east-africa",
    // Ethiopia, Kenya, Tanzania, Uganda, Somalia, Sudan, South Sudan, Eritrea, Rwanda, Burundi
    countries: ["wd:Q115", "wd:Q114", "wd:Q924", "wd:Q1036", "wd:Q1045", "wd:Q1049", "wd:Q958", "wd:Q986", "wd:Q1037", "wd:Q967"],
  },
  {
    key: "southern-africa",
    // South Africa, Zimbabwe, Zambia, Mozambique, Angola, Botswana, Namibia, Madagascar, Malawi
    countries: ["wd:Q258", "wd:Q954", "wd:Q953", "wd:Q1029", "wd:Q916", "wd:Q963", "wd:Q1030", "wd:Q1019", "wd:Q1020"],
  },
  { key: "africa", continent: "wd:Q15" },
];

// A region pass binds ?item to a country, so it is a strictly narrower query than
// the unpartitioned one. It can afford a lower notability floor: the whole point
// is to reach past the globally-famous into what is locally significant, and a
// floor tuned to survive a worldwide sort is far too high once the field is a
// single region.
const REGION_MIN_SITELINKS = Number(process.env.FETCH_REGION_MINSITELINKS ?? 2);

// Region passes are opt-in. They roughly double the query count, and an ordinary
// rebuild should not silently become a several-hundred-query job.
//   FETCH_REGIONS=1 node scripts/fetch-events.mjs "Wars & Conflicts"
const REGION_PASSES = process.env.FETCH_REGIONS === "1";

// SPARQL fragment restricting ?item to a region, via whatever variable holds the
// place. Events join through the item's own country; people through the country
// of the place they were born or died in.
function regionClause(region, subject) {
  if (!region) return "";
  const v = `?rcountry_${region.key.replace(/-/g, "_")}`;
  return region.continent
    ? `${subject} wdt:P17 ${v} . ${v} wdt:P30 ${region.continent} .`
    : `${subject} wdt:P17 ${v} . VALUES ${v} { ${region.countries.join(" ")} }`;
}

// --- Derived type lists ---
//
// data/.cache/type-graph.json is built by fetch-type-graph.mjs, which asks
// Wikidata what counts as a battle, a place of worship, a state, and so on, by
// walking wdt:P279* from a named root concept. It exists because three
// hand-written type lists in this file failed the same way -- "Roman emperor"
// but not "Mughal emperor", "church building" but not "mausoleum", "sovereign
// state" but not "Chinese dynasty" -- and each failure was invisible until
// somebody asked about one specific missing thing.
//
// Measured against the graph, the hand-written lists reach 18% of the dated
// instances that exist. But the raw gap is not all worth having: of 993,128
// instances, roughly 386,000 are individual sporting fixtures -- 136,868 sports
// seasons, 77,107 basketball games, 20,447 football club matches -- which are
// results rather than history, and are concentrated in exactly the countries and
// decades this dataset is already densest in. Adding them would grow the total
// while making the regional balance worse.
//
// Two guards, therefore.
// type-triage.json is type-graph.json with English labels attached and the
// fixture/admin types already removed -- see fetch-type-graph.mjs and the triage
// step that produced it.
const TYPE_TRIAGE_PATH = path.join(__dirname, "..", "data", ".cache", "type-triage.json");

// One instance of a recurring competition is a fixture. So is a team's season,
// a tournament edition, a cycling stage. Local elections and roadside milestones
// are the same problem wearing a different hat.
const FIXTURE_TYPE =
  /\b(season|game|match|fixture|edition|round|draw|leg|heat|race|grand prix|playoff|tie|stage)\b/i;
const ADMIN_TYPE = /\b(municipal election|local election|by-election|milestone|boundary marker|census)\b/i;

// No single type may supply more than this share of a category's types by
// instance count. Without it, "church building" (59,895) and "Stolperstein"
// (4,557) would between them define what the map looks like, and both are
// overwhelmingly European. A cap keeps the long tail -- temples, forts,
// caravanserais, stupas -- proportionally present instead of drowned.
const MAX_TYPES_PER_CATEGORY = Number(process.env.FETCH_MAX_TYPES ?? 60);

let TRIAGE_CACHE = null;
function derivedTypes(categoryName) {
  if (TRIAGE_CACHE === null) {
    try {
      TRIAGE_CACHE = JSON.parse(fsSync.readFileSync(TYPE_TRIAGE_PATH, "utf8")).keep || [];
    } catch {
      console.warn(`No ${TYPE_TRIAGE_PATH} -- falling back to the hand-written type lists.`);
      TRIAGE_CACHE = [];
    }
  }
  return TRIAGE_CACHE.filter((t) => t.cat === categoryName)
    .filter((t) => !FIXTURE_TYPE.test(t.label) && !ADMIN_TYPE.test(t.label))
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_TYPES_PER_CATEGORY)
    .map((t) => `wd:${t.qid}`);
}

// One pass per derived type, for the same reason PERSON_OCCUPATIONS is split:
// every query ends in ORDER BY DESC(?sitelinks), so cost scales with how many
// items match rather than with LIMIT, and a single VALUES clause holding sixty
// types never returns inside Wikidata's 60s budget. Batched in small groups so
// a common type cannot spend the whole budget on its own.
function derivedTypePasses(cfg) {
  if (!DERIVED_TYPES) return [];
  const existing = new Set((cfg.types || []).map((t) => t.replace("wd:", "")));
  const fresh = derivedTypes(cfg.name).filter((t) => !existing.has(t.replace("wd:", "")));
  const batches = [];
  for (let i = 0; i < fresh.length; i += 4) batches.push(fresh.slice(i, i + 4));
  return batches.map((types, i) => ({
    ...cfg,
    extra: undefined,
    types,
    label: `derived ${i + 1}`,
    minSitelinks: Math.min(cfg.minSitelinks ?? 3, DERIVED_MIN_SITELINKS),
  }));
}

// Opt-in: these roughly triple the query count for a full run.
const DERIVED_TYPES = process.env.FETCH_DERIVED === "1";
const DERIVED_MIN_SITELINKS = Number(process.env.FETCH_DERIVED_MINSITELINKS ?? 2);

// Shared by the founding and dissolution passes of Empires & Countries. They
// were separate lists, and only the founding one got widened when Chinese
// dynasties turned out to be unreachable -- so the Qin, Tang, Song, Ming and
// Yuan dynasties could be founded on this map but never ended. Any type added
// to one half must apply to the other; a polity that can be created and not
// destroyed is worse than one that is simply absent.
const POLITY_TYPES = [
  "wd:Q6256", // country
  "wd:Q3624078", // sovereign state
  "wd:Q3024240", // historical country
  "wd:Q48349", // empire
  "wd:Q12857432", // Chinese dynasty
  "wd:Q50068795", // historical Chinese state
  "wd:Q164950", // dynasty
  "wd:Q7275", // state
  "wd:Q1250464", // realm
  "wd:Q1763527", // constituent country
  "wd:Q56061", // administrative territorial entity
  "wd:Q417175", // kingdom
  "wd:Q133442", // city-state
  "wd:Q154547", // duchy
  "wd:Q208500", // principality
  "wd:Q331644", // khanate
];
// Every QID above was checked against Wikidata rather than guessed from the
// name, after guessing produced "form of government" (a metaclass) and, worse,
// "sports venue" -- which would have quietly filled Empires & Countries with
// stadiums. Search is no safer: it returns a New York Times podcast for
// "caliphate", Oman for "sultanate" and a 1986 science-fiction convention for
// "confederation". Breadth beyond this list comes from the derived type graph,
// which is generated from subclass relations and cannot make that mistake.

// Occupations (P106), each with its own notability floor. The floor is not a
// quality judgement -- it's what keeps the query inside Wikidata's 60s budget.
// personQuery() ends in ORDER BY DESC(?sitelinks), which forces a full sort of
// every matching item, so cost scales with how many people hold the occupation,
// not with LIMIT. "Politician" matches millions of items and 504s at a floor of
// 6; at 40 it returns in seconds. Rarer occupations can afford a low floor.
const PERSON_OCCUPATIONS = [
  { qid: "wd:Q4964182", label: "philosopher", minSitelinks: 6 },
  { qid: "wd:Q82955", label: "politician", minSitelinks: 40 },
  { qid: "wd:Q49757", label: "poet", minSitelinks: 15 },
  { qid: "wd:Q36180", label: "writer", minSitelinks: 25 },
  { qid: "wd:Q201788", label: "historian", minSitelinks: 8 },
  { qid: "wd:Q47064", label: "military personnel", minSitelinks: 10 },
  { qid: "wd:Q189290", label: "military officer", minSitelinks: 12 },
];

// Keeps the Wikidata one-line description (the genuinely useful part) and
// prepends the life event, so a card reads "Born in Lumbini. Indian
// philosopher and founder of Buddhism." rather than just "The Buddha was born."
const PERSON_SUMMARY = {
  born: (name, year, location, desc) =>
    [location ? `Born in ${location}.` : `${name} was born.`, desc ? `${desc}.` : ""].filter(Boolean).join(" "),
  died: (name, year, location, desc) =>
    [location ? `Died in ${location}.` : `${name} died.`, desc ? `${desc}.` : ""].filter(Boolean).join(" "),
};

// A person sub-query hanging off a topical category. Several categories find
// people this way -- scientists, explorers, popes, activists, athletes -- and
// every row they produce is a life event, so it is filed under People rather
// than under the category whose config found it. A scientist's death is a fact
// about a person, not about science; leaving these rows on the topic is what put
// "Giovanni Battista Calvi" (an engineer who died in 1564) in Science &
// Technology, reading as though he were a technology.
//
// requirePlace pins the marker at the place of death with no birthplace
// fallback, which is what makes the "Died in X." summary safe to assert. It
// costs some rows; the alternative is a mispinned marker and a false sentence.
const personDeathPass = (cfg) => ({
  mode: "person",
  personDate: "death",
  requirePlace: true,
  category: "People",
  titleSuffix: "died",
  summary: PERSON_SUMMARY.died,
  ...cfg,
});

const CATEGORIES = [
  {
    name: "Wars & Conflicts",
    mode: "event",
    types: ["wd:Q178561", "wd:Q198", "wd:Q188055", "wd:Q3199915", "wd:Q3882219"],
    dateProps: ["wdt:P585", "wdt:P580"],
    minSitelinks: 3,
  },
  {
    name: "Politics & Government",
    mode: "event",
    types: ["wd:Q45382", "wd:Q131569", "wd:Q625298", "wd:Q40231", "wd:Q1076105"],
    dateProps: ["wdt:P585", "wdt:P580"],
    minSitelinks: 3,
  },
  {
    // People: births and deaths of notable figures, as two separate map events
    // per person ("X born" / "X died"), each at its own year and place. The
    // four sub-queries are the cross product of two axes:
    //   - how the person is identified: position held (P39) vs occupation (P106)
    //   - which life event: death (P570/P20) vs birth (P569/P19)
    // Occupation-based passes matter most for antiquity and the early medieval
    // period, where philosophers, generals and poets are often the only
    // well-documented figures.
    name: "People",
    mode: "person",
    personDate: "birth",
    requirePlace: true,
    posProps: ["wdt:P39"],
    posValues: PERSON_POSITION_QIDS,
    minSitelinks: 12,
    titleSuffix: "born",
    summary: PERSON_SUMMARY.born,
    extra: [
      // One pass per occupation instead of a single VALUES clause covering all
      // seven. "Writer" (Q36180) alone matches hundreds of thousands of items,
      // and the combined query reliably blew past Wikidata's 60s limit (endless
      // HTTP 504s at any RAW_LIMIT). Split up, each pass returns comfortably --
      // and it raises the effective row cap, since RAW_LIMIT now applies per
      // occupation rather than to all of them put together.
      ...PERSON_OCCUPATIONS.map(({ qid, label, minSitelinks }) => ({
        mode: "person",
        personDate: "birth",
        requirePlace: true,
        posProps: ["wdt:P106"],
        posValues: [qid],
        minSitelinks,
        label,
        titleSuffix: "born",
        summary: PERSON_SUMMARY.born,
      })),
      // The 228 cached ruler titles, births and deaths alike. Deaths are fetched
      // here rather than left to migrate-people.mjs, because that script relabels
      // rows an earlier run already collected -- and these rows were never
      // collected by any run, which is the whole point.
      ...rulerPositionBatches(loadRulerPositions()).flatMap((batch, i) => [
        {
          mode: "person",
          personDate: "birth",
          requirePlace: true,
          posProps: ["wdt:P39"],
          posValues: batch,
          minSitelinks: 12,
          label: `rulers ${i + 1} (born)`,
          titleSuffix: "born",
          summary: PERSON_SUMMARY.born,
        },
        {
          mode: "person",
          personDate: "death",
          requirePlace: true,
          posProps: ["wdt:P39"],
          posValues: batch,
          minSitelinks: 12,
          label: `rulers ${i + 1} (died)`,
          titleSuffix: "died",
          summary: PERSON_SUMMARY.died,
        },
      ]),
      // NOTE: the death half of this category is not fetched here. The 5,081
      // events previously filed under "Historical Figures" were already
      // death events (P570), so scripts/migrate-people.mjs relabels those in
      // place rather than re-querying -- that preserves coverage built up over
      // several earlier fetch runs, which a single capped query can't match.
      // Those events keep a neutral summary because their coordinate may be a
      // birthplace fallback (see requirePlace above).
    ],
  },
  {
    // This category used to consist of a single person query -- 10,912 rows,
    // every one of them a scientist's date of death titled with a bare name. It
    // read as though the people *were* technologies, and once those rows moved
    // to People (scripts/migrate-person-events.mjs) the category was left with
    // 4 events. So the topic is now carried by the places where science and
    // technology actually happen and can be pinned to a map: the founding of
    // research institutes, universities, hospitals, observatories and
    // laboratories, plus discrete events like nuclear tests.
    //
    // Infrastructure that is engineering rather than science -- dams, canals,
    // tunnels -- is deliberately left to Architecture & Engineering rather than
    // double-filed here.
    // The types are split across several passes rather than listed in one
    // VALUES clause for the same reason PERSON_OCCUPATIONS is split: the query
    // ends in ORDER BY DESC(?sitelinks), which forces a full sort of everything
    // matched, so cost scales with how common the type is. All fourteen types in
    // one query never returned inside Wikidata's 60s budget. Split up, each pass
    // answers quickly -- and RAW_LIMIT then applies per pass instead of to the
    // whole category, which raises the ceiling too.
    name: "Science & Technology",
    mode: "event",
    types: ["wd:Q3918"], // university -- the single biggest type, on its own
    // Inception first: for an institution the founding date is the event.
    dateProps: ["wdt:P571", "wdt:P585", "wdt:P580"],
    minSitelinks: 2,
    label: "university",
    extra: [
      {
        mode: "event",
        types: [
          "wd:Q31855", // research institute
          "wd:Q16917", // hospital
        ],
        dateProps: ["wdt:P571", "wdt:P585", "wdt:P580"],
        minSitelinks: 2,
        label: "research institute / hospital",
      },
      {
        mode: "event",
        types: [
          "wd:Q1254933", // astronomical observatory
          "wd:Q62832", // observatory
          "wd:Q483242", // laboratory
          "wd:Q588140", // science museum
          "wd:Q148319", // planetarium
          "wd:Q167346", // botanical garden
          "wd:Q130825", // particle accelerator
          "wd:Q366301", // research expedition
        ],
        dateProps: ["wdt:P571", "wdt:P585", "wdt:P580"],
        minSitelinks: 2,
        label: "observatories / labs / collections",
      },
      {
        mode: "event",
        types: [
          "wd:Q159719", // power station
          "wd:Q134447", // nuclear power plant
          "wd:Q210112", // nuclear weapons testing
        ],
        dateProps: ["wdt:P571", "wdt:P585", "wdt:P580"],
        minSitelinks: 2,
        label: "power / nuclear",
      },
      // Scientists still get found here -- they just get filed under People now.
      personDeathPass({
        posProps: ["wdt:P106"],
        posValues: [
          "wd:Q169470",
          "wd:Q593644",
          "wd:Q170790",
          "wd:Q11063",
          "wd:Q205375",
          "wd:Q81096",
          "wd:Q82594",
          "wd:Q864503",
        ],
        minSitelinks: 15,
        label: "scientist",
      }),
    ],
  },
  {
    name: "Exploration & Discovery",
    mode: "event",
    types: [
      "wd:Q2401485", // expedition
      "wd:Q1194369", // first ascent
      "wd:Q3533809",
      "wd:Q906512", // shipwrecking
      "wd:Q852190", // shipwreck
      "wd:Q1135885", // circumnavigation
      "wd:Q69502940", // polar expedition
    ],
    dateProps: ["wdt:P585", "wdt:P580", "wdt:P571"],
    minSitelinks: 0,
    extra: [
      {
        // The discoveries themselves, via P575 (time of discovery or
        // invention): the year a cave, island, meteorite, tomb or buried
        // artefact was found, pinned where it was found. No type filter -- see
        // eventQuery(). This is the only pass in the dataset that captures
        // discovery as an event rather than as a person's biography.
        mode: "event",
        dateProps: ["wdt:P575"],
        minSitelinks: 2,
        label: "discovery (P575)",
      },
      // Notable explorers, using date of death as the event. Files under People.
      personDeathPass({
        posProps: ["wdt:P106"],
        posValues: ["wd:Q11900058"],
        minSitelinks: 3,
        label: "explorer",
      }),
    ],
  },
  {
    name: "Religion & Belief Systems",
    mode: "event",
    types: [
      "wd:Q51645", // ecumenical council
      "wd:Q12546",
      "wd:Q301585",
      "wd:Q3774758",
      "wd:Q1827102",
      "wd:Q46999986",
      "wd:Q111161", // synod
      "wd:Q186431", // papal conclave
      "wd:Q2061186", // religious order
    ],
    dateProps: ["wdt:P585", "wdt:P580", "wdt:P571"],
    minSitelinks: 0,
    label: "councils / synods / orders",
    extra: [
      {
        // Places of worship, by foundation date. Architecture & Engineering
        // already covers church buildings and monasteries, so Christianity was
        // the only religion with any presence on the map at all -- mosques,
        // synagogues and temples were absent from the dataset entirely. None of
        // these types are duplicated in Architecture.
        mode: "event",
        types: [
          "wd:Q32815", // mosque
          "wd:Q34627", // synagogue
          "wd:Q2977", // cathedral
        ],
        dateProps: ["wdt:P571", "wdt:P585", "wdt:P580"],
        minSitelinks: 1,
        label: "mosques / synagogues / cathedrals",
      },
      {
        mode: "event",
        types: [
          "wd:Q160742", // abbey
          "wd:Q44539", // temple
          "wd:Q842402", // Hindu temple
          "wd:Q697295", // shrine
          "wd:Q1129743", // pagoda
        ],
        dateProps: ["wdt:P571", "wdt:P585", "wdt:P580"],
        minSitelinks: 1,
        label: "abbeys / temples / shrines",
      },
      // Popes and other major religious leadership positions, using date of
      // death. Files under People.
      personDeathPass({
        posProps: ["wdt:P39"],
        posValues: [
          "wd:Q19546",
          "wd:Q60719",
          "wd:Q37349",
          "wd:Q2538679",
          "wd:Q4501412",
          "wd:Q29282",
          "wd:Q1410729",
        ],
        minSitelinks: 2,
        label: "religious leader",
      }),
    ],
  },
  {
    name: "Economy & Trade",
    mode: "event",
    types: [
      "wd:Q114380",
      "wd:Q1020018",
      "wd:Q290178",
      "wd:Q252550",
      "wd:Q185565",
      "wd:Q176494",
      "wd:Q172754",
      "wd:Q4856009",
      "wd:Q1417912",
      "wd:Q273182",
    ],
    dateProps: ["wdt:P585", "wdt:P580"],
    minSitelinks: 0,
    extra: [
      {
        // Companies/businesses, using founding (inception) date and
        // headquarters location for coordinates.
        mode: "event",
        types: ["wd:Q4830453"],
        dateProps: ["wdt:P571"],
        locProps: ["wdt:P159"],
        minSitelinks: 3,
      },
    ],
  },
  {
    name: "Disasters & Pandemics",
    mode: "event",
    types: ["wd:Q7944", "wd:Q8065", "wd:Q12184", "wd:Q8068", "wd:Q179057"],
    dateProps: ["wdt:P585", "wdt:P580"],
    minSitelinks: 3,
  },
  {
    name: "Social Movements & Revolutions",
    mode: "event",
    types: ["wd:Q10931", "wd:Q49773", "wd:Q273120", "wd:Q124734", "wd:Q124757"],
    dateProps: ["wdt:P585", "wdt:P580"],
    minSitelinks: 2,
    extra: [
      // Notable activists, using date of death as the event. Files under People.
      personDeathPass({
        posProps: ["wdt:P106"],
        posValues: ["wd:Q15253558"],
        minSitelinks: 3,
        label: "activist",
      }),
    ],
  },
  {
    // The original six types were bridge, church building, monastery, palace,
    // tower and stadium -- which is to say, European architecture plus stadiums.
    // Nothing else could be collected, so the Taj Mahal was absent from the
    // dataset while "Taj Mahal Palace", a hotel, was present. Its Wikidata item
    // has an inception date and coordinates and always did; there was simply no
    // type here it could match, because it is a mausoleum.
    //
    // Same for Qutb Minar (minaret), Khajuraho (Hindu temple), and Harappa and
    // Mohenjo-daro (archaeological sites). The about page blames Wikidata's
    // western skew for gaps like these, and for these it was not Wikidata's.
    //
    // Split into passes for the same reason PERSON_OCCUPATIONS is: each query
    // ends in ORDER BY DESC(?sitelinks), which forces a full sort of everything
    // matched, so cost scales with how common the type is rather than with
    // LIMIT. It also gives each pass its own RAW_LIMIT instead of making a
    // world's worth of temples compete with churches for one 900-row budget.
    name: "Architecture & Engineering",
    mode: "event",
    types: ["wd:Q12280", "wd:Q16970", "wd:Q44613", "wd:Q16560", "wd:Q12518", "wd:Q483110"],
    dateProps: ["wdt:P571", "wdt:P585"],
    minSitelinks: 3,
    extra: [
      ...[
        ["wd:Q32815", "mosque"],
        ["wd:Q842402", "Hindu temple"],
        ["wd:Q5393308", "Buddhist temple"],
        ["wd:Q44539", "temple"],
        ["wd:Q162875", "mausoleum"],
        ["wd:Q381885", "tomb"],
        ["wd:Q180987", "stupa"],
        ["wd:Q199451", "pagoda"],
        ["wd:Q697295", "shrine"],
        ["wd:Q845945", "Shinto shrine"],
        ["wd:Q34627", "synagogue"],
        ["wd:Q48356", "minaret"],
        ["wd:Q132834", "madrasa"],
        ["wd:Q186347", "caravanserai"],
        ["wd:Q1473950", "stepwell"],
        ["wd:Q1785071", "fort"],
        ["wd:Q57821", "fortification"],
        ["wd:Q23413", "castle"],
        ["wd:Q839954", "archaeological site"],
      ].map(([qid, label]) => ({
        mode: "event",
        types: [qid],
        label,
        dateProps: ["wdt:P571", "wdt:P585"],
        minSitelinks: 3,
      })),
    ],
  },
  {
    // Deliberately excludes "sports season" (Q27020041): it matches 13k+ modern
    // league seasons, which would outnumber every other kind of event in the
    // category and bury the map under "2019-20 Premier League" pins.
    name: "Sports & Entertainment",
    mode: "event",
    types: [
      "wd:Q159821",
      "wd:Q13406554",
      "wd:Q19317",
      "wd:Q220505", // film festival
      "wd:Q868557", // music festival
    ],
    dateProps: ["wdt:P585", "wdt:P580", "wdt:P571"],
    minSitelinks: 2,
    label: "competitions / festivals",
    extra: [
      {
        // Venues, by opening date -- the places entertainment happens.
        mode: "event",
        types: [
          "wd:Q24354", // theatre building
          "wd:Q153562", // opera house
          "wd:Q194195", // amusement park
        ],
        dateProps: ["wdt:P571", "wdt:P585", "wdt:P580"],
        minSitelinks: 2,
        label: "theatres / opera houses / parks",
      },
      {
        mode: "event",
        types: [
          "wd:Q1344963", // world championship
          "wd:Q27787439", // film festival edition
          "wd:Q41582469", // music festival edition
          "wd:Q12166442", // association football match
        ],
        dateProps: ["wdt:P585", "wdt:P580", "wdt:P571"],
        minSitelinks: 2,
        label: "championships / festival editions",
      },
      // Notable athletes, actors, musicians and comedians, using date of death.
      // Files under People.
      personDeathPass({
        posProps: ["wdt:P106"],
        posValues: ["wd:Q2066131", "wd:Q33999", "wd:Q639669", "wd:Q245068"],
        minSitelinks: 8,
        label: "performer/athlete",
      }),
    ],
  },
  {
    // Empires, sovereign states, and historical countries: one sub-query for
    // founding (inception date) and one for dissolution (dissolved/abolished
    // date), so the same entity can surface as two distinct map events --
    // "X founded" and "X dissolved" -- each at its own year and location
    // (using the capital's coordinates, since the state itself rarely has
    // its own point geometry).
    name: "Empires & Countries",
    mode: "event",
    // Four Western-framed types -- country, sovereign state, historical country,
    // empire -- could not see a Chinese dynasty, because Wikidata classifies
    // those as "Chinese dynasty" (Q12857432) and "historical Chinese state"
    // (Q50068795). So the Qin, Tang, Song, Ming and Yuan dynasties were absent
    // from the dataset entirely while Chola, Pandya, Satavahana, Zagwe, Idrisid
    // and Buyid were all present: those happen to be filed as historical
    // countries, and the Chinese ones are not.
    //
    // Han and Qing slip through only because they ALSO carry "historical
    // country". Ming lists "sovereign state" but on a non-preferred rank, and
    // wdt: returns only truthy statements, so it matched nothing at all.
    //
    // This is the third whitelist in this file to fail the same way -- ruler
    // titles had Roman emperor but not Mughal emperor, building types had
    // church and monastery but not mausoleum. Each list was written from a
    // European frame and applied worldwide, and Wikidata has region-specific
    // classes precisely because a Chinese dynasty is not a European sovereign
    // state. Adding QIDs by hand fixes today's gap and leaves tomorrow's.
    //
    // TODO: derive this from the subclass graph (?t wdt:P279* wd:Q7275 for
    // state, wd:Q1250464 polity, wd:Q164950 dynasty) and cache it, exactly as
    // ruler-positions.json already does for P39. Written but not yet run --
    // Wikidata's endpoint was refusing every connection at the time.
    types: POLITY_TYPES,
    dateProps: ["wdt:P571", "wdt:P580"],
    locProps: ["wdt:P36"],
    preferLocCoord: true,
    minSitelinks: 2,
    titleSuffix: "founded",
    summary: (name, year, location) => `${name} was founded${location ? `, with its capital at ${location}` : ""}.`,
    extra: [
      {
        mode: "event",
        types: POLITY_TYPES,
        dateProps: ["wdt:P576", "wdt:P582"],
        locProps: ["wdt:P36"],
        preferLocCoord: true,
        minSitelinks: 2,
        titleSuffix: "dissolved",
        summary: (name, year, location) => `${name} ceased to exist${location ? `, having been centered at ${location}` : ""}.`,
      },
    ],
  },
];

// Wikidata keeps a date's precision on the statement's value node, not on the
// truthy `wdt:` triple, so a query that reads `wdt:P571` cannot tell "1101" from
// "12th century" -- both arrive as 1101-01-01. That is how ~19,000 approximate
// dates ended up asserted as exact years, with 615 of them piled onto /year/1101/.
//
// These blocks re-find the statement that produced the already-bound ?date and
// read wikibase:timePrecision off it. Being OPTIONAL and joined on a bound ?date,
// they can only ever add a column: no row that matched before can drop out.
//
// Two details matter. The predicates are written out per property rather than
// bound through `?prop wikibase:claim ?p`, because the generic form makes
// Blazegraph scan every statement in the graph and reliably 504s. And these must
// be emitted *after* the BIND that sets ?date, since SPARQL evaluates a BIND in
// document order -- placed earlier, ?date would still be unbound and each block
// would match every statement on the item.
//
//   6 millennium  7 century  8 decade  9 year  10 month  11 day
function precisionBlocks(dateProps) {
  const paths = dateProps.map((p, i) => {
    const pid = p.replace(/^wdt:/, "");
    return `OPTIONAL { ?item p:${pid} ?pst${i} . ?pst${i} psv:${pid} ?pvn${i} .
    ?pvn${i} wikibase:timeValue ?date ; wikibase:timePrecision ?prec${i} . }`;
  });
  const coalesce = dateProps.map((_, i) => `?prec${i}`).join(", ");
  // Coalesced in the same property order as ?date itself, so the precision comes
  // from the property that supplied the date. An item can also hold two
  // statements with the same value at different precisions, which yields two rows
  // differing only in ?precision; fetchCategory()'s dedup keeps the more precise.
  return `${paths.join("\n  ")}
  BIND(COALESCE(${coalesce}) AS ?precision)`;
}

function eventQuery(cfg) {
  // types is optional. The Exploration & Discovery pass keyed on P575 (time of
  // discovery or invention) deliberately omits it: what gets discovered is
  // islands, caves, meteorites, tombs and archaeological finds, and any P31 list
  // covering that would be arbitrary and lossy. P575 is rare enough (~2k items
  // with coordinates) to be selective on its own, so the date property carries
  // the whole filter.
  const typeClause = cfg.types ? `VALUES ?type { ${cfg.types.join(" ")} }\n  ?item wdt:P31 ?type .` : "";
  // Restricts the whole query to one region when cfg.region is set. Placed with
  // the type clause so it binds ?item early and the planner can use it.
  const regionBlock = regionClause(cfg.region, "?item");
  // Normally P31 anchors the query and every date property is OPTIONAL, so an
  // item matching any one of them qualifies. With no type clause there'd be
  // nothing binding ?item outside an OPTIONAL, which is not a selective query at
  // all -- so the first date property becomes the required anchor instead.
  const dateBindings = cfg.dateProps
    .map((p, i) => (!cfg.types && i === 0 ? `?item ${p} ?d${i} .` : `OPTIONAL { ?item ${p} ?d${i} . }`))
    .join("\n  ");
  const coalesce = cfg.dateProps.map((_, i) => `?d${i}`).join(", ");

  const locProps = cfg.locProps || ["wdt:P276"];
  const locBindings = locProps
    .map((p, i) => `OPTIONAL { ?item ${p} ?rloc${i} . ?rloc${i} wdt:P625 ?lc${i} . }`)
    .join("\n  ");
  // Normally the item's own coordinate (?c0, e.g. wdt:P625) is preferred
  // over a related-location fallback. Countries/empires are a special case:
  // many carry a P625 "geographic center" coordinate (e.g. Russia's centroid
  // sits deep in Siberia, nowhere near Moscow), which is a worse pin than
  // their actual capital. cfg.preferLocCoord flips the priority so the
  // capital coordinate wins when both are present.
  const locCoordCoalesce = cfg.preferLocCoord
    ? [...locProps.map((_, i) => `?lc${i}`), "?c0"].join(", ")
    : ["?c0", ...locProps.map((_, i) => `?lc${i}`)].join(", ");
  const locCoalesce = locProps.map((_, i) => `?rloc${i}`).join(", ");

  return `
SELECT DISTINCT ?item ?itemLabel ?date ?precision ?coord ?locLabel ?sitelinks ?article ?desc WHERE {
  ${typeClause}
  ${regionBlock}
  ${dateBindings}
  BIND(COALESCE(${coalesce}) AS ?date)
  FILTER(BOUND(?date))
  FILTER(YEAR(?date) >= ${MIN_YEAR} && YEAR(?date) <= ${MAX_YEAR})
  ${precisionBlocks(cfg.dateProps)}
  OPTIONAL { ?item wdt:P625 ?c0 . }
  ${locBindings}
  BIND(COALESCE(${locCoordCoalesce}) AS ?coord)
  BIND(COALESCE(${locCoalesce}) AS ?loc)
  FILTER(BOUND(?coord))
  ?item wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks > ${cfg.minSitelinks})
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?articleTitle . }
  OPTIONAL { ?item schema:description ?desc . FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(?sitelinks)
LIMIT ${RAW_LIMIT}`;
}

function personQuery(cfg) {
  const posValues = cfg.posValues.join(" ");
  const posProp = cfg.posProps[0];
  // Every category except People frames a person as a single event at their
  // date of death (P570), pinned at their place of death (P20) and falling
  // back to place of birth (P19). cfg.personDate === "birth" flips both, so
  // the People category can surface the same person twice -- once born, once
  // died -- as two independent map events.
  const birth = cfg.personDate === "birth";
  const dateProp = birth ? "wdt:P569" : "wdt:P570";
  const placeProp = birth ? "wdt:P19" : "wdt:P20";
  const placeFallbackProp = birth ? "wdt:P20" : "wdt:P19";
  // People are placed by where they were born or died, so a region pass joins
  // through that place's country rather than through the person.
  const regionBlock = cfg.region ? `?item ${placeProp} ?rloc . ${regionClause(cfg.region, "?rloc")}` : "";
  return `
SELECT DISTINCT ?item ?itemLabel ?date ?precision ?coord ?locLabel ?sitelinks ?article ?desc WHERE {
  VALUES ?pos { ${posValues} }
  ?item ${posProp} ?pos .
  ${regionBlock}
  ?item ${dateProp} ?date .
  FILTER(YEAR(?date) >= ${MIN_YEAR} && YEAR(?date) <= ${MAX_YEAR})
  ${precisionBlocks([dateProp])}
  ${
    cfg.requirePlace
      ? // No fallback: the coordinate must be the place matching this life
        // event. Falling back to the *other* place (birthplace for a death
        // event, say) both mispins the marker and makes it impossible to write
        // an accurate "Born in X" / "Died in X" summary. Costs some rows.
        `?item ${placeProp} ?loc . ?loc wdt:P625 ?coord .`
      : `OPTIONAL { ?item ${placeProp} ?loc0 . ?loc0 wdt:P625 ?c0 . }
  OPTIONAL { ?item ${placeFallbackProp} ?loc1 . ?loc1 wdt:P625 ?c1 . }
  BIND(COALESCE(?loc0, ?loc1) AS ?loc)
  BIND(COALESCE(?c0, ?c1) AS ?coord)
  FILTER(BOUND(?coord))`
  }
  ?item wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks > ${cfg.minSitelinks})
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?articleTitle .
  OPTIONAL { ?item schema:description ?desc . FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(?sitelinks)
LIMIT ${RAW_LIMIT}`;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runQuery(query, attempt = 1) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");

  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(90000),
    });
  } catch (err) {
    if (attempt <= 4) {
      const wait = 5000 * attempt;
      console.log(`  fetch error (${err.message}), retrying in ${wait}ms...`);
      await sleep(wait);
      return runQuery(query, attempt + 1);
    }
    throw err;
  }

  if (res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504) {
    if (attempt <= 6) {
      const wait = 8000 * attempt;
      console.log(`  HTTP ${res.status}, retrying in ${wait}ms...`);
      await sleep(wait);
      return runQuery(query, attempt + 1);
    }
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for query`);
  }

  const json = await res.json();
  return json.results.bindings;
}

// Wikidata dates use astronomical year numbering (year 0 = 1 BCE). Our
// dataset instead stores "human" BCE years as negatives (776 BCE -> -776),
// matching how formatYear() displays them.
function toDisplayYear(isoDate) {
  const match = /^(-?\d+)-/.exec(isoDate);
  if (!match) return null;
  const astronomicalYear = parseInt(match[1], 10);
  return astronomicalYear <= 0 ? astronomicalYear - 1 : astronomicalYear;
}

// Wikidata coordinates are not necessarily on Earth. A non-terrestrial point is
// serialised with an explicit globe URI -- "<http://www.wikidata.org/entity/Q111>
// Point(267.35 -7.231)" for Mars -- and uses 0..360 longitude, so it parses
// cleanly and then lands nowhere on an Earth map. The P575 discovery pass makes
// this reachable: rovers and probes discover craters on Mercury and rocks on
// Mars, and those are real discoveries with real dates.
const EARTH_GLOBE = "http://www.wikidata.org/entity/Q2";

function parseCoord(wkt) {
  const globe = /^<([^>]+)>/.exec(wkt);
  if (globe && globe[1] !== EARTH_GLOBE) return null;
  const match = /Point\(([-0-9.]+)\s+([-0-9.]+)\)/.exec(wkt);
  if (!match) return null;
  const lng = parseFloat(match[1]);
  const lat = parseFloat(match[2]);
  // Backstop for anything that omits the globe URI but still isn't Earth-shaped.
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lng, lat };
}

function toEvent(binding, category, opts = {}) {
  const dateStr = binding.date?.value;
  const coordStr = binding.coord?.value;
  if (!dateStr || !coordStr) return null;

  const year = toDisplayYear(dateStr);
  const coord = parseCoord(coordStr);
  if (year === null || !coord) return null;

  const rawTitle = binding.itemLabel?.value;
  if (!rawTitle || rawTitle.startsWith("Q")) return null;
  // Some sub-queries (e.g. Empires & Countries' founding vs. dissolution
  // passes) reuse the same underlying entity for two distinct events, so a
  // suffix disambiguates them in the title ("Roman Empire founded" /
  // "Western Roman Empire dissolved").
  const title = opts.titleSuffix ? `${rawTitle} ${opts.titleSuffix}` : rawTitle;

  // Prefer a real English Wikipedia article when one exists; otherwise fall
  // back to the item's own Wikidata page. Wikidata is a distinct, structured
  // source in its own right (curated from museum/library authority records,
  // national archives, and non-English Wikipedias among other references),
  // so this lets us surface real, verifiable, sourced events/figures that
  // simply don't have an English Wikipedia write-up yet -- common for
  // antiquity and non-Western history -- while still linking out for
  // further reading wherever possible.
  const article = binding.article?.value;
  const qid = binding.item.value.replace("http://www.wikidata.org/entity/", "");
  const wiki = article || `https://www.wikidata.org/wiki/${qid}`;
  const source = article ? "wikipedia" : "wikidata";

  const location = binding.locLabel?.value || "";
  const desc = binding.desc?.value ? binding.desc.value.charAt(0).toUpperCase() + binding.desc.value.slice(1) : "";
  // The raw Wikidata description is passed through to custom summary builders
  // so they can keep the biographical detail ("Indian philosopher and founder
  // of Buddhism") instead of throwing it away for a bare "X was born." line.
  const summary = opts.summary ? opts.summary(rawTitle, year, location, desc) : desc || `${title} (${category}).`;

  // Only recorded when the date is vaguer than a year (6 millennium, 7 century,
  // 8 decade). Year, month and day precision all pin the year we store, so
  // marking them would put a redundant field on ~85% of the dataset. An absent
  // ?precision means Wikidata had no statement node for the date, which is
  // treated the same way -- assume the year is good rather than invent doubt.
  const rawPrecision = parseInt(binding.precision?.value ?? "", 10);
  const prec = Number.isFinite(rawPrecision) && rawPrecision < 9 ? rawPrecision : undefined;

  return {
    year,
    ...(prec !== undefined ? { prec } : {}),
    lat: coord.lat,
    lng: coord.lng,
    title,
    category,
    location,
    summary,
    wiki,
    source,
    sitelinks: parseInt(binding.sitelinks?.value || "0", 10),
    // Suffix keeps founding/dissolution events (or any other same-entity,
    // multiple-sub-query category) from colliding in the sub-query-spanning
    // dedup map in fetchCategory().
    _id: binding.item.value + (opts.titleSuffix ? `::${opts.titleSuffix}` : ""),
  };
}

async function fetchCategory(cfg) {
  console.log(`Fetching "${cfg.name}"...`);
  // The unpartitioned passes, then one pass per region on top. The
  // unpartitioned ones are kept rather than replaced: they are what surfaces the
  // genuinely worldwide-famous events, and dropping them to chase balance would
  // trade one distortion for another.
  //
  // Region passes reuse the base config's types and date properties -- the same
  // question, asked once per region -- with their own notability floor, because a
  // floor calibrated to survive a global sort is far too high inside one region.
  // Only the top-level config is expanded, not cfg.extra: the extras are already
  // fine-grained (one occupation, one building type each), and crossing them with
  // five regions would multiply a fifty-query run into several hundred.
  const regionPasses = REGION_PASSES
    ? REGIONS.map((region) => ({
        ...cfg,
        extra: undefined,
        region,
        minSitelinks: Math.min(cfg.minSitelinks ?? REGION_MIN_SITELINKS, REGION_MIN_SITELINKS),
        label: `${cfg.label ? `${cfg.label} ` : ""}${region.key}`,
      }))
    : [];
  const subConfigs = [cfg, ...(cfg.extra || []), ...regionPasses, ...derivedTypePasses(cfg)];

  const seen = new Map();
  const failed = [];
  let totalRaw = 0;
  for (let i = 0; i < subConfigs.length; i++) {
    const sub =
      MINSITELINKS_CAP != null
        ? { ...subConfigs[i], minSitelinks: Math.min(subConfigs[i].minSitelinks, MINSITELINKS_CAP) }
        : subConfigs[i];
    const query = sub.mode === "person" ? personQuery(sub) : eventQuery(sub);
    const tag = `sub-query ${i + 1}/${subConfigs.length} (${sub.label || sub.mode})`;
    // A sub-query that exhausts its retries used to throw and take the whole
    // category down with it, discarding every row already collected. Wikidata
    // timeouts are common enough on the broad passes that that's not an
    // acceptable failure mode: skip the pass, keep the rest, and report which
    // ones were lost so the run can be topped up later.
    let bindings;
    try {
      bindings = await runQuery(query);
    } catch (err) {
      console.error(`  ${tag} FAILED (${err.message}) -- skipping, keeping rows collected so far`);
      failed.push(tag);
      continue;
    }
    console.log(`  ${tag} -> ${bindings.length} raw rows`);
    totalRaw += bindings.length;
    // Pass the originating sub-config through as toEvent's opts, so
    // per-sub-query title suffixes/summaries (e.g. "founded" vs
    // "dissolved") are applied correctly and don't get mixed up across
    // sub-queries the way a single merged-bindings pass would.
    for (const b of bindings) {
      // A sub-query may file its rows under a different category than the one
      // it's configured beside. Person sub-queries use this: a scientist's death
      // is a fact about a person, not a technology, so it belongs in People even
      // though the query that finds it lives under Science & Technology.
      const ev = toEvent(b, sub.category || cfg.name, sub);
      if (!ev) continue;
      const existing = seen.get(ev._id);
      // An item holding two statements with the same date value at different
      // precisions returns two rows that differ only in ?precision. Prefer the
      // more precise reading: it's the one Wikidata's own editors refined, and
      // arrival order here is otherwise arbitrary.
      const morePrecise = existing && existing.prec !== undefined && ev.prec === undefined;
      if (!existing || morePrecise || (!existing.location && ev.location)) seen.set(ev._id, ev);
    }
    if (i < subConfigs.length - 1) await sleep(2000);
  }

  const events = [...seen.values()]
    .sort((a, b) => b.sitelinks - a.sitelinks)
    .slice(0, TARGET_PER_CATEGORY)
    .map(({ _id, sitelinks, ...rest }) => rest);

  console.log(`  -> ${events.length} events (raw rows: ${totalRaw})`);
  if (failed.length) console.warn(`  NOTE: ${failed.length} sub-query(ies) failed: ${failed.join(", ")}`);
  return events;
}

async function main() {
  const cacheDir = path.join(__dirname, "..", "data", ".cache");
  await fs.mkdir(cacheDir, { recursive: true });

  const only = process.argv[2] ? new Set(process.argv.slice(2)) : null;

  for (const cfg of CATEGORIES) {
    if (only && !only.has(cfg.name)) continue;
    const cachePath = path.join(cacheDir, `${cfg.name.replace(/[^a-z0-9]/gi, "_")}.json`);
    try {
      const events = await fetchCategory(cfg);
      await fs.writeFile(cachePath, JSON.stringify(events, null, 2));
    } catch (err) {
      console.error(`  FAILED "${cfg.name}": ${err.message} (leaving previous cache, if any)`);
    }
    await sleep(3000);
  }

  const allEvents = [];
  for (const cfg of CATEGORIES) {
    const cachePath = path.join(cacheDir, `${cfg.name.replace(/[^a-z0-9]/gi, "_")}.json`);
    try {
      const events = JSON.parse(await fs.readFile(cachePath, "utf8"));
      allEvents.push(...events);
    } catch {
      console.warn(`  no cached data for "${cfg.name}" -- skipped in final output`);
    }
  }

  allEvents.sort((a, b) => a.year - b.year);

  const outPath = path.join(__dirname, "..", "data", "events.generated.json");
  await fs.writeFile(outPath, JSON.stringify(allEvents, null, 2));
  console.log(`\nWrote ${allEvents.length} events to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
