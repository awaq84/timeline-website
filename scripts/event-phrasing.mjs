// Turning a dataset title into a sentence.
//
// Extracted from build-discover.mjs so the quiz can reuse it. Most titles in the
// dataset are not sentences: whole categories are bare nouns ("Leucippus",
// "Trapani Cathedral", "Brazil"), which say nothing about what happened in the
// year attached to them. Both features need the same thing -- a clause that
// states the event -- and both are wrong in the same way if they guess.
//
// questionFor() returns null when no rule matches. That is the useful answer:
// callers drop the event rather than invent a phrasing for it.
//
// This file is pure text transformation. It reads no data and has no I/O, so it
// can be imported by any build script.

// Prefix a lowercase "the" unless the title already carries its own article.
// Safe for event nouns (a Battle/Siege/Treaty always takes "the").
const withThe = (t) => (/^(the|a|an)\s/i.test(t) ? t : `the ${t}`);

// Polities are different: "the Khmer Empire" is right but "the Hungary" and
// "the Francia" are not. English takes an article only when the name has a
// common-noun head ("... Empire", "... Dynasty") or is an "X of Y" construction;
// a bare toponym takes none. Plurals like "the Netherlands" also take one but
// can't be detected structurally, so they're listed.
const POLITY_HEAD =
  /(?:empire|kingdom|republic|dynasty|caliphate|sultanate|khanate|shogunate|emirate|duchy|principality|confederacy|confederation|union|federation|league|commonwealth|protectorate|colony|territory|province|state|states|horde|raj|reich|dominion|regency|khaganate|tsardom|despotate|hegemony)$/i;
const ARTICLE_PLURALS = /^(?:Netherlands|Philippines|United\s|Papal States|Two Sicilies)/i;

const withTheIfPolity = (t) => {
  if (/^(the|a|an)\s/i.test(t)) return t;
  if (POLITY_HEAD.test(t) || / of /.test(t) || ARTICLE_PLURALS.test(t)) return `the ${t}`;
  return t;
};

// "the Papal States were founded", not "was". Only names whose head noun is
// itself plural take a plural verb -- "the United States of America" is
// conventionally singular, so the test looks at the final word only.
const isPluralPolity = (t) => /(?:States|Sicilies|Netherlands|Philippines|Provinces|Emirates)$/i.test(t.trim());
const wasWere = (t) => (isPluralPolity(t) ? "were" : "was");

// Institutions and buildings follow the same article rule as polities, just with
// a different set of head nouns. "the University of Ferrara" and "the Paris
// Observatory" are right because the name leads with (or is built around) a
// common noun; "the Babeș-Bolyai University" and "the St. Lawrence Island" are
// not, because there the common noun is a trailing tag on a proper name.
const COMMON_HEAD =
  /^(?:University|College|Institute|Institution|Academy|School|Polytechnic|Museum|Observatory|Laboratory|Hospital|Infirmary|Cathedral|Basilica|Mosque|Synagogue|Temple|Abbey|Priory|Shrine|Pagoda|Monastery|Theatre|Theater|Playhouse|Opera House|Council|Synod|Conclave|Isle|Island)\b/i;

const withTheIfCommonHead = (t) => {
  if (/^(the|a|an)\s/i.test(t)) return t;
  if (/ of /i.test(t) || COMMON_HEAD.test(t)) return `the ${t}`;
  return t;
};

const ORDINAL = String.raw`(?:First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth)\s`;

// First match wins. Each rule turns a title into a clause that reads naturally
// after "Discover what else was going on in the world when ...".
const RULES = [
  { re: new RegExp(String.raw`^(.+) born$`), q: (m) => `${m[1]} was born` },
  { re: new RegExp(String.raw`^(.+) died$`), q: (m) => `${m[1]} died` },
  { re: new RegExp(String.raw`^(.+) founded$`), q: (m) => `${withTheIfPolity(m[1])} ${wasWere(m[1])} founded` },
  { re: new RegExp(String.raw`^(.+) dissolved$`), q: (m) => `${withTheIfPolity(m[1])} ${wasWere(m[1])} dissolved` },
  { re: new RegExp(String.raw`^(?:${ORDINAL})?Battle of `), q: (m) => `${withThe(m.input)} was fought` },
  { re: new RegExp(String.raw`^(?:${ORDINAL})?Siege of `), q: (m) => `${withThe(m.input)} took place` },
  { re: new RegExp(String.raw`^(?:Treaty|Peace|Pact|Convention) of `), q: (m) => `${withThe(m.input)} was signed` },
  { re: /(?:earthquake|flood|tsunami|eruption|cyclone|hurricane)$/i, q: (m) => `${withThe(m.input)} struck` },
  { re: /(?:plague|pandemic|epidemic|famine)$/i, q: (m) => `${withThe(m.input)} broke out` },
  { re: /\bWar$/, q: (m) => `${withThe(m.input)} began` },
  { re: /(?:Revolt|Rebellion|Uprising|Revolution|Insurrection)$/i, q: (m) => `${withThe(m.input)} began` },
  { re: /(?:Crusade|Massacre|Mutiny)$/i, q: (m) => `${withThe(m.input)} took place` },
];

