// Prototype logic: world map (D3 + topojson), year slider, category filters, event list.

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

// One glyph per category, drawn on top of the category-coloured dot so the
// marker carries its meaning even for colour-blind users (several of the 13
// palette colours are hard to tell apart otherwise).
//
// All paths are authored in a 24x24 box and stroked rather than filled --
// stroked outlines stay legible when scaled down to ~11px, where fine filled
// detail turns into mush. Keep any new glyph to a handful of bold strokes.
const CATEGORY_ICONS = {
  // Star
  "Major Events": "M12 4l2.4 5.2 5.6.6-4.2 3.9 1.2 5.5L12 16.4 7 19.2l1.2-5.5L4 9.8l5.6-.6z",
  // Crossed swords
  "Wars & Conflicts": "M6 5l12 12M18 5L6 17M3 19l4-4M21 19l-4-4",
  // Classical building with columns
  "Politics & Government": "M3 21h18M12 3l8 4H4zM6 21V9M10 21V9M14 21V9M18 21V9",
  // Head and shoulders
  People: "M12 8.2a3.1 3.1 0 100-6.2 3.1 3.1 0 000 6.2zM4.8 21c0-4 3.2-7.2 7.2-7.2s7.2 3.2 7.2 7.2",
  // Laboratory flask
  "Science & Technology": "M9 3h6M10 3v6l-5 9a1.8 1.8 0 001.6 2.8h10.8A1.8 1.8 0 0019 18l-5-9V3",
  // Compass needle
  "Exploration & Discovery": "M12 2.5a9.5 9.5 0 100 19 9.5 9.5 0 000-19zM16.2 7.8l-2.6 6.4-6.4 2.6 2.6-6.4z",
  // Domed place of worship
  "Religion & Belief Systems": "M12 2v3M3 21h18M6 21V11a6 6 0 0112 0v10",
  // Coin
  "Economy & Trade": "M12 2.5a9.5 9.5 0 100 19 9.5 9.5 0 000-19zM12 6.5v11M14.8 9.6c0-1.4-1.2-2.1-2.8-2.1s-2.8.8-2.8 2.1 1.3 1.9 2.8 2.3 2.8 1 2.8 2.4-1.2 2.1-2.8 2.1-2.8-.7-2.8-2.1",
  // Warning triangle
  "Disasters & Pandemics": "M12 3l9.5 17H2.5zM12 9v5M12 17.4v.2",
  // Raised flag
  "Social Movements & Revolutions": "M5.5 21V3M5.5 3.5h11l-2.2 4.2 2.2 4.2h-11",
  // Crane / building under construction
  "Architecture & Engineering": "M4 21V7l8-4 8 4v14M9.5 21v-5.5h5V21M8.5 10.5h2M13.5 10.5h2",
  // Trophy
  "Sports & Entertainment": "M8 3.5h8V9a4 4 0 01-8 0zM5 4.5h3M16 4.5h3M12 13v4M9 21h6",
  // Crown
  "Empires & Countries": "M3 8l3.6 11h10.8L21 8l-5 4-4-7-4 7z",
};

const state = {
  year: 1969,
  activeCategories: new Set(CATEGORY_ORDER),
  playing: false,
  playTimer: null,
};

const yearSlider = document.getElementById("yearSlider");
const yearBadge = document.getElementById("yearBadge");
const eventsYearEl = document.getElementById("eventsYear");
const eventsListEl = document.getElementById("eventsList");
const categoryFiltersEl = document.getElementById("categoryFilters");
const stepBackBtn = document.getElementById("stepBack");
const stepForwardBtn = document.getElementById("stepForward");
const playBtn = document.getElementById("playBtn");
const mapSectionEl = document.querySelector(".map-section");
const mapTooltipEl = document.getElementById("mapTooltip");
const datasetStatEl = document.getElementById("datasetStat");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomResetBtn = document.getElementById("zoomResetBtn");
const mapZoomHintEl = document.getElementById("mapZoomHint");
const discoveryPromptEl = document.getElementById("discoveryPrompt");
const discoveryRefreshBtnEl = document.getElementById("discoveryRefreshBtn");
const discoverGoBtnEl = document.getElementById("discoverGoBtn");

