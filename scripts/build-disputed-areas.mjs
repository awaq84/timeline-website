// Builds data/disputed-areas.json from Natural Earth's disputed-areas dataset.
//
// Was done by hand in a scratch script, which left three defects an audit found:
// a duplicate feature from a typo in the source ("Ilemi Triange" beside "Ilemi
// Triangle"), two features both called "W. Sahara" with tooltips that read as
// contradictory, and ten features with no description at all, so hovering Gaza,
// Kosovo, the West Bank or the Cyprus U.N. Buffer Zone gave a bare name and no
// indication of why it was hatched.
//
// WINDING. d3.geoPath reads a ring wound the wrong way as the whole sphere minus
// the shape, so one bad ring paints the entire map orange. Exterior rings must
// be clockwise (negative shoelace on lon/lat), holes the opposite. Exactly one
// ring in the source needs flipping, and without it the map looks catastrophic
// rather than subtly wrong.
//
// Usage:  node scripts/build-disputed-areas.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data", "disputed-areas.json");
const SRC =
  "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_10m_admin_0_disputed_areas.geojson";

// Sovereignty disputes only. Leases (Guantanamo, Baikonur), overlays (the Korean
// DMZ) and plain geo units are different things and are not hatched.
const KEEP = new Set(["Disputed", "Breakaway", "Indeterminate"]);

const round = (c) => (Array.isArray(c[0]) ? c.map(round) : [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100]);

const dedup = (c) => {
  if (!Array.isArray(c[0][0])) {
    const out = c.filter((p, i) => i === 0 || p[0] !== c[i - 1][0] || p[1] !== c[i - 1][1]);
    return out.length >= 4 ? out : c;
  }
  return c.map(dedup);
};

const area = (ring) => {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};

const windRings = (poly) =>
  poly.map((ring, i) => {
    const a = area(ring);
    return (i === 0 ? a > 0 : a < 0) ? ring.slice().reverse() : ring;
  });

// Natural Earth's own wording where it has any, then its admin note, and only
// then something constructed from who administers it. Nothing here is an opinion
// about who should hold a territory; administration and claim are both facts.
function describe(p) {
  // A note is only useful if it says something about the dispute. Natural Earth
  // sometimes puts a bare country name in NOTE_ADM0 ("S. Sudan"), which read as
  // a description on hover and explained nothing.
  const raw = (p.NOTE_BRK || p.NOTE_ADM0 || "").trim();
  const note = /admin\.|claim|disput|self admin/i.test(raw) ? raw : "";
  if (note) return note;
  const admin = (p.ADMIN || p.SOVEREIGNT || "").trim();
  if (admin && admin !== p.BRK_NAME) return `Admin. by ${admin}; sovereignty disputed`;
  return "Sovereignty disputed";
}

// The source has "Ilemi Triange" as well as "Ilemi Triangle", and two features
// named "W. Sahara" whose notes only make sense once you know they are different
// parts of it.
function nameOf(p) {
  const raw = (p.BRK_NAME || p.NAME || "").replace(/^﻿/, "").trim();
  if (raw === "Ilemi Triange") return "Ilemi Triangle";
  if (raw === "W. Sahara") {
    const note = (p.NOTE_BRK || "").toLowerCase();
    if (note.includes("self admin")) return "Western Sahara (self-administered)";
    if (note.includes("morocco")) return "Western Sahara (Moroccan-administered)";
  }
  return raw;
}

async function main() {
  console.log(`Fetching ${SRC}`);
  const res = await fetch(SRC, { headers: { "User-Agent": "TimelineHistory/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const src = JSON.parse(await res.text());
  console.log(`  ${src.features.length} features in source`);

  const seen = new Set();
  let rewound = 0;
  const feats = [];

  for (const f of src.features) {
    if (!KEEP.has(f.properties.TYPE)) continue;
    const n = nameOf(f.properties);
    const d = describe(f.properties);
    // A name+note pair seen twice is the same territory listed twice.
    const key = `${n}|${d}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let coords = dedup(round(f.geometry.coordinates));
    const before = JSON.stringify(coords);
    coords = f.geometry.type === "Polygon" ? windRings(coords) : coords.map(windRings);
    if (JSON.stringify(coords) !== before) rewound++;

    feats.push({ type: "Feature", properties: { n, d }, geometry: { type: f.geometry.type, coordinates: coords } });
  }

  // Two features can legitimately share a name -- the Ilemi Triangle has more
  // than one claim line -- but two identical labels on the map are just
  // confusing. Disambiguate by who administers each.
  const counts = {};
  for (const f of feats) counts[f.properties.n] = (counts[f.properties.n] || 0) + 1;
  for (const f of feats) {
    if (counts[f.properties.n] < 2) continue;
    const admin = f.properties.d.match(/Admin\. by ([^;]+)/i);
    if (admin) f.properties.n = `${f.properties.n} (${admin[1].trim()}-administered)`;
  }

  feats.sort((a, b) => a.properties.n.localeCompare(b.properties.n));

  const out = {
    _source:
      "Natural Earth 10m admin_0_disputed_areas (public domain). TYPE in {Disputed, Breakaway, Indeterminate}; coords rounded to 2dp; rings wound for d3.geoPath. Regenerate: node scripts/build-disputed-areas.mjs",
    type: "FeatureCollection",
    features: feats,
  };
  await fs.writeFile(OUT, JSON.stringify(out));

  const names = feats.map((f) => f.properties.n);
  console.log(`\n  ${feats.length} features written`);
  console.log(`  rings rewound      : ${rewound}`);
  console.log(`  duplicate names    : ${new Set(names).size === names.length ? "none" : [...new Set(names.filter((n, i) => names.indexOf(n) !== i))].join(", ")}`);
  console.log(`  empty descriptions : ${feats.filter((f) => !f.properties.d).length}`);
  console.log(`  size               : ${(JSON.stringify(out).length / 1024).toFixed(0)}KB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
