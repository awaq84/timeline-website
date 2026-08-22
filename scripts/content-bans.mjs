// Question shapes that are never shown to a reader, wherever they would appear.
//
// These are not quality filters. Everything here is correctly dated, correctly
// phrased and often perfectly famous -- it is excluded because it makes a bad
// prompt, and it stays everywhere else on the site: the map, the year pages and
// the dataset all still carry it.
//
// This file exists because the rules were written inside build-quiz.mjs and the
// other generated feature did not have them. data/discover.js -- the "Discover
// what else was going on in the world when X" panel above the map -- is built by
// build-discover.mjs from the same phrasing module, and shipped 100 university
// foundings, including "Charles University was founded", weeks after the quiz
// stopped showing any. One copy, imported by both, is the only way that stays
// fixed.
//
// Pure text predicates, no I/O.

// "X was born" / "X died", matched on the TITLE suffix rather than the finished
// statement. Those two words are what the phrasing rules and subjectKey() key
// on, so matching the same thing here cannot drift away from what is produced.
const BIO_TITLE = /\s+(born|died)$/i;

// Universities and colleges, in every spelling the dataset uses. An earlier
// version matched only "University", "College" and "Polytechnic" and let through
// Université de Montréal, Universidade Federal de Goiás, Università degli Studi,
// Universitas Istropolitana and three business schools.
const SCHOOL =
  /\b(?:Universit\w*|Univerzit\w*|Uniwersytet\w*|Universiteit|Universidad\w*|Universidade|Hochschule|College|Colegio|Coll[eè]ge|Escuela|Polytechnic|Politecnico|Ateneo|Madrasa|Seminary)\b|\bSchool\b/i;

// Geographical discoveries. 62 of the 69 "was discovered" statements were
// islands and the rest caves -- "Coche Island was discovered" asks which voyage
// happened to sight a rock, not anything about history. The landform list is
// wider than what the data currently holds so a later harvest cannot reintroduce
// the shape through a mountain or a lake.
//
// Tombs, hoards, fossils and meteorites are NOT here: "Tutankhamun's tomb was
// discovered" is an event people know, and is not a geographical discovery.
const LANDFORM =
  /\b(?:Islands?|Isles?|Atolls?|Reefs?|Caves?|Rocks?|Skerry|Skerries|Mountains?|Mount|Peaks?|Lakes?|Rivers?|Bays?|Straits?|Capes?|Glaciers?|Deserts?|Falls|Springs?|Peninsulas?|Archipelagos?|Seas?|Gulfs?|Fjords?|Volcanoes?)\b/i;

// Sport, in three shapes, because it arrives in three.
//
// Fixtures and venues by name; clubs, which name no fixture; and the sport
// itself named anywhere, which is what finally caught the two that are neither
// club nor fixture -- "City Football Group" ("Holding company that administers
// association football clubs") and "Red Bull Powertrains" ("Formula One power
// unit manufacturer"), both filed under Economy & Trade as companies.
//
// Sport only, not entertainment. The Globe Theatre opening in 1599, the Bolshoi
// in 1776 and the Sydney Opera House in 1973 are filed under "Sports &
// Entertainment" and none of them is a sports event.
const SPORTS_FIXTURE =
  /\b(?:Grand Prix|Olympics?|Olympic Games|Olympiad|Games|Championships?|Cup|Open|Tournament|League|Derby|Regatta|Masters|Stadium|Arena|Velodrome|Racecourse|Racetrack|Ballpark)\b/i;
const SPORTS_CLUB =
  /\b(?:football|association football|basketball|ice hockey|handball|baseball|rugby|cricket|volleyball|futsal)\s+(?:club|team)s?\b/i;
const SPORT_WORD =
  /\b(?:football|soccer|basketball|baseball|ice hockey|rugby|cricket|tennis|golf|motorsport|Formula One|Formula 1|NASCAR|athletics|boxing|wrestling|cycling|swimming|handball|volleyball|futsal)\b/i;

const isSport = (statement, description = "") =>
  SPORTS_FIXTURE.test(statement) || SPORTS_FIXTURE.test(description) ||
  SPORTS_CLUB.test(statement) || SPORTS_CLUB.test(description) ||
  SPORT_WORD.test(statement) || SPORT_WORD.test(description);

const isBirthOrDeath = (title) => BIO_TITLE.test(title);
const isSchoolFounding = (statement) => SCHOOL.test(statement) && /\bwas founded$/i.test(statement);
const isLandformDiscovery = (statement) => LANDFORM.test(statement) && /\bwas discovered$/i.test(statement);

// One call for everything. `title` may be omitted where the caller has already
// filtered births and deaths by other means.
function isBanned({ statement, title = "", description = "" }) {
  if (title && isBirthOrDeath(title)) return "birth or death";
  if (isSchoolFounding(statement)) return "university founding";
  if (isLandformDiscovery(statement)) return "geographical discovery";
  if (isSport(statement, description)) return "sport";
  return null;
}

export {
  BIO_TITLE,
  SCHOOL,
  LANDFORM,
  isSport,
  isBirthOrDeath,
  isSchoolFounding,
  isLandformDiscovery,
  isBanned,
};