// A curated shortlist of genuinely famous "everyone's heard of this" moments
// (a subset of the hand-authored "Major Events" category, not the full
// programmatically-fetched dataset) that anchor the "Discover" jump-to-year
// feature above the map. Matched against the real event by title so the
// year/location always stays in sync with the dataset.
const DISCOVERY_PROMPTS = [
  { title: "Great Pyramid of Giza completed", question: "the Pyramids of Giza were built" },
  { title: "First Olympic Games", question: "the first Olympic Games were held" },
  { title: "Founding of the Roman Republic", question: "Rome became a republic" },
  { title: "Qin Shi Huang unifies China", question: "China was first unified" },
  { title: "Assassination of Julius Caesar", question: "Julius Caesar was assassinated" },
  { title: "Crucifixion of Jesus", question: "Jesus was crucified" },
  { title: "Eruption of Mount Vesuvius", question: "Pompeii was buried by Mount Vesuvius" },
  { title: "Fall of the Western Roman Empire", question: "the Roman Empire fell" },
  { title: "The Hijra", question: "the Hijra took place and the Islamic calendar began" },
  { title: "Battle of Hastings", question: "the Battle of Hastings was fought" },
  { title: "Genghis Khan founds the Mongol Empire", question: "Genghis Khan founded the Mongol Empire" },
  { title: "Signing of the Magna Carta", question: "the Magna Carta was signed" },
  { title: "The Black Death reaches Europe", question: "the Black Death swept through Europe" },
  { title: "Gutenberg's Printing Press", question: "Gutenberg invented the printing press" },
  { title: "Fall of Constantinople", question: "Constantinople fell to the Ottomans" },
  { title: "Columbus reaches the Americas", question: "Columbus reached the Americas" },
  { title: "Luther's 95 Theses", question: "Martin Luther sparked the Reformation" },
  { title: "Great Fire of London", question: "the Great Fire of London broke out" },
  { title: "Newton publishes the Principia", question: "Newton published his laws of motion" },
  { title: "US Declaration of Independence", question: "the US Declaration of Independence was signed" },
  { title: "Storming of the Bastille", question: "the French Revolution began" },
  { title: "Battle of Waterloo", question: "Napoleon was defeated at Waterloo" },
  { title: "Darwin publishes On the Origin of Species", question: "Darwin published On the Origin of Species" },
  { title: "American Civil War begins", question: "the American Civil War began" },
  { title: "Telephone invented", question: "the telephone was invented" },
  { title: "Eiffel Tower completed", question: "the Eiffel Tower was built" },
  { title: "First powered flight", question: "the Wright brothers achieved the first powered flight" },
  { title: "Sinking of the Titanic", question: "the Titanic sank" },
  { title: "End of World War I", question: "World War I ended" },
  { title: "Tutankhamun's tomb discovered", question: "Tutankhamun's tomb was discovered" },
  { title: "Wall Street Crash", question: "the Wall Street Crash triggered the Great Depression" },
  { title: "Germany invades Poland", question: "World War II began" },
  { title: "Attack on Pearl Harbor", question: "Pearl Harbor was attacked" },
  { title: "D-Day landings", question: "the D-Day landings took place" },
  { title: "Atomic bombing of Hiroshima", question: "the atomic bomb was dropped on Hiroshima" },
  { title: "Launch of Sputnik", question: "Sputnik launched the Space Age" },
  { title: "Assassination of John F. Kennedy", question: "JFK was assassinated" },
  { title: "Apollo 11 Moon Landing", question: "humans first walked on the Moon" },
  { title: "Fall of the Berlin Wall", question: "the Berlin Wall fell" },
  { title: "World Wide Web goes public", question: "the World Wide Web went public" },
  { title: "September 11 attacks", question: "the September 11 attacks happened" },
  { title: "First iPhone released", question: "the first iPhone was released" },
  { title: "COVID-19 declared a pandemic", question: "COVID-19 was declared a pandemic" },
];

function formatYear(y) {
  return y < 0 ? `${Math.abs(y)} BCE` : `${y}`;
}

function getFilteredEvents() {
  return EVENTS.filter((e) => state.activeCategories.has(e.category));
}

function getEventYears() {
  return [...new Set(getFilteredEvents().map((e) => e.year))].sort((a, b) => a - b);
}

