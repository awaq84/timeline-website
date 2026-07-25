// Prototype logic: world map (D3 + topojson), year slider, category filters, event list.

const CATEGORY_COLORS = {
  "Major Events": "#ffd60a",
  "Wars & Conflicts": "#e5534b",
  "Politics & Government": "#4fb0ff",
  "Historical Figures": "#f2c94c",
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
  "Historical Figures",
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

    const swatch = document.createElement("span");
    swatch.className = "chip-dot";
    swatch.style.background = CATEGORY_COLORS[cat] || "#888";

    wrapper.appendChild(checkbox);
    wrapper.appendChild(swatch);
    wrapper.appendChild(document.createTextNode(cat));
    categoryFiltersEl.appendChild(wrapper);
  });
}

function shortLabel(title) {
  const maxLen = 22;
  if (title.length <= maxLen) return title;
  const truncated = title.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 8 ? truncated.slice(0, lastSpace) : truncated) + "…";
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
      <div class="event-meta">${e.category} &middot; ${e.location}</div>
      <p class="event-summary">${e.summary}</p>
      <a href="${e.wiki}" target="_blank" rel="noopener noreferrer">${isWikidata ? "View source on Wikidata" : "Read more on Wikipedia"} &rarr;</a>
    `;
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
  hideMapTooltip();

  const groups = markerLayer.selectAll("g.event-marker").data(currentEvents, (d) => d.title);

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

  visual.append("circle").attr("class", "marker-halo").attr("r", 9);
  visual.append("circle").attr("r", 5);
  visual
    .append("text")
    .attr("class", "marker-label")
    .attr("x", 10)
    .attr("y", 4)
    .text((d) => shortLabel(d.title));

  entered
    .on("mouseenter", (event, d) => showMapTooltip(event, d))
    .on("mousemove", (event) => positionMapTooltip(event))
    .on("mouseleave", hideMapTooltip);

  const merged = entered.merge(groups).attr("transform", (d) => {
    const coords = projection([d.lng, d.lat]);
    return coords ? `translate(${coords[0]}, ${coords[1]})` : "translate(-100,-100)";
  });

  merged.select(".marker-visual circle:last-of-type").attr("fill", (d) => CATEGORY_COLORS[d.category] || "#4fb0ff");
  merged.select(".marker-visual .marker-halo").attr("stroke", (d) => CATEGORY_COLORS[d.category] || "#4fb0ff");

  resolveLabelCollisions();
}

// Tries a handful of positions around each dot (right, left, above, below) and
// hides the label (keeping just the dot + hover tooltip) if none are free.
const LABEL_OFFSETS = [
  { dx: 10, dy: 4, anchor: "start" },
  { dx: -10, dy: 4, anchor: "end" },
  { dx: 10, dy: -10, anchor: "start" },
  { dx: 10, dy: 18, anchor: "start" },
  { dx: -10, dy: -10, anchor: "end" },
  { dx: -10, dy: 18, anchor: "end" },
];

function resolveLabelCollisions() {
  const groups = markerLayer.selectAll("g.event-marker").nodes();

  // Seed with every dot's own footprint (tagged with its owning node) so
  // labels route around neighboring markers, not just around each other's
  // text. Each marker's own dot is excluded when checking its own label.
  // Marker positions are stored in pre-zoom map coordinates, but marker
  // *visuals* (dot + label) are counter-scaled to stay a constant pixel
  // size -- so to compare footprints in the same "pixel space" we scale
  // each marker's local position by the current zoom factor. Translation
  // from panning cancels out in the overlap comparison, so it's ignored.
  const dotRadius = 8;
  const localXY = (g) => {
    const matrix = g.transform.baseVal.consolidate();
    return {
      x: (matrix ? matrix.matrix.e : 0) * currentZoomK,
      y: (matrix ? matrix.matrix.f : 0) * currentZoomK,
    };
  };
  const placedRects = groups.map((g) => {
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

  sorted.forEach((g) => {
    const text = g.querySelector(".marker-label");
    if (!text) return;
    const { x: px, y: py } = localXY(g);

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
      if (!overlaps) {
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

function showMapTooltip(event, d) {
  const token = ++tooltipHoverToken;
  const dotColor = CATEGORY_COLORS[d.category] || "#4fb0ff";
  mapTooltipEl.innerHTML = `
    <div class="tooltip-image-wrap" id="tooltipImageWrap"></div>
    <h4>${d.title}</h4>
    <div class="tooltip-meta">
      <span class="tooltip-dot" style="background:${dotColor}"></span>
      <span>${formatYear(d.year)} &middot; ${d.category}${d.location ? ` &middot; ${d.location}` : ""}</span>
    </div>
    <p class="tooltip-summary">${d.summary}</p>
  `;
  mapTooltipEl.classList.add("visible");
  positionMapTooltip(event);

  if (tooltipImageCache.has(d.wiki)) {
    applyTooltipImage(token, tooltipImageCache.get(d.wiki), event);
  } else {
    fetchTooltipImage(d).then((img) => applyTooltipImage(token, img, event));
  }
}

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
  mapTooltipEl.classList.remove("visible");
}

function renderAll() {
  const currentEvents = getFilteredEvents().filter((e) => e.year === state.year);
  yearBadge.textContent = formatYear(state.year);
  renderEventsList(currentEvents);
  renderMarkers(currentEvents);
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
  spotlightMarker(event.title);
}

function spotlightMarker(title) {
  if (!markerLayer) return;
  markerLayer
    .selectAll("g.event-marker")
    .filter((d) => d.title === title)
    .each(function () {
      const g = d3.select(this);
      g.classed("spotlight", false);
      // Force reflow so re-adding the class restarts the CSS animation.
      void this.getBoundingClientRect();
      g.classed("spotlight", true);
      setTimeout(() => g.classed("spotlight", false), 4400);
    });
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
