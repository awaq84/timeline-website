// Shared helper, kept in its own module deliberately: both enrich-sitelinks.mjs
// and build-discover.mjs need it, but those scripts run their work at import
// time (top-level `await main()`), so importing one from the other would kick
// off a full run as a side effect.

// Turns https://en.wikipedia.org/wiki/Battle_of_Hastings into "Battle of Hastings".
//
// This is the join key between the dataset and Wikidata. Event titles can't be
// used for that: they come from Wikidata labels and often disagree with the
// article name ("Siege of Naxos" vs "Siege of Naxos (499 BC)"). Events sourced
// from wikidata.org rather than en.wikipedia.org have no article title and
// return null.
export function articleTitleFromWiki(wiki) {
  if (!wiki || !wiki.includes("en.wikipedia.org/wiki/")) return null;
  try {
    const slug = new URL(wiki).pathname.replace(/^\/wiki\//, "");
    return decodeURIComponent(slug).replace(/_/g, " ");
  } catch {
    return null;
  }
}

// The other half of the join. Events with no English Wikipedia article link to
// their Wikidata item instead (https://www.wikidata.org/wiki/Q42), and there are
// 5,341 of them -- disproportionately the obscure ones, which are also the ones
// most likely to carry a vague date. Keying those on the QID rather than skipping
// them is what stops /year/1000/ and /year/1500/ keeping most of their inflation.
export function qidFromWiki(wiki) {
  if (!wiki || !wiki.includes("wikidata.org/wiki/")) return null;
  const m = /\/wiki\/(Q\d+)/.exec(wiki);
  return m ? m[1] : null;
}