// Builds a marker-lookalike swatch (coloured disc + category glyph) for use in
// the filter list and the pinned event card.
function categorySwatch(cat, size = 18) {
  const svgNS = "http://www.w3.org/2000/svg";
  const iconSize = size * 0.6875; // matches the map's 8:11 dot-to-glyph ratio
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "chip-dot");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("viewBox", `${-size / 2} ${-size / 2} ${size} ${size}`);
  svg.setAttribute("aria-hidden", "true");

  const circle = document.createElementNS(svgNS, "circle");
  circle.setAttribute("r", size / 2 - 0.75);
  circle.setAttribute("fill", CATEGORY_COLORS[cat] || "#888");
  svg.appendChild(circle);

  if (CATEGORY_ICONS[cat]) {
    const g = document.createElementNS(svgNS, "g");
    g.setAttribute("transform", `translate(${-iconSize / 2},${-iconSize / 2}) scale(${iconSize / 24})`);
    const p = document.createElementNS(svgNS, "path");
    p.setAttribute("d", CATEGORY_ICONS[cat]);
    g.appendChild(p);
    svg.appendChild(g);
  }
  return svg;
}

function buildCategoryFilters() {
  categoryFiltersEl.innerHTML = "";
  CATEGORY_ORDER.forEach((cat) => {
    const id = `cat-${cat.replace(/[^a-z0-9]/gi, "")}`;
    const wrapper = document.createElement("label");
    wrapper.className = "chip";
    wrapper.setAttribute("for", id);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "chip-input";
    checkbox.id = id;
    checkbox.checked = state.activeCategories.has(cat);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.activeCategories.add(cat);
      else state.activeCategories.delete(cat);
      renderAll();
    });

    // The swatch shows the same colour *and* glyph as the map marker, so the
    // filter list doubles as the map legend -- 13 glyphs is more than anyone
    // will memorise from the map alone.
    const swatch = categorySwatch(cat);

    wrapper.appendChild(checkbox);
    wrapper.appendChild(swatch);
    wrapper.appendChild(document.createTextNode(cat));
    categoryFiltersEl.appendChild(wrapper);
  });
}

document.getElementById("selectAll").addEventListener("click", () => {
  state.activeCategories = new Set(CATEGORY_ORDER);
  buildCategoryFilters();
  renderAll();
});

document.getElementById("clearAll").addEventListener("click", () => {
  state.activeCategories = new Set();
  buildCategoryFilters();
  renderAll();
});

function renderEventsList(currentEvents) {
  eventsYearEl.textContent = formatYear(state.year);
  eventsListEl.innerHTML = "";

  if (currentEvents.length === 0) {
    const nearestInfo = findNearestEventYear(state.year);
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = nearestInfo
      ? `No recorded events in ${formatYear(state.year)}. Nearest: ${formatYear(nearestInfo)} — use the arrows to jump there.`
      : `No events match the selected focus areas.`;
    eventsListEl.appendChild(empty);
    return;
  }

  currentEvents.forEach((e) => {
    const card = document.createElement("div");
    card.className = "event-card";
    card.style.borderLeftColor = CATEGORY_COLORS[e.category] || "#888";

    const isWikidata = e.source === "wikidata";
    card.innerHTML = `
      <h3>${e.title}</h3>
      <div class="event-meta"><span class="event-meta-swatch"></span>${e.category}${e.location ? ` &middot; ${e.location}` : ""}</div>
      <p class="event-summary">${e.summary}</p>
      <a href="${e.wiki}" target="_blank" rel="noopener noreferrer">${isWikidata ? "View source on Wikidata" : "Read more on Wikipedia"} &rarr;</a>
    `;
    // Same glyph as the map marker and the filter legend, so a category is
    // recognisable in all three places.
    card.querySelector(".event-meta-swatch").appendChild(categorySwatch(e.category, 14));
    eventsListEl.appendChild(card);
  });
}

function findNearestEventYear(year) {
  const years = getEventYears();
  if (years.length === 0) return null;
  return years.reduce((best, y) =>
    Math.abs(y - year) < Math.abs(best - year) ? y : best
  );
}

// ---- Map rendering ----

let projection, path, svg, zoomLayer, markerLayer, zoomBehavior;
let currentZoomK = 1;
// Dots are bigger than the old r=5 so a glyph fits legibly inside them.
const MARKER_R = 8;
const ICON_SIZE = 11;

// Stable identity for an event. Title alone isn't unique (see renderMarkers).
const eventKey = (d) => `${d.year}|${d.title}|${d.lat}|${d.lng}`;
// Title of the marker currently spotlighted by Discover, if any.
let spotlightKey = null;
const MAP_WIDTH = 960;
const MAP_HEIGHT = 500;

