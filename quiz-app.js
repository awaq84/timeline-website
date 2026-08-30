// "Test your knowledge" -- a ten-question run up a difficulty ladder.
//
// Split out of app.js so /quiz/ can stand on its own. The map page loads d3,
// topojson, a 27KB year index and a world atlas before it can draw anything;
// none of that is needed to ask which two events share a period, and making a
// quiz player wait for it would be absurd. This file has no dependencies at all.
//
// The run is ten questions, one per level, and both difficulty axes tighten
// together: the target period narrows from fifteen centuries to a decade while
// the fame floor drops, so the events stop being ones everybody has heard of. The levels
// themselves -- spans, floors and names -- are generated into data/quiz.js as
// QUIZ_LEVELS, so the build can verify against the pool it just produced rather
// than trusting a copy kept here by hand.

// Mirrors CATEGORY_ORDER in app.js and build-quiz.mjs. The pool stores a
// category index rather than a name, and this is what turns it back into a
// colour. Kept as a local copy on the same terms as the copy in build-quiz.mjs:
// if the list in app.js changes, all three move together.
const QUIZ_CATEGORY_COLORS = [
  "#ff9f0a", // Major Events
  "#ff453a", // Wars & Conflicts
  "#5e5ce6", // Politics & Government
  "#2997ff", // People
  "#64d2ff", // Science & Technology
  "#30d158", // Exploration & Discovery
  "#bf5af2", // Religion & Belief Systems
  "#ffd60a", // Economy & Trade
  "#ff6482", // Disasters & Pandemics
  "#ac8e68", // Social Movements & Revolutions
  "#8e8e93", // Architecture & Engineering
  "#26d0ce", // Sports & Entertainment
  "#a2845e", // Empires & Countries
];

const sectionEl = document.getElementById("quizSection");
const bodyEl = document.getElementById("quizBody");

// Score and progress are deliberately plain variables. /privacy/ promises the
// site sets no cookies and writes nothing to local or session storage, so a run
// has to end when the tab does.
const run = {
  loaded: false,
  loading: false,
  tiers: [], // one {pool, years} per level, pool sorted by year
  level: 0, // 0-based index into QUIZ_LEVELS
  results: [], // true/false per graded question
  puzzle: null,
  picked: [], // indices into puzzle.options, oldest first, max 2
  graded: false,
  finished: false,
};

const levels = () => (typeof QUIZ_LEVELS !== "undefined" ? QUIZ_LEVELS : []);

