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