function initMap() {
  svg = d3
    .select("#map")
    .append("svg")
    .attr("viewBox", `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`);

  projection = d3.geoNaturalEarth1().scale(160).translate([MAP_WIDTH / 2, MAP_HEIGHT / 2]);
  path = d3.geoPath(projection);

  zoomLayer = svg.append("g").attr("class", "zoom-layer");
  const landLayer = zoomLayer.append("g").attr("class", "land-layer");
  markerLayer = zoomLayer.append("g").attr("class", "marker-layer");

  zoomBehavior = d3
    .zoom()
    .scaleExtent([1, 14])
    .translateExtent([
      [0, 0],
      [MAP_WIDTH, MAP_HEIGHT],
    ])
    .extent([
      [0, 0],
      [MAP_WIDTH, MAP_HEIGHT],
    ])
    .on("start", () => {
      svg.classed("zooming", true);
      dismissZoomHint();
    })
    .on("zoom", (event) => {
      currentZoomK = event.transform.k;
      zoomLayer.attr("transform", event.transform);
      markerLayer.selectAll(".marker-visual").attr("transform", `scale(${1 / currentZoomK})`);
      scheduleLabelReflow();
    })
    .on("end", () => {
      svg.classed("zooming", false);
    });

  svg.call(zoomBehavior);

  zoomInBtn?.addEventListener("click", () => {
    dismissZoomHint();
    svg.transition().duration(220).call(zoomBehavior.scaleBy, 1.6);
  });
  zoomOutBtn?.addEventListener("click", () => {
    dismissZoomHint();
    svg.transition().duration(220).call(zoomBehavior.scaleBy, 1 / 1.6);
  });
  zoomResetBtn?.addEventListener("click", () => {
    dismissZoomHint();
    svg.transition().duration(300).call(zoomBehavior.transform, d3.zoomIdentity);
  });

  d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json").then((world) => {
    const countries = topojson.feature(world, world.objects.countries);
    landLayer
      .selectAll("path")
      .data(countries.features)
      .join("path")
      .attr("class", "land")
      .attr("d", path);
    renderAll();
  });
}

function dismissZoomHint() {
  mapZoomHintEl?.classList.add("hidden");
}

let labelReflowTimer = null;
function scheduleLabelReflow() {
  clearTimeout(labelReflowTimer);
  labelReflowTimer = setTimeout(resolveLabelCollisions, 120);
}

function renderMarkers(currentEvents) {
  if (!markerLayer) return;
  // The marker set is changing, so any pinned card may point at an event
  // that's about to disappear -- always clear it, pinned or not. Same reasoning
  // for the Discover spotlight; jumpToEvent() re-applies it after this render.
  unpinMapTooltip();
  clearSpotlight();

  // Keyed on more than the title: ~300 titles in the dataset are genuinely
  // shared by two events in the same year (several Roman consuls share a name,
  // and cities were besieged repeatedly). Keying on title alone silently
  // collapsed those into a single marker, losing ~455 of them.
  const groups = markerLayer.selectAll("g.event-marker").data(currentEvents, eventKey);

  groups.exit().remove();

  const entered = groups
    .enter()
    .append("g")
    .attr("class", "event-marker")
    .attr("transform", (d) => {
      const coords = projection([d.lng, d.lat]);
      return coords ? `translate(${coords[0]}, ${coords[1]})` : "translate(-100,-100)";
    });

  // Visuals live in a nested group that's counter-scaled against the current
  // zoom level, so dots/labels stay a constant pixel size while geographic
  // distance between them grows as you zoom in -- that's what lets zoom
  // actually pull overlapping markers apart instead of just magnifying them.
  const visual = entered.append("g").attr("class", "marker-visual").attr("transform", `scale(${1 / currentZoomK})`);

  visual.append("circle").attr("class", "marker-halo").attr("r", 11);
  visual.append("circle").attr("r", MARKER_R);
  // The glyph is authored in a 24x24 box, so scale it down and re-centre it on
  // the dot. Kept as a sibling of the dot (not a child) so the existing
  // circle-based selectors and the spotlight's r animation keep working.
  visual
    .append("g")
    .attr("class", "marker-icon")
    .attr("transform", `translate(${-ICON_SIZE / 2},${-ICON_SIZE / 2}) scale(${ICON_SIZE / 24})`)
    .append("path")
    .attr("d", (d) => CATEGORY_ICONS[d.category] || "");
  visual
    .append("text")
    .attr("class", "marker-label")
    .attr("x", MARKER_R + 5)
    .attr("y", 4)
    .text((d) => d.title);

  entered
    .on("mouseenter", (event, d) => showMapTooltip(event, d))
    .on("mousemove", (event) => {
      if (!isTooltipPinned()) positionMapTooltip(event);
    })
    .on("mouseleave", hideMapTooltip)
    .on("click", (event, d) => {
      // Stop the click reaching the document-level dismiss handler below.
      event.stopPropagation();
      pinMapTooltip(event, d);
    });

  const merged = entered.merge(groups).attr("transform", (d) => {
    const coords = projection([d.lng, d.lat]);
    return coords ? `translate(${coords[0]}, ${coords[1]})` : "translate(-100,-100)";
  });

  // Markers of deselected categories stay visible but greyed; the actual grey
  // is in CSS, which beats these presentation attributes.
  merged.classed("inactive", (d) => !state.activeCategories.has(d.category));
  merged.select(".marker-visual circle:last-of-type").attr("fill", (d) => CATEGORY_COLORS[d.category] || "#4fb0ff");
  merged.select(".marker-visual .marker-halo").attr("stroke", (d) => CATEGORY_COLORS[d.category] || "#4fb0ff");

  resolveLabelCollisions();
}

