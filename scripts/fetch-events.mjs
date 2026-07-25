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
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "HistoricalAtlasBuildScript/1.0 (personal educational project)";
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
    name: "Historical Figures",
    mode: "person",
    posProps: ["wdt:P39"],
    posValues: [
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
    ],
    minSitelinks: 12,
    extra: [
      {
        // Notable figures identified by occupation rather than a formal
        // position held -- important for antiquity/early-medieval coverage,
        // where philosophers, generals, poets and historians are often the
        // only well-documented "events" (via date of death) available.
        mode: "person",
        posProps: ["wdt:P106"],
        posValues: [
          "wd:Q4964182",
          "wd:Q82955",
          "wd:Q49757",
          "wd:Q36180",
          "wd:Q201788",
          "wd:Q47064",
          "wd:Q189290",
        ],
        minSitelinks: 6,
      },
    ],
  },
  {
    name: "Science & Technology",
    mode: "person",
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
  },
  {
    name: "Exploration & Discovery",
    mode: "event",
    types: ["wd:Q2401485", "wd:Q1194369", "wd:Q3533809"],
    dateProps: ["wdt:P585", "wdt:P580", "wdt:P571"],
    minSitelinks: 0,
    extra: [
      {
        // Notable explorers, using date of death as the event.
        mode: "person",
        posProps: ["wdt:P106"],
        posValues: ["wd:Q11900058"],
        minSitelinks: 3,
      },
    ],
  },
  {
    name: "Religion & Belief Systems",
    mode: "event",
    types: ["wd:Q51645", "wd:Q12546", "wd:Q301585", "wd:Q3774758", "wd:Q1827102", "wd:Q46999986"],
    dateProps: ["wdt:P585", "wdt:P580"],
    minSitelinks: 0,
    extra: [
      {
        // Popes and other major religious leadership positions, using date of death.
        mode: "person",
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
      },
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
      {
        // Notable activists, using date of death as the event.
        mode: "person",
        posProps: ["wdt:P106"],
        posValues: ["wd:Q15253558"],
        minSitelinks: 3,
      },
    ],
  },
  {
    name: "Architecture & Engineering",
    mode: "event",
    types: ["wd:Q12280", "wd:Q16970", "wd:Q44613", "wd:Q16560", "wd:Q12518", "wd:Q483110"],
    dateProps: ["wdt:P571", "wdt:P585"],
    minSitelinks: 3,
  },
  {
    name: "Sports & Entertainment",
    mode: "event",
    types: ["wd:Q159821", "wd:Q13406554", "wd:Q19317", "wd:Q220505", "wd:Q868557"],
    dateProps: ["wdt:P585", "wdt:P580"],
    minSitelinks: 2,
    extra: [
      {
        // Notable athletes, actors, musicians and comedians, using date of death.
        mode: "person",
        posProps: ["wdt:P106"],
        posValues: ["wd:Q2066131", "wd:Q33999", "wd:Q639669", "wd:Q245068"],
        minSitelinks: 8,
      },
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
    types: ["wd:Q6256", "wd:Q3624078", "wd:Q3024240", "wd:Q48349"],
    dateProps: ["wdt:P571"],
    locProps: ["wdt:P36"],
    preferLocCoord: true,
    minSitelinks: 5,
    titleSuffix: "founded",
    summary: (name, year, location) => `${name} was founded${location ? `, with its capital at ${location}` : ""}.`,
    extra: [
      {
        mode: "event",
        types: ["wd:Q6256", "wd:Q3624078", "wd:Q3024240", "wd:Q48349"],
        dateProps: ["wdt:P576"],
        locProps: ["wdt:P36"],
        preferLocCoord: true,
        minSitelinks: 5,
        titleSuffix: "dissolved",
        summary: (name, year, location) => `${name} ceased to exist${location ? `, having been centered at ${location}` : ""}.`,
      },
    ],
  },
];

function eventQuery(cfg) {
  const typeValues = cfg.types.join(" ");
  const dateBindings = cfg.dateProps
    .map((p, i) => `OPTIONAL { ?item ${p} ?d${i} . }`)
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
SELECT DISTINCT ?item ?itemLabel ?date ?coord ?locLabel ?sitelinks ?article ?desc WHERE {
  VALUES ?type { ${typeValues} }
  ?item wdt:P31 ?type .
  ${dateBindings}
  BIND(COALESCE(${coalesce}) AS ?date)
  FILTER(BOUND(?date))
  FILTER(YEAR(?date) >= ${MIN_YEAR} && YEAR(?date) <= ${MAX_YEAR})
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
  return `
SELECT DISTINCT ?item ?itemLabel ?date ?coord ?locLabel ?sitelinks ?article ?desc WHERE {
  VALUES ?pos { ${posValues} }
  ?item ${posProp} ?pos .
  ?item wdt:P570 ?date .
  FILTER(YEAR(?date) >= ${MIN_YEAR} && YEAR(?date) <= ${MAX_YEAR})
  OPTIONAL { ?item wdt:P20 ?loc0 . ?loc0 wdt:P625 ?c0 . }
  OPTIONAL { ?item wdt:P19 ?loc1 . ?loc1 wdt:P625 ?c1 . }
  BIND(COALESCE(?loc0, ?loc1) AS ?loc)
  BIND(COALESCE(?c0, ?c1) AS ?coord)
  FILTER(BOUND(?coord))
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

function parseCoord(wkt) {
  const match = /Point\(([-0-9.]+)\s+([-0-9.]+)\)/.exec(wkt);
  if (!match) return null;
  return { lng: parseFloat(match[1]), lat: parseFloat(match[2]) };
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
  const summary = opts.summary
    ? opts.summary(rawTitle, year, location)
    : binding.desc?.value
    ? binding.desc.value.charAt(0).toUpperCase() + binding.desc.value.slice(1)
    : `${title} (${category}).`;

  return {
    year,
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
  const subConfigs = [cfg, ...(cfg.extra || [])];

  const seen = new Map();
  let totalRaw = 0;
  for (let i = 0; i < subConfigs.length; i++) {
    const sub =
      MINSITELINKS_CAP != null
        ? { ...subConfigs[i], minSitelinks: Math.min(subConfigs[i].minSitelinks, MINSITELINKS_CAP) }
        : subConfigs[i];
    const query = sub.mode === "person" ? personQuery(sub) : eventQuery(sub);
    const bindings = await runQuery(query);
    console.log(`  sub-query ${i + 1}/${subConfigs.length} (${sub.mode}) -> ${bindings.length} raw rows`);
    totalRaw += bindings.length;
    // Pass the originating sub-config through as toEvent's opts, so
    // per-sub-query title suffixes/summaries (e.g. "founded" vs
    // "dissolved") are applied correctly and don't get mixed up across
    // sub-queries the way a single merged-bindings pass would.
    for (const b of bindings) {
      const ev = toEvent(b, cfg.name, sub);
      if (!ev) continue;
      const existing = seen.get(ev._id);
      if (!existing || (!existing.location && ev.location)) seen.set(ev._id, ev);
    }
    if (i < subConfigs.length - 1) await sleep(2000);
  }

  const events = [...seen.values()]
    .sort((a, b) => b.sitelinks - a.sitelinks)
    .slice(0, TARGET_PER_CATEGORY)
    .map(({ _id, sitelinks, ...rest }) => rest);

  console.log(`  -> ${events.length} events (raw rows: ${totalRaw})`);
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
