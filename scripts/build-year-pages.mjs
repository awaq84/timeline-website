// Generates a static HTML page for every year in the dataset, a hub page for
// every century, and a sitemap listing all of them.
//
// Why this exists: the site was a single URL. Everything -- 111,389 events
// across 2,451 years -- lived behind a slider on "/", so Google had exactly one
// page to index and every search for "what happened in 1969" went somewhere
// else. These pages give each year a real URL with real crawlable text, and
// they are what the interactive map links people back from.
//
// The pages are deliberately NOT the app. They ship no JavaScript, load no
// chunks and draw no map -- just the year's events as HTML, plus navigation.
// A crawler (and a reader on a slow connection) gets the content immediately,
// and the interactive version is one click away at /?year=1969.
//
// Output is committed to the repo because GitHub Pages serves static files and
// runs no build step. Regenerate after any change to data/events.js:
//
//   node scripts/build-chunks.mjs && node scripts/build-year-pages.mjs
//
// Usage:  node scripts/build-year-pages.mjs

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATIC_PAGES } from "./static-pages.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const YEAR_DIR = path.join(ROOT, "year");
const CENTURY_DIR = path.join(ROOT, "century");
const SITEMAP_PATH = path.join(ROOT, "sitemap.xml");

const SITE = "https://timelinehistory.net";
const CSS_VERSION = "5ba15398";

// Mirrors CATEGORY_COLORS / CATEGORY_ORDER in app.js. Duplicated rather than
// imported because app.js is a browser script with no exports, and turning it
// into a module to share thirteen colour strings would mean touching the app's
// load path for the sake of a build script.
const CATEGORY_COLORS = {
  "Major Events": "#ffd60a",
  "Wars & Conflicts": "#e5534b",
  "Politics & Government": "#4fb0ff",
  People: "#f2c94c",
  "Science & Technology": "#6fcf97",
  "Exploration & Discovery": "#bb86fc",
  "Religion & Belief Systems": "#f2994a",
  "Economy & Trade": "#56ccf2",
  "Disasters & Pandemics": "#eb5757",
  "Social Movements & Revolutions": "#9b51e0",
  "Architecture & Engineering": "#c0a080",
  "Sports & Entertainment": "#2d9cdb",
  "Empires & Countries": "#20b2aa",
};

const CATEGORY_ORDER = Object.keys(CATEGORY_COLORS);

// Years below this many events get an "Around this time" section. A page
// carrying one event and a nav bar is a thin page: it gives a searcher nothing
// and drags on how the whole site is assessed. Pulling in the nearest events
// from surrounding years turns it into something worth landing on, and the
// content is genuinely different on every page because the neighbours differ.
const THIN_YEAR = 5;
const AROUND_LIMIT = 12;

// ---- Formatting ----

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const yearLabel = (y) => (y < 0 ? `${Math.abs(y)} BC` : String(y));
const yearSlug = (y) => (y < 0 ? `${Math.abs(y)}-bc` : String(y));

// There is no year zero, so 1 BC is followed directly by AD 1. Ordinal
// centuries follow from that: the 20th century is 1901-2000, and the 5th
// century BC is 500-401 BC. Getting this wrong by one would put 1900 on the
// "19th century" page and quietly contradict every history book.
function centuryOf(year) {
  return year > 0 ? Math.ceil(year / 100) : -Math.ceil(Math.abs(year) / 100);
}

const ordinal = (n) => {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
};

const centuryLabel = (c) =>
  c > 0 ? `${ordinal(c)} century` : `${ordinal(-c)} century BC`;

const centurySlug = (c) =>
  c > 0 ? `${ordinal(c)}-century` : `${ordinal(-c)}-century-bc`;

const centuryRange = (c) =>
  c > 0
    ? [(c - 1) * 100 + 1, c * 100]
    : [-(Math.abs(c) * 100), -((Math.abs(c) - 1) * 100 + 1)];