// Tries a handful of positions around each dot (right, left, above, below) and
// hides the label (keeping just the dot + hover tooltip) if none are free.
const LABEL_OFFSETS = [
  { dx: MARKER_R + 5, dy: 4, anchor: "start" },
  { dx: -(MARKER_R + 5), dy: 4, anchor: "end" },
  { dx: MARKER_R + 5, dy: -10, anchor: "start" },
  { dx: MARKER_R + 5, dy: 18, anchor: "start" },
  { dx: -(MARKER_R + 5), dy: -10, anchor: "end" },
  { dx: -(MARKER_R + 5), dy: 18, anchor: "end" },
];

function resolveLabelCollisions() {
  const groups = markerLayer.selectAll("g.event-marker").nodes();

  // Seed with each *active* dot's own footprint (tagged with its owning node)
  // so labels route around neighboring markers, not just around each other's
  // text. Each marker's own dot is excluded when checking its own label.
  // Marker positions are stored in pre-zoom map coordinates, but marker
  // *visuals* (dot + label) are counter-scaled to stay a constant pixel
  // size -- so to compare footprints in the same "pixel space" we scale
  // each marker's local position by the current zoom factor. Translation
  // from panning cancels out in the overlap comparison, so it's ignored.
  //
  // Greyed-out dots are deliberately NOT obstacles. They're still drawn (as
  // faint geographic context), but treating them as blockers meant narrowing
  // the filter down to one category produced *zero* labels: at a busy year the
  // few surviving markers sit inside a cluster of a couple hundred greyed dots,
  // and every candidate offset collided with one. A label crossing a 45%-opacity
  // grey dot is a far smaller cost than no label at all.
  const dotRadius = MARKER_R + 2;
  const localXY = (g) => {
    const matrix = g.transform.baseVal.consolidate();
    return {
      x: (matrix ? matrix.matrix.e : 0) * currentZoomK,
      y: (matrix ? matrix.matrix.f : 0) * currentZoomK,
    };
  };
  const placedRects = groups
    .filter((g) => !g.classList.contains("inactive"))
    .map((g) => {
      const { x, y } = localXY(g);
      return {
        owner: g,
        x1: x - dotRadius,
        y1: y - dotRadius,
        x2: x + dotRadius,
        y2: y + dotRadius,
      };
    });

  const sorted = groups.slice().sort((a, b) => localXY(a).x - localXY(b).x);

  // Labels are full event titles, some of which are very long, so a label
  // anchored near an edge can easily run outside the map. The overlap test
  // above works in a pan-independent space, so for the edge test we fall back
  // to real screen rects, which account for zoom and pan automatically.
  const svgRect = svg.node().getBoundingClientRect();

  sorted.forEach((g) => {
    const text = g.querySelector(".marker-label");
    if (!text) return;
    const { x: px, y: py } = localXY(g);

    // Greyed-out (deselected) markers never get a label -- they're context, not
    // content. They're also not obstacles for anyone else's label; see the
    // placedRects seed above for why.
    if (g.classList.contains("inactive")) {
      text.style.display = "none";
      return;
    }

    text.style.display = "";
    let placed = false;

    for (const offset of LABEL_OFFSETS) {
      text.setAttribute("x", offset.dx);
      text.setAttribute("y", offset.dy);
      text.setAttribute("text-anchor", offset.anchor);
      const bbox = text.getBBox();
      const rect = {
        x1: px + bbox.x - 3,
        y1: py + bbox.y - 3,
        x2: px + bbox.x + bbox.width + 3,
        y2: py + bbox.y + bbox.height + 3,
      };
      const overlaps = placedRects.some(
        (r) => r.owner !== g && rect.x1 < r.x2 && rect.x2 > r.x1 && rect.y1 < r.y2 && rect.y2 > r.y1
      );
      const screen = text.getBoundingClientRect();
      const outOfBounds =
        screen.left < svgRect.left ||
        screen.right > svgRect.right ||
        screen.top < svgRect.top ||
        screen.bottom > svgRect.bottom;
      if (!overlaps && !outOfBounds) {
        placedRects.push({ owner: g, ...rect });
        placed = true;
        break;
      }
    }

    if (!placed) {
      text.style.display = "none";
    }
  });
}

