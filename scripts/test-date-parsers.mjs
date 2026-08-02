// Adversarial regression suite for the infobox date parser, built from the
// audit's findings. Every case below either shipped a wrong value or silently
// returned nothing.
import fs from "node:fs";

const src = fs.readFileSync("scripts/fetch-infobox-dates.mjs", "utf8");
const body = src.slice(src.indexOf("function clean"), src.indexOf("async function sparql"));
const { parseDate } = new Function(`${body}\nreturn { clean, parseDate };`)();

const cases = [
  // --- wrong SIGN: the worst class, all previously returned AD ---
  ["500 B.C.", -500, 9],
  ["1200 B.C.", -1200, 9],
  ["c. 800 B.C.", -800, 7],
  ["500 B.C.E.", -500, 9],
  ["2500 B.C.", -2500, 9],
  ["B.C. 300", -300, 9],

  // --- wrong MAGNITUDE: comma grouping ---
  ["1,200 BC", -1200, 9],
  ["10,000 BC", -10000, 9],
  ["2,000 - 1,500 BC", -2000, 9], // the Omori Katsuyama case, was -500

  // --- documented rule: earlier end of a range ---
  ["between 200 and 100 BC", -200, 9],
  ["2500-1700 BC", -2500, 9],

  // --- AD centuries: first year, never the future ---
  ["5th century AD", 401, 7],
  ["1st century AD", 1, 7],
  ["21st century", 2001, 7],
  ["2nd century AD", 101, 7],

  // --- circa must lower precision, not assert a year ---
  ["{{circa|1712}}", 1712, 7],
  ["ca. 1575-1600", 1575, 7],
  ["c. 1500", 1500, 7],

  // --- previously unreachable ---
  ["AD 79", 79, 9],
  ["79 AD", 79, 9],
  ["79 CE", 79, 9],
  ["5th-century BC", -500, 7],

  // --- must still reject ---
  ["{{convert|250|ha|abbr=on}}", null, null],
  ["250 ha", null, null],
  ["unknown", null, null],
  ["", null, null],

  // --- must still work ---
  ["{{circa|2500 BC}}", -2500, 7],
  ["3rd millennium BC", -3000, 6],
  ["1066", 1066, 9],
  ["1984", 1984, 9],
];

let bad = 0;
for (const [input, wantY, wantP] of cases) {
  const got = parseDate(input);
  const y = got?.year ?? null;
  const p = got?.prec ?? null;
  const ok = y === wantY && p === wantP;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${JSON.stringify(input).padEnd(30)} -> ${String(y).padStart(7)} prec${p}   want ${wantY} prec${wantP}`);
}
console.log(bad ? `\n${bad} of ${cases.length} FAILED` : `\nall ${cases.length} pass`);
process.exit(bad ? 1 : 0);
