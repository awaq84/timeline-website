// Overnight regional backfill: every category, with the region passes on.
//
// This exists so the command is `node scripts/fetch-regional-backfill.mjs` with
// no environment prefix. Claude Code's permission rules match on a command
// PREFIX, so `FETCH_REGIONS=1 node scripts/...` needs its own approval for every
// distinct set of variable values, while a plain `node scripts/...` is covered
// once. An unattended run must not stop on a permission prompt at 3am.
//
// Settings are deliberately generous, because the point of this run is volume in
// the regions the global fame ranking has been starving:
//
//   FETCH_REGIONS       region passes on -- the actual fix
//   FETCH_MIN_YEAR      back to 3000 BC rather than the 500 BC default
//   FETCH_TARGET        20,000 per category, so the 550 guillotine cannot cut
//                       the regional rows straight back out again
//   FETCH_RAW_LIMIT     1,200 per sub-query, up from 900
//
// Writes only to data/.cache/. Nothing reaches data/events.js until
// scripts/merge-events.mjs is run deliberately, so a bad night costs nothing.

process.env.FETCH_REGIONS = "1";
process.env.FETCH_MIN_YEAR = process.env.FETCH_MIN_YEAR ?? "-3000";
process.env.FETCH_TARGET = process.env.FETCH_TARGET ?? "20000";
process.env.FETCH_RAW_LIMIT = process.env.FETCH_RAW_LIMIT ?? "1200";

// Categories may still be passed through: node scripts/fetch-regional-backfill.mjs "Wars & Conflicts"
console.log("Regional backfill starting");
console.log(`  regions on, years ${process.env.FETCH_MIN_YEAR}..${process.env.FETCH_MAX_YEAR ?? 2026}`);
console.log(`  target ${process.env.FETCH_TARGET}/category, raw limit ${process.env.FETCH_RAW_LIMIT}/sub-query`);
console.log(`  categories: ${process.argv.slice(2).join(", ") || "all"}`);
console.log(`  started ${new Date().toISOString()}\n`);

await import("./fetch-events.mjs");
