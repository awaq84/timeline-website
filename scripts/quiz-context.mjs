// Extracting the datable context a description refers to.
//
// Shared by enrich-context-fame.mjs, which fetches how well known each context
// is, and build-quiz.mjs, which uses that to decide whether an obscure event is
// still fair to ask about. Both must extract the same names or the cache and the
// lookup silently disagree, which is why this is one file rather than a regex
// copied into two.
//
// The idea: "the Battle of Torrence's Tavern was fought" is unanswerable on its
// own -- two language Wikipedias, nobody has heard of it. But it is shown with
// its description, "Battle of the American Revolutionary War", and the year has
// already been stripped out of that by stripDates(). Placing it needs no
// knowledge of the battle at all, only of when the war was.
//
// Pure text transformation, no I/O, so either script can import it.

// Two shapes. The first is a connective followed by a named period ("during the
// Peninsular War", "of the Taiping Rebellion"); the second is the handful of
// names that appear without one, where a general pattern would either miss them
// or swallow the numeral -- an earlier version returned "Battle of World War"
// for "Battle of World War I", which resolves to nothing.
const NAMED_PERIOD = String.raw`(?:Wars?|Crusades?|Revolution|Rebellion|Uprising|Dynasty|Empire|Reconquista|Reformation|Campaign)`;

const CONTEXT_PATTERN = new RegExp(
  String.raw`\b(World War\s+(?:I{1,3}|1|2))\b` +
    String.raw`|\b(?:of|during|in|from|part of|against)\s+the\s+([A-ZÀ-Ý][^,;.]*?${NAMED_PERIOD})\b`,
  ""
);

// A few names in common use are not the article title. Mapped here rather than
// left to fail, because between them they account for over a hundred events.
const ALIASES = {
  "First World War": "World War I",
  "Second World War": "World War II",
  "World War 1": "World War I",
  "World War 2": "World War II",
  "Great War": "World War I",
};

// Returns the context name a description cites, or null. Deliberately strict:
// a description that merely contains the word "war" gives nothing to date from,
// so only a capitalised, named period counts.
function contextName(description) {
  if (!description) return null;
  const m = String(description).match(CONTEXT_PATTERN);
  if (!m) return null;
  const raw = (m[1] || m[2] || "").replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();
  if (raw.length < 4) return null;
  return ALIASES[raw] || raw;
}

export { CONTEXT_PATTERN, contextName };
