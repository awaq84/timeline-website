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
  ["2,000 - 1,500 BC", -2000, 6], // the Omori Katsuyama case, was -500

  // --- documented rule: earlier end of a range ---
  //
  // These three asserted prec 9 until the Americas harvest showed what that
  // means downstream: a 500- or 800-year range printed as a flat "2000 BC", a
  // confidence no source offered. The YEAR was never in question -- only how
  // loudly to hedge it -- so the expectations move, not the parser's answer.
  // Span sets the hedge: <=25y decade, <=250y century, wider millennium.
  ["between 200 and 100 BC", -200, 7],
  ["2500-1700 BC", -2500, 6],
  ["1080-1100", 1080, 8],
  ["536-600", 536, 7],
  ["600-400 BCE", -600, 7],

  // --- AD ranges had no branch at all and took the LATER end at prec 9 ---
  ["0-499 AD", 1, 6], // Pinson Mounds, was AD 499 exactly
  ["1200-1300", 1200, 7],

  // --- "approx."/"around"/"estimated" mean what "c." means ---
  ["approx. 4000 BC - 2000 BC", -4000, 6], // Mount Taylor, was -4000 prec 9
  ["around 1850", 1850, 8],
  ["estimated 1600", 1600, 8],

  // --- an ISO date is not a range ---
  ["1980-01-01", 1980, 9],

  // --- a comma list is a build date plus later additions, not a range ---
  ["1745, 1834-1835", 1745, 9],   // Kentland Farm, was dated to its 1834 addition
  ["1778, 1939-1941", 1778, 9],   // Fort Roberdeau, was dated to its 1939 rebuild
  ["1650-1699, 1700s", 1650, 7],
  ["March 15, 1901", 1901, 9],    // first segment has no year: must not split

  // --- AD centuries: first year, never the future ---
  ["5th century AD", 401, 7],
  ["1st century AD", 1, 7],
  ["21st century", 2001, 7],
  ["2nd century AD", 101, 7],

  // --- circa must lower precision, not assert a year ---
  ["{{circa|1712}}", 1712, 8],
  ["ca. 1575-1600", 1575, 8],
  ["c. 1500", 1500, 8],

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
