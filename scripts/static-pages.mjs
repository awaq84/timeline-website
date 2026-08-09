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
//   - app.js ALSO calls en.wikipedia.org on every pinned map tooltip, for the
//     article thumbnail, which then loads from upload.wikimedia.org. That is a
//     request the visitor never asked for, so the privacy page has to list it;
//     it went unlisted for a while purely because nobody re-read the page after
//     the tooltip images were added
//   - the DNS records are PROXIED through Cloudflare, so Cloudflare terminates
//     every request and its dashboard reports aggregate traffic to us. Check with
//     `dig +short timelinehistory.net A`: Cloudflare IPs (104.x/172.x) mean
//     proxied, GitHub's 185.199.108-111.153 mean DNS-only and the analytics
//     paragraph below is then claiming more than actually happens.
// If any of that changes, these pages are wrong and need editing.

export const STATIC_PAGES = [
  {
    slug: "about",
    title: "About Timeline History",
    description:
      "What Timeline History is, where its {{TOTAL_EVENTS}} events come from, and how the dataset was built from Wikidata.",
    body: `
  <h1>About Timeline History</h1>

  <p class="lead">Timeline History is an interactive map of recorded history: {{TOTAL_EVENTS}} events from {{FIRST_YEAR}} to {{LAST_YEAR}}, each placed where it happened and dated to when it happened, so you can slide through time and watch the world fill in.</p>

  <h2>What it is</h2>
  <p>Most history online is organised by topic. You read about the Crusades, or about Song dynasty China, and each sits in its own article as though the rest of the world were paused. This site is organised by <em>time</em> instead. Move the slider to 1150 and you get the Baptistery of Parma, the Taifa of Tavira dissolving, and the Tiwanaku polity ending — things that had nothing to do with each other beyond happening at once.</p>
  <p>Every year with recorded events also has its own page, written as plain HTML with no JavaScript, so it loads instantly and can be read, linked and searched without the map.</p>

  <h2>Where the data comes from</h2>
  <p>Every event is drawn from <a href="https://www.wikidata.org/" rel="noopener">Wikidata</a>, the structured database behind Wikipedia. Nothing here is written by hand: titles, descriptions, dates and coordinates are all taken from Wikidata items, which is why coverage is broad but uneven, and why the site is best understood as a view onto Wikidata rather than an encyclopedia of its own.</p>
  <p>Full details of sources and licensing are on the <a href="/attribution/">attribution page</a>.</p>

  <h2>How it was built</h2>
  <p>Events are collected by category — wars, treaties, buildings, discoveries, births and deaths, and so on — through the Wikidata Query Service, then deduplicated, given coordinates where the item or its location carries them, and split into chunks the map loads on demand. The whole dataset is 29MB, so loading it up front cost about six seconds before the first marker appeared; it now arrives in pieces as you move through time.</p>

  <h2>What it gets wrong</h2>
  <p>It is worth being direct about the limits, because they are not small.</p>
  <p><strong>Coverage is skewed.</strong> Wikidata reflects who has written about what. Europe and North America are covered far more densely than the rest of the world, and the modern era far more densely than antiquity. A thin year on this map means thin records, not a quiet year.</p>
  <p><strong>Dates are sometimes only approximate.</strong> The sources often know only that something happened in, say, the 12th century. Wikidata stores that as a placeholder date of 1101 or 1150; a Wikipedia infobox may simply say &ldquo;12th century&rdquo; or give a range. Events like these are labelled with the period actually recorded — "12th century" rather than a year — and on year pages they are listed separately under "Dated to the wider period". {{APPROX_EVENTS}} events currently carry such a label. They still appear at their placeholder year on the map, because it is the only position available and it is right to within a century, but the site does not claim they happened in that exact year.</p>
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
  <p>All {{TOTAL_EVENTS}} events come from <a href="https://www.wikidata.org/" rel="noopener">Wikidata</a>: the event titles, the one-line descriptions, the coordinates, and the dates for all but {{INFOBOX_EVENTS}} of them (see <a href="#infobox-dates">below</a>). Wikidata content is released under the <a href="https://creativecommons.org/publicdomain/zero/1.0/" rel="noopener">Creative Commons CC0 1.0 Universal Public Domain Dedication</a>, which places it in the public domain and imposes no attribution requirement.</p>
  <p>We credit it anyway. A public-domain dedication removes the obligation, not the debt: this site would not exist without the people who entered those statements, and readers deserve to know where the claims come from and where to check them.</p>

  <h2 id="infobox-dates">Dates read from Wikipedia infoboxes</h2>
  <p>{{INFOBOX_EVENTS}} events carry a date that Wikidata does not have. These are places Wikidata knows the location of but records no date for at all &mdash; no date of founding, no start time, no inception. Mohenjo-daro is the type case: forty properties, precise coordinates, and nothing at all about when it was built. For antiquity that is closer to the norm than the exception, and it is why so many years before 1000&nbsp;BC were empty here.</p>
  <p>For those events the date, and only the date, was read from the <code>built</code>, <code>founded</code>, <code>established</code> or <code>completed</code> parameter of the English Wikipedia infobox. The title and the description you read are still Wikidata's own. A date is a fact rather than a form of words, so no expression is being copied &mdash; but it is a different provenance from everything else on this page, and you are entitled to know which claims have it.</p>
  <p>These dates are parsed out of text that people typed by hand, in inconsistent formats, so they are held to a lower confidence than Wikidata's structured ones. Where the source gives a range or says &ldquo;about&rdquo;, the site shows a decade, century or millennium rather than a year, and never a precision the source did not offer.</p>

  <h2>Wikipedia</h2>
  <p>Each event links to its English Wikipedia article where one exists, and to its Wikidata item otherwise. <strong>No Wikipedia article text is reproduced on this site.</strong> Wikipedia is used only as a link destination and as a key for matching items; the descriptions you see are Wikidata's own, not extracts from articles. Wikipedia's <a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="noopener">CC BY-SA 4.0</a> licence therefore does not attach to anything published here.</p>

  <h2>Map geometry — Natural Earth</h2>
  <p>Country outlines come from <a href="https://github.com/topojson/world-atlas" rel="noopener">world-atlas</a>, a TopoJSON build of <a href="https://www.naturalearthdata.com/" rel="noopener">Natural Earth</a>. Natural Earth is in the <a href="https://www.naturalearthdata.com/about/terms-of-use/" rel="noopener">public domain</a>.</p>
  <p>Note that the map shows present-day borders at every point on the timeline. Drawing historically accurate borders for 5,000 years is a far harder problem than this site solves, so the outlines are a backdrop for placing events, not a claim about who governed what.</p>
  <p>Territories whose sovereignty is contested are hatched, using Natural Earth's <a href="https://github.com/nvkelso/natural-earth-vector" rel="noopener">disputed areas</a> dataset rather than the country outlines &mdash; the country file folds Kashmir, Crimea and the Golan Heights into whichever neighbour it picked, and marking only the handful it happens to separate out would be an editorial position rather than a description. Around half the hatched areas are too small to see at world scale &mdash; Gibraltar, the Spratlys and Rockall are disputed precisely because they are tiny &mdash; so the layer carries all 79 but shows rather fewer. Hovering a hatched area gives Natural Earth's own wording, such as &ldquo;Admin. by India; Claimed by Pakistan&rdquo;. Who administers a territory and who claims it are both checkable facts; nothing there is worded by us.</p>

  <h2>Software</h2>
  <ul>
    <li><a href="https://d3js.org/" rel="noopener">D3</a> — visualisation library, <a href="https://github.com/d3/d3/blob/main/LICENSE" rel="noopener">ISC licence</a>.</li>
    <li><a href="https://github.com/topojson/topojson-client" rel="noopener">topojson-client</a> — TopoJSON decoding, <a href="https://github.com/topojson/topojson-client/blob/master/LICENSE" rel="noopener">ISC licence</a>.</li>
  </ul>

  <h2>Corrections</h2>
  <p>Because the data is Wikidata's, factual corrections are best made at the source: edit the item on Wikidata and the correction reaches every project that uses it, not just this one. Each event page links directly to the item it came from.</p>
`,
  },

  // The quiz. Unlike its three neighbours here this page is interactive, which
  // is why layout() grew `head` and `scripts` -- it needs quiz.css and
  // quiz-app.js, and the prose pages must not start carrying them.
  //
  // The intro below is not filler. Everything a player actually sees is built by
  // JavaScript from data/quiz.js, so a crawler arriving here finds an empty
  // <div> and nothing else; without real text on the page there is nothing to
  // index and no reason for it to rank for anything.
  {
    slug: "quiz",
    title: "History Quiz",
    schemaType: "WebApplication",
    description:
      "A ten-level history quiz. Four events, one period — pick the two that belong to it. Starts with events everyone knows and ends somewhere unreasonable.",
    head: `\n<link rel="stylesheet" href="/quiz.css?v=5">`,
    scripts: `\n<script src="/quiz-app.js?v=11"></script>`,
    body: `
  <h1>History Quiz</h1>

  <p class="lead">Ten questions, ten levels. Each one shows you four events and a period of history, and asks which two of the four fall inside it. Get it right and the next level narrows the period and reaches for less famous events.</p>

  <section class="quiz-section" id="quizSection">
    <div class="quiz-body" id="quizBody">
      <p class="quiz-loading">Loading questions&hellip;</p>
    </div>
  </section>

  <h2>How the levels work</h2>
  <p>Difficulty moves on two axes at once. The target period starts fifteen centuries wide &mdash; level 1 is really asking which millennium something belongs to &mdash; and closes to ten years, so guessing roughly the right era stops being enough. At the same time the events themselves get more obscure: level 1 draws only on events with a Wikipedia article in more than 120 languages — the moon landing, the fall of the Berlin Wall, the founding of the Roman Republic — while level 10 will happily ask you about the Battle of Graus.</p>
  <p>You will not be marked wrong for a date nobody agrees on. Every event in the quiz is one Wikidata records to an exact year; the tens of thousands of events elsewhere on this site that are known only to a century or a decade are excluded from it entirely, because a question you cannot fairly answer is not a question.</p>

  <h2>Where the questions come from</h2>
  <p>All 3,012 of them are drawn from the same <a href="/about/">Wikidata-derived dataset</a> behind the <a href="/">interactive map</a>, filtered down to events that are dated precisely, phrased as a statement of something that happened, and well enough recorded to be a fair question. Nothing is written by hand except the phrasing of a few dozen famous events whose titles do not read as sentences.</p>
  <p>Your score lives in the page and nowhere else. This site <a href="/privacy/">sets no cookies and stores nothing</a>, so closing the tab ends the run — there is no leaderboard and no account.</p>
`,
  },

  {
    slug: "privacy",
    title: "Privacy Policy",
    description:
      "Timeline History sets no cookies, runs no tracking scripts and collects no personal data. What the site does and does not do with your information.",
    body: `
  <h1>Privacy Policy</h1>

  <p class="lead">Timeline History sets no cookies, runs no tracking scripts, and asks you for nothing. This page explains what little does happen.</p>
  <p class="section-note">Last updated: 2 August 2026.</p>

  <h2>What this site collects</h2>
  <p>Nothing. There is no account system, no contact form, no newsletter and no comments. The site never asks for your name, email address or any other personal detail, and there is nowhere for you to enter one.</p>

  <h2>Cookies and local storage</h2>
  <p>This site sets no cookies and writes nothing to your browser's local or session storage. Your filter selections and the year you are viewing live in the page's URL and in memory only, and are gone when you close the tab.</p>

  <h2>Analytics</h2>
  <p>Nothing on this site measures you. There is no Google Analytics, no tracking pixel, no fingerprinting, and no script of any kind that runs in your browser to record what you do. Nothing you click, filter or scroll is reported anywhere.</p>
  <p>Visits are counted at the network edge instead. Every request passes through <a href="https://www.cloudflare.com/privacypolicy/" rel="noopener">Cloudflare</a> on its way to the site, and Cloudflare produces totals from that — how many requests arrived, which pages were asked for, roughly which countries they came from, and how much of it was automated rather than human. Those totals are visible to whoever runs this site.</p>
  <p>This happens on Cloudflare's servers as a by-product of delivering the page, not in your browser. It puts nothing on your device, it cannot follow you to any other site, and the figures are aggregate — they say a hundred people opened the map yesterday, not which hundred. Cloudflare does see your IP address in the course of serving you, exactly as GitHub Pages already did and as every web server must; that is covered below.</p>

  <h2>Third parties that do see something</h2>
  <p>Loading any web page reveals your IP address and browser details to whoever serves it. For this site that means:</p>
  <ul>
    <li><strong><a href="https://www.cloudflare.com/privacypolicy/" rel="noopener">Cloudflare</a></strong>, which handles DNS, serves the site and counts requests as described above.</li>
    <li><strong><a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" rel="noopener">GitHub Pages</a></strong>, which stores the site and keeps server logs.</li>
    <li><strong><a href="https://d3js.org/" rel="noopener">d3js.org</a></strong> and <strong><a href="https://www.jsdelivr.com/terms/privacy-policy-jsdelivr-net" rel="noopener">jsDelivr</a></strong>, content delivery networks the map libraries and country outlines are loaded from.</li>
    <li><strong><a href="https://foundation.wikimedia.org/wiki/Policy:Privacy_policy" rel="noopener">Wikimedia</a></strong>, when you open an event on the map. Clicking a marker asks Wikipedia for that article&rsquo;s picture, so your browser contacts <code>en.wikipedia.org</code> and, if there is a picture, <code>upload.wikimedia.org</code>. This happens whether or not you follow the link, and only for events you actually open.</li>
  </ul>
  <p>None of these are under our control, and each has its own privacy policy, linked above. Only Cloudflare reports anything back to us, and only as the aggregate totals described above &mdash; never a record of what any particular visitor did. Nothing is reported back to us by Wikimedia at all; we do not learn which events you opened.</p>

  <h2>Links to other sites</h2>
  <p>Every event links out to Wikipedia or Wikidata. Once you follow such a link you are on the <a href="https://foundation.wikimedia.org/wiki/Policy:Privacy_policy" rel="noopener">Wikimedia Foundation's</a> site and its privacy policy applies, not this one.</p>

  <h2>Children</h2>
  <p>Since no personal data is collected from anyone, none is collected from children either.</p>

  <h2>Changes</h2>
  <p>If this site ever adds advertising, analytics or anything else that processes visitor data, this page will be updated to say so before that happens, and the date at the top will change.</p>
`,
  },
];