// ---- Map hover tooltip ----

// Thumbnail images aren't stored in the dataset (adding one per event would
// balloon the already-18MB data file); instead we lazily fetch them from
// Wikipedia's public REST summary API on hover and cache the result in
// memory so re-hovering the same marker is instant and only fetched once.
const tooltipImageCache = new Map(); // wiki url -> image url | null
let tooltipHoverToken = 0;

function wikipediaTitleFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)wikipedia\.org$/.test(u.hostname)) return null;
    const match = /^\/wiki\/(.+)$/.exec(u.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

async function fetchTooltipImage(d) {
  if (tooltipImageCache.has(d.wiki)) return tooltipImageCache.get(d.wiki);
  const title = wikipediaTitleFromUrl(d.wiki);
  if (!title) {
    tooltipImageCache.set(d.wiki, null);
    return null;
  }
  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const img = json.thumbnail?.source || null;
    tooltipImageCache.set(d.wiki, img);
    return img;
  } catch {
    tooltipImageCache.set(d.wiki, null);
    return null;
  }
}

function applyTooltipImage(token, imgUrl, event) {
  if (token !== tooltipHoverToken) return; // hover moved on before fetch resolved
  const wrap = document.getElementById("tooltipImageWrap");
  if (!wrap) return;
  if (imgUrl) {
    wrap.innerHTML = `<img src="${imgUrl}" alt="" class="tooltip-image">`;
  } else {
    wrap.innerHTML = "";
  }
  positionMapTooltip(event);
}

// A pinned tooltip (set by clicking a marker) stays put and becomes
// interactive, so the user can actually click through to the source link.
// While pinned it takes precedence over hover, and is dismissed by the close
// button, Escape, clicking outside it, or the marker set being re-rendered.
let pinnedEventKey = null;

function isTooltipPinned() {
  return pinnedEventKey !== null;
}

function tooltipMarkup(d, pinned) {
  const linkText = d.source === "wikidata" ? "View source on Wikidata" : "Read more on Wikipedia";
  const active = state.activeCategories.has(d.category);
  return `
    <div class="tooltip-image-wrap" id="tooltipImageWrap"></div>
    ${pinned ? `<button class="tooltip-close" id="tooltipClose" aria-label="Close" title="Close">&times;</button>` : ""}
    <h4>${d.title}</h4>
    <div class="tooltip-meta">
      <span class="tooltip-swatch" id="tooltipSwatch"></span>
      <span>${formatYear(d.year)} &middot; ${d.category}${d.location ? ` &middot; ${d.location}` : ""}</span>
    </div>
    <p class="tooltip-summary">${d.summary}</p>
    ${
      pinned
        ? `<a class="tooltip-link" href="${d.wiki}" target="_blank" rel="noopener noreferrer">${linkText} &rarr;</a>
           <button class="tooltip-category-toggle" id="tooltipCategoryToggle">
             ${active ? `Hide &ldquo;${d.category}&rdquo; on map` : `Show &ldquo;${d.category}&rdquo; again`}
           </button>`
        : `<p class="tooltip-hint">Click to keep open</p>`
    }
  `;
}

// Where the pinned card is anchored. Kept so the card can be re-rendered in
// place (e.g. after toggling its category) without needing a fresh mouse event.
let pinnedAnchor = null;
let pinnedEvent = null;

function renderMapTooltip(anchor, d, pinned) {
  const token = ++tooltipHoverToken;
  mapTooltipEl.innerHTML = tooltipMarkup(d, pinned);
  mapTooltipEl.classList.toggle("pinned", pinned);
  mapTooltipEl.classList.add("visible");
  positionMapTooltip(anchor);

  // Marker-matching swatch, built with the same helper as the filter list.
  document.getElementById("tooltipSwatch")?.appendChild(categorySwatch(d.category, 14));

  if (pinned) {
    document.getElementById("tooltipClose")?.addEventListener("click", (e) => {
      e.stopPropagation();
      unpinMapTooltip();
    });
    document.getElementById("tooltipCategoryToggle")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCategoryFromCard(d);
    });
  }

  if (tooltipImageCache.has(d.wiki)) {
    applyTooltipImage(token, tooltipImageCache.get(d.wiki), anchor);
  } else {
    fetchTooltipImage(d).then((img) => applyTooltipImage(token, img, anchor));
  }
}