// An event carries `prec` only when Wikidata's date is vaguer than a year:
// 6 millennium, 7 century, 8 decade. See migrate-date-precision.mjs.
//
// These events still have an anchor year, because Wikidata renders an imprecise
// date as a concrete January 1st -- "12th century" arrives as either 1101 or 1150
// depending on the item. That anchor is fine for placing a marker on a timeline
// and useless as a factual claim, which is the whole problem this guards against:
// /year/1150/ was asserting 490 events happened in 1150 when 470 of them are only
// known to the century.
//
// The label has to reproduce what a Wikidata editor saw when they chose the date,
// and Wikibase derives the ordinal from the *astronomical* year -- the one where
// 0 exists and stands for 1 BC. Verified against Wikibase's own wbformatvalue
// renderer: -0400 at century precision displays as "4. century BCE", not 5th,
// even though the year -0400 is 401 BC and 401 BC sits in the 5th century BC.
//
// Our events store display years (401 BC as -401), so the astronomical year has
// to be recovered before the arithmetic. Doing this on the display year instead
// puts every BC century and millennium label off by one.
const astronomicalYear = (y) => (y < 0 ? y + 1 : y);

function precisionLabel(e) {
  if (!e.prec) return null;
  const a = astronomicalYear(e.year);
  const bc = a <= 0;
  const mag = Math.abs(a);
  // Wikibase truncates for decades ("410s BCE") and rounds up for the ordinal
  // buckets ("4. century BCE"), so these two can't share a formula.
  if (e.prec === 8) return `${Math.floor(mag / 10) * 10}s${bc ? " BC" : ""}`;
  const size = e.prec === 7 ? 100 : 1000;
  const word = e.prec === 7 ? "century" : "millennium";
  // max(1) guards astronomical year 0, which has no meaningful ordinal.
  return `${ordinal(Math.max(1, Math.ceil(mag / size)))} ${word}${bc ? " BC" : ""}`;
}

const listPhrase = (items) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

// ---- Shared chrome ----

// The footer credits Wikidata under CC0, not Wikipedia under CC BY-SA as it used
// to. Nothing on this site reproduces Wikipedia article text: fetch-events.mjs
// takes labels and schema:description from the Wikidata item and uses the
// Wikipedia URL only as a link target and a join key. Claiming CC BY-SA asserted
// a licence over content we don't actually carry, and named a source we don't
// actually quote. See scripts/static-pages.mjs.
// `head` and `scripts` exist for /quiz/, which is the first generated page that
// is not pure prose: it needs its own stylesheet and a script tag. Everything
// else passes neither and comes out byte-identical to before.
// Dataset facts injected into prose at build time. These used to be typed by
// hand -- "111,389 events from 3001 BC to 2026" appeared in five files -- and
// every one of them was silently wrong the moment the dataset grew. Filled from
// the events actually loaded, so they cannot go stale again.
let DATASET_FACTS = {};

// Pulls the real pool size and level-1 fame floor out of data/quiz.js. Returns
// empty strings rather than throwing if the quiz has not been built, so a
// year-pages run is never blocked by it -- but a missing number is visible in
// the page, which is the point.
function quizFacts() {
  try {
    const code = fsSync.readFileSync(path.join(DATA_DIR, "quiz.js"), "utf8");
    const { QUIZ_EVENTS, QUIZ_LEVELS } = new Function(code + "\nreturn { QUIZ_EVENTS, QUIZ_LEVELS };")();
    return {
      quizPool: QUIZ_EVENTS.length.toLocaleString("en-US"),
      quizL1Fame: String(QUIZ_LEVELS[0].minFame),
    };
  } catch {
    console.warn("  could not read data/quiz.js -- quiz numbers on the quiz page will be blank");
    return { quizPool: "", quizL1Fame: "" };
  }
}

