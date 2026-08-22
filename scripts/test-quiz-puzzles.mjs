// Reproduces the audit's quiz check, plus the defect it found: a distractor
// whose statement is ALSO true inside the window.
import fs from "node:fs";

const noop = () => {};
global.document = {
  getElementById: () => null,
  createElement: () => ({ appendChild: noop, addEventListener: noop, setAttribute: noop, classList: { add: noop, toggle: noop }, style: {} }),
  head: { appendChild: noop },
  readyState: "loading",
  addEventListener: noop,
};
global.window = { addEventListener: noop };

const data = fs.readFileSync("data/quiz.js", "utf8");
const src = fs.readFileSync("quiz-app.js", "utf8").replace(/\ninitQuiz\(\);\s*$/, "\n");
const api = new Function(`${data}\n${src}\nreturn { buildPuzzle, buildTiers, QUIZ_LEVELS, QUIZ_EVENTS, run };`)();
api.buildTiers();

// Ground truth built independently of the app.
const yearsByQ = new Map();
for (const p of api.QUIZ_EVENTS) {
  if (!yearsByQ.has(p.q)) yearsByQ.set(p.q, new Set());
  yearsByQ.get(p.q).add(p.y);
}

const N = 8000;
let nulls = 0, checked = 0;
// Births, deaths, university foundings and land masses being discovered are
// barred from the pool by scripts/build-quiz.mjs. Restated here in one pattern
// so the test fails on what the player is shown, not on what the builder
// intended.
const BARRED_SHAPE =
  /(?:\b(?:was born|died)$)|(?:\b(?:Universit(?:y|ies|é|ät|à|a|ad|eit|ä)|College|Polytechnic)\b.*\bwas founded$)|(?:\b(?:Islands?|Isles?|Atolls?|Reefs?|Caves?|Rocks?|Skerry|Skerries)\b.*\bwas discovered$)/i;

const fail = { optCount: 0, corrCount: 0, corrOutside: 0, wrongInside: 0, dupSubject: 0, dupStatement: 0, barredShape: 0, fameFloor: 0, windowOOB: 0, ambiguous: 0 };
const examples = [];

for (let i = 0; i < N; i++) {
  const L = i % api.QUIZ_LEVELS.length;
  const lv = api.QUIZ_LEVELS[L];
  const p = api.buildPuzzle(L);
  if (!p) { nulls++; continue; }
  checked++;
  if (p.options.length !== 4) fail.optCount++;
  if (p.answer.size !== 2) fail.corrCount++;
  if (p.end - p.start + 1 !== lv.span) fail.windowOOB++;
  if (new Set(p.options.map((o) => o.s)).size !== 4) fail.dupSubject++;
  if (new Set(p.options.map((o) => o.q)).size !== 4) fail.dupStatement++;
  p.options.forEach((o, j) => {
    const inside = o.y >= p.start && o.y <= p.end;
    if (inside && !p.answer.has(j)) fail.corrOutside++;
    if (!inside && p.answer.has(j)) fail.wrongInside++;
    if (o.f < lv.minFame) fail.fameFloor++;
    // The three barred question shapes, checked on the option a player actually
    // sees rather than on the pool. build-quiz.mjs asserts the same thing about
    // the pool it writes; this catches the case where a stale data/quiz.js is
    // still on disk, which is exactly what the browser would be serving.
    if (BARRED_SHAPE.test(o.q)) fail.barredShape++;
    // THE DEFECT: a wrong option whose statement is true somewhere in the window.
    if (!p.answer.has(j)) {
      const ys = yearsByQ.get(o.q);
      if (ys && [...ys].some((y) => y >= p.start && y <= p.end)) {
        fail.ambiguous++;
        if (examples.length < 5) examples.push(`L${L + 1} ${p.start}..${p.end}  "${o.q}" shown at ${o.y} but also true at ${[...ys].filter((y) => y >= p.start && y <= p.end).join(",")}`);
      }
    }
  });
}

console.log(`${checked} puzzles built, ${nulls} nulls\n`);
for (const [k, v] of Object.entries(fail)) console.log(`  ${k.padEnd(14)} ${v}`);
if (examples.length) { console.log("\nambiguous examples:"); examples.forEach((e) => console.log("  " + e)); }
const total = Object.values(fail).reduce((a, b) => a + b, 0);
console.log(total ? `\n${total} FAILURES` : "\nall clean");