// Verbatim from the original hand-authored list. Keyed by title only: these are
// famous enough to be unambiguous, and their titles are unique in the dataset.
const HAND_WRITTEN = {
  "Great Pyramid of Giza completed": "the Pyramids of Giza were built",
  "First Olympic Games": "the first Olympic Games were held",
  "Founding of the Roman Republic": "Rome became a republic",
  "Qin Shi Huang unifies China": "China was first unified",
  "Assassination of Julius Caesar": "Julius Caesar was assassinated",
  "Crucifixion of Jesus": "Jesus was crucified",
  "Eruption of Mount Vesuvius": "Pompeii was buried by Mount Vesuvius",
  "Fall of the Western Roman Empire": "the Roman Empire fell",
  "The Hijra": "the Hijra took place and the Islamic calendar began",
  "Battle of Hastings": "the Battle of Hastings was fought",
  "Genghis Khan founds the Mongol Empire": "Genghis Khan founded the Mongol Empire",
  "Signing of the Magna Carta": "the Magna Carta was signed",
  "The Black Death reaches Europe": "the Black Death swept through Europe",
  "Gutenberg's Printing Press": "Gutenberg invented the printing press",
  "Fall of Constantinople": "Constantinople fell to the Ottomans",
  "Columbus reaches the Americas": "Columbus reached the Americas",
  "Luther's 95 Theses": "Martin Luther sparked the Reformation",
  "Great Fire of London": "the Great Fire of London broke out",
  "Newton publishes the Principia": "Newton published his laws of motion",
  "US Declaration of Independence": "the US Declaration of Independence was signed",
  "Storming of the Bastille": "the French Revolution began",
  "Battle of Waterloo": "Napoleon was defeated at Waterloo",
  "Darwin publishes On the Origin of Species": "Darwin published On the Origin of Species",
  "American Civil War begins": "the American Civil War began",
  "Telephone invented": "the telephone was invented",
  "Eiffel Tower completed": "the Eiffel Tower was built",
  "First powered flight": "the Wright brothers achieved the first powered flight",
  "Sinking of the Titanic": "the Titanic sank",
  "End of World War I": "World War I ended",
  "Tutankhamun's tomb discovered": "Tutankhamun's tomb was discovered",
  "Wall Street Crash": "the Wall Street Crash triggered the Great Depression",
  "Germany invades Poland": "World War II began",
  "Attack on Pearl Harbor": "Pearl Harbor was attacked",
  "D-Day landings": "the D-Day landings took place",
  "Atomic bombing of Hiroshima": "the atomic bomb was dropped on Hiroshima",
  "Launch of Sputnik": "Sputnik launched the Space Age",
  "Assassination of John F. Kennedy": "JFK was assassinated",
  "Apollo 11 Moon Landing": "humans first walked on the Moon",
  "Fall of the Berlin Wall": "the Berlin Wall fell",
  "World Wide Web goes public": "the World Wide Web went public",
  "September 11 attacks": "the September 11 attacks happened",
  "First iPhone released": "the first iPhone was released",
  "COVID-19 declared a pandemic": "COVID-19 was declared a pandemic",
};