// Toggles the pinned event's category and re-pins the same card in place.
// renderAll() clears the pin (the marker set may have changed underneath it),
// so the card has to be restored afterwards rather than left to survive.
function toggleCategoryFromCard(d) {
  if (state.activeCategories.has(d.category)) state.activeCategories.delete(d.category);
  else state.activeCategories.add(d.category);

  const anchor = pinnedAnchor;
  buildCategoryFilters();
  renderAll();
  if (anchor) pinMapTooltip(anchor, d);
}

function showMapTooltip(anchor, d) {
  if (isTooltipPinned()) return; // don't let hover clobber a pinned card
  renderMapTooltip(anchor, d, false);
}

function pinMapTooltip(anchor, d) {
  pinnedEventKey = eventKey(d);
  // positionMapTooltip() only reads clientX/clientY, so a plain point works and
  // survives the re-render that a category toggle triggers.
  pinnedAnchor = { clientX: anchor.clientX, clientY: anchor.clientY };
  pinnedEvent = d;
  renderMapTooltip(pinnedAnchor, d, true);
}

function unpinMapTooltip() {
  pinnedEventKey = null;
  pinnedAnchor = null;
  pinnedEvent = null;
  mapTooltipEl.classList.remove("pinned", "visible");
}

document.addEventListener("click", (e) => {
  if (!isTooltipPinned()) return;
  if (mapTooltipEl.contains(e.target)) return; // clicks inside the card (e.g. the link) are fine
  unpinMapTooltip();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  unpinMapTooltip();
  clearSpotlight();
});

function positionMapTooltip(event) {
  const bounds = mapSectionEl.getBoundingClientRect();
  const tooltipWidth = mapTooltipEl.offsetWidth || 260;
  const tooltipHeight = mapTooltipEl.offsetHeight || 90;
  const margin = 16;

  let x = event.clientX - bounds.left + 18;
  let y = event.clientY - bounds.top + 18;

  if (x + tooltipWidth + margin > bounds.width) {
    x = event.clientX - bounds.left - tooltipWidth - 18;
  }
  if (y + tooltipHeight + margin > bounds.height) {
    y = event.clientY - bounds.top - tooltipHeight - 18;
  }

  mapTooltipEl.style.left = `${Math.max(margin, x)}px`;
  mapTooltipEl.style.top = `${Math.max(margin, y)}px`;
}

function hideMapTooltip() {
  if (isTooltipPinned()) return; // mouseleave shouldn't dismiss a pinned card
  mapTooltipEl.classList.remove("visible");
}

function renderAll() {
  // Deselecting a category no longer removes its markers -- they stay on the
  // map greyed out and unlabelled, so you keep the geographic context of what
  // you filtered out and can click one to switch it back on. The events list,
  // by contrast, only shows what's selected.
  const yearEvents = EVENTS.filter((e) => e.year === state.year);
  yearBadge.textContent = formatYear(state.year);
  renderEventsList(yearEvents.filter((e) => state.activeCategories.has(e.category)));
  renderMarkers(yearEvents);
}

// ---- Discover ----

let discoveryResolved = [];
let discoveryCurrent = null;

function initDiscovery() {
  if (!discoveryPromptEl) return;

  const byTitle = new Map(EVENTS.map((e) => [e.title, e]));
  discoveryResolved = DISCOVERY_PROMPTS.map((p) => ({ ...p, event: byTitle.get(p.title) })).filter((p) => {
    if (!p.event) console.warn(`Discover: no matching event found for "${p.title}"`);
    return Boolean(p.event);
  });

  if (!discoveryResolved.length) return;

  showRandomDiscoveryPrompt();

  discoveryRefreshBtnEl?.addEventListener("click", () => {
    showRandomDiscoveryPrompt();
    discoveryRefreshBtnEl.classList.remove("spinning");
    void discoveryRefreshBtnEl.offsetWidth;
    discoveryRefreshBtnEl.classList.add("spinning");
  });

  discoverGoBtnEl?.addEventListener("click", () => {
    if (discoveryCurrent) jumpToEvent(discoveryCurrent.event);
  });
}

