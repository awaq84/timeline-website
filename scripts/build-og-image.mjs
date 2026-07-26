// Social preview image and favicons.
//
// The site shipped with no images at all. /favicon.ico returned 404, no page
// carried an og:image, and index.html declared twitter:card=summary_large_image
// -- promising a large preview and then supplying nothing. Every share on X,
// Slack, WhatsApp or LinkedIn rendered a blank card, which for a site whose
// whole appeal is a picture of the world is the worst thing to be missing.
//
// The map below is drawn from the same source as the live one: Natural Earth
// via world-atlas, the same d3.geoNaturalEarth1 projection, the same category
// colours, and real event coordinates out of data/events/. That matters more
// than it sounds -- a hand-drawn mock-up would quietly stop resembling the
// product, whereas this cannot.
//
// Rasterising is the awkward part. macOS ships no pixel-exact SVG renderer
// (qlmanage rescales the input and crops it), so this shells out to
// `npx sharp-cli`, which downloads on first use and therefore needs network.
// The PNGs are committed, so that only happens when the design changes.
//
// Run: node scripts/build-og-image.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "data", ".cache");
const ATLAS_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

const W = 1200;
const H = 630;

// Mirrors CATEGORY_COLORS in app.js and build-year-pages.mjs. Duplicated for the
// same reason they are: these scripts run offline against the committed data and
// app.js is a browser script with no exports.
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

// ---- Projection -------------------------------------------------------------

// d3's naturalEarth1Raw, verbatim. Reimplemented rather than imported because
// the repo has no package.json and this is the only piece of d3 needed offline;
// the polynomial is fixed and published, so there is nothing to drift.
const RAD = Math.PI / 180;

function naturalEarth1Raw(lambda, phi) {
  const p2 = phi * phi;
  const p4 = p2 * p2;
  return [
    lambda * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))),
    phi * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))),
  ];
}

// Raw half-extents, used to size the map to the frame instead of guessing a
// scale factor: x at the antimeridian on the equator, y at the pole.
const RAW_HALF_W = naturalEarth1Raw(Math.PI, 0)[0];
const RAW_HALF_H = naturalEarth1Raw(0, Math.PI / 2)[1];

function makeProjection({ width, height, padX, padY }) {
  const k = Math.min((width - padX * 2) / (RAW_HALF_W * 2), (height - padY * 2) / (RAW_HALF_H * 2));
  return (lon, lat) => {
    const [rx, ry] = naturalEarth1Raw(lon * RAD, lat * RAD);
    // d3 flips y: screen y grows downward, projected y grows north.
    return [k * rx + width / 2, height / 2 - k * ry];
  };
}

// ---- TopoJSON ---------------------------------------------------------------

// Minimal decoder: quantised delta-encoded arcs into lon/lat rings. Only the
// Polygon and MultiPolygon cases exist in countries-110m, so nothing else is
// handled -- an unexpected type throws rather than silently drawing nothing.
function decodeArcs(topo) {
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  return topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
}

function ringFrom(arcIndices, arcs) {
  const ring = [];
  for (const i of arcIndices) {
    // A negative index means "this arc, reversed"; ~i recovers the real one.
    const pts = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
    // Consecutive arcs share an endpoint, so drop the duplicate on every join.
    ring.push(...(ring.length ? pts.slice(1) : pts));
  }
  return ring;
}

function polygonsOf(geom, arcs) {
  if (geom.type === "Polygon") return [geom.arcs.map((r) => ringFrom(r, arcs))];
  if (geom.type === "MultiPolygon") return geom.arcs.map((poly) => poly.map((r) => ringFrom(r, arcs)));
  if (geom.type === null || geom.type === undefined) return [];
  throw new Error(`unhandled geometry type: ${geom.type}`);
}

// ---- Rendering --------------------------------------------------------------

// Natural Earth's own data is already cut at the antimeridian, so no country
// ring should wrap. If one ever does, projecting it naively draws a stripe
// across the whole map, so split rather than trust it -- and report, because a
// silent split would hide a bad atlas.
let wrapSplits = 0;

