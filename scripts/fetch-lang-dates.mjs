// Dates events from a non-English Wikipedia, for items Wikidata knows but has
// never been given a date.
//
// Why: Wikidata's ancient coverage is not evenly thin, it is unevenly thin. For
// 475-221 BC this dataset holds 115 battles in Greece, 114 in Italy, and 10 in
// China -- and the reason is not that Chinese battles are missing from Wikidata.
// Chinese Wikipedia's "Warring States battles" category has 15 items with
// Wikidata entries, of which only 3 carry a date. The items exist. Someone
// migrated Greek and Roman dates into Wikidata years ago and nobody did the same
// for China. The date sits in the article:
//
//     |date=前270年        270 BC
//     |date=公元前301年     301 BC
//
// TWO RULES, both load-bearing.
//
// 1. ONLY THE DATE IS TAKEN. Everything displayed on the site remains Wikidata's
//    CC0 English label and description. A date is a fact; taking one is not
//    reproducing an article.
//
// 2. ONLY ITEMS THAT ALREADY HAVE AN ENGLISH WIKIDATA LABEL. Half of these items
//    have none -- Q13415409 is 陰晉之戰 and nothing else. Those are skipped, not
//    translated. A machine-translated title would be text WE wrote, which breaks
//    the one thing this site can say plainly: nothing here is written by us. It
//    would also be a failure nothing downstream could catch, in a language the
//    author cannot read. Roughly halves the yield. Worth it.
//
// Adding a language means writing its DATE_PARAMS and its era markers, then
// checking a sample against a known answer. Do not add one you cannot read well
// enough to tell a right date from a wrong one: the English pass produced three
// classes of silent error (citation dates read as event dates, "~150 [[BCE]]"
// read as AD 150, "250 ha" read as year 250) and every one was caught by eye.
//
// Usage:  node scripts/fetch-lang-dates.mjs zh [max-items]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "data", ".cache");
const SPARQL = "https://query.wikidata.org/sparql";
const UA = "TimelineHistory/1.0 (https://github.com/awaq84/timeline-website)";

const LANGS = {
  zh: {
    name: "Chinese",
    // In Chinese military infoboxes `date` IS the event date. In English ones it
    // is the citation date, which is why the English harvester excludes it --
    // the same parameter name means different things and cannot be shared.
    params: /^\s*\|?\s*(date|日期|時間|时间|年代|建成時間|建成时间)\s*=\s*(.+)$/i,
    // 前 and 公元前 both mark BC; 年 closes the year.
    parse(raw) {
      const t = String(raw)
        .replace(/<ref[^]*?<\/ref>/gi, "")
        .replace(/\{\{[^}]*\}\}/g, "")
        .replace(/\[\[([^\]|]*\|)?/g, "")
        .replace(/\]\]/g, "")
        .trim();
      let m;
      // "前270年", "公元前301年", "西元前221年"
      if ((m = t.match(/(?:公元|西元)?前\s*(\d{1,4})\s*年/))) return { year: -(+m[1]), prec: 9 };
      // "前3世纪" -- century BC
      if ((m = t.match(/(?:公元|西元)?前\s*(\d{1,2})\s*世纪|世紀/))) return { year: -(+m[1] * 100), prec: 7 };
      // Plain AD year "1279年"
      if ((m = t.match(/(\d{3,4})\s*年/))) {
        const y = +m[1];
        if (y >= 1 && y <= 2026) return { year: y, prec: 9 };
      }
      return null;
    },
    // Sample with answers verified by hand before this was allowed to run.
    tests: [
      ["前270年（趙惠文王二十九年）", -270, 9],
      ["前389年", -389, 9],
      ["公元前301年", -301, 9],
      ["前233年", -233, 9],
      ["1279年", 1279, 9],
      ["250公頃", null, null],
    ],
  },
};

