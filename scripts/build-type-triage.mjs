// Turns data/.cache/type-graph.json into data/.cache/type-triage.json, which is
// the file fetch-events.mjs actually reads.
//
// This step existed once as something run by hand and was never committed, so
// type-triage.json sat frozen at whatever the graph looked like on 2 August
// while type-graph.json moved on. derivedTypes() reads the triage file, so
// re-deriving the graph changed nothing at all -- FETCH_DERIVED=1 has been
// running against a month-old snapshot without saying so.
//
// That is how "Caesar's invasions of Britain" stayed missing after the root fix.
// It is a military campaign (Q831663), which the corrected graph contains with
// 957 dated instances, and which the stale triage file does not: the file the
// fetcher reads listed 31 conflict types and knew nothing of military campaign,
// military operation, rebellion or invasion.
//
// Triage is two things the graph does not carry: English labels, because the
// fixture and admin filters match on words rather than QIDs, and the removal of
// the types those filters catch.
//
// Usage:  node scripts/build-type-triage.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(__dirname, "..", "data", ".cache");
const GRAPH_PATH = path.join(CACHE, "type-graph.json");
const OUT_PATH = path.join(CACHE, "type-triage.json");
const API = "https://www.wikidata.org/w/api.php";
const UA = "TimelineHistoryBuildScript/1.0 (personal educational project)";

// Kept identical to fetch-events.mjs. If these two ever disagree the fetcher
// will query types this file thought it had removed.
const FIXTURE_TYPE =
  /\b(season|game|match|fixture|edition|round|draw|leg|heat|race|grand prix|playoff|tie|stage)\b/i;
const ADMIN_TYPE = /\b(municipal election|local election|by-election|milestone|boundary marker|census)\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, attempts = 5) {
  let wait = 1500;
  for (let i = 1; i <= attempts; i++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const text = await res.text();
    if (text.startsWith("{")) return JSON.parse(text);
    if (i === attempts) throw new Error("rate limited");
    await sleep(wait);
    wait *= 2;
  }
}

const graph = JSON.parse(await fs.readFile(GRAPH_PATH, "utf8"));
const wanted = new Map(); // qid -> [categories]
for (const [cat, types] of Object.entries(graph)) {
  for (const t of types) {
    if (!wanted.has(t.qid)) wanted.set(t.qid, []);
    wanted.get(t.qid).push({ cat, n: t.n });
  }
}
const qids = [...wanted.keys()];
console.log(`${Object.keys(graph).length} categories, ${qids.length} distinct types to label`);

const labels = new Map();
for (let i = 0; i < qids.length; i += 50) {
  const batch = qids.slice(i, i + 50);
  try {
    const data = await fetchJson(
      `${API}?action=wbgetentities&ids=${batch.join("|")}&props=labels&languages=en&format=json&formatversion=2`
    );
    for (const [qid, ent] of Object.entries(data.entities || {})) {
      const l = ent.labels?.en?.value;
      if (l) labels.set(qid, l);
    }
  } catch (err) {
    console.warn(`  batch at ${i}: ${err.message} -- skipped`);
  }
  if (i % 500 === 0) console.log(`  ${Math.min(i + 50, qids.length)}/${qids.length}`);
  await sleep(400);
}
console.log(`  labelled ${labels.size}/${qids.length}`);

const keep = [];
const dropped = { unlabelled: 0, fixture: 0, admin: 0 };
for (const [qid, entries] of wanted) {
  const label = labels.get(qid);
  if (!label) {
    dropped.unlabelled++;
    continue;
  }
  if (FIXTURE_TYPE.test(label)) {
    dropped.fixture++;
    continue;
  }
  if (ADMIN_TYPE.test(label)) {
    dropped.admin++;
    continue;
  }
  for (const e of entries) keep.push({ qid, label, cat: e.cat, n: e.n });
}

keep.sort((a, b) => b.n - a.n);
await fs.writeFile(OUT_PATH, JSON.stringify({ keep }, null, 1));

console.log(`\nkept ${keep.length} (type, category) pairs`);
console.log(`  dropped -- no English label : ${dropped.unlabelled}`);
console.log(`  dropped -- fixture type     : ${dropped.fixture}`);
console.log(`  dropped -- admin type       : ${dropped.admin}`);
for (const cat of Object.keys(graph)) {
  console.log(`  ${String(keep.filter((k) => k.cat === cat).length).padStart(4)}  ${cat}`);
}
console.log(`\nWritten to ${OUT_PATH}`);