function fillFacts(text) {
  return String(text)
    .replace(/\{\{TOTAL_EVENTS\}\}/g, DATASET_FACTS.total ?? "")
    .replace(/\{\{FIRST_YEAR\}\}/g, DATASET_FACTS.first ?? "")
    .replace(/\{\{LAST_YEAR\}\}/g, DATASET_FACTS.last ?? "")
    .replace(/\{\{APPROX_EVENTS\}\}/g, DATASET_FACTS.approx ?? "")
    .replace(/\{\{INFOBOX_EVENTS\}\}/g, DATASET_FACTS.infobox ?? "")
    .replace(/\{\{QUIZ_POOL\}\}/g, DATASET_FACTS.quizPool ?? "")
    .replace(/\{\{QUIZ_L1_FAME\}\}/g, DATASET_FACTS.quizL1Fame ?? "");
}

function layout({ title, description, canonical, jsonLd, body, head = "", scripts = "" }) {
  return fillFacts(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta name="theme-color" content="#000000">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Timeline History">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="A world map on a black background, scattered with coloured dots marking historical events.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE}/og-image.png">
<script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
</script>
<link rel="stylesheet" href="/page.css?v=${CSS_VERSION}">${head}
</head>
<body>

<header class="page-header">
  <a class="brand" href="/">Timeline History</a>
  <nav class="brand-nav"><a href="/">Interactive map</a><a href="/quiz/">Quiz</a></nav>
</header>

${body}

<footer class="page-footer">
  <p>Event data from <a href="https://www.wikidata.org/" rel="noopener">Wikidata</a>, released under <a href="https://creativecommons.org/publicdomain/zero/1.0/" rel="noopener">CC0 1.0</a>.</p>
  <nav class="footer-nav">
    <a href="/">Interactive map</a>
    <a href="/quiz/">Quiz</a>
    <a href="/about/">About</a>
    <a href="/attribution/">Sources &amp; attribution</a>
    <a href="/privacy/">Privacy</a>
  </nav>
  <p class="footer-tagline"><a href="/">Timeline History</a> &middot; an interactive world history map of {{TOTAL_EVENTS}} events from {{FIRST_YEAR}} to {{LAST_YEAR}}.</p>
</footer>
${scripts}
</body>
</html>
`);
}

function breadcrumb(items) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: `${SITE}${it.path}`,
    })),
  };
}

// ---- Year pages ----

function eventCard(e, { showYear = false } = {}) {
  const colour = CATEGORY_COLORS[e.category] || "#888";
  const place = e.location ? ` &middot; ${esc(e.location)}` : "";
  const approx = precisionLabel(e);
  // An approximate event shows its real precision ("12th century") instead of an
  // anchor year it can't support, and the label is plain text rather than a link
  // to /year/1101/ -- linking there would re-assert the exact date this is
  // correcting. Exact events keep the year link.
  const when = approx
    ? `<span class="event-year event-year-approx" title="Dated only to the ${esc(approx)} in the source data">${esc(approx)}</span>`
    : showYear
    ? `<a class="event-year" href="/year/${yearSlug(e.year)}/">${esc(yearLabel(e.year))}</a>`
    : "";
  const linkText =
    e.source === "wikidata" ? "View source on Wikidata" : "Read more on Wikipedia";
  return `      <li class="event-card" style="border-left-color:${colour}">
        <h3>${esc(e.title)}</h3>
        <p class="event-meta">${when}<span class="cat-dot" style="background:${colour}"></span>${esc(e.category)}${place}</p>
        ${e.summary ? `<p class="event-summary">${esc(e.summary)}</p>` : ""}
        <a class="event-link" href="${esc(e.wiki)}" rel="noopener">${linkText} &rarr;</a>
      </li>`;
}

function yearPage(year, events, ctx) {
  const { prevYear, nextYear, nearby, around } = ctx;
  const label = yearLabel(year);
  const century = centuryOf(year);

  // The page's own claim -- title, lead, count, description, JSON-LD -- is made
  // only about events genuinely dated to this year. Everything vaguer is real
  // history and stays on the page, but below, under a heading that says what it
  // actually is. Before this split, /year/1150/ opened with "490 recorded events
  // in 1150" when 470 of those are only known to the 12th century.
  const exact = events.filter((e) => !e.prec);
  const approx = events.filter((e) => e.prec);

  // Categories in the site's canonical order, not whatever order the events
  // happen to sit in the chunk, so the page reads the same way as the app.
  const byCategory = new Map();
  for (const e of exact) {
    if (!byCategory.has(e.category)) byCategory.set(e.category, []);
    byCategory.get(e.category).push(e);
  }
  const cats = CATEGORY_ORDER.filter((c) => byCategory.has(c));

  const topCats = [...byCategory.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(([c, list]) => `${list.length} in ${c.toLowerCase()}`);

  const approxNote = approx.length
    ? ` A further ${approx.length === 1 ? "event is" : `${approx.length.toLocaleString("en-US")} events are`} dated only to the wider period.`
    : "";

  const lead =
    exact.length === 0
      ? `No event is dated precisely to ${label}, but ${approx.length.toLocaleString("en-US")} ${approx.length === 1 ? "entry is" : "entries are"} recorded in the surrounding period.`
      : exact.length === 1
      ? `One recorded event in ${label}: ${exact[0].title}.${approxNote}`
      : `${exact.length.toLocaleString("en-US")} recorded events in ${label}, including ${listPhrase(topCats)}.${approxNote}`;

  const description = `What happened in ${label}? ${lead} Explore them on an interactive world map.`;

  const sections = cats
    .map(
      (c) => `    <section class="cat-block">
      <h2 id="${esc(c.toLowerCase().replace(/[^a-z]+/g, "-"))}">${esc(c)} <span class="cat-count">${byCategory.get(c).length}</span></h2>
      <ul class="event-list">
${byCategory.get(c).map((e) => eventCard(e)).join("\n")}
      </ul>
    </section>`
    )
    .join("\n");

  const aroundBlock = around.length
    ? `    <section class="around-block">
      <h2>Around this time</h2>
      <p class="section-note">The nearest recorded events on either side of ${esc(label)}.</p>
      <ul class="event-list">
${around.map((e) => eventCard(e, { showYear: true })).join("\n")}
      </ul>
    </section>`
    : "";

  // Grouped by the period they're actually dated to, so a page can hold both
  // "12th century" and "1150s" entries without implying they're equally precise.
  // Sorted vaguest-first so the reader meets the broadest claims at the top.
  const approxGroups = new Map();
  for (const e of approx) {
    const k = precisionLabel(e);
    if (!approxGroups.has(k)) approxGroups.set(k, { prec: e.prec, events: [] });
    approxGroups.get(k).events.push(e);
  }
  const approxBlock = approx.length
    ? `    <section class="approx-block">
      <h2>Dated to the wider period</h2>
      <p class="section-note">${
        // Naming Wikidata here was true until infobox-dated events existed, and
        // is exactly wrong for them: Wikidata records no date for those at all,
        // which is why the date was read from a Wikipedia infobox instead. Say
        // "the source" unless every entry in this block really is Wikidata's.
        approx.every((e) => e.dateSource === "wikipedia-infobox")
          ? "The source gives"
          : approx.some((e) => e.dateSource === "wikipedia-infobox")
            ? "The sources give"
            : "Wikidata records"
      } ${approx.length === 1 ? "this entry" : `these ${approx.length.toLocaleString("en-US")} entries`} only to a century, decade or millennium rather than to a specific year. ${approx.length === 1 ? "It is" : "They are"} listed here because ${esc(label)} is where that broader date falls, not because ${approx.length === 1 ? "it is" : "they are"} known to have happened in ${esc(label)}.</p>
${[...approxGroups.entries()]
  .sort((a, b) => a[1].prec - b[1].prec)
  .map(
    ([periodLabel, g]) => `      <h3 class="approx-period">${esc(periodLabel)} <span class="cat-count">${g.events.length.toLocaleString("en-US")}</span></h3>
      <ul class="event-list">
${g.events.map((e) => eventCard(e)).join("\n")}
      </ul>`
  )
  .join("\n")}
    </section>`
    : "";

  const pager = `  <nav class="pager">
    ${prevYear !== null ? `<a class="pager-prev" href="/year/${yearSlug(prevYear)}/"><span>&larr; Previous</span>${esc(yearLabel(prevYear))}</a>` : `<span></span>`}
    <a class="pager-up" href="/century/${centurySlug(century)}/">${esc(centuryLabel(century))}</a>
    ${nextYear !== null ? `<a class="pager-next" href="/year/${yearSlug(nextYear)}/"><span>Next &rarr;</span>${esc(yearLabel(nextYear))}</a>` : `<span></span>`}
  </nav>`;

  const nearbyBlock = nearby.length
    ? `  <nav class="nearby">
    <h2>Nearby years</h2>
    <ul>${nearby.map((n) => `<li><a href="/year/${yearSlug(n.year)}/">${esc(yearLabel(n.year))} <span>${n.count}</span></a></li>`).join("")}</ul>
  </nav>`
    : "";

  const body = `<main class="year-page">
  <nav class="crumbs"><a href="/">Home</a> &rsaquo; <a href="/century/${centurySlug(century)}/">${esc(centuryLabel(century))}</a> &rsaquo; <span>${esc(label)}</span></nav>

  <h1>What happened in ${esc(label)}?</h1>
  <p class="lead">${esc(lead)}</p>

  <p class="cta"><a class="cta-btn" href="/?year=${year}">See ${esc(label)} on the interactive map &rarr;</a></p>

${sections}
${approxBlock}
${aroundBlock}
${pager}
${nearbyBlock}
</main>`;

  return layout({
    title: `${label} — What Happened That Year | Timeline History`,
    description,
    canonical: `${SITE}/year/${yearSlug(year)}/`,
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          name: `Events of ${label}`,
          url: `${SITE}/year/${yearSlug(year)}/`,
          description,
          isPartOf: { "@type": "WebSite", name: "Timeline History", url: `${SITE}/` },
          about: { "@type": "Thing", name: `History of ${label}` },
        },
        breadcrumb([
          { name: "Timeline History", path: "/" },
          { name: centuryLabel(century), path: `/century/${centurySlug(century)}/` },
          { name: label, path: `/year/${yearSlug(year)}/` },
        ]),
      ],
    },
    body,
  });
}

// ---- Century pages ----

function centuryPage(c, years, byYear, prevC, nextC) {
  const label = centuryLabel(c);
  const [from, to] = centuryRange(c);
  const span = `${yearLabel(from)} to ${yearLabel(to)}`;

  // A century page can legitimately count a century-precision event: an event
  // dated "12th century" really does belong on the 12th century page, even though
  // it can't be pinned to 1101. Millennium-precision entries (prec 6) are the
  // exception -- landing in this century is an accident of where Wikidata put the
  // anchor -- so they're excluded from the total rather than silently inflating it.
  const countable = (y) => byYear.get(y).filter((e) => !e.prec || e.prec >= 7);
  // What the year pages themselves now headline, so the grid can't contradict
  // the page it links to.
  const exactCount = (y) => byYear.get(y).filter((e) => !e.prec).length;
  const total = years.reduce((s, y) => s + countable(y).length, 0);

  // The busiest years act as the page's own content rather than just a list of
  // links -- a naked index of a hundred year numbers is the kind of page that
  // gets crawled once and never ranked. Ranked on exact counts so this doesn't
  // just resurface the century-anchor years (1101, 1150) that started as the bug.
  const busiest = [...years]
    .filter((y) => exactCount(y) > 0)
    .sort((a, b) => exactCount(b) - exactCount(a))
    .slice(0, 8);

  const catCount = new Map();
  for (const y of years) {
    for (const e of countable(y)) catCount.set(e.category, (catCount.get(e.category) || 0) + 1);
  }
  const topCats = [...catCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c2, n]) => `${c2.toLowerCase()} (${n.toLocaleString("en-US")})`);

  // The century total and the year grid deliberately count different things: an
  // event dated "12th century" belongs on this page but has no year to sit under,
  // so the total exceeds the grid by however many of those there are. Stating both
  // numbers here stops the page looking like it contradicts itself to anyone who
  // adds the grid up.
  const exactTotal = years.reduce((s, y) => s + exactCount(y), 0);
  const pinned =
    exactTotal === total
      ? ""
      : ` ${exactTotal.toLocaleString()} of them are dated to a specific year; the rest are recorded only as belonging to the ${label}.`;

  const lead = `${total.toLocaleString()} recorded events across ${years.length} year${years.length === 1 ? "" : "s"} of the ${label}, ${span}.${pinned} The largest categories are ${listPhrase(topCats)}.`;
  const description = `Browse ${total.toLocaleString()} historical events from the ${label} (${span}), year by year, on an interactive world map.`;

  const grid = years
    .map(
      (y) =>
        `      <li><a href="/year/${yearSlug(y)}/"><span class="y">${esc(yearLabel(y))}</span><span class="n">${exactCount(y)}</span></a></li>`
    )
    .join("\n");

  const highlights = busiest
    .map((y) => {
      const n = exactCount(y);
      const sample = byYear.get(y).find((e) => !e.prec);
      return `      <li><a href="/year/${yearSlug(y)}/"><strong>${esc(yearLabel(y))}</strong> &mdash; ${n} event${n === 1 ? "" : "s"}<span class="hl-sample">${esc(sample.title)}</span></a></li>`;
    })
    .join("\n");

  const body = `<main class="century-page">
  <nav class="crumbs"><a href="/">Home</a> &rsaquo; <span>${esc(label)}</span></nav>

  <h1>The ${esc(label)}</h1>
  <p class="lead">${esc(lead)}</p>

  <p class="cta"><a class="cta-btn" href="/?year=${years[0]}">Open the ${esc(label)} on the interactive map &rarr;</a></p>

  <section>
    <h2>Busiest years</h2>
    <ul class="highlight-list">
${highlights}
    </ul>
  </section>

  <section>
    <h2>Every year in the ${esc(label)}</h2>
    <p class="section-note">Years with no recorded events are omitted. The number is how many events are dated precisely to that year; entries known only to a century or decade are listed on the year page separately.</p>
    <ul class="year-grid">
${grid}
    </ul>
  </section>

  <nav class="pager">
    ${prevC !== null ? `<a class="pager-prev" href="/century/${centurySlug(prevC)}/"><span>&larr; Previous</span>${esc(centuryLabel(prevC))}</a>` : `<span></span>`}
    <a class="pager-up" href="/">All eras</a>
    ${nextC !== null ? `<a class="pager-next" href="/century/${centurySlug(nextC)}/"><span>Next &rarr;</span>${esc(centuryLabel(nextC))}</a>` : `<span></span>`}
  </nav>
</main>`;

  return layout({
    title: `The ${label} — Year by Year | Timeline History`,
    description,
    canonical: `${SITE}/century/${centurySlug(c)}/`,
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          name: `The ${label}`,
          url: `${SITE}/century/${centurySlug(c)}/`,
          description,
          isPartOf: { "@type": "WebSite", name: "Timeline History", url: `${SITE}/` },
        },
        breadcrumb([
          { name: "Timeline History", path: "/" },
          { name: label, path: `/century/${centurySlug(c)}/` },
        ]),
      ],
    },
    body,
  });
}

// ---- Build ----

// This script reads the chunks, not data/events.js, so it must run AFTER
// build-chunks.mjs. Running it before is silent and looks entirely successful:
// it happily rebuilt 2,744 year pages and a 2,800-URL sitemap off the previous
// run's chunks while events.js already held 154,493 events across 2,758 years.
// Nothing in the output said the number was 5,737 events stale. Compare the
// mtimes and refuse rather than publish a sitemap that omits real pages.
async function assertChunksFresh() {
  const [chunks, source] = await Promise.all([
    fs.stat(path.join(DATA_DIR, "index.json")),
    fs.stat(path.join(DATA_DIR, "events.js")),
  ]);
  if (chunks.mtimeMs < source.mtimeMs) {
    throw new Error(
      "data/index.json is older than data/events.js -- the chunks are stale.\n" +
        "Run `node scripts/build-chunks.mjs` first, then re-run this script."
    );
  }
}

async function main() {
  await assertChunksFresh();
  const index = JSON.parse(await fs.readFile(path.join(DATA_DIR, "index.json"), "utf8"));

  const byYear = new Map();
  for (let i = 0; i < index.chunkStarts.length; i++) {
    const rows = JSON.parse(
      await fs.readFile(path.join(DATA_DIR, "events", `${String(i).padStart(3, "0")}.json`), "utf8")
    );
    for (const e of rows) {
      if (!byYear.has(e.year)) byYear.set(e.year, []);
      byYear.get(e.year).push(e);
    }
  }

  const years = [...byYear.keys()].sort((a, b) => a - b);

  // Populated before any page is rendered, because layout() reads it.
  let totalEvents = 0;
  let approxEvents = 0;
  let infoboxEvents = 0;
  for (const rows of byYear.values()) {
    totalEvents += rows.length;
    for (const e of rows) if (e.prec) approxEvents++;
    // Counted from the data rather than written into the prose, because
    // /attribution/ makes a licensing claim with this number in it and a
    // hand-typed figure goes stale the first time a harvest is merged.
    for (const e of rows) if (e.dateSource === "wikipedia-infobox") infoboxEvents++;
  }
  DATASET_FACTS = {
    total: totalEvents.toLocaleString("en-US"),
    approx: approxEvents.toLocaleString("en-US"),
    infobox: infoboxEvents.toLocaleString("en-US"),
    first: yearLabel(years[0]),
    last: yearLabel(years[years.length - 1]),
    // Read from the built quiz rather than written down. The quiz page claimed
    // "All 3,012 of them" and "an article in more than 120 languages" long after
    // both had stopped being true -- the pool had moved to 2,893 and level 1's
    // actual floor is 39 -- because the prose was hand-edited and the numbers
    // were not. Anything the page asserts about the quiz now comes from the file
    // the quiz actually loads.
    ...quizFacts(),
  };
  console.log(`Dataset: ${DATASET_FACTS.total} events, ${DATASET_FACTS.first} to ${DATASET_FACTS.last} (${DATASET_FACTS.approx} approximate-date, ${DATASET_FACTS.infobox} infobox-dated)`);
  const total = years.reduce((s, y) => s + byYear.get(y).length, 0);
  if (total !== index.total) {
    throw new Error(`read ${total} events but index says ${index.total}`);
  }
  console.log(`${total.toLocaleString()} events across ${years.length} years`);

  // Wipe first. Years can disappear when the dataset is refetched, and a stale
  // /year/1412/ left behind would sit in the sitemap-less dark forever, still
  // served, still indexed, quietly contradicting the current data.
  await fs.rm(YEAR_DIR, { recursive: true, force: true });
  await fs.rm(CENTURY_DIR, { recursive: true, force: true });

  const posOf = new Map(years.map((y, i) => [y, i]));

  for (const y of years) {
    const i = posOf.get(y);
    const events = byYear.get(y);

    // Nearby = the four closest years on each side that actually exist, so the
    // links never 404 and a reader in 1203 BC isn't offered 1202 BC when the
    // next thing on record is 60 years away.
    const nearby = [];
    for (let k = Math.max(0, i - 4); k <= Math.min(years.length - 1, i + 4); k++) {
      if (k !== i) nearby.push({ year: years[k], count: byYear.get(years[k]).length });
    }

    let around = [];
    if (events.length < THIN_YEAR) {
      // Walk outwards alternately so the sample is balanced around the year
      // rather than being whatever the earlier side happens to hold.
      let lo = i - 1;
      let hi = i + 1;
      while (around.length < AROUND_LIMIT && (lo >= 0 || hi < years.length)) {
        if (lo >= 0) around.push(...byYear.get(years[lo--]).slice(0, 3));
        if (around.length >= AROUND_LIMIT) break;
        if (hi < years.length) around.push(...byYear.get(years[hi++]).slice(0, 3));
      }
      around = around.slice(0, AROUND_LIMIT).sort((a, b) => a.year - b.year);
    }

    const html = yearPage(y, events, {
      prevYear: i > 0 ? years[i - 1] : null,
      nextYear: i < years.length - 1 ? years[i + 1] : null,
      nearby,
      around,
    });
    const dir = path.join(YEAR_DIR, yearSlug(y));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "index.html"), html);
  }
  console.log(`Wrote ${years.length} year pages`);

  const byCentury = new Map();
  for (const y of years) {
    const c = centuryOf(y);
    if (!byCentury.has(c)) byCentury.set(c, []);
    byCentury.get(c).push(y);
  }
  const centuries = [...byCentury.keys()].sort((a, b) => a - b);

  for (const [i, c] of centuries.entries()) {
    const html = centuryPage(
      c,
      byCentury.get(c),
      byYear,
      i > 0 ? centuries[i - 1] : null,
      i < centuries.length - 1 ? centuries[i + 1] : null
    );
    const dir = path.join(CENTURY_DIR, centurySlug(c));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "index.html"), html);
  }
  console.log(`Wrote ${centuries.length} century pages`);

  // Hand-written prose (about / attribution / privacy). Rendered here rather than
  // by their own script so they share layout() and, more importantly, cannot fall
  // out of the sitemap below -- a separate build step is one someone forgets.
  for (const page of STATIC_PAGES) {
    const canonical = `${SITE}/${page.slug}/`;
    const html = layout({
      title: `${page.title} | Timeline History`,
      description: page.description,
      canonical,
      jsonLd: {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": page.schemaType || "WebPage",
            name: page.title,
            url: canonical,
            description: page.description,
            isPartOf: { "@type": "WebSite", name: "Timeline History", url: `${SITE}/` },
          },
          breadcrumb([{ name: "Timeline History", path: "/" }, { name: page.title, path: `/${page.slug}/` }]),
        ],
      },
      body: `<main class="prose-page">\n${page.body}</main>`,
      head: page.head || "",
      scripts: page.scripts || "",
    });
    const dir = path.join(ROOT, page.slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "index.html"), html);
  }
  console.log(`Wrote ${STATIC_PAGES.length} static pages`);

  const urls = [
    `${SITE}/`,
    ...STATIC_PAGES.map((p) => `${SITE}/${p.slug}/`),
    ...centuries.map((c) => `${SITE}/century/${centurySlug(c)}/`),
    ...years.map((y) => `${SITE}/year/${yearSlug(y)}/`),
  ];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u, i) =>
      `  <url>\n    <loc>${u}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>${i === 0 ? "1.0" : u.includes("/century/") ? "0.8" : "0.6"}</priority>\n  </url>`
  )
  .join("\n")}
</urlset>
`;
  await fs.writeFile(SITEMAP_PATH, sitemap);
  console.log(`Wrote sitemap.xml with ${urls.length} URLs`);

  // The era list the home page links out from, so a crawler reaches every
  // century in one hop from "/" and every year in two.
  const cacheDir = path.join(DATA_DIR, ".cache");
  await fs.mkdir(cacheDir, { recursive: true });
  const eraLinks = centuries
    .map((c) => `<a href="/century/${centurySlug(c)}/">${centuryLabel(c)}</a>`)
    .join("\n        ");
  await fs.writeFile(path.join(cacheDir, "era-links.html"), eraLinks);
  console.log(`\nEra links for index.html written to data/.cache/era-links.html`);
}

await main();
