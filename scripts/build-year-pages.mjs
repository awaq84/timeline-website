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
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const YEAR_DIR = path.join(ROOT, "year");
const CENTURY_DIR = path.join(ROOT, "century");
const SITEMAP_PATH = path.join(ROOT, "sitemap.xml");

const SITE = "https://timelinehistory.net";
const CSS_VERSION = 1;

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

const listPhrase = (items) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

// ---- Shared chrome ----

function layout({ title, description, canonical, jsonLd, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta name="theme-color" content="#000000">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Timeline History">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
</script>
<link rel="stylesheet" href="/page.css?v=${CSS_VERSION}">
</head>
<body>

<header class="page-header">
  <a class="brand" href="/">Timeline History</a>
  <nav class="brand-nav"><a href="/">Interactive map</a></nav>
</header>

${body}

<footer class="page-footer">
  <p>Event data from <a href="https://www.wikidata.org/" rel="noopener">Wikidata</a> and <a href="https://en.wikipedia.org/" rel="noopener">Wikipedia</a>, available under <a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="noopener">CC BY-SA 4.0</a>.</p>
  <p><a href="/">Timeline History</a> &middot; an interactive world history map of 111,389 events from 3001 BC to 2026.</p>
</footer>

</body>
</html>
`;
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
  const when = showYear
    ? `<a class="event-year" href="/year/${yearSlug(e.year)}/">${esc(yearLabel(e.year))}</a>`
    : "";
  const linkText =
    e.source === "wikidata" ? "View source on Wikidata" : "Read more on Wikipedia";
  return `      <li class="event-card" style="border-left-color:${colour}">
        <h3>${esc(e.title)}</h3>
        <p class="event-meta">${when}<span class="cat-dot" style="background:${colour}"></span>${esc(e.category)}${place}</p>
        <p class="event-summary">${esc(e.summary)}</p>
        <a class="event-link" href="${esc(e.wiki)}" rel="noopener">${linkText} &rarr;</a>
      </li>`;
}

function yearPage(year, events, ctx) {
  const { prevYear, nextYear, nearby, around } = ctx;
  const label = yearLabel(year);
  const century = centuryOf(year);

  // Categories in the site's canonical order, not whatever order the events
  // happen to sit in the chunk, so the page reads the same way as the app.
  const byCategory = new Map();
  for (const e of events) {
    if (!byCategory.has(e.category)) byCategory.set(e.category, []);
    byCategory.get(e.category).push(e);
  }
  const cats = CATEGORY_ORDER.filter((c) => byCategory.has(c));

  const topCats = [...byCategory.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(([c, list]) => `${list.length} in ${c.toLowerCase()}`);

  const lead =
    events.length === 1
      ? `One recorded event in ${label}: ${events[0].title}.`
      : `${events.length} recorded events in ${label}, including ${listPhrase(topCats)}.`;

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
  const total = years.reduce((s, y) => s + byYear.get(y).length, 0);
  const span = `${yearLabel(from)} to ${yearLabel(to)}`;

  // The busiest years act as the page's own content rather than just a list of
  // links -- a naked index of a hundred year numbers is the kind of page that
  // gets crawled once and never ranked.
  const busiest = [...years]
    .sort((a, b) => byYear.get(b).length - byYear.get(a).length)
    .slice(0, 8);

  const catCount = new Map();
  for (const y of years) {
    for (const e of byYear.get(y)) catCount.set(e.category, (catCount.get(e.category) || 0) + 1);
  }
  const topCats = [...catCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c2, n]) => `${c2.toLowerCase()} (${n.toLocaleString("en-US")})`);

  const lead = `${total.toLocaleString()} recorded events across ${years.length} year${years.length === 1 ? "" : "s"} of the ${label}, ${span}. The largest categories are ${listPhrase(topCats)}.`;
  const description = `Browse ${total.toLocaleString()} historical events from the ${label} (${span}), year by year, on an interactive world map.`;

  const grid = years
    .map(
      (y) =>
        `      <li><a href="/year/${yearSlug(y)}/"><span class="y">${esc(yearLabel(y))}</span><span class="n">${byYear.get(y).length}</span></a></li>`
    )
    .join("\n");

  const highlights = busiest
    .map(
      (y) =>
        `      <li><a href="/year/${yearSlug(y)}/"><strong>${esc(yearLabel(y))}</strong> &mdash; ${byYear.get(y).length} events<span class="hl-sample">${esc(byYear.get(y)[0].title)}</span></a></li>`
    )
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
    <p class="section-note">Years with no recorded events are omitted. The number is how many events that year holds.</p>
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

async function main() {
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

  const urls = [
    `${SITE}/`,
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