function showRandomDiscoveryPrompt() {
  if (!discoveryResolved.length) return;
  let next = discoveryCurrent;
  if (discoveryResolved.length > 1) {
    while (!next || next.title === discoveryCurrent?.title) {
      next = discoveryResolved[Math.floor(Math.random() * discoveryResolved.length)];
    }
  } else {
    next = discoveryResolved[0];
  }
  discoveryCurrent = next;

  discoveryPromptEl.innerHTML = `Discover what else was going on in the world when <strong>${next.question}</strong> (${formatYear(
    next.event.year
  )})`;
}

function jumpToEvent(event) {
  // Make sure the event's own category is active so its marker actually
  // renders, then jump the slider to its year.
  state.activeCategories.add(event.category);
  buildCategoryFilters();
  state.year = event.year;
  yearSlider.value = event.year;
  renderAll();

  mapSectionEl?.scrollIntoView({ behavior: "smooth", block: "start" });
  spotlightMarker(event);
}

function spotlightMarker(target) {
  if (!markerLayer) return;
  const key = eventKey(target);
  spotlightKey = key;
  markerLayer
    .selectAll("g.event-marker")
    .filter((d) => eventKey(d) === key)
    .each(function () {
      const g = d3.select(this);
      g.classed("spotlight", false);
      // Force reflow so re-adding the class restarts the CSS animation.
      void this.getBoundingClientRect();
      g.classed("spotlight", true);
    });
}

function clearSpotlight() {
  spotlightKey = null;
  markerLayer?.selectAll("g.event-marker.spotlight").classed("spotlight", false);
}

// ---- Timeline controls ----

yearSlider.addEventListener("input", () => {
  state.year = Number(yearSlider.value);
  renderAll();
});

stepBackBtn.addEventListener("click", () => {
  const years = getEventYears();
  const prev = [...years].reverse().find((y) => y < state.year);
  if (prev !== undefined) {
    state.year = prev;
    yearSlider.value = prev;
    renderAll();
  }
});

stepForwardBtn.addEventListener("click", () => {
  const years = getEventYears();
  const next = years.find((y) => y > state.year);
  if (next !== undefined) {
    state.year = next;
    yearSlider.value = next;
    renderAll();
  }
});

const playIcon = playBtn.querySelector(".icon-play");
const pauseIcon = playBtn.querySelector(".icon-pause");

playBtn.addEventListener("click", () => {
  state.playing = !state.playing;
  playIcon.toggleAttribute("hidden", state.playing);
  pauseIcon.toggleAttribute("hidden", !state.playing);
  if (state.playing) {
    state.playTimer = setInterval(() => {
      const years = getEventYears();
      const next = years.find((y) => y > state.year);
      if (next !== undefined) {
        state.year = next;
        yearSlider.value = next;
        renderAll();
      } else {
        state.playing = false;
        playIcon.removeAttribute("hidden");
        pauseIcon.setAttribute("hidden", "");
        clearInterval(state.playTimer);
      }
    }, 1200);
  } else {
    clearInterval(state.playTimer);
  }
});

// ---- Init ----

function initTimelineRange() {
  const years = EVENTS.map((e) => e.year);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);

  yearSlider.min = minYear;
  yearSlider.max = maxYear;
  if (state.year < minYear || state.year > maxYear) {
    state.year = Math.min(Math.max(state.year, minYear), maxYear);
  }
  yearSlider.value = state.year;

  const timelineLabelsEl = document.querySelector(".timeline-labels");
  if (timelineLabelsEl) {
    const stops = 7;
    timelineLabelsEl.innerHTML = "";
    for (let i = 0; i < stops; i++) {
      const y = Math.round(minYear + ((maxYear - minYear) * i) / (stops - 1));
      const span = document.createElement("span");
      span.textContent = formatYear(y);
      timelineLabelsEl.appendChild(span);
    }
  }

  if (datasetStatEl) {
    const byCategory = new Map();
    for (const e of EVENTS) byCategory.set(e.category, (byCategory.get(e.category) || 0) + 1);
    const breakdown = CATEGORY_ORDER.filter((c) => byCategory.has(c))
      .map((c) => `${c} (${byCategory.get(c)})`)
      .join(", ");
    datasetStatEl.innerHTML = `<strong>${EVENTS.length.toLocaleString()} events</strong> loaded, spanning ${formatYear(minYear)} &ndash; ${formatYear(maxYear)}.`;
    datasetStatEl.title = breakdown;
  }
}

initTimelineRange();
buildCategoryFilters();
initMap();
initDiscovery();
