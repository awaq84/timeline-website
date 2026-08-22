// Rewrites every `?v=` cache-busting token from a hash of the file it points at.
//
// GitHub Pages serves everything with `cache-control: max-age=14400`, so a
// browser holds an asset for four hours and the `?v=` token is the only thing
// that makes it refetch. Those tokens were hand-maintained integers -- v=8, v=11,
// v=25, v=38 -- across five files, and bumping them was a step nobody remembered.
//
// The failure is silent and looks exactly like a bug in the data. data/quiz.js
// and data/discover.js were rebuilt repeatedly over one session while the tokens
// stayed at v=11 and v=8, so anyone who had loaded the page that day kept being
// served the old pool for hours: "Charles University was founded" and "Ellesmere
// Island was discovered" were still on screen after both had been removed from
// every file the server actually holds.
//
// A content hash cannot be forgotten. If the bytes change the token changes; if
// they do not, the browser keeps its copy.
//
// Order matters. app.js carries the token for disputed-areas.json and
// quiz-app.js carries the token for quiz.js, so those are stamped BEFORE either
// script is itself hashed -- otherwise the hash in index.html describes a version
// of app.js that no longer exists by the time the run finishes.
//
// Usage:  node scripts/stamp-asset-versions.mjs   (run last, after every build)

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const hashOf = async (rel) => {
  const buf = await fs.readFile(path.join(ROOT, rel));
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);
};

// Each edit: in `file`, find `pattern` and replace its v= token with the hash of
// `asset`. The pattern must capture everything up to and including "v=".
const changes = [];
async function stamp(file, asset, pattern) {
  const full = path.join(ROOT, file);
  const before = await fs.readFile(full, "utf8");
  const v = await hashOf(asset);
  let hits = 0;
  const after = before.replace(pattern, (m, prefix) => {
    hits++;
    return `${prefix}${v}`;
  });
  if (!hits) throw new Error(`No ?v= token matching ${pattern} found in ${file}`);
  if (after !== before) {
    await fs.writeFile(full, after);
    changes.push(`${file}: ${asset} -> v=${v}`);
  }
  return v;
}

// --- Pass 1: tokens that live INSIDE the scripts, before those get hashed ---
await stamp("quiz-app.js", "data/quiz.js", /(["']\/data\/quiz\.js\?v=)[0-9a-f]+/g);
await stamp("app.js", "data/disputed-areas.json", /(["']data\/disputed-areas\.json\?v=)[0-9a-f]+/g);

// --- Pass 2: tokens pointing at those now-final scripts ---
await stamp("index.html", "style.css", /(["']style\.css\?v=)[0-9a-f]+/g);
await stamp("index.html", "data/discover.js", /(["']data\/discover\.js\?v=)[0-9a-f]+/g);
await stamp("index.html", "app.js", /(["']app\.js\?v=)[0-9a-f]+/g);

// static-pages.mjs is the source for /quiz/ -- build-year-pages.mjs must run
// after this to regenerate the page with the new tokens.
await stamp("scripts/static-pages.mjs", "quiz.css", /(\/quiz\.css\?v=)[0-9a-f]+/g);
await stamp("scripts/static-pages.mjs", "quiz-app.js", /(\/quiz-app\.js\?v=)[0-9a-f]+/g);

// build-year-pages.mjs holds page.css's token in a const rather than a URL.
{
  const file = path.join(ROOT, "scripts", "build-year-pages.mjs");
  const before = await fs.readFile(file, "utf8");
  const v = await hashOf("page.css");
  const after = before.replace(/const CSS_VERSION = "[0-9a-f]+"/, `const CSS_VERSION = "${v}"`);
  if (after === before && !before.includes(`const CSS_VERSION = "${v}"`)) {
    throw new Error('No `const CSS_VERSION = "..."` found in build-year-pages.mjs');
  }
  if (after !== before) {
    await fs.writeFile(file, after);
    changes.push(`scripts/build-year-pages.mjs: page.css -> v=${v}`);
  }
}

if (!changes.length) {
  console.log("All asset versions already current.");
} else {
  console.log(`Stamped ${changes.length} asset version(s):`);
  for (const c of changes) console.log(`  ${c}`);
  console.log("\nRe-run `node scripts/build-year-pages.mjs` so /quiz/ picks up its new tokens.");
}
