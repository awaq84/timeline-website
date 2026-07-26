// Prose pages: /about/, /attribution/ and /privacy/.
//
// Kept out of build-year-pages.mjs because that script is generated-content
// machinery and this is hand-written text, but rendered BY it so both go through
// the same layout() and land in the same sitemap.xml. A separate build step
// would eventually be forgotten and these three would drift out of the sitemap.
//
// Anything factual here is checked against the code rather than remembered:
//   - what we reproduce is Wikidata labels and schema:description, both CC0
//   - Wikipedia is a link target only; fetch-events.mjs never requests article
//     text, so CC BY-SA does not attach to anything on this site
//   - app.js sets no cookie and no storage, and loads d3js.org + jsdelivr
// If any of that changes, these pages are wrong and need editing.

export const STATIC_PAGES = [
  {
    slug: "about",
    title: "About Timeline History",
    description:
      "What Timeline History is, where its 111,389 events come from, and how the dataset was built from Wikidata.",
    body: `
  <h1>About Timeline History</h1>

  <p class="lead">Timeline History is an interactive map of recorded history: 111,389 events from 3001 BC to 2026, each placed where it happened and dated to when it happened, so you can slide through time and watch the world fill in.</p>

  <h2>What it is</h2>
  <p>Most history online is organised by topic. You read about the Crusades, or about Song dynasty China, and each sits in its own article as though the rest of the world were paused. This site is organised by <em>time</em> instead. Move the slider to 1150 and you get the Baptistery of Parma, the Taifa of Tavira dissolving, and the Tiwanaku polity ending — things that had nothing to do with each other beyond happening at once.</p>
  <p>Every year with recorded events also has its own page, written as plain HTML with no JavaScript, so it loads instantly and can be read, linked and searched without the map.</p>

  <h2>Where the data comes from</h2>
  <p>Every event is drawn from <a href="https://www.wikidata.org/" rel="noopener">Wikidata</a>, the structured database behind Wikipedia. Nothing here is written by hand: titles, descriptions, dates and coordinates are all taken from Wikidata items, which is why coverage is broad but uneven, and why the site is best understood as a view onto Wikidata rather than an encyclopedia of its own.</p>
  <p>Full details of sources and licensing are on the <a href="/attribution/">attribution page</a>.</p>

  <h2>How it was built</h2>
  <p>Events are collected by category — wars, treaties, buildings, discoveries, births and deaths, and so on — through the Wikidata Query Service, then deduplicated, given coordinates where the item or its location carries them, and split into chunks the map loads on demand. The whole dataset is 28MB, so loading it up front cost about six seconds before the first marker appeared; it now arrives in pieces as you move through time.</p>

  <h2>What it gets wrong</h2>
  <p>It is worth being direct about the limits, because they are not small.</p>
  <p><strong>Coverage is skewed.</strong> Wikidata reflects who has written about what. Europe and North America are covered far more densely than the rest of the world, and the modern era far more densely than antiquity. A thin year on this map means thin records, not a quiet year.</p>
  <p><strong>Dates are sometimes only approximate.</strong> Wikidata often knows only that something happened in, say, the 12th century, and stores that as a placeholder date of 1101 or 1150. Events like these are labelled with the period actually recorded — "12th century" rather than a year — and on year pages they are listed separately under "Dated to the wider period". 6,832 events currently carry such a label. They still appear at their placeholder year on the map, because it is the only position available and it is right to within a century, but the site does not claim they happened in that exact year.</p>
  <p><strong>Locations are approximate too.</strong> A battle is placed at its named location's coordinates, which may be a modern city centre rather than the field it was fought on.</p>
  <p><strong>It is a snapshot.</strong> The dataset was captured at a point in time and does not update live as Wikidata changes.</p>
  <p>If something looks wrong, it is usually wrong in Wikidata, and fixing it there fixes it for everyone. Each event links to its Wikidata item or Wikipedia article so you can check.</p>
`,
  },

  {
    slug: "attribution",
    title: "Sources & Attribution",
    description:
      "Timeline History is built from Wikidata (CC0) and uses Natural Earth map geometry, D3 and TopoJSON. Full source and licence details.",
    body: `
  <h1>Sources &amp; Attribution</h1>

  <p class="lead">This site is built almost entirely from other people's work. This page records whose, and under what terms.</p>

  <h2>Event data — Wikidata</h2>
  <p>All 111,389 events come from <a href="https://www.wikidata.org/" rel="noopener">Wikidata</a>: the event titles, the one-line descriptions, the dates, the date precisions and the coordinates. Wikidata content is released under the <a href="https://creativecommons.org/publicdomain/zero/1.0/" rel="noopener">Creative Commons CC0 1.0 Universal Public Domain Dedication</a>, which places it in the public domain and imposes no attribution requirement.</p>
  <p>We credit it anyway. A public-domain dedication removes the obligation, not the debt: this site would not exist without the people who entered those statements, and readers deserve to know where the claims come from and where to check them.</p>

  <h2>Wikipedia</h2>
  <p>Each event links to its English Wikipedia article where one exists, and to its Wikidata item otherwise. <strong>No Wikipedia article text is reproduced on this site.</strong> Wikipedia is used only as a link destination and as a key for matching items; the descriptions you see are Wikidata's own, not extracts from articles. Wikipedia's <a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="noopener">CC BY-SA 4.0</a> licence therefore does not attach to anything published here.</p>

  <h2>Map geometry — Natural Earth</h2>
  <p>Country outlines come from <a href="https://github.com/topojson/world-atlas" rel="noopener">world-atlas</a>, a TopoJSON build of <a href="https://www.naturalearthdata.com/" rel="noopener">Natural Earth</a>. Natural Earth is in the <a href="https://www.naturalearthdata.com/about/terms-of-use/" rel="noopener">public domain</a>.</p>
  <p>Note that the map shows present-day borders at every point on the timeline. Drawing historically accurate borders for 5,000 years is a far harder problem than this site solves, so the outlines are a backdrop for placing events, not a claim about who governed what.</p>

  <h2>Software</h2>
  <ul>
    <li><a href="https://d3js.org/" rel="noopener">D3</a> — visualisation library, <a href="https://github.com/d3/d3/blob/main/LICENSE" rel="noopener">ISC licence</a>.</li>
    <li><a href="https://github.com/topojson/topojson-client" rel="noopener">topojson-client</a> — TopoJSON decoding, <a href="https://github.com/topojson/topojson-client/blob/master/LICENSE.md" rel="noopener">ISC licence</a>.</li>
  </ul>

  <h2>Corrections</h2>
  <p>Because the data is Wikidata's, factual corrections are best made at the source: edit the item on Wikidata and the correction reaches every project that uses it, not just this one. Each event page links directly to the item it came from.</p>
`,
  },

  {
    slug: "privacy",
    title: "Privacy Policy",
    description:
      "Timeline History sets no cookies, runs no analytics and collects no personal data. What the site does and does not do with your information.",
    body: `
  <h1>Privacy Policy</h1>

  <p class="lead">Timeline History sets no cookies, runs no analytics, and asks you for nothing. This page explains what little does happen.</p>
  <p class="section-note">Last updated: 26 July 2026.</p>

  <h2>What this site collects</h2>
  <p>Nothing. There is no account system, no contact form, no newsletter and no comments. The site never asks for your name, email address or any other personal detail, and there is nowhere for you to enter one.</p>

  <h2>Cookies and local storage</h2>
  <p>This site sets no cookies and writes nothing to your browser's local or session storage. Your filter selections and the year you are viewing live in the page's URL and in memory only, and are gone when you close the tab.</p>

  <h2>Analytics</h2>
  <p>There are none. No Google Analytics, no tracking pixels, no fingerprinting, no third-party measurement of any kind.</p>

  <h2>Third parties that do see something</h2>
  <p>Loading any web page reveals your IP address and browser details to whoever serves it. For this site that means:</p>
  <ul>
    <li><strong><a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" rel="noopener">GitHub Pages</a></strong>, which hosts the site and keeps server logs.</li>
    <li><strong><a href="https://www.cloudflare.com/privacypolicy/" rel="noopener">Cloudflare</a></strong>, which provides DNS and sits in front of the site.</li>
    <li><strong><a href="https://d3js.org/" rel="noopener">d3js.org</a></strong> and <strong><a href="https://www.jsdelivr.com/terms/privacy-policy-jsdelivr-net" rel="noopener">jsDelivr</a></strong>, content delivery networks the map libraries and country outlines are loaded from.</li>
  </ul>
  <p>None of these are under our control, and each has its own privacy policy, linked above. We receive no data from any of them.</p>

  <h2>Links to other sites</h2>
  <p>Every event links out to Wikipedia or Wikidata. Once you follow such a link you are on the <a href="https://foundation.wikimedia.org/wiki/Policy:Privacy_policy" rel="noopener">Wikimedia Foundation's</a> site and its privacy policy applies, not this one.</p>

  <h2>Children</h2>
  <p>Since no personal data is collected from anyone, none is collected from children either.</p>

  <h2>Changes</h2>
  <p>If this site ever adds advertising, analytics or anything else that processes visitor data, this page will be updated to say so before that happens, and the date at the top will change.</p>
`,
  },
];