// Rules that are only safe to apply within a given category. Most of the
// dataset's institutions, venues and places of worship are titled with a bare
// proper noun ("Chapman University", "Trapani Cathedral"), which says nothing
// about what happened -- but the category plus the query that produced it does:
// those rows are dated by inception (P571), so the event is the founding or
// opening. Applying these globally would be wrong; "Victoria Theatre" in another
// category is not necessarily a theatre opening.
const CATEGORY_RULES = {
  "Science & Technology": [
    { re: /\b(?:University|College|Institute|Institution|Academy|Observatory|Laboratory|Museum|Hospital|Infirmary|Polytechnic)\b/i, q: (m) => `${withTheIfCommonHead(m.input)} was founded` },
    { re: /\b(?:Botanical Garden|Botanic Garden|Arboretum|Planetarium)s?\b/i, q: (m) => `${withTheIfCommonHead(m.input)} opened` },
    { re: /\b(?:Power Station|Power Plant|Nuclear Power Plant)\b/i, q: (m) => `${withTheIfCommonHead(m.input)} started up` },
  ],
  "Religion & Belief Systems": [
    { re: /\b(?:Cathedral|Basilica|Mosque|Synagogue|Temple|Abbey|Priory|Shrine|Pagoda|Monastery)\b/i, q: (m) => `${withTheIfCommonHead(m.input)} was founded` },
    { re: /\b(?:Council|Synod|Conclave)\b/i, q: (m) => `${withTheIfCommonHead(m.input)} was convened` },
  ],
  "Sports & Entertainment": [
    { re: /\b(?:Theatre|Theater|Opera House|Playhouse|Amusement Park|Theme Park|Gardens)\b/i, q: (m) => `${withTheIfCommonHead(m.input)} opened` },
    { re: /\b(?:Championship|Championships|Cup|Games|Festival|Grand Prix|Open|Olympiad)\b/i, q: (m) => `${withTheIfCommonHead(m.input)} was held` },
  ],
  "Exploration & Discovery": [
    // Only titles that name a found *thing*. Expeditions and shipwrecks also
    // live in this category and "the Rodi disaster was discovered" is nonsense.
    { re: /\b(?:Cave|Caves|Island|Islands|Hoard|Tomb|Meteorite|Skeleton|Fossil|Artefact|Artifact)\b/i, q: (m) => `${withTheIfCommonHead(m.input)} was discovered` },
  ],
};

// --- Bare-name fallback, driven by the date's own Wikidata property ---
//
// Most of the dataset is titled with a bare proper noun -- "Bent Pyramid",
// "Medici Bank", "Zincirli Höyük" -- and 59,510 events were dropped from the
// quiz for saying nothing about what happened. They are not unusable, though:
// the reader is shown the Wikidata description beside every option, so
// "Mohenjo-daro / archaeological site in the province of Sindh, Pakistan" reads
// perfectly well. What was missing was never the noun. It was the verb.
//
// CATEGORY_RULES above guess the verb from the head noun and a stated assumption
// that "those rows are dated by inception (P571)". This does not guess. The
// precision cache built by enrich-date-precision.mjs stores every (property,
// year, precision) triple per article, so the property that actually supplied
// the stored year is known: P571 inception, P580 start time, P575 discovery,
// P576 dissolution. The verb follows from that rather than from a hunch about
// what kind of thing the title names.
//
// Deliberately narrow. Only the property/category pairs where the claim is true
// for every member of the pair are listed, because a wrong verb here is not a
// cosmetic problem -- the quiz grades people against it. P585 "point in time" is
// absent throughout: it means only "this is when the thing is dated to", which
// supports no verb at all for a bare noun. P569 and P570 are absent because
// births and deaths are barred from the quiz outright.
// A settlement, city or dig site is founded, not built. Checked against the
// Wikidata description rather than the title, because the title is a bare proper
// noun that says nothing -- "Assur", "Amarna", "Phanagoria" are all cities and
// none of them announce it.
const IS_PLACE = /\b(?:archaeolog\w*|settlement|city|town|village|polis|colony|capital)\b/i;

// "Broke out" is only true of something that breaks out. The residue of this
// category that reaches the fallback is whatever the title-based rules did not
// already catch, and it is not all epidemics: without this guard the pool
// contained "Armenian Genocide broke out", "September Massacres broke out" and
// "the Harrying of the North broke out". A genocide is perpetrated, not
// contracted, and phrasing it as an outbreak is both wrong and grotesque.
const IS_OUTBREAK = /\b(?:epidemic|pandemic|plague|famine|fire|conflagration|blaze|outbreak|disease)\b/i;