function formatYear(y) {
  return y < 0 ? `${Math.abs(y)} BC` : `${y}`;
}

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// First index with years[i] >= target.
function lowerBound(years, target) {
  let lo = 0;
  let hi = years.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (years[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function rangeOf(tier, lo, hi) {
  return tier.pool.slice(lowerBound(tier.years, lo), lowerBound(tier.years, hi + 1));
}

// Takes two entries with different subjects, marking both as used. Returns null
// if the candidates are all about the same handful of subjects -- the caller
// retries with a different window rather than showing "Napoleon born" next to
// "Napoleon died".
//
// The statement is claimed alongside the subject key, because the key does not
// catch everything: the pool holds the Storming of the Bastille and the French
// Revolution as separate subjects, both dated 1789 and both phrased "the French
// Revolution began". Two different subjects, one sentence -- and as a pair of
// options it looks like the page has repeated itself.
function pickTwoDistinct(candidates, taken) {
  const out = [];
  for (const c of shuffled(candidates)) {
    if (taken.has(c.s) || taken.has(`q:${c.q}`)) continue;
    taken.add(c.s);
    taken.add(`q:${c.q}`);
    out.push(c);
    if (out.length === 2) return out;
  }
  return null;
}

// The two wrong answers sit outside the window but not far outside: `gap` keeps
// them clear of the edge so a near-miss doesn't feel arbitrary, `reach` keeps
// them near enough that the period still has to be read. Both scale with the
// span, which is what makes level 10 genuinely harder than level 1 rather than
// just differently worded. reach has a floor of 40 years so the narrow late
// levels still have somewhere to draw a distractor from.
function buildPuzzle(levelIndex) {
  const lv = levels()[levelIndex];
  const tier = run.tiers[levelIndex];
  if (!lv || !tier || !tier.pool.length) return null;

  const span = lv.span;
  const gap = Math.max(1, Math.round(span / 2));
  const reach = Math.max(40, span * 5);

  for (let attempt = 0; attempt < 600; attempt++) {
    const anchor = tier.pool[randInt(tier.pool.length)];
    // Slide the window randomly around the anchor so the answer is not always
    // sitting on the first year of the period, then pull it back inside the
    // range the dataset actually covers.
    //
    // Without the clamp the window runs off both ends of history: at a span of
    // 1500 years an anchor in the 1900s produced "which two happened between
    // 1409 and 2908", asking the player about seven centuries that have not
    // happened yet. Harmless to the grading -- there are no events out there to
    // get wrong -- but it reads as broken, which is worse.
    const start = Math.max(run.minYear, Math.min(anchor.y - randInt(span), run.maxYear - span + 1));
    const end = start + span - 1;

    const inside = rangeOf(tier, start, end);
    if (inside.length < 2) continue;

    // A distractor must be false for THIS window, which is not the same as
    // sitting outside it: the same statement can be true of several years, and
    // one of those years may be inside. pickTwoDistinct only stops two options
    // sharing a statement within one puzzle -- it cannot see this.
    const outside = rangeOf(tier, start - reach, start - gap)
      .concat(rangeOf(tier, end + gap, end + reach))
      .filter((o) => {
        const years = run.yearsByStatement.get(o.q);
        return !years || !years.some((y) => y >= start && y <= end);
      });
    if (outside.length < 2) continue;

    const taken = new Set();
    const correct = pickTwoDistinct(inside, taken);
    if (!correct) continue;
    const wrong = pickTwoDistinct(outside, taken);
    if (!wrong) continue;

    const options = shuffled(correct.concat(wrong));
    return {
      start,
      end,
      span,
      options,
      answer: new Set(options.map((o, i) => (correct.includes(o) ? i : -1)).filter((i) => i >= 0)),
    };
  }
  return null;
}

function periodLabel(p) {
  return p.span === 1
    ? `Which two happened in ${formatYear(p.start)}?`
    : `Which two happened between ${formatYear(p.start)} and ${formatYear(p.end)}?`;
}

// ---- Rendering ----

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function renderProgress() {
  const lv = levels()[run.level];
  const wrap = el("div", "quiz-progress");

  const head = el("div", "quiz-level-head");
  head.appendChild(el("span", "quiz-level-num", `Level ${lv.n} of ${levels().length}`));
  head.appendChild(el("span", "quiz-level-name", lv.name));
  wrap.appendChild(head);

  // One pip per question: filled for answered, ticked or crossed once graded.
  const pips = el("div", "quiz-pips");
  pips.setAttribute("aria-label", `Question ${run.level + 1} of ${levels().length}`);
  for (let i = 0; i < levels().length; i++) {
    const pip = el("span", "quiz-pip");
    if (i < run.results.length) pip.classList.add(run.results[i] ? "is-right" : "is-wrong");
    else if (i === run.level) pip.classList.add("is-current");
    pips.appendChild(pip);
  }
  wrap.appendChild(pips);
  return wrap;
}

function renderQuestion() {
  const p = run.puzzle;
  bodyEl.innerHTML = "";
  bodyEl.appendChild(renderProgress());

  if (!p) {
    // Never seen across 100,000 generated puzzles and the build refuses to ship
    // a level with fewer than 200, but a dead end here would strand the run.
    bodyEl.appendChild(el("p", "quiz-loading", "Couldn't put a question together for this level."));
    const retry = el("button", "icon-btn-accent quiz-primary", "Try again");
    retry.type = "button";
    retry.addEventListener("click", nextQuestion);
    bodyEl.appendChild(retry);
    return;
  }

  bodyEl.appendChild(el("p", "quiz-period", periodLabel(p)));

  const list = el("div", "quiz-options");
  p.options.forEach((opt, i) => {
    const picked = run.picked.includes(i);

    // A <div> with button semantics rather than a real <button>. Once graded the
    // option contains a link to Wikipedia, and an anchor nested inside a button
    // is invalid HTML that browsers and assistive tech handle inconsistently; a
    // disabled button would also drop that link out of the tab order. role,
    // tabindex and the Enter/Space handler below restore what <button> gave.
    const box = el("div", "quiz-option");
    const head = el("div", "quiz-option-head");

    const dot = el("span", "quiz-dot");
    dot.style.background = QUIZ_CATEGORY_COLORS[opt.c] || "#8a8a8e";
    head.appendChild(dot);

    // Statements are generated lower-case ("the Battle of Hastings was fought")
    // so they can be embedded in a sentence; standing alone they need a capital.
    head.appendChild(el("span", "quiz-option-text", opt.q.charAt(0).toUpperCase() + opt.q.slice(1)));

    if (run.graded) {
      if (p.answer.has(i)) box.classList.add("is-correct");
      else if (picked) box.classList.add("is-wrong");
      // The year is the whole point of the exercise, so reveal it on every
      // option once the answer is locked in -- including the ones nobody picked.
      head.appendChild(el("span", "quiz-option-year", formatYear(opt.y)));
    }
    box.appendChild(head);

    // Shown before the answer as well as after: it is what makes an unfamiliar
    // option guessable rather than a coin toss. build-quiz.mjs strips every date
    // out of it first, so it says what the thing was without saying when.
    if (opt.d) box.appendChild(el("p", "quiz-option-desc", opt.d));

    if (run.graded) {
      if (opt.w) {
        const a = el("a", "quiz-option-link", "Read on Wikipedia →");
        a.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(opt.w)}`;
        a.target = "_blank";
        a.rel = "noopener";
        box.appendChild(a);
      }
    } else {
      box.setAttribute("role", "button");
      box.tabIndex = 0;
      box.setAttribute("aria-pressed", picked ? "true" : "false");
      if (picked) box.classList.add("is-picked");
      box.classList.add("is-clickable");
      const choose = () => pickOption(i);
      box.addEventListener("click", choose);
      box.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          choose();
        }
      });
    }

    list.appendChild(box);
  });
  bodyEl.appendChild(list);

  const actions = el("div", "quiz-actions");
  const primary = el("button", "icon-btn-accent quiz-primary");
  primary.type = "button";
  if (run.graded) {
    const last = run.level === levels().length - 1;
    primary.textContent = last ? "See your result" : "Next level";
    primary.addEventListener("click", nextQuestion);
  } else {
    primary.textContent = "Check answer";
    primary.disabled = run.picked.length !== 2;
    primary.addEventListener("click", grade);
  }
  actions.appendChild(primary);

  const feedback = el("p", "quiz-feedback");
  feedback.setAttribute("role", "status");
  if (run.graded) {
    // Which two were right is already on screen -- every option now shows its
    // year and carries a tick or a cross -- so the sentence reports how the
    // guess did instead of restating them.
    const hits = run.picked.filter((i) => p.answer.has(i)).length;
    feedback.classList.add(hits === 2 ? "is-right" : "is-wrong");
    feedback.textContent =
      hits === 2
        ? "Correct — both of those fall inside the period."
        : hits === 1
        ? "Half right — only one of your two falls inside the period."
        : "Not quite — neither of your picks falls inside the period.";
  } else {
    feedback.textContent = run.picked.length === 2 ? "" : `Pick ${2 - run.picked.length} more.`;
  }
  actions.appendChild(feedback);
  bodyEl.appendChild(actions);
}

// Your title is the level whose name you earned: ten right and you finish on
// "Were You Personally There?". Nought right gets its own line rather than
// borrowing level 1's, which would read as though you had passed something.
function titleFor(score) {
  if (score <= 0) return "History Is a Thing That Happened";
  return levels()[Math.min(score, levels().length) - 1].name;
}

function renderResult() {
  const total = levels().length;
  const score = run.results.filter(Boolean).length;
  bodyEl.innerHTML = "";

  const card = el("div", "quiz-result");
  card.appendChild(el("p", "quiz-result-eyebrow", "Your rank"));
  card.appendChild(el("h3", "quiz-result-title", titleFor(score)));
  card.appendChild(el("p", "quiz-result-score", `${score} / ${total} correct`));

  const pips = el("div", "quiz-pips");
  run.results.forEach((ok, i) => {
    const pip = el("span", `quiz-pip ${ok ? "is-right" : "is-wrong"}`);
    pip.title = `Level ${i + 1}: ${levels()[i].name}`;
    pips.appendChild(pip);
  });
  card.appendChild(pips);

  card.appendChild(
    el(
      "p",
      "quiz-result-note",
      score === total
        ? "A perfect run. Level 10 pins events to a single decade and draws on articles that exist in barely a dozen languages, so this is not luck."
        : score >= 7
        ? "Strong. Past level 7 the events stop being ones most people have heard of, and the window is down to a century or less."
        : score >= 4
        ? "Respectable. The window closes from fifteen centuries to ten years as you climb, so the later ones are meant to hurt."
        : "The early levels only ask which millennium something belongs to, and it tightens fast. Another run draws a different set of events."
    )
  );

  const actions = el("div", "quiz-actions");
  const again = el("button", "icon-btn-accent quiz-primary", "Play again");
  again.type = "button";
  again.addEventListener("click", startRun);
  actions.appendChild(again);

  const explore = el("a", "quiz-secondary", "Explore these on the map →");
  explore.href = "/";
  actions.appendChild(explore);
  card.appendChild(actions);

  bodyEl.appendChild(card);
}

// ---- Flow ----

// Third pick pushes the first one out rather than being ignored -- silently
// swallowing a click reads as a broken button.
function pickOption(i) {
  const at = run.picked.indexOf(i);
  if (at >= 0) run.picked.splice(at, 1);
  else {
    run.picked.push(i);
    if (run.picked.length > 2) run.picked.shift();
  }
  renderQuestion();
}

function grade() {
  if (run.graded || run.picked.length !== 2 || !run.puzzle) return;
  run.graded = true;
  run.results.push(run.picked.every((i) => run.puzzle.answer.has(i)));
  renderQuestion();
}

function nextQuestion() {
  if (run.level >= levels().length - 1 && run.graded) {
    run.finished = true;
    renderResult();
    return;
  }
  if (run.graded) run.level++;
  run.puzzle = buildPuzzle(run.level);
  run.picked = [];
  run.graded = false;
  renderQuestion();
}

function startRun() {
  run.level = 0;
  run.results = [];
  run.picked = [];
  run.graded = false;
  run.finished = false;
  run.puzzle = buildPuzzle(0);
  renderQuestion();
}

// ---- Data ----

// Each level filters the pool by its own fame floor, so the tiers are built once
// up front rather than re-filtered per question. Ten sorted copies of a 3,000
// entry array is nothing, and it keeps the binary search in rangeOf() honest --
// it needs a years array matching the pool it is searching.
function buildTiers() {
  const sorted = QUIZ_EVENTS.slice().sort((a, b) => a.y - b.y);

  // Bounds of the whole dataset, not of a tier: buildPuzzle() keeps every window
  // inside these so a question never spans years no event could occupy. Taken
  // from the pool rather than hard-coded, so a rebuild that extends the data
  // moves them automatically.
  run.minYear = sorted[0].y;
  run.maxYear = sorted[sorted.length - 1].y;

  // Every year each statement is true of. 86 statements in the pool are true at
  // more than one year -- "the Siege of Constantinople took place" at twelve of
  // them, "the Siege of Jerusalem took place" at five. Without this, such a
  // statement gets served as a WRONG answer for a window in which it is also
  // right, and a player who knows the 1099 siege is marked wrong for saying so.
  run.yearsByStatement = new Map();
  for (const p of sorted) {
    let ys = run.yearsByStatement.get(p.q);
    if (!ys) run.yearsByStatement.set(p.q, (ys = []));
    ys.push(p.y);
  }

  run.tiers = levels().map((lv) => {
    // The pool is pre-filtered by the build; the level only sets the fame floor.
const pool = sorted.filter((p) => p.f >= lv.minFame);
    return { pool, years: pool.map((p) => p.y) };
  });
}

function loadPool() {
  if (run.loaded || run.loading) return;
  run.loading = true;
  const s = document.createElement("script");
  s.src = "/data/quiz.js?v=88ac774d";
  s.onload = () => {
    run.loading = false;
    if (typeof QUIZ_EVENTS === "undefined" || !QUIZ_EVENTS.length || !levels().length) {
      sectionEl?.setAttribute("hidden", "");
      return;
    }
    buildTiers();
    run.loaded = true;
    startRun();
  };
  s.onerror = () => {
    run.loading = false;
    bodyEl.innerHTML = `<p class="quiz-loading">Couldn't load the questions. Please reload the page.</p>`;
  };
  document.head.appendChild(s);
}

function initQuiz() {
  if (!sectionEl || !bodyEl) return;

  // Fast path: fetch as the section comes into view.
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          loadPool();
        }
      },
      { rootMargin: "300px" }
    );
    io.observe(sectionEl);
  }

  // Guaranteed path. The observer is the optimisation, not the mechanism: if its
  // callback never arrives -- and there are rendering environments where it
  // doesn't -- the section is left saying "Loading questions..." forever, which
  // is a far worse outcome than the download it was avoiding. loadPool() is
  // idempotent, so whichever path gets there first wins.
  const idle = () => (window.requestIdleCallback || ((fn) => setTimeout(fn, 1200)))(loadPool, { timeout: 4000 });
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
}

initQuiz();