function ringToPath(ring, project) {
  const segments = [];
  let current = [];
  let prevLon = null;
  for (const [lon, lat] of ring) {
    if (prevLon !== null && Math.abs(lon - prevLon) > 180) {
      wrapSplits++;
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(project(lon, lat));
    prevLon = lon;
  }
  if (current.length > 1) segments.push(current);

  return segments
    .map((seg) => `M${seg.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}Z`)
    .join("");
}

async function loadAtlas() {
  const cached = path.join(CACHE, "countries-110m.json");
  try {
    return JSON.parse(await fs.readFile(cached, "utf8"));
  } catch {
    console.log("Fetching world-atlas countries-110m.json ...");
    const res = await fetch(ATLAS_URL);
    if (!res.ok) throw new Error(`atlas fetch failed: ${res.status}`);
    const text = await res.text();
    await fs.mkdir(CACHE, { recursive: true });
    await fs.writeFile(cached, text);
    return JSON.parse(text);
  }
}

async function loadEvents() {
  const dir = path.join(ROOT, "data", "events");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const out = [];
  for (const f of files) {
    for (const e of JSON.parse(await fs.readFile(path.join(dir, f), "utf8"))) {
      if (typeof e.lat === "number" && typeof e.lng === "number") out.push(e);
    }
  }
  return out;
}

// A deterministic stride rather than random sampling: the image is committed, so
// rebuilding it after an unrelated change should produce an identical file
// instead of a diff full of moved dots.
function sample(events, target) {
  const stride = Math.max(1, Math.floor(events.length / target));
  return events.filter((_, i) => i % stride === 0);
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function rasterize(svgPath, pngPath, width, height) {
  const args = ["-y", "sharp-cli", "-i", svgPath, "-o", path.dirname(pngPath), "-f", "png", "resize", String(width), String(height)];
  await run("npx", args, { cwd: ROOT, maxBuffer: 1 << 26 });
  const produced = path.join(path.dirname(pngPath), `${path.basename(svgPath, ".svg")}.png`);
  if (produced !== pngPath) await fs.rename(produced, pngPath);
}

// ---- Favicon ----------------------------------------------------------------

// A globe with one bright event marker on it. Built from filled shapes rather
// than strokes on purpose: the first version drew the globe as a ring plus an
// equator line, and at 16px -- the size that actually appears in a browser tab --
// the ring and the line blurred into a grey blob. Solid forms survive the
// downscale, so this is two circles and nothing else.
function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="7" fill="#000000"/>
  <circle cx="15" cy="17" r="10.5" fill="#2997ff"/>
  <circle cx="23.5" cy="8.5" r="6.6" fill="#000000"/>
  <circle cx="23.5" cy="8.5" r="4.4" fill="#ffd60a"/>
</svg>
`;
}

// ICO is a 6-byte header, one 16-byte directory entry per image, then the image
// payloads -- and since Vista those payloads may be PNG as-is. That is the whole
// format for our purposes, so wrapping the 32px PNG by hand beats adding a
// dependency. Width/height bytes are 0 for 256, but 32 fits in a byte fine.
function icoWrap(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry[0] = 32; // width
  entry[1] = 32; // height
  entry[2] = 0; // palette size (0 = not palettised)
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, png]);
}

// ---- Main -------------------------------------------------------------------

async function main() {
  const [atlas, allEvents, index] = await Promise.all([
    loadAtlas(),
    loadEvents(),
    fs.readFile(path.join(ROOT, "data", "index.json"), "utf8").then(JSON.parse),
  ]);

  const arcs = decodeArcs(atlas);
  const project = makeProjection({ width: W, height: H, padX: 8, padY: 26 });

  const countryPaths = atlas.objects.countries.geometries
    .flatMap((g) => polygonsOf(g, arcs))
    .flatMap((poly) => poly)
    .map((ring) => ringToPath(ring, project))
    .filter(Boolean)
    .join("");

  const dots = sample(allEvents, 1100)
    .map((e) => {
      const [x, y] = project(e.lng, e.lat);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const c = CATEGORY_COLORS[e.category] || "#8e8e93";
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.1" fill="${c}"/>`;
    })
    .filter(Boolean)
    .join("");

  const total = index.total.toLocaleString("en-US");
  const font = "Helvetica Neue, Helvetica, Arial, sans-serif";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="45%" stop-color="#000000" stop-opacity="0.72"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.97"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="#000000"/>
  <path d="${countryPaths}" fill="#15171c" stroke="#2a2f38" stroke-width="0.8" stroke-linejoin="round"/>
  <g opacity="0.92">${dots}</g>

  <rect x="0" y="${H - 250}" width="${W}" height="250" fill="url(#scrim)"/>

  <text x="60" y="${H - 116}" fill="#ffffff" font-family="${font}" font-size="70" font-weight="700" letter-spacing="-1.6">Timeline History</text>
  <text x="60" y="${H - 72}" fill="#b8b8bf" font-family="${font}" font-size="27" font-weight="400">${esc(total)} events from 3001 BC to 2026, mapped and dated.</text>
  <text x="60" y="${H - 30}" fill="#2997ff" font-family="${font}" font-size="24" font-weight="600">timelinehistory.net</text>
</svg>
`;

  await fs.mkdir(CACHE, { recursive: true });
  const ogSvg = path.join(CACHE, "og-image.svg");
  await fs.writeFile(ogSvg, svg);
  await rasterize(ogSvg, path.join(ROOT, "og-image.png"), W, H);

  const favSvg = path.join(CACHE, "favicon.svg");
  await fs.writeFile(favSvg, faviconSvg());
  await fs.writeFile(path.join(ROOT, "favicon.svg"), faviconSvg());
  await rasterize(favSvg, path.join(ROOT, "favicon-32.png"), 32, 32);
  await rasterize(favSvg, path.join(ROOT, "apple-touch-icon.png"), 180, 180);

  const png32 = await fs.readFile(path.join(ROOT, "favicon-32.png"));
  await fs.writeFile(path.join(ROOT, "favicon.ico"), icoWrap(png32));

  console.log(`Events with coordinates: ${allEvents.length.toLocaleString("en-US")}`);
  console.log(`Dots drawn: ${(dots.match(/<circle/g) || []).length}`);
  console.log(`Antimeridian splits: ${wrapSplits}`);
  console.log("Wrote og-image.png, favicon.svg, favicon-32.png, favicon.ico, apple-touch-icon.png");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