// Universities in every spelling the dataset actually uses. The first version of
// this matched only "University", "College" and "Polytechnic", and let through
// Université de Montréal, Universidade Federal de Goiás, Università degli Studi,
// Universitas Istropolitana, the London School of Economics and three business
// schools. Universit\w* covers the Romance and Germanic forms in one; the rest
// are listed because they share no stem with it.
const IS_SCHOOL =
  /\b(?:Universit\w*|Univerzit\w*|Uniwersytet\w*|Universiteit|Hochschule|College|Colegio|Coll[eè]ge|Escuela|Polytechnic|Politecnico|Ateneo)\b|\bSchool\b/i;

// Sporting fixtures. Not a quality judgement about sport -- the dataset filed
// "Saudi Arabian Grand Prix" under Economy & Trade, where the P571 rule turned it
// into "Saudi Arabian Grand Prix was founded", which is both the wrong verb for a
// motor race and a fixture the dataset was explicitly asked not to accumulate.
// This stops the fallback inventing new ones; fixtures already phrased by the
// title rules above are unaffected.
const IS_FIXTURE =
  /\b(?:Grand Prix|Championships?|Cup|Olympiad|Olympics|Tournament|Trophy|League|Season|Open|Games|Derby|Regatta)\b/i;

// Verb tables, consulted after the guards above. Keyed by the Wikidata property
// that supplied the stored year -- P571 inception, P580 start time, P576
// dissolution -- so the claim follows the data rather than a guess about what
// kind of thing the title names.
//
// Deliberately narrow. Only pairs where the verb is true of every member are
// listed, because a wrong verb here is not cosmetic: the quiz grades people
// against it. P585 "point in time" is absent throughout, because it means only
// "this is when the thing is dated to" and supports no verb for a bare noun.
// P569 and P570 are absent because births and deaths are barred outright.
// "Wars & Conflicts" is absent from P580 for the same reason IS_OUTBREAK exists:
// what reaches the fallback there is campaigns, fronts and expeditions -- "the
// Algiers expedition broke out", "Eastern Front broke out" -- not wars.
const BARE_NAME_VERBS = {
  P571: {
    "Architecture & Engineering": (d) => (IS_PLACE.test(d) ? "was founded" : "was built"),
    "Economy & Trade": () => "was founded",
    "Religion & Belief Systems": () => "was founded",
    "Science & Technology": () => "was founded",
    "Politics & Government": () => "was founded",
  },
  P580: {
    "Architecture & Engineering": (d) => (IS_PLACE.test(d) ? "was founded" : "was built"),
    "Disasters & Pandemics": (d) => (IS_OUTBREAK.test(d) ? "broke out" : null),
  },
  P576: {
    "Economy & Trade": () => "closed",
    "Religion & Belief Systems": () => "was dissolved",
  },
};

function bareNameQuestion(title, category, dateProp, description = "") {
  const pick = BARE_NAME_VERBS[dateProp]?.[category];
  if (!pick) return null;
  // Universities are barred from the quiz, and the fallback is the one path that
  // can invent a founding statement for one. Stopping it here keeps the rule in
  // the same place as the phrasing it would otherwise create.
  if (IS_SCHOOL.test(title)) return null;
  if (IS_FIXTURE.test(title) || IS_FIXTURE.test(description || "")) return null;
  const verb = pick(description || "");
  if (!verb) return null;
  return `${withTheIfCommonHead(title)} ${verb}`;
}

// dateProp is optional: callers without the precision cache get exactly the old
// behaviour, which is what keeps the year pages and every other consumer of this
// module unchanged.
function questionFor(title, category, dateProp = null, description = "") {
  // General rules first: a title that already says what happened ("... born",
  // "Battle of ...") should phrase the same way regardless of category.
  for (const rule of RULES) {
    const m = rule.re.exec(title);
    if (m) {
      // m.input is the whole title; rules that use it want the title intact.
      return rule.q(m);
    }
  }
  for (const rule of CATEGORY_RULES[category] || []) {
    const m = rule.re.exec(title);
    if (m) return rule.q(m);
  }
  // Last: the bare proper noun, phrased from the date's own property.
  return bareNameQuestion(title, category, dateProp, description);
}

export { withThe, withTheIfPolity, withTheIfCommonHead, RULES, CATEGORY_RULES, HAND_WRITTEN, BARE_NAME_VERBS, questionFor };