const LANG = process.argv[2] || "zh";
const MAX_ITEMS = Number(process.argv[3] || process.env.LANG_MAX || 4000);
const CFG = LANGS[LANG];
if (!CFG) {
  console.error(`No config for "${LANG}". Known: ${Object.keys(LANGS).join(", ")}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sparql(query, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${SPARQL}?query=${encodeURIComponent(query)}`, {
        headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Wikidata answers 200 then truncates the body on long queries, so the
      // failure surfaces as a JSON parse error rather than a status code.
      return JSON.parse(await res.text()).results.bindings;
    } catch (err) {
      last = err;
      const wait = 5000 * (i + 1);
      console.warn(`    attempt ${i + 1}/${attempts}: ${err.message}; retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw last;
}

// Items with an article in this language, coordinates, an English label, and no
// date of any kind. The English label requirement is rule 2 expressed in SPARQL:
// if there is nothing to display in English, the row is not wanted.
async function candidates() {
  const q = `SELECT ?item ?enLabel ?enDesc ?article ?coord WHERE {
  ?article schema:about ?item ; schema:isPartOf <https://${LANG}.wikipedia.org/> .
  ?item wdt:P625 ?coord ; rdfs:label ?enLabel .
  FILTER(LANG(?enLabel) = "en")
  FILTER NOT EXISTS { ?item wdt:P571 ?a }
  FILTER NOT EXISTS { ?item wdt:P580 ?b }
  FILTER NOT EXISTS { ?item wdt:P585 ?c }
  ?item wdt:P31/wdt:P279* ?type .
  VALUES ?type { wd:Q178561 wd:Q198 wd:Q188055 wd:Q839954 wd:Q4989906 wd:Q44539 wd:Q57821 }
  OPTIONAL { ?item schema:description ?enDesc . FILTER(LANG(?enDesc) = "en") }
} LIMIT ${MAX_ITEMS}`;
  const rows = await sparql(q);
  const out = [];
  for (const r of rows) {
    const c = r.coord.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
    if (!c) continue;
    out.push({
      qid: r.item.value.split("/").pop(),
      label: r.enLabel.value,
      desc: r.enDesc?.value || "",
      title: decodeURIComponent(r.article.value.split("/wiki/")[1]).replace(/_/g, " "),
      lat: +c[2],
      lng: +c[1],
    });
  }
  return out;
}

function selfTest() {
  let bad = 0;
  console.log(`Parser self-test (${CFG.name}):`);
  for (const [input, wantY, wantP] of CFG.tests) {
    const got = CFG.parse(input);
    const y = got?.year ?? null;
    const p = got?.prec ?? null;
    const ok = y === wantY && p === wantP;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${input}  ->  ${y} prec${p}`);
  }
  if (bad) {
    console.error(`\n${bad} parser test(s) failed -- refusing to run.`);
    process.exit(1);
  }
  console.log("  all pass\n");
}

async function main() {
  selfTest();
  await fs.mkdir(CACHE_DIR, { recursive: true });

  console.log(`Finding ${CFG.name}-covered items with an English label and no date...`);
  const items = await candidates();
  console.log(`  ${items.length} candidates\n`);

  const byTitle = new Map(items.map((i) => [i.title, i]));
  const found = [];
  let checked = 0;

  for (let i = 0; i < items.length; i += 40) {
    const batch = items.slice(i, i + 40);
    const url = `https://${LANG}.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&titles=${encodeURIComponent(
      batch.map((b) => b.title).join("|")
    )}&format=json&formatversion=2`;
    let pages;
    try {
      pages = (await (await fetch(url, { headers: { "User-Agent": UA } })).json()).query?.pages || [];
    } catch (err) {
      console.warn(`  batch ${i}: ${err.message}`);
      await sleep(2000);
      continue;
    }
    for (const p of pages) {
      checked++;
      const item = byTitle.get(p.title);
      const text = p.revisions?.[0]?.slots?.main?.content;
      if (!item || !text) continue;
      for (const line of text.slice(0, 4000).split("\n")) {
        const m = line.match(CFG.params);
        if (!m) continue;
        const d = CFG.parse(m[2]);
        if (d) {
          found.push({ ...item, ...d, lang: LANG, param: m[1], raw: m[2].slice(0, 80) });
          break;
        }
      }
    }
    if (i % 400 === 0) console.log(`  ${checked}/${items.length} read, ${found.length} dated`);
    await sleep(350);
  }

  found.sort((a, b) => a.year - b.year);
  const out = path.join(CACHE_DIR, `lang-dates-${LANG}.json`);
  await fs.writeFile(out, JSON.stringify(found, null, 1));

  const bc = found.filter((f) => f.year < 0);
  console.log(`\n${checked} articles read`);
  console.log(`  dated  : ${found.length} (${((found.length / Math.max(checked, 1)) * 100).toFixed(0)}%)`);
  console.log(`  BC     : ${bc.length}`);
  console.log(`\nsample:`);
  for (const f of found.slice(0, 12)) console.log(`  ${String(f.year).padStart(6)}  ${f.label}   [${f.raw.slice(0, 30)}]`);
  console.log(`\nWritten to ${out} -- nothing merged.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
