// The full backfill: derived type lists, region partitioning, generous caps.
//
// No environment prefix on the command, so an unattended run cannot stop at a
// permission prompt -- see fetch-regional-backfill.mjs for why that matters.
//
//   FETCH_DERIVED   use the type lists derived from Wikidata's subclass graph
//                   rather than the hand-written ones, which reach 18% of what
//                   exists
//   FETCH_REGIONS   give each region its own pass and row budget, so a Chinese
//                   temple competes with other Chinese temples
//   FETCH_TARGET    high enough that the per-category guillotine cannot cut the
//                   regional and long-tail rows straight back out
//
// Writes only to data/.cache/. Nothing reaches data/events.js until
// scripts/merge-events.mjs is run deliberately.
process.env.FETCH_DERIVED = "1";
process.env.FETCH_REGIONS = "1";
process.env.FETCH_MIN_YEAR = process.env.FETCH_MIN_YEAR ?? "-3000";
process.env.FETCH_TARGET = process.env.FETCH_TARGET ?? "60000";
process.env.FETCH_RAW_LIMIT = process.env.FETCH_RAW_LIMIT ?? "1500";
process.env.FETCH_MAX_TYPES = process.env.FETCH_MAX_TYPES ?? "60";

console.log("Full backfill");
console.log(`  derived types on, regions on, years ${process.env.FETCH_MIN_YEAR}..2026`);
console.log(`  target ${process.env.FETCH_TARGET}/category, ${process.env.FETCH_RAW_LIMIT}/sub-query`);
console.log(`  started ${new Date().toISOString()}\n`);

await import("./fetch-events.mjs");
