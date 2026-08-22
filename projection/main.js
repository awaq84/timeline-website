/* main.js — wiring: load assets, compose scenes, run the loop.
 *
 * Painting space is a fixed-size canvas whose aspect ratio matches the real
 * painting. Effects draw into it in those coordinates; mapper.js warps the
 * whole thing onto the painting's four corners on the wall.
 */

(() => {
  const hud = document.getElementById('hud');
  const statusEl = document.getElementById('status');

  /* ---------- Surfaces ----------------------------------------------------
   * Two paintings on the same wall, each with its own quad, saved alignment,
   * photo, analysis and scene set — all live at once. They are told apart on
   * screen by the accent colour of their alignment handles.
   *
   * The per-surface state below is swapped into the module-level `ctx`, `W`,
   * `H`, `ref`, `regions` and `Analysis` bindings before each surface draws.
   * Threading a surface argument through every effect signature would have
   * touched all thirty of them; swapping five bindings once per surface per
   * frame does the same job. */
  const SURFACE_DEFS = [
    {
      id: 'a', name: 'Seascape', accent: '#0f8',
      img: 'painting.jpg', store: 'projection.corners.v1',
      crop: { x: 0.2195, y: 0.2145, w: 0.5235, h: 0.5275 },
      dom: { stage: 'stage', overlay: 'overlay', edges: 'edges' },
    },
    {
      id: 'b', name: 'Birches', accent: '#fd0',
      img: 'painting2.jpg', store: 'projection.corners.b.v1',
      // Portrait. Read off a fraction grid overlaid on the photo: inner edge
      // of the black liner. The source HEIC needed a 90-degree rotation baked
      // in — its EXIF said one thing and its pixels another.
      crop: { x: 0.1520, y: 0.1890, w: 0.6580, h: 0.6930 },
      dom: { stage: 'stage2', overlay: 'overlay2', edges: 'edges2' },
    },
  ];

  const surfaces = [];
  let activeSurface = 0;        // which one the alignment keys act on

  /* Alignment keys always act on the active surface. This getter keeps the
   * existing `Mapper.*` call sites working now that there is one mapper per
   * painting rather than a single global one. */
  const Mapper = new Proxy({}, {
    get(_, prop) {
      const m = surfaces[activeSurface]?.mapper;
      if (!m) return undefined;
      const v = m[prop];
      return typeof v === 'function' ? v.bind(m) : v;
    },
  });

  // Module-level bindings, reassigned per surface each frame.
  let stage = null, stageCtx = null, light = null, ctx = null;
  let feather = null;
  let padX = 0, padY = 0;

  /* How far the image may extend past the painting, as a fraction of its size
   * on each side. Large enough that at full spread the two paintings' halos
   * meet on the wall between them. */
  /* How far past the painting the projection may reach, as a fraction of the
   * painting's width on each side. This is the field of play: branches, halo
   * and spill all live out here, and the homography maps the whole padded
   * target onto the wall, so raising it genuinely gives the growth more wall.
   *
   * 0.34 boxed the branches in close to the frame. 0.70 roughly doubles the
   * reach; the base render width drops to keep the pixel count from climbing
   * with the square of the margin — the margin is mostly empty, so it does not
   * need the same resolution as the painting. */
  const MARGIN = 0.70;

  // Master brightness for the projected light. Raise it on the wall until the
  // effects read without blowing out the highlights.
  let intensity = 1.0;

  /* Soft-edged mask multiplied into the light layer. Built once per resize.
   * Feathering the border is standard practice for projection onto a framed
   * object: a hard edge of light makes every millimetre of misalignment
   * visible, whereas a soft one is forgiving. */
  function buildFeather(W, H) {
    const feather = document.createElement('canvas');
    feather.width = W; feather.height = H;
    const f = feather.getContext('2d');
    const inset = Math.round(Math.min(W, H) * 0.055);
    f.fillStyle = '#fff';
    f.fillRect(inset, inset, W - inset * 2, H - inset * 2);
    // Four linear gradients ramp the border to transparent.
    const ramp = (x, y, w, h, x0, y0, x1, y1) => {
      const g = f.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(1, '#fff');
      f.fillStyle = g;
      f.fillRect(x, y, w, h);
    };
    ramp(0, 0, W, inset, 0, 0, 0, inset);                     // top
    ramp(0, H - inset, W, inset, 0, H, 0, H - inset);         // bottom
    ramp(0, 0, inset, H, 0, 0, inset, 0);                     // left
    ramp(W - inset, 0, inset, H, W, 0, W - inset, 0);         // right
    return feather;
  }

  /* The region of painting.jpg that is the canvas itself, as fractions of the
   * photo. The photo includes the gold frame and the wall; effects must sample
   * only the painted canvas or the shimmer picks up frame gilding. Nudge these
   * four numbers if the crop looks off — press T and compare against the real
   * painting. */
  const CANVAS_CROP = { x: 0.2195, y: 0.2145, w: 0.5235, h: 0.5275 };

  // Painting space, derived from the crop's aspect ratio at load.
  // This painting is portrait, roughly 0.74:1.
  let W = 700, H = 945;

  /* Sky meets water here. Effect bands must respect it — a ripple that runs
   * across the horizon destroys the illusion faster than anything else.
   *
   * 0.60 is measured from the photo, not guessed: the row luminance profile
   * shows the cloud mass ending around 0.44, a warm gold band at 0.48-0.55,
   * then a dark trough at 0.56-0.61 (the far shore) before the water brightens
   * again at 0.62. The trough is the division. Adjustable at runtime with
   * ; and ' because the right line depends on how the quad is aligned. */
  let HORIZON = +(localStorage.getItem('proj.horizon') ?? 0.60);

  let currentSurfaceId = 'a';  // which painting is mid-draw; sun lookups use it
  let ref = null;              // cropped canvas photo, or null
  let regions = [];            // named polygons, normalised 0..1
  // Boot into a running scene, not the alignment grid. A static test pattern on
  // first load reads as "nothing is working" — press T when you want to align.
  let showTest = false;
  // Preview composites the effects over the painting photo so you can judge
  // them on a laptop. MUST be off when actually projecting — otherwise you
  // project a picture of the painting onto the painting.
  let preview = true;
  const start = performance.now();

  /* ---------- Scenes ------------------------------------------------------
   * A scene is just a draw function. Keep them additive. Compose freely. */
  const region = name => regions.find(r => r.name === name);

  /* Water occupies everything below the horizon; sky everything above.
   * These arrays are mutated in place rather than reassigned, so the ~15 scenes
   * holding a reference to them pick up a horizon change with no re-plumbing. */
  const WATER = [HORIZON + 0.01, 1.0];
  const SKY = [0.0, HORIZON - 0.04];

  function setHorizon(v) {
    HORIZON = Math.min(0.92, Math.max(0.08, v));
    WATER[0] = HORIZON + 0.01;
    SKY[1] = HORIZON - 0.04;
    localStorage.setItem('proj.horizon', HORIZON.toFixed(4));
  }
  // The reflection column, as [x, y, w, h] for glitter.
  const GLITTER_PATH = [0.29, HORIZON + 0.02, 0.33, 0.42];

  /* ======================================================================
   * SCENES — the directed piece
   *
   * Named sections rather than a weight mixer. The band (0-5) chosen from the
   * music decides which scene runs; each scene is a distinct look with its own
   * job in the arc, and they cross-fade.
   *
   * Three rules from the treatment are enforced here rather than left to
   * chance:
   *   - the peak is rationed (PEAK_COOLDOWN), or it becomes wallpaper;
   *   - a peak is always followed by its comedown, never straight back to rest;
   *   - the two paintings never peak together — `lastPeakAt` is shared.
   * ==================================================================== */
  const PEAK_COOLDOWN = 150;      // seconds between peaks, across both paintings
  const PEAK_LENGTH   = 15;       // how long a peak may hold
  const FALL_LENGTH   = 22;       // the comedown after it
  let lastPeakAt = -999;          // shared, so the two never flood at once

  /* ======================================================================
   * THE SHOW
   *
   * A piece with a runtime, rather than a loop that reacts forever. The music
   * still drives everything moment to moment, but the *shape* is on a clock:
   * it opens in darkness, builds, breaks once, and returns to darkness.
   *
   * Each act names the scenes it may draw on and carries an envelope that
   * scales the whole output — so the quiet passages are quiet because the
   * piece is early, not because the room happens to be quiet just then.
   *
   * The two paintings take turns leading: on odd acts they swap, so attention
   * moves across the wall over the course of the piece.
   * ==================================================================== */
  const SHOW = {
    duration: 5 * 60,          // seconds
    /* The piece runs by default. Leaving this null fell back to the old
     * free-running loop, which meant everything built here was invisible
     * unless you happened to press S — the show is the work, not an option. */
    startedAt: 0,
    loop: true,                // restart when it ends, for an unattended wall
    acts: [
      { name: 'Overture', to: 0.10, env: 0.42, lead: 'a',
        scenes: ['Nocturne', 'Deep Shade', 'Becalmed', 'Still Air', 'First Light', 'Dawn Filter'] },
      { name: 'Waking', to: 0.28, env: 0.62, lead: 'b',
        scenes: ['Cascade', 'Breathe', 'Breathing', 'Breathing Canopy', 'Corona',
                 'Raking', 'Raking Trunks', 'Low Sun', 'Floor Pool'] },
      { name: 'Weather', to: 0.52, env: 0.80, lead: 'a',
        scenes: ['Glitter Path', 'Swell', 'Shafts', 'Dapple', 'Caustics', 'Ripple',
                 'Damp Light', 'Mist', 'Ember', 'Green Rise', 'Colour Bleed'] },
      { name: 'Unmaking', to: 0.68, env: 0.90, lead: 'b',
        scenes: ['Erosion', 'Dissolve', 'Isolate', 'Chop', 'Squall', 'Wind',
                 'Cold Front', 'Full Palette', 'Burnthrough', 'Sweep'] },
      { name: 'Break', to: 0.80, env: 1.00, lead: 'a', climax: true,
        scenes: ['The Break', 'Sunbreak', 'Growing', 'Gold Turn'] },
      { name: 'Close', to: 1.00, env: 0.42, lead: 'b',
        scenes: ['Afterglow', 'Settling', 'Nocturne', 'Deep Shade', 'Becalmed', 'Still Air'] },
    ],
  };

  function showState(t) {
    if (SHOW.startedAt === null) return null;
    const p = (t - SHOW.startedAt) / SHOW.duration;
    if (p >= 1) {
      // Loop back to the top: an installation should begin again rather than
      // go dark forever. Press S to stop it deliberately.
      if (SHOW.loop) { SHOW.startedAt = t; return showState(t); }
      SHOW.startedAt = null;
      return null;
    }
    let from = 0;
    for (const act of SHOW.acts) {
      if (p < act.to) {
        const local = (p - from) / Math.max(0.001, act.to - from);
        return { act, p, local, from };
      }
      from = act.to;
    }
    return { act: SHOW.acts[SHOW.acts.length - 1], p, local: 1, from };
  }

  /* Envelope for the whole piece. Fades up out of black at the very start and
   * down into it at the very end, so the room sees it begin and end rather
   * than walking in on something already running. */
  function showEnvelope(st) {
    if (!st) return 1;
    const open = Math.min(1, st.p / 0.035);          // ~17s fade in
    const shut = Math.min(1, (1 - st.p) / 0.06);     // ~29s fade out
    // Ease across the act so its own level arrives rather than switching.
    return st.act.env * open * shut;
  }

  /* ---------- Dialogue between the paintings ------------------------------
   * Two paintings on a wall should be one piece, not two displays. This is the
   * channel between them: when one flares it pushes the other down, and light
   * leaving one edge arrives at the other a moment later, so attention crosses
   * the gap instead of splitting.
   */
  const bus = {
    level: { a: 0, b: 0 },        // each surface's current output
    handoff: { at: -99, to: null },
  };

  function otherId(id) { return id === 'a' ? 'b' : 'a'; }

  // How much this painting should yield to the other right now. A surface that
  // is quiet while its partner blazes reads as deference — the pair breathing
  // in opposition rather than both shouting.
  function deference(id) {
    const them = bus.level[otherId(id)];
    return Math.max(0.25, 1 - them * 0.75);
  }

  /* Light crossing the gap. When one painting throws a streak off the edge
   * facing the other, the other answers a beat later from its facing edge —
   * the same gesture continuing across the wall. */
  function offerHandoff(fromId, t) {
    if (t - bus.handoff.at < 6) return;
    bus.handoff = { at: t, to: otherId(fromId) };
  }
  function claimHandoff(id, t) {
    if (bus.handoff.to !== id) return false;
    if (t - bus.handoff.at < 0.55 || t - bus.handoff.at > 1.1) return false;
    bus.handoff.to = null;
    return true;
  }

  /* Choose the next scene from a pool. Scenes declare the bands they suit; the
   * director rotates among those eligible so a track holding one intensity
   * still moves through different looks. */
  const SCENE_DWELL = 26;         // seconds before rotating within a band

  function pickScene(sd, pool, band, t, act) {
    const age = t - sd.sceneStart;
    const cur = sd.scene;

    /* During a show the act decides what is permissible; the music only
     * chooses among what the act allows. That is the difference between a
     * piece and a reactive loop — the arc is not up for negotiation. */
    if (act) {
      const allowed = pool.filter(x => act.scenes.includes(x.name));
      if (allowed.length) {
        if (act.climax) {
          const pk = allowed.find(x => x.peak);
          if (pk) {
            // Hold the peak for as long as the act lasts. Timing out mid-act
            // handed over to the comedown and left the climax with no climax.
            return pk;
            if (cur !== pk) lastPeakAt = t;
          }
        }
        if (cur && allowed.includes(cur) && age < SCENE_DWELL) return cur;
        const i = allowed.indexOf(cur);
        return allowed[(i + 1) % allowed.length];
      }
    }

    // A peak runs its course and always hands to its comedown. Nothing cuts in.
    if (cur && cur.peak) {
      if (age < PEAK_LENGTH) return cur;
      return pool.find(x => x.fall) || cur;
    }
    if (cur && cur.fall && age < FALL_LENGTH) return cur;

    // Earn a peak: top-band energy, and neither painting peaked recently.
    if (band >= 4 && t - lastPeakAt > PEAK_COOLDOWN && age > 6) {
      const pk = pool.find(x => x.peak);
      if (pk) { lastPeakAt = t; return pk; }
    }

    const eligible = pool.filter(x => !x.peak && !x.fall && x.bands.includes(band));
    // Never return nothing: an empty band would leave the wall blank.
    if (!eligible.length) return cur || pool[0];
    if (cur && eligible.includes(cur) && age < SCENE_DWELL) return cur;

    // Rotate rather than picking at random, so every scene gets shown.
    const i = eligible.indexOf(cur);
    return eligible[(i + 1) % eligible.length];
  }

  /* Per-painting scene tables. Same six slots, different vocabulary — the
   * seascape is one light source dying, the wood is light arriving in pieces.
   * `g` is the music's glow, 0..1. `p` is progress through the scene, 0..1. */
  /* ======================================================================
   * SCENE POOL — twenty per painting
   *
   * Each scene declares the energy bands it belongs to. The director picks
   * among the scenes eligible for the current band and rotates through them,
   * so a track that sits at one intensity still develops instead of repeating.
   *
   * Families, per the brief: LIGHT (how the canvas is lit at all), SUNLIGHT
   * (the source throwing shafts), WATER (the painting's own liquid motion),
   * COLOUR (a pigment picked out, or the canvas held dark), and for the wood,
   * GROWTH. Band 5 scenes are peaks and are rationed by the director.
   * ==================================================================== */

  /* ---------- Band bindings ------------------------------------------------
   * Every scene reacts to the spectrum, not just to overall loudness.
   *
   * Writing the bindings into fifty draw functions by hand would be
   * inconsistent and would drift the moment a scene was edited. Instead they
   * live here, keyed by effect, and are applied at the call site: each effect
   * is modulated by the band that physically belongs to it. Sparkle is a
   * high-frequency event, so glitter tracks treble; a swell is low, so shimmer
   * and bloom track bass; movement sits in the middle, so drift and caustics
   * track mids. A scene inherits sensible behaviour without stating it.
   *
   *   band   which spectral band drives it
   *   fields which options are scaled
   *   depth  0 = ignores music, 1 = fully driven by it
   */
  const BIND = {
    glitter:  { band: 'treble', fields: ['intensity', 'count', 'speed'], depth: 0.75 },
    stars:    { band: 'treble', fields: ['intensity', 'count'],          depth: 0.55 },
    leaves:   { band: 'treble', fields: ['intensity', 'progress'],       depth: 0.45 },
    accent:   { band: 'treble', fields: ['amount'],                      depth: 0.60 },

    shimmer:  { band: 'bass',   fields: ['amp', 'strength'],             depth: 0.70 },
    bloom:    { band: 'bass',   fields: ['amount', 'radius'],            depth: 0.55 },
    grow:     { band: 'bass',   fields: ['intensity'],                   depth: 0.50 },
    rain:     { band: 'bass',   fields: ['count', 'speed', 'alpha'],     depth: 0.60 },

    caustics: { band: 'mid',    fields: ['strength', 'speed'],           depth: 0.70 },
    drift:    { band: 'mid',    fields: ['speed', 'strength'],           depth: 0.60 },
    colourFlow:{band: 'mid',    fields: ['amount', 'speed', 'intensity'],depth: 0.60 },
    dapple:   { band: 'mid',    fields: ['count', 'intensity', 'speed'], depth: 0.60 },
    bleed:    { band: 'mid',    fields: ['strength'],                    depth: 0.55 },

    godRays:  { band: 'level',  fields: ['intensity', 'count'],          depth: 0.65 },
    radiance: { band: 'level',  fields: ['reach', 'intensity'],          depth: 0.45 },
    sweep:    { band: 'level',  fields: ['intensity'],                   depth: 0.50 },
    regionField:{band:'mid',    fields: ['amount', 'erode', 'dissolve'], depth: 0.55 },
  };

  /* A facade over Effects that applies the binding. Scenes call FX.<effect>
   * and get band-reactive behaviour for free; anything calling Effects direct
   * is left alone (the always-on layers tune themselves). */
  const FX = new Proxy({}, {
    get(_, name) {
      const fn = Effects[name];
      if (typeof fn !== 'function') return fn;
      const b = BIND[name];
      if (!b) return fn;
      return (ctx, t, env, opts = {}) => {
        const a = env.audio || {};
        const v = Math.max(0, Math.min(1, a[b.band] || 0));
        // 0.35x when the band is silent, up to ~1.65x when it is peaking.
        const k = (1 - b.depth) + b.depth * (0.35 + 1.3 * v);
        const scaled = { ...opts };
        for (const f of b.fields) {
          if (typeof scaled[f] === 'number') scaled[f] = scaled[f] * k;
        }
        return fn(ctx, t, env, scaled);
      };
    },
  });

  const SEA = [
    // ---- LIGHT ------------------------------------------------------------
    { name: 'Becalmed', bands: [0, 1], draw(t, env, g) {
        FX.radiance(ctx, t, env, { reach: 0.20 + g * 0.18, intensity: 0.32, warm: 0.5 });
        FX.drift(ctx, t, env, { band: SKY, speed: 6, strength: 0.14, turbulence: 0.5 });
      } },
    { name: 'First Light', bands: [0, 1], draw(t, env, g, p) {
        // The sun coming up out of nothing over the whole scene.
        FX.radiance(ctx, t, env, { reach: 0.08 + p * 0.5 + g * 0.2, intensity: 0.36, warm: 0.85 });
        FX.bloom(ctx, t, env, { amount: 0.04 + p * 0.14, radius: 30 + p * 40 });
      } },
    { name: 'Nocturne', bands: [0, 1], draw(t, env, g) {
        // Held dark on purpose: only the sky and the sun's last ember.
        FX.radiance(ctx, t, env, { reach: 0.14, intensity: 0.20, warm: 0.3 });
        FX.stars(ctx, t, env, { count: 70, intensity: 0.4 + g * 0.3 });
        FX.bloom(ctx, t, env, { amount: 0.10, radius: 44 });
      } },
    { name: 'Breathing', bands: [0, 1, 2], draw(t, env, g) {
        const b = 0.5 + 0.5 * Math.sin(t * 0.22);
        FX.radiance(ctx, t, env, { reach: 0.22 + b * 0.24 + g * 0.2, intensity: 0.34, warm: 0.55 });
        FX.colourFlow(ctx, t, env, { amount: 0.22, speed: 0.12, intensity: 0.14, depth: 1.0 });
      } },
    { name: 'Raking', bands: [1, 2], draw(t, env, g) {
        FX.sweep(ctx, t, env);
        FX.radiance(ctx, t, env, { reach: 0.25 + g * 0.2, intensity: 0.28, warm: 0.5 });
      } },

    // ---- SUNLIGHT ---------------------------------------------------------
    { name: 'Shafts', bands: [2, 3], draw(t, env, g) {
        FX.radiance(ctx, t, env, { reach: 0.4 + g * 0.3, intensity: 0.4, warm: 0.6 });
        FX.godRays(ctx, t, env, { origin: srcUV(), count: 8, intensity: 0.08 + g * 0.28 });
        FX.bloom(ctx, t, env, { amount: 0.06 + g * 0.16, radius: 32 });
      } },
    { name: 'Corona', bands: [1, 2], draw(t, env, g) {
        // Halo only — no shafts. The sun swelling in place.
        FX.radiance(ctx, t, env, { reach: 0.28 + g * 0.3, intensity: 0.44, warm: 0.9 });
        FX.bloom(ctx, t, env, { amount: 0.14 + g * 0.3, radius: 50 + g * 50 });
      } },
    { name: 'Burnthrough', bands: [3, 4], draw(t, env, g) {
        // Shafts punching through moving cloud.
        FX.drift(ctx, t, env, { band: SKY, speed: 26, strength: 0.24, turbulence: 1.6 });
        FX.godRays(ctx, t, env, { origin: srcUV(), count: 11, intensity: 0.14 + g * 0.4 + hit * 0.3 });
        FX.radiance(ctx, t, env, { reach: 0.45 + g * 0.4, intensity: 0.42, warm: 0.6 });
      } },
    { name: 'Last Ray', bands: [1, 2], draw(t, env, g) {
        FX.godRays(ctx, t, env, { origin: srcUV(), count: 2, spread: 0.22, intensity: 0.10 + g * 0.3 });
        FX.radiance(ctx, t, env, { reach: 0.2, intensity: 0.28, warm: 0.8 });
      } },
    { name: 'The Break', bands: [5], peak: true, draw(t, env, g, p) {
        /* Restrained on purpose. Stacked at full these four clipped the canvas
         * to flat white — the painting disappeared and the climax read as a
         * blank rectangle. A peak has to be the picture at its most intense,
         * not the picture replaced by light. */
        const e = Math.sin(Math.PI * Math.min(1, p));
        FX.radiance(ctx, t, env, { reach: 0.45 + e * 0.7, intensity: 0.30 + e * 0.26, warm: 0.7 });
        FX.godRays(ctx, t, env, { origin: srcUV(), count: 10 + Math.round(e * 6), intensity: 0.12 + e * 0.34 });
        FX.bloom(ctx, t, env, { amount: 0.08 + e * 0.20, radius: 40 + e * 60 });
        FX.glitter(ctx, t, env, { region: GLITTER_PATH, count: Math.round(80 + e * 180), intensity: 0.4 + e * 0.4 });
      } },

    // ---- WATER ------------------------------------------------------------
    { name: 'Glitter Path', bands: [2, 3], draw(t, env, g) {
        FX.radiance(ctx, t, env, { reach: 0.4 + g * 0.3, intensity: 0.38, warm: 0.55 });
        FX.glitter(ctx, t, env, {
          region: GLITTER_PATH, count: Math.round(60 + g * 190),
          intensity: 0.4 + g * 0.5, speed: 1.6 + g * 2.2 });
      } },
    { name: 'Swell', bands: [1, 2], draw(t, env, g) {
        FX.shimmer(ctx, t, env, { band: WATER, amp: 4 + g * 8, speed: 0.7, strength: 0.22 + g * 0.14 });
        FX.radiance(ctx, t, env, { reach: 0.3, intensity: 0.3, warm: 0.5 });
      } },
    { name: 'Chop', bands: [3, 4], draw(t, env, g) {
        const a = env.audio;
        FX.shimmer(ctx, t, env, {
          band: WATER, amp: 8 + a.bass * 16 + hit * 12, speed: 2.4 + a.level * 2, strength: 0.24 });
        FX.glitter(ctx, t, env, { region: GLITTER_PATH, count: 60, intensity: 0.3 + hit * 0.5, speed: 3.2 });
      } },
    { name: 'Caustics', bands: [2, 3], draw(t, env, g) {
        FX.caustics(ctx, t, env, { band: WATER, strength: 0.16 + g * 0.26, speed: 0.8 + g * 1.8 });
        FX.radiance(ctx, t, env, { reach: 0.32, intensity: 0.32, warm: 0.5 });
      } },
    { name: 'Squall', bands: [3, 4], draw(t, env, g) {
        const a = env.audio;
        FX.drift(ctx, t, env, { band: SKY, speed: 32, strength: 0.26, turbulence: 1.9 });
        FX.rain(ctx, t, env, { count: Math.round(80 + g * 220), speed: 900 + a.bass * 700, alpha: 0.2 + g * 0.3 });
        FX.shimmer(ctx, t, env, { band: WATER, amp: 6 + hit * 12, speed: 1.6, strength: 0.18 });
        FX.lightning(ctx, t, env, { timer: false, trigger: a.onset && a.bass > 0.8, intensity: 0.42 });
      } },

    // ---- COLOUR -----------------------------------------------------------
    { name: 'Ember', bands: [1, 2], draw(t, env, g) {
        FX.accent(ctx, t, env, { tint: warmestHue(), amount: 0.3 + g * 0.4, tolerance: 100 });
        FX.radiance(ctx, t, env, { reach: 0.26, intensity: 0.3, warm: 0.9 });
      } },
    { name: 'Cold Front', bands: [2, 3], draw(t, env, g) {
        FX.accent(ctx, t, env, { tint: coolestHue(), amount: 0.3 + g * 0.4, tolerance: 100 });
        FX.drift(ctx, t, env, { band: SKY, speed: 22, strength: 0.22, turbulence: 1.4 });
      } },
    { name: 'Colour Bleed', bands: [2, 3], draw(t, env, g, p) {
        FX.bleed(ctx, t, env, {
          progress: p, seed: bleedSeed, tint: accentHue(t), strength: 0.35 + g * 0.35 });
        FX.radiance(ctx, t, env, { reach: 0.3, intensity: 0.3, warm: 0.5 });
      } },
    { name: 'Full Palette', bands: [3, 4], draw(t, env, g) {
        // Each pigment lit in turn, fast enough to read as one moving colour.
        FX.accent(ctx, t, env, { tint: accentHue(t * 6), amount: 0.35 + g * 0.4, tolerance: 85 });
        FX.colourFlow(ctx, t, env, { amount: 0.55, speed: 0.5, intensity: 0.24, depth: 1.3 });
      } },
    // ---- TRANSFORMATION — the verbs the surface should perform -------------
    { name: 'Cascade', bands: [1, 2], draw(t, env, g) {
        // Regions light one after another, top to bottom. The painting
        // assembles itself in layers rather than coming up all at once.
        const n = Analysis.ready ? Analysis.regions.length : 0;
        for (let i = 0; i < n; i++) {
          const phase = (t * 0.16 - i * 0.22) % 1.6;
          const lit = phase > 0 && phase < 1 ? Math.sin(Math.PI * phase) : 0;
          if (lit > 0.01) {
            FX.regionField(ctx, t, env, { index: i, amount: (0.25 + g * 0.4) * lit });
          }
        }
      } },
    { name: 'Erosion', bands: [2, 3], draw(t, env, g, p) {
        // One region is eaten away from its edges while its neighbours hold.
        const n = Analysis.ready ? Analysis.regions.length : 1;
        const which = Math.floor(t / 9) % n;
        const cycle = (t % 9) / 9;
        for (let i = 0; i < n; i++) {
          FX.regionField(ctx, t, env, {
            index: i,
            amount: 0.28 + g * 0.35,
            erode: i === which ? Math.sin(Math.PI * cycle) * 0.9 : 0,
          });
        }
      } },
    { name: 'Dissolve', bands: [2, 3], draw(t, env, g, p) {
        // The paint breaks into grain and thins away, region by region.
        const n = Analysis.ready ? Analysis.regions.length : 1;
        const which = Math.floor(t / 11) % n;
        const cycle = (t % 11) / 11;
        for (let i = 0; i < n; i++) {
          FX.regionField(ctx, t, env, {
            index: i,
            amount: 0.30 + g * 0.35,
            dissolve: i === which ? Math.sin(Math.PI * cycle) * 0.85 : 0,
          });
        }
      } },
    { name: 'Breathe', bands: [1, 2], draw(t, env, g) {
        // Each region swells and subsides on its own clock — the surface
        // breathing rather than pulsing as one.
        const n = Analysis.ready ? Analysis.regions.length : 1;
        for (let i = 0; i < n; i++) {
          const b = 0.5 + 0.5 * Math.sin(t * (0.22 + i * 0.055) + i * 1.7);
          FX.regionField(ctx, t, env, { index: i, amount: (0.18 + g * 0.4) * (0.35 + b) });
        }
      } },
    { name: 'Isolate', bands: [2, 3], draw(t, env, g) {
        // Everything dark but one part. The strongest thing mapping can do and
        // the one that most obviously is not a light show.
        const n = Analysis.ready ? Analysis.regions.length : 1;
        const which = Math.floor(t / 7) % n;
        FX.regionField(ctx, t, env, { index: which, amount: 0.5 + g * 0.5, boost: 1.5 });
      } },
    { name: 'Afterglow', bands: [5], fall: true, draw(t, env, g, p) {
        const k = 1 - p;
        FX.radiance(ctx, t, env, { reach: 0.15 + k * 0.5, intensity: 0.25 + k * 0.3, warm: 0.7 });
        FX.glitter(ctx, t, env, {
          region: GLITTER_PATH, count: Math.round(40 + 90 * k), intensity: 0.3 + 0.4 * Math.sqrt(k) });
      } },
  ];

  const WOOD = [
    // ---- LIGHT ------------------------------------------------------------
    { name: 'Still Air', bands: [0, 1], draw(t, env, g) {
        FX.radiance(ctx, t, env, { reach: 0.18 + g * 0.16, intensity: 0.30, warm: 0.35 });
        FX.godRays(ctx, t, env, { origin: srcUV(), count: 3, spread: 0.28, intensity: 0.06 + g * 0.08 });
      } },
    { name: 'Dawn Filter', bands: [0, 1], draw(t, env, g, p) {
        FX.radiance(ctx, t, env, { reach: 0.08 + p * 0.45 + g * 0.2, intensity: 0.34, warm: 0.5 });
        FX.leaves(ctx, t, env, { region: CANOPY_R, max: 60, progress: p * 0.5, intensity: 0.3 });
      } },
    { name: 'Deep Shade', bands: [0, 1], draw(t, env, g) {
        // Held dark. Only the gap in the canopy is lit at all.
        FX.radiance(ctx, t, env, { reach: 0.10, intensity: 0.22, warm: 0.3 });
        FX.bloom(ctx, t, env, { amount: 0.08, radius: 40 });
      } },
    { name: 'Breathing Canopy', bands: [0, 1, 2], draw(t, env, g) {
        const b = 0.5 + 0.5 * Math.sin(t * 0.2);
        FX.radiance(ctx, t, env, { reach: 0.2 + b * 0.22 + g * 0.2, intensity: 0.32, warm: 0.35 });
        FX.leaves(ctx, t, env, { region: CANOPY_R, max: 70, progress: 0.3 + b * 0.3 });
      } },
    { name: 'Raking Trunks', bands: [1, 2], draw(t, env, g) {
        FX.sweep(ctx, t, env);
        FX.radiance(ctx, t, env, { reach: 0.24 + g * 0.2, intensity: 0.28, warm: 0.35 });
      } },

    // ---- SUNLIGHT ---------------------------------------------------------
    { name: 'Shafts', bands: [2, 3], draw(t, env, g) {
        FX.radiance(ctx, t, env, { reach: 0.38 + g * 0.3, intensity: 0.38, warm: 0.4 });
        FX.godRays(ctx, t, env, { origin: srcUV(), count: 8, spread: 0.45, intensity: 0.09 + g * 0.28 });
      } },
    { name: 'Dapple', bands: [2, 3], draw(t, env, g) {
        FX.dapple(ctx, t, env, { count: 10 + Math.round(g * 14), speed: 0.13 + g * 0.2, intensity: 0.22 + g * 0.24 });
        FX.radiance(ctx, t, env, { reach: 0.34, intensity: 0.34, warm: 0.4 });
      } },
    { name: 'Sweep', bands: [3, 4], draw(t, env, g) {
        // The gap opens and closes; shafts swing across the stand.
        FX.godRays(ctx, t, env, {
          origin: [0.3 + 0.4 * (0.5 + 0.5 * Math.sin(t * 0.18)), -0.15],
          count: 10, spread: 0.5, intensity: 0.12 + g * 0.36 + hit * 0.28 });
        FX.radiance(ctx, t, env, { reach: 0.42 + g * 0.35, intensity: 0.4, warm: 0.4 });
      } },
    { name: 'Low Sun', bands: [1, 2], draw(t, env, g) {
        FX.godRays(ctx, t, env, { origin: [0.05, 0.25], count: 5, spread: 0.3, intensity: 0.1 + g * 0.3 });
        FX.radiance(ctx, t, env, { reach: 0.24, intensity: 0.3, warm: 0.7 });
      } },
    { name: 'Sunbreak', bands: [5], peak: true, draw(t, env, g, p) {
        // Same restraint as The Break — see the note there.
        const e = Math.sin(Math.PI * Math.min(1, p));
        FX.radiance(ctx, t, env, { reach: 0.45 + e * 0.65, intensity: 0.30 + e * 0.24, warm: 0.55 });
        FX.godRays(ctx, t, env, { origin: srcUV(), count: 12 + Math.round(e * 6), spread: 0.42, intensity: 0.14 + e * 0.32 });
        FX.bloom(ctx, t, env, { amount: 0.08 + e * 0.18, radius: 36 + e * 52 });
        FX.leaves(ctx, t, env, { region: CANOPY_R, max: 130, progress: 1 });
      } },

    // ---- WATER / FLOOR ----------------------------------------------------
    { name: 'Floor Pool', bands: [1, 2], draw(t, env, g) {
        FX.caustics(ctx, t, env, { band: B_GROUND, strength: 0.16 + g * 0.22, speed: 0.5 });
        FX.radiance(ctx, t, env, { reach: 0.3, intensity: 0.3, warm: 0.35 });
      } },
    { name: 'Ripple', bands: [2, 3], draw(t, env, g) {
        const a = env.audio;
        FX.shimmer(ctx, t, env, {
          band: B_GROUND, amp: 3 + a.bass * 10 + hit * 8, speed: 0.6 + a.level, strength: 0.2 });
        FX.radiance(ctx, t, env, { reach: 0.34, intensity: 0.32, warm: 0.35 });
      } },
    { name: 'Damp Light', bands: [1, 2], draw(t, env, g) {
        FX.caustics(ctx, t, env, { band: B_GROUND, strength: 0.2, speed: 0.35 });
        FX.glitter(ctx, t, env, {
          region: [0.1, 0.72, 0.8, 0.26], count: Math.round(20 + g * 70),
          intensity: 0.25 + g * 0.35, uniform: true, tint: [220, 255, 210] });
      } },
    { name: 'Wind', bands: [3, 4], draw(t, env, g) {
        const a = env.audio;
        FX.shimmer(ctx, t, env, {
          band: B_CANOPY, amp: 6 + a.mid * 16 + hit * 10, speed: 1.8 + a.level * 2, strength: 0.2 });
        FX.colourFlow(ctx, t, env, { amount: 0.55 + g * 0.3, speed: 0.5, intensity: 0.24, depth: 1.35 });
        FX.leaves(ctx, t, env, { region: CANOPY_R, max: 110, progress: 0.8 + g * 0.2 });
      } },
    { name: 'Mist', bands: [1, 2], draw(t, env, g) {
        FX.drift(ctx, t, env, { band: [0.45, 0.95], speed: 5, strength: 0.16, turbulence: 0.4 });
        FX.radiance(ctx, t, env, { reach: 0.28, intensity: 0.3, warm: 0.3 });
      } },

    // ---- COLOUR & GROWTH --------------------------------------------------
    { name: 'Green Rise', bands: [1, 2], draw(t, env, g) {
        FX.accent(ctx, t, env, { tint: coolestHue(), amount: 0.3 + g * 0.4, tolerance: 100 });
        FX.colourFlow(ctx, t, env, { amount: 0.3, speed: 0.2, intensity: 0.16, depth: 1.1 });
      } },
    { name: 'Gold Turn', bands: [2, 3], draw(t, env, g) {
        FX.accent(ctx, t, env, { tint: warmestHue(), amount: 0.34 + g * 0.4, tolerance: 100 });
        FX.leaves(ctx, t, env, { region: CANOPY_R, max: 100, progress: 0.7, tint: [255, 220, 130] });
      } },
    { name: 'Colour Bleed', bands: [2, 3], draw(t, env, g, p) {
        FX.bleed(ctx, t, env, { progress: p, seed: bleedSeed, tint: accentHue(t), strength: 0.32 + g * 0.35 });
        FX.radiance(ctx, t, env, { reach: 0.3, intensity: 0.3, warm: 0.35 });
      } },
    { name: 'Growing', bands: [3, 4], draw(t, env, g, p) {
        // Light climbing the trunks — the trees appear to grow.
        FX.grow(ctx, t, env, { progress: Math.min(1, p * 1.3), intensity: 0.45 + g * 0.5 });
        FX.leaves(ctx, t, env, { region: CANOPY_R, max: 120, progress: Math.min(1, p * 1.6) });
        FX.radiance(ctx, t, env, { reach: 0.35 + g * 0.3, intensity: 0.36, warm: 0.4 });
      } },
    // ---- TRANSFORMATION — the verbs the surface should perform -------------
    { name: 'Cascade', bands: [1, 2], draw(t, env, g) {
        // Regions light one after another, top to bottom. The painting
        // assembles itself in layers rather than coming up all at once.
        const n = Analysis.ready ? Analysis.regions.length : 0;
        for (let i = 0; i < n; i++) {
          const phase = (t * 0.16 - i * 0.22) % 1.6;
          const lit = phase > 0 && phase < 1 ? Math.sin(Math.PI * phase) : 0;
          if (lit > 0.01) {
            FX.regionField(ctx, t, env, { index: i, amount: (0.25 + g * 0.4) * lit });
          }
        }
      } },
    { name: 'Erosion', bands: [2, 3], draw(t, env, g, p) {
        // One region is eaten away from its edges while its neighbours hold.
        const n = Analysis.ready ? Analysis.regions.length : 1;
        const which = Math.floor(t / 9) % n;
        const cycle = (t % 9) / 9;
        for (let i = 0; i < n; i++) {
          FX.regionField(ctx, t, env, {
            index: i,
            amount: 0.28 + g * 0.35,
            erode: i === which ? Math.sin(Math.PI * cycle) * 0.9 : 0,
          });
        }
      } },
    { name: 'Dissolve', bands: [2, 3], draw(t, env, g, p) {
        // The paint breaks into grain and thins away, region by region.
        const n = Analysis.ready ? Analysis.regions.length : 1;
        const which = Math.floor(t / 11) % n;
        const cycle = (t % 11) / 11;
        for (let i = 0; i < n; i++) {
          FX.regionField(ctx, t, env, {
            index: i,
            amount: 0.30 + g * 0.35,
            dissolve: i === which ? Math.sin(Math.PI * cycle) * 0.85 : 0,
          });
        }
      } },
    { name: 'Breathe', bands: [1, 2], draw(t, env, g) {
        // Each region swells and subsides on its own clock — the surface
        // breathing rather than pulsing as one.
        const n = Analysis.ready ? Analysis.regions.length : 1;
        for (let i = 0; i < n; i++) {
          const b = 0.5 + 0.5 * Math.sin(t * (0.22 + i * 0.055) + i * 1.7);
          FX.regionField(ctx, t, env, { index: i, amount: (0.18 + g * 0.4) * (0.35 + b) });
        }
      } },
    { name: 'Isolate', bands: [2, 3], draw(t, env, g) {
        // Everything dark but one part. The strongest thing mapping can do and
        // the one that most obviously is not a light show.
        const n = Analysis.ready ? Analysis.regions.length : 1;
        const which = Math.floor(t / 7) % n;
        FX.regionField(ctx, t, env, { index: which, amount: 0.5 + g * 0.5, boost: 1.5 });
      } },
    { name: 'Settling', bands: [5], fall: true, draw(t, env, g, p) {
        const k = 1 - p;
        FX.radiance(ctx, t, env, { reach: 0.12 + k * 0.45, intensity: 0.24 + k * 0.28, warm: 0.35 });
        FX.leaves(ctx, t, env, { region: CANOPY_R, max: 110, progress: k });
        FX.godRays(ctx, t, env, { origin: srcUV(), count: 4, spread: 0.35, intensity: 0.04 + k * 0.2 });
      } },
  ];

  const CANOPY_R = [0.05, 0.0, 0.9, 0.42];

  /* The signature layer. Always on, under every scene, at a level that never
   * competes with what the music is doing — it is what the painting is when
   * nothing else is happening. Waves for the sea, fireflies for the wood. */
  const BASE = {
    a(t, env, g) {
      Effects.waves(ctx, t, env, {
        band: WATER, amp: 3 + g * 5, speed: 0.4 + g * 0.35,
        strength: 0.13 + g * 0.10, wavelength: 0.24,
      });
    },
    b(t, env, g) {
      Effects.fireflies(ctx, t, env, {
        region: [0.06, 0.30, 0.88, 0.62],
        count: 16 + Math.round(g * 12),
        intensity: 0.34 + g * 0.28,
        speed: 0.8 + g * 0.5,
      });
    },
  };

  // Warmest and coolest pigments in this painting, for the colour scenes.
  function warmestHue() {
    const p = Analysis.ready ? Analysis.palette : null;
    if (!p || !p.length) return [255, 210, 120];
    return [...p].sort((a, b) => (b.rgb[0] - b.rgb[2]) - (a.rgb[0] - a.rgb[2]))[0].rgb;
  }
  function coolestHue() {
    const p = Analysis.ready ? Analysis.palette : null;
    if (!p || !p.length) return [140, 210, 255];
    return [...p].sort((a, b) => (b.rgb[2] - b.rgb[0]) - (a.rgb[2] - a.rgb[0]))[0].rgb;
  }

  // The accented colour rotates slowly through the painting's own palette, so
  // a different pigment is picked out each time rather than one fixed hue.
  function accentHue() {
    const pal = Analysis.ready ? Analysis.palette : null;
    if (!pal || !pal.length) return [255, 220, 120];
    // Indexed by beats, so the colour changes on the music rather than on a clock.
    return pal[accentIndex % Math.min(4, pal.length)].rgb;
  }

  /* Where the light in each painting comes from.
   *
   * The detector finds the brightest coherent blob, which on the seascape is
   * ambiguous — the horizon band and the water's reflection are both bright,
   * and it settled on neither of them being the sun. These are measured off
   * the paintings themselves: the seascape's sun is the orange mass in the
   * upper-left sky, the wood's is the gap in the canopy. Everything radial —
   * rays, halo, the lit edge of the boat — originates here. */
  const SUN = {
    a: JSON.parse(localStorage.getItem('proj.sun.a') || 'null') || { u: 0.40, v: 0.28 },
    b: JSON.parse(localStorage.getItem('proj.sun.b') || 'null') || { u: 0.50, v: 0.10 },
  };

  function setSun(id, u, v) {
    SUN[id] = { u, v };
    localStorage.setItem('proj.sun.' + id, JSON.stringify(SUN[id]));
    const s = surfaces.find(x => x.id === id);
    if (s && s.analysis) s.analysis.setLightSource(u, v);
    return SUN[id];
  }

  function srcUV() {
    const s = SUN[currentSurfaceId] || SUN.a;
    if (s) return [s.u, s.v];
    const ls = Analysis.ready && Analysis.lightSource;
    return ls ? [ls.u, ls.v] : [0.45, 0.3];
  }

  /* ======================================================================
   * THE LIVE COMPOSITION
   *
   * One continuous piece, not a carousel. Every layer is always available;
   * the music moves the balance between them, and the weights interpolate so
   * nothing ever cuts. Three things are always true:
   *
   *   - Relight is the floor. Light and shadow across the impasto is what
   *     makes the painting sculptural, so it never switches off — the music
   *     changes how hard it rakes and how fast the sun travels.
   *   - Colour comes from the painting. Washes and particles are tinted from
   *     the extracted palette, so the piece deepens its own hues rather than
   *     having someone else's pushed onto it.
   *   - A slow movement phase (~3 min) shifts emphasis even when the music
   *     holds steady, so a constant-energy track still develops.
   * ==================================================================== */
  /* MOVEMENTS — the piece has named sections with distinct character, not one
   * undifferentiated blend. Running every layer at once averages into mush;
   * a movement commits to a few layers and drops the rest, which is what
   * gives a section an identity you can recognise.
   *
   * Each entry is a weight profile. The active movement is chosen by energy,
   * held for a minimum time, and crossfaded over several seconds — so the
   * transition is a slow dissolve between two coherent looks rather than
   * every layer drifting independently. */
  const MOVEMENTS = [
    // Deliberately almost empty. Quiet music should mean a near-still painting
    // with light moving over it — not a thinner version of everything at once.
    { name: 'Still',    relight: 0.95, wash: 0.30, flow: 0.00, contour: 0.00,
                        rays: 0.25, caustics: 0.00, glitter: 0.15, rain: 0.00, warmth: 0.85 },
    { name: 'Ember',    relight: 1.00, wash: 0.80, flow: 0.30, contour: 0.00,
                        rays: 0.95, caustics: 0.20, glitter: 0.70, rain: 0.00, warmth: 0.95 },
    { name: 'Tide',     relight: 0.85, wash: 0.55, flow: 1.00, contour: 0.15,
                        rays: 0.20, caustics: 1.00, glitter: 0.45, rain: 0.00, warmth: 0.30 },
    { name: 'Fracture', relight: 0.70, wash: 0.30, flow: 0.20, contour: 1.00,
                        rays: 0.00, caustics: 0.20, glitter: 0.40, rain: 0.00, warmth: 0.10 },
    { name: 'Tempest',  relight: 1.00, wash: 0.35, flow: 0.55, contour: 0.30,
                        rays: 0.25, caustics: 0.80, glitter: 0.55, rain: 1.00, warmth: 0.15 },
  ];
  const LAYER_KEYS = ['relight', 'wash', 'flow', 'contour', 'rays', 'caustics', 'glitter', 'rain'];

  /* One accent at a time, rotating. Running them together is what produced
   * mush; showing one for ~11s gives each a chance to actually be seen. */
  const ACCENTS = ['spark', 'water', 'flow'];
  // The birch painting's own accents — vertical light, not horizontal water.
  const ACCENTS_B = ['canopy', 'ground', 'sap'];

  const mix = { relight: 0.6, wash: 0.4, flow: 0, contour: 0,
                glitter: 0, rays: 0, caustics: 0, rain: 0 };
  let warmth = 0.5;
  let energy = 0;          // slow average of musical energy, 0..1
  let punch = 0;           // alias of `hit`, for the older single-effect presets
  let hit = 0, hit2 = 0;   // beat envelopes: ~150ms and ~600ms
  let swell = 0;           // sustained loudness, ~2.5s
  let demoUntil = 0;       // non-zero while the demo sweep is running
  let kickAt = -99, kickPower = 0;
  let lastBeatEvent = -99;
  let accentIndex = 0;     // advanced by beats, not by a clock
  let igniteAt = -99;
  let igniteAngle = 0;
  let lastFrame = 0;

  // Colour bleed: a slow event, launched between movements rather than on beats.
  const BLEED_DUR = 14;
  let bleedUntil = -99;
  let bleedSeed = [0.5, 0.4];
  let bleedTint = [255, 180, 90];

  /* Breathing: the projected light slowly expands and contracts. Capped at 1.0
   * so it can never grow past the alignment and spill onto the frame or wall —
   * it only ever draws back from the edges, which reads as the light receding
   * rather than the picture being cropped. */
  function breathScale(t, a) {
    const slow = 0.5 + 0.5 * Math.sin(t * 0.055);
    return 0.925 + 0.055 * slow + 0.020 * a.bass;
  }

  let movFrom = 0, movTo = 0, movX = 1, movSince = -99;
  const MOV_HOLD = 22;     // seconds before a movement may be replaced
  const MOV_FADE = 5.0;    // crossfade duration

  const smoothstep = (e, a, b) =>
    Math.max(0, Math.min(1, (e - a) / Math.max(1e-6, b - a)));

  /* ---------- Spatial focus ----------------------------------------------
   * Lighting the whole canvas uniformly is flat — there is no figure and no
   * ground. These masks confine the light to part of the painting so the rest
   * falls dark, which is where the contrast comes from.
   *
   * Rendered small and scaled up (the shapes are all soft gradients, so the
   * interpolation costs nothing), then applied to the finished light layer
   * with 'destination-in'. Masking the composite rather than each effect means
   * every layer is confined consistently and the edges always agree.
   *
   * Masks run on their own hold/fade cadence, deliberately out of phase with
   * the movements, so the two never change together and the piece keeps
   * developing. FLOOR keeps unlit regions dim rather than absolutely black —
   * pure black reads as a broken projector rather than a compositional choice. */
  const FLOOR = 0.16;

  const MASKS = [
    { name: 'full', draw(g, w, h) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); } },

    { name: 'sky', draw(g, w, h, t) {
        const edge = HORIZON + 0.06 * Math.sin(t * 0.05);
        const gr = g.createLinearGradient(0, 0, 0, h);
        gr.addColorStop(0, '#fff');
        gr.addColorStop(Math.max(0, edge - 0.14), '#fff');
        gr.addColorStop(Math.min(1, edge + 0.10), `rgba(255,255,255,${FLOOR})`);
        gr.addColorStop(1, `rgba(255,255,255,${FLOOR})`);
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      } },

    { name: 'water', draw(g, w, h, t) {
        const edge = HORIZON + 0.05 * Math.sin(t * 0.043 + 1);
        const gr = g.createLinearGradient(0, 0, 0, h);
        gr.addColorStop(0, `rgba(255,255,255,${FLOOR})`);
        gr.addColorStop(Math.max(0, edge - 0.08), `rgba(255,255,255,${FLOOR})`);
        gr.addColorStop(Math.min(1, edge + 0.12), '#fff');
        gr.addColorStop(1, '#fff');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      } },

    // A pool of light that drifts across the canvas — the strongest contrast.
    { name: 'pool', draw(g, w, h, t) {
        g.fillStyle = `rgba(255,255,255,${FLOOR})`;
        g.fillRect(0, 0, w, h);
        const cx = (0.5 + 0.30 * Math.sin(t * 0.061)) * w;
        const cy = (0.5 + 0.32 * Math.cos(t * 0.047 + 0.7)) * h;
        const r = (0.34 + 0.07 * Math.sin(t * 0.09)) * Math.max(w, h);
        const gr = g.createRadialGradient(cx, cy, r * 0.10, cx, cy, r);
        gr.addColorStop(0, '#fff');
        gr.addColorStop(0.55, 'rgba(255,255,255,0.72)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
        g.globalCompositeOperation = 'source-over';
      } },

    // A band sweeping down the painting, revealing it in horizontal slices.
    { name: 'band', draw(g, w, h, t) {
        g.fillStyle = `rgba(255,255,255,${FLOOR})`;
        g.fillRect(0, 0, w, h);
        const c = ((t * 0.055) % 1.4 - 0.2) * h;
        const half = 0.20 * h;
        const gr = g.createLinearGradient(0, c - half, 0, c + half);
        gr.addColorStop(0, 'rgba(255,255,255,0)');
        gr.addColorStop(0.5, '#fff');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
        g.globalCompositeOperation = 'source-over';
      } },

    // Vertical split, sliding — lights one side against the other.
    { name: 'side', draw(g, w, h, t) {
        const c = 0.5 + 0.28 * Math.sin(t * 0.038);
        const gr = g.createLinearGradient(0, 0, w, 0);
        const flip = Math.sin(t * 0.019) > 0;
        gr.addColorStop(0, flip ? '#fff' : `rgba(255,255,255,${FLOOR})`);
        gr.addColorStop(Math.max(0.01, c - 0.22), flip ? '#fff' : `rgba(255,255,255,${FLOOR})`);
        gr.addColorStop(Math.min(0.99, c + 0.22), flip ? `rgba(255,255,255,${FLOOR})` : '#fff');
        gr.addColorStop(1, flip ? `rgba(255,255,255,${FLOOR})` : '#fff');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      } },
  ];

  const maskCv = document.createElement('canvas');
  maskCv.width = 160; maskCv.height = 216;
  const maskG = maskCv.getContext('2d');
  let maskFrom = 0, maskTo = 0, maskX = 1, maskSince = -99;
  const MASK_HOLD = 17;      // out of phase with MOV_HOLD (22) on purpose
  const MASK_FADE = 6.0;     // long, because a mask change moves a lot of light

  function updateMask(t, dt) {
    if (t - maskSince > MASK_HOLD + Math.random() * 6) {
      let next = (Math.random() * MASKS.length) | 0;
      if (next === maskTo) next = (next + 1) % MASKS.length;
      maskFrom = maskTo; maskTo = next; maskSince = t; maskX = 0;
    }
    maskX = Math.min(1, maskX + dt / MASK_FADE);
  }

  // Blend the outgoing and incoming masks by alpha, so the focus dissolves
  // from one shape to the next instead of cutting.
  function applyMask(t) {
    if (maskFrom === maskTo && maskX >= 1 && MASKS[maskTo].name === 'full') return;
    const w = maskCv.width, h = maskCv.height;
    const x = 0.5 - 0.5 * Math.cos(Math.PI * maskX);
    maskG.globalCompositeOperation = 'source-over';
    maskG.clearRect(0, 0, w, h);
    maskG.globalAlpha = 1 - x;
    MASKS[maskFrom].draw(maskG, w, h, t);
    maskG.globalCompositeOperation = 'lighter';
    maskG.globalAlpha = x;
    MASKS[maskTo].draw(maskG, w, h, t);
    maskG.globalAlpha = 1;

    ctx.globalCompositeOperation = 'destination-in';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(maskCv, 0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }

  function chooseMovement(e) {
    if (e < 0.18) return 0;      // Still
    if (e < 0.38) return 1;      // Ember
    if (e < 0.58) return 2;      // Tide
    if (e < 0.78) return 3;      // Fracture
    return 4;                    // Tempest
  }

  function updateMix(t, a, dt) {
    /* No microphone must not mean a dead wall. Without audio the piece drives
     * itself from slow LFOs instead of sitting at the mix floor forever —
     * a denied permission or a silent room still gets a full performance,
     * just an unsynchronised one. */
    if (demoUntil) {
      // A 110s ramp through every band, then back down, so the arc plays out.
      const cyc = (t % 110) / 110;
      const shape = cyc < 0.75 ? cyc / 0.75 : (1 - (cyc - 0.75) / 0.25);
      energy += (Math.min(1, shape * 1.05) - energy) * Math.min(1, dt * 0.8);
      if (Math.random() < 0.05 * energy) {
        hit = 1; hit2 = 1;
        const src = srcUV();
        if (Math.random() < 0.6) {
          Effects.spawnRipple(t, src[0] + (Math.random() - 0.5) * 0.3,
                                 src[1] + (Math.random() - 0.5) * 0.3, 0.5 + energy * 0.5);
          kickAt = t; kickPower = energy;
        } else {
          Effects.spawnStreak(t, Math.random() < 0.4, Math.random() < 0.5 ? 1 : -1);
        }
        if (Math.random() < 0.35) accentIndex++;
      }
      hit  *= Math.pow(0.01, dt / 0.15);
      hit2 *= Math.pow(0.01, dt / 0.60);
      swell += (energy - swell) * Math.min(1, dt / 2.5);
      punch = hit;
      return;
    }
    const live = AudioIn.ready;
    const inst = live
      ? Math.min(1, a.level * 0.6 + a.bass * 0.3 + a.mid * 0.1)
      // With no audio source at all, drift gently rather than performing —
      // an unattended wall should look calm, not like it is reacting to
      // something that is not there.
      : 0.16 + 0.12 * Math.sin(t * 0.032) + 0.06 * Math.sin(t * 0.013 + 1.3);
    energy += (inst - energy) * Math.min(1, dt * 1.1);

    /* Beat envelopes. These are the whole basis of the response now: measured
     * end-to-end, the old smoothed chain took 2.5-4.5s to react to a step,
     * which is far too slow to feel connected to anything. These attack in a
     * single frame and decay on fixed clocks, independent of frame rate.
     *
     *   hit   ~150ms — the strike itself
     *   hit2  ~600ms — the tail, for things that should ring on
     *   swell ~2.5s  — sustained loudness, for slow builds */
    if (live && a.onset) { hit = 1; hit2 = 1; }
    else if (!live && Math.sin(t * 0.7) > 0.9995) { hit = 0.35; hit2 = 0.35; }
    hit  *= Math.pow(0.01, dt / 0.15);
    hit2 *= Math.pow(0.01, dt / 0.60);
    swell += (Math.min(1, a.level * 1.15) - swell) * Math.min(1, dt / 2.5);
    punch = hit;                      // kept for the older presets that read it

    // --- Movement selection -------------------------------------------
    const want = chooseMovement(energy);
    if (want !== movTo && t - movSince > MOV_HOLD) {
      movFrom = movTo; movTo = want; movSince = t; movX = 0;
    }
    movX = Math.min(1, movX + dt / MOV_FADE);
    // Cosine ease, so the dissolve has no visible start or stop.
    const x = 0.5 - 0.5 * Math.cos(Math.PI * movX);
    const A = MOVEMENTS[movFrom], B = MOVEMENTS[movTo];

    // Movement profile sets the character; music modulates within it.
    const target = {};
    for (const key of LAYER_KEYS) {
      const base = A[key] + (B[key] - A[key]) * x;
      let m = 1;
      /* Low floors are the point. These used to sit at 0.35-0.75, so every
       * layer kept running however quiet the music was — which is why a soft
       * passage still looked busy. Now only relight holds a high floor; the
       * rest genuinely recede to nothing and come back with the music. */
      switch (key) {
        case 'relight':  m = 0.70 + 0.30 * energy + punch * 0.20; break;
        case 'glitter':  m = 0.08 + 0.92 * a.treble + punch * 0.50; break;
        case 'caustics': m = 0.12 + 0.88 * a.mid; break;
        case 'flow':     m = 0.18 + 0.82 * a.level + punch * 0.30; break;
        case 'rain':     m = 0.30 + 0.70 * a.level; break;
        // Rays get their own curve — they read as the painting's own sunlight,
        // so they should breathe with the midrange rather than the overall level.
        case 'rays':     m = 0.35 + 0.65 * a.mid + punch * 0.25; break;
        default:         m = 0.20 + 0.80 * energy;
      }
      target[key] = Math.min(1.4, base * m);
    }
    warmth += ((A.warmth + (B.warmth - A.warmth) * x) - warmth) * Math.min(1, dt * 0.8);

    // Interpolate. Deliberately unhurried — visible crossfading is the point,
    // since a hard switch reads as a glitch on a wall.
    // ~250ms, down from ~1.1s. Slow enough to avoid flicker, fast enough that
    // a layer can open and close within a bar.
    const k = Math.min(1, dt * 4.0);
    for (const key of LAYER_KEYS) mix[key] += (target[key] - mix[key]) * k;

    // Strong onsets launch a wavefront across the painting's edges. Gated so
    // a dense passage doesn't leave one permanently mid-flight. With no
    // microphone, fire on a timer so the gesture still happens.
    const fire = live
      ? (a.onset && a.bass > 0.42 && t - igniteAt > 1.1)
      : (t - igniteAt > 6.0);
    if (fire) {
      igniteAt = t;
      igniteAngle = Math.random() * Math.PI * 2;
    }


    /* Launch a colour bleed on a movement change, or occasionally at rest.
     * Tied to structure rather than beats — at 14 seconds it is a section
     * event, and firing it on transients would leave several overlapping. */
    if (t > bleedUntil + 12 && (movX < 0.05 || Math.random() < 0.0012)) {
      bleedUntil = t + BLEED_DUR;
      bleedSeed = [0.2 + Math.random() * 0.6, 0.15 + Math.random() * 0.6];
      const pal = Analysis.ready ? Analysis.palette : null;
      if (pal && pal.length) {
        // Prefer a saturated palette entry — the muted ones vanish additively.
        const pick = pal.slice(0, 4).sort((p, q) => {
          const sat = c => Math.max(...c.rgb) - Math.min(...c.rgb);
          return sat(q) - sat(p);
        })[0];
        bleedTint = pick.rgb;
      }
    }
  }

  /* Beat events, per painting and in its own vocabulary.
   *
   * This used to live inside the shared updateMix with a single guard, so one
   * surface claimed each beat and the other got nothing — and before the pools
   * were split, both drew the very same event. Each painting now answers the
   * music in terms that belong to its own subject: water makes rings, a wood
   * takes a gust.
   */
  const lastBeat = { a: -99, b: -99 };

  function seaBeat(t, a, id) {
    if (!(a.onset && t - lastBeat[id] > 0.22)) return;
    lastBeat[id] = t;

    /* Rings originate at the sun.
     *
     * They used to be dropped around the water like stones, which made them
     * read as something striking the surface from outside the picture. The
     * sun is the only light source here, so a pulse of light should leave it
     * and travel outward — the rings are the light arriving, not an impact.
     * Jitter is small and biased downward, so successive pulses are not
     * perfectly concentric but still clearly come from the same place. */
    const [su, sv] = srcUV();
    const jitter = (amt) => (Math.random() - 0.5) * amt;

    if (a.bass > 0.55) {
      // Heavy hits: a strong pulse straight off the sun.
      Effects.spawnRipple(t, su + jitter(0.05), sv + jitter(0.04),
                          0.7 + a.bass * 0.6, id);
      kickAt = t; kickPower = Math.min(1, a.bass);
    } else if (a.treble > 0.5) {
      // Bright hits: a small, tight pulse right at the source.
      Effects.spawnRipple(t, su + jitter(0.03), sv + jitter(0.025), 0.35, id);
    } else {
      // Everything else: slightly wider scatter, still centred on the sun.
      Effects.spawnRipple(t, su + jitter(0.10), sv + jitter(0.07), 0.5, id);
    }
    if (Math.random() < 0.35) accentIndex++;
  }


  function woodBeat(t, a, id) {
    if (!(a.onset && t - lastBeat[id] > 0.26)) return;
    lastBeat[id] = t;
    // A gust crosses the canopy and passes. Trees do not ripple.
    if (a.bass > 0.5) {
      Effects.spawnGust(t, Math.random() < 0.5 ? 1 : -1, 0.6 + a.bass * 0.6, id);
      kickAt = t; kickPower = Math.min(1, a.bass) * 0.55;   // wood gives less
    } else if (a.treble > 0.5) {
      Effects.spawnGust(t, Math.random() < 0.5 ? 1 : -1, 0.3, id);
    }
    if (Math.random() < 0.3) accentIndex++;
  }

  const scenes = [
    {
      name: '● LIVE',
      note: 'The Last Light — six scenes, chosen by the music.',
      audio: true,
      draw(t, env) {
        const a = env.audio;
        const dt = Math.min(0.1, Math.max(0.001, t - lastFrame));
        lastFrame = t;
        updateMix(t, a, dt);

        // Band 0-5 from sustained energy; the beat envelopes stay instant.
        const band = energy < 0.06 ? 0 : energy < 0.22 ? 1 : energy < 0.42 ? 2
                   : energy < 0.68 ? 3 : energy < 0.86 ? 4 : 5;

        const sd = env.sceneDir;
        const pool = env.surfaceId === 'a' ? SEA : WOOD;
        const st = showState(t);
        // Catalogue mode owns scene selection while it is running.
        const next = catalogue.on ? sd.scene : pickScene(sd, pool, band, t, st && st.act);
        if (next !== sd.scene) {
          sd.prev = sd.scene; sd.prevStart = sd.sceneStart;
          sd.scene = next; sd.sceneStart = t; sd.xfade = 0;
        }
        sd.xfade = Math.min(1, sd.xfade + dt / 3.5);

        const musicGlow = Math.min(1, swell * 0.85 + hit * 0.55 + hit2 * 0.25);

        /* The act envelope is a FLOOR, not a multiplier — see the other
         * painting's copy. Multiplied, a silent room produced zero however far
         * into the piece you were, and the whole arc played in the dark. */
        let glow;
        if (st) {
          const e = showEnvelope(st);
          glow = Math.min(1, e * 0.62 + musicGlow * e * 0.55);
          if (st.act.lead !== env.surfaceId) glow *= 0.68;
        } else {
          glow = musicGlow;
        }

        // Yield to the other painting when it is the one doing the talking.
        glow *= deference(env.surfaceId);
        bus.level[env.surfaceId] = glow;

        // A streak thrown toward the other painting is answered from its
        // facing edge, so the gesture crosses the wall between them.
        if (hit > 0.85 && Math.random() < 0.25) offerHandoff(env.surfaceId, t);
        if (claimHandoff(env.surfaceId, t)) {
          Effects.spawnStreak(t, false, env.surfaceId === 'b' ? 1 : -1);
        }
        const len = !sd.scene ? SCENE_DWELL
                  : sd.scene.peak ? PEAK_LENGTH
                  : sd.scene.fall ? FALL_LENGTH : SCENE_DWELL;
        const p = Math.min(1, (t - sd.sceneStart) / len);

        /* The picture extending past its own frame, underneath everything.
         * Grows with the music: quiet keeps it inside the canvas, a peak
         * pushes it far enough onto the wall that the two paintings' halos
         * meet in the space between them. */
        Effects.beyond(ctx, t, env, {
          // At the climax the halo is pushed to full, which is the moment the
          // two paintings' light actually meets on the wall between them.
          spread: (st && st.act.climax ? 0.75 : 0.10) + swell * 0.45 + hit2 * 0.2,
          intensity: (0.18 + swell * 0.30) * (st ? showEnvelope(st) : 1),
        });

        // Signature layer, always, under whatever the scene is doing.
        (env.surfaceId === 'a' ? BASE.a : BASE.b)(t, env, glow);

        // Cross-fade: the outgoing scene keeps drawing at falling alpha, so
        // sections dissolve into each other instead of cutting.
        if (sd.prev && sd.xfade < 1) {
          ctx.save();
          ctx.globalAlpha = 1 - sd.xfade;
          sd.prev.draw(t, env, glow, 1);
          ctx.restore();
        }
        ctx.save();
        ctx.globalAlpha = sd.prev ? sd.xfade : 1;
        if (sd.scene) sd.scene.draw(t, env, glow, p);
        ctx.restore();

        /* Beat events, above the scene. These are what the music actually
         * makes: rings crossing the canvas and bars of light travelling it,
         * each outliving the beat that spawned it. */
        /* A boat crossing the horizon, under the scene layers so weather and
         * light fall over it. Always running on this painting — it belongs to
         * the seascape the way the branches belong to the wood, and it keeps
         * its own slow clock rather than following the music. */
        Effects.boat(ctx, t, env, {
          horizon: HORIZON,
          cross: 210, gap: 60,
          /* 0.030 was 19px in a 620px painting — technically drawing, visually
           * absent. A boat has to be big enough to read as a boat from across
           * a room, and this is still only a twelfth of the width. */
          size: 0.085,
          sunU: srcUV()[0],
          // Only the lamp answers the music, and only a little.
          intensity: 0.95 + swell * 0.3,
        });

        seaBeat(t, a, env.surfaceId);

        Effects.rippleField(ctx, t, env, {
          life: 2.2, speed: 0.5, amp: 8 + swell * 6, intensity: 0.45 + swell * 0.35,
        });
        Effects.streakField(ctx, t, env, {
          life: 1.4, width: 0.14, intensity: 0.28 + swell * 0.25,
        });

        /* Relief last and always. It is the one layer that is not literally
         * light from the source; it earns its place by making the impasto
         * catch whatever the scene above just put on the canvas. */
        const src = srcUV();
        Effects.relight(ctx, t, env, {
          angle: Math.atan2(0.5 - src[1], 0.5 - src[0]),
          relief: 2.2 + glow * 1.2,
          spec: 0.20 + glow * 0.5,
          gain: 0.30 + glow * 0.7,
          warmth: 0.55,
          alpha: 0.22 + glow * 0.38,
        });
      },
    },
    {
      name: 'Sunset',
      note: 'The default. Sun breathes, water ripples, glitter on the reflection.',
      draw(t, env) {
        Effects.breath(ctx, t, env, { base: 0.025, swing: 0.02 });
        // Clouds drift almost imperceptibly — enough that the sky is never still.
        Effects.shimmer(ctx, t, env, { band: SKY, amp: 2.5, speed: 0.35, strength: 0.16 });
        Effects.shimmer(ctx, t, env, { band: WATER, amp: 5, speed: 1.1, strength: 0.30 });
        const sun = region('sun');
        if (sun) Effects.regionGlow(ctx, t, env, sun, { base: 0.13, swing: 0.07, period: 7, blur: 55 });
        Effects.glitter(ctx, t, env, { region: GLITTER_PATH, count: 95, intensity: 0.7 });
      },
    },
    {
      name: 'Golden hour',
      note: 'Warmer and slower. Heavy bloom on the sun, dense glitter.',
      draw(t, env) {
        Effects.breath(ctx, t, env, { base: 0.055, swing: 0.03 });
        Effects.shimmer(ctx, t, env, { band: WATER, amp: 4, speed: 0.8, strength: 0.26 });
        ['sun', 'reflection'].forEach(n => {
          const r = region(n);
          if (r) Effects.regionGlow(ctx, t, env, r, { base: 0.16, swing: 0.06, period: 9, blur: 60 });
        });
        Effects.glitter(ctx, t, env, {
          region: GLITTER_PATH, count: 140, intensity: 0.85, speed: 1.6, size: 3,
        });
      },
    },
    {
      name: 'Storm',
      note: 'Cold and restless. Choppy water, moving cloud, lightning.',
      draw(t, env) {
        Effects.shimmer(ctx, t, env, { band: SKY, amp: 6, speed: 1.3, strength: 0.22 });
        Effects.shimmer(ctx, t, env, { band: WATER, amp: 9, speed: 2.6, strength: 0.28 });
        Effects.glitter(ctx, t, env, {
          region: GLITTER_PATH, count: 50, intensity: 0.45,
          speed: 3.4, tint: [200, 224, 255],
        });
        Effects.lightning(ctx, t, env, { minGap: 7, jitter: 13, intensity: 0.55 });
      },
    },
    {
      name: 'Raking light',
      note: 'Slow side-light across the impasto. The texture reveal — try this first.',
      draw(t, env) {
        Effects.sweep(ctx, t, env);
        Effects.breath(ctx, t, env, { base: 0.02, swing: 0.015 });
      },
    },
    {
      name: 'Rays',
      note: 'Shafts fan down from the sun. Caustics on the water, bloom throughout.',
      draw(t, env) {
        Effects.bloom(ctx, t, env, { amount: 0.20, radius: 30 });
        Effects.godRays(ctx, t, env, { origin: [0.45, 0.28], count: 9, intensity: 0.15 });
        Effects.caustics(ctx, t, env, { band: WATER, strength: 0.22 });
        Effects.glitter(ctx, t, env, { region: GLITTER_PATH, count: 70, intensity: 0.6 });
      },
    },
    {
      name: 'Nightfall',
      note: 'Stars over the dark cloud, deep bloom, quiet water.',
      draw(t, env) {
        Effects.breath(ctx, t, env, { base: 0.015, swing: 0.012 });
        Effects.bloom(ctx, t, env, { amount: 0.26, radius: 36 });
        Effects.stars(ctx, t, env, { count: 80, intensity: 0.55 });
        Effects.shimmer(ctx, t, env, { band: WATER, amp: 3, speed: 0.5, strength: 0.20 });
        Effects.glitter(ctx, t, env, {
          region: GLITTER_PATH, count: 45, intensity: 0.5, tint: [220, 235, 255],
        });
      },
    },
    {
      name: 'Downpour',
      note: 'Rain, caustics, lightning. Rain thickens with the music.',
      audio: true,
      draw(t, env) {
        const a = env.audio;
        Effects.shimmer(ctx, t, env, { band: SKY, amp: 5 + a.bass * 8, speed: 1.2, strength: 0.20 });
        Effects.caustics(ctx, t, env, { band: WATER, strength: 0.26 + a.mid * 0.22, speed: 1.8 });
        Effects.rain(ctx, t, env, {
          count: 150 + a.level * 220,
          speed: 900 + a.bass * 700,
          alpha: 0.40 + a.level * 0.30,
          width: 1.5 + a.bass * 1.2,
        });
        Effects.lightning(ctx, t, env, {
          minGap: 6, jitter: 10, intensity: 0.6,
          trigger: a.onset && a.bass > 0.72,   // heavy hits throw lightning
        });
      },
    },
    {
      name: '♪ Resonate',
      note: 'Sound-reactive. Bass swells the sea, treble sparkles, beats flash.',
      audio: true,
      draw(t, env) {
        const a = env.audio;
        // Bass drives the swell — wave amplitude and the glow of the sun.
        Effects.breath(ctx, t, env, { base: 0.02 + a.bass * 0.06, swing: 0.015 });
        Effects.bloom(ctx, t, env, { amount: 0.10 + a.bass * 0.30, radius: 24 + a.bass * 34 });
        Effects.shimmer(ctx, t, env, {
          band: WATER,
          amp: 2 + a.bass * 14,
          speed: 0.8 + a.mid * 2.2,
          strength: 0.18 + a.level * 0.22,
        });
        Effects.caustics(ctx, t, env, {
          band: WATER, strength: 0.10 + a.mid * 0.28, speed: 0.6 + a.level * 2.4,
        });
        // Treble is the sparkle band — hi-hats and cymbals hit the glitter.
        Effects.glitter(ctx, t, env, {
          region: GLITTER_PATH,
          count: Math.round(40 + a.treble * 150),
          intensity: 0.35 + a.treble * 0.65,
          speed: 1.8 + a.treble * 3.5,
          size: 2 + a.bass * 2.5,
        });
        // Onsets punch the rays; sustained loudness widens the fan.
        Effects.godRays(ctx, t, env, {
          origin: [0.45, 0.28],
          count: 9,
          intensity: 0.04 + a.beat * 0.22 + a.level * 0.06,
          spread: 1.3 + a.level * 0.8,
        });
        if (a.beat > 0.55) {
          ctx.fillStyle = `rgba(226,240,255,${(a.beat - 0.55) * 0.5})`;
          ctx.fillRect(0, 0, W, H);
        }
      },
    },
    {
      name: '♪ Tempest',
      note: 'Sound-reactive storm. Rain rate and lightning follow the music.',
      audio: true,
      draw(t, env) {
        const a = env.audio;
        Effects.shimmer(ctx, t, env, {
          band: SKY, amp: 3 + a.bass * 10, speed: 1.0 + a.mid * 2, strength: 0.20,
        });
        Effects.caustics(ctx, t, env, {
          band: WATER, strength: 0.16 + a.bass * 0.24, speed: 1.2 + a.level * 3,
        });
        Effects.rain(ctx, t, env, {
          count: Math.round(40 + a.level * 260),
          speed: 700 + a.mid * 900,
          slant: 0.10 + a.bass * 0.30,
          alpha: 0.14 + a.treble * 0.26,
        });
        // Beat-triggered strikes instead of the timer-driven ones.
        if (a.beat > 0.8) {
          ctx.fillStyle = `rgba(216,234,255,${(a.beat - 0.8) * 2.4})`;
          ctx.fillRect(0, 0, W, H);
        }
        Effects.stars(ctx, t, env, { count: 40, intensity: a.treble * 0.7 });
      },
    },
    {
      name: 'Waking',
      note: 'Dormant until someone approaches, then the sea comes up.',
      draw(t, env) {
        const p = env.presence;
        Effects.breath(ctx, t, env, { base: 0.012 + p * 0.03, swing: 0.015 });
        Effects.spotlight(ctx, t, env, { radius: 0.5, intensity: 0.26, height: 0.4 });
        if (p > 0.12) {
          Effects.shimmer(ctx, t, env, {
            band: WATER, amp: 2 + p * 5, speed: 0.7 + p * 0.7, strength: 0.10 + p * 0.20,
          });
          const sun = region('sun');
          if (sun) Effects.regionGlow(ctx, t, env, sun, {
            base: 0.03 + p * 0.12, swing: 0.05, period: 6, blur: 55,
          });
        }
        if (p > 0.35) {
          Effects.glitter(ctx, t, env, {
            region: GLITTER_PATH, count: Math.round(p * 110), intensity: p * 0.8,
          });
        }
      },
    },

    /* ---- Image-derived scenes ------------------------------------------
     * These read the painting's own structure. On physical impasto the
     * relight scenes are the striking ones: the projected shading aligns
     * with real ridges of paint, so the brushwork casts travelling shadows. */
    {
      name: '✦ Relight',
      note: 'A virtual sun orbits. The impasto casts moving shadows.',
      draw(t, env) {
        Effects.relight(ctx, t, env, {
          speed: 0.30, relief: 2.8, spec: 0.6, gain: 1.0, alpha: 0.9,
        });
        Effects.bloom(ctx, t, env, { amount: 0.06, radius: 30 });
      },
    },
    {
      name: '✦ Brushflow',
      note: 'Light streams along the artist\'s own brushstrokes.',
      audio: true,
      draw(t, env) {
        const a = env.audio;
        Effects.breath(ctx, t, env, { base: 0.02, swing: 0.012 });
        Effects.brushflow(ctx, t, env, {
          count: 1500 + Math.round(a.level * 1400),
          speed: 0.05 + a.bass * 0.09,
          intensity: 0.42 + a.level * 0.30,
          size: 1.5, saturate: 1.6,
        });
      },
    },
    {
      name: '✦ Cartography',
      note: 'The painting as a living topographic map.',
      audio: true,
      draw(t, env) {
        const a = env.audio;
        Effects.contours(ctx, t, env, {
          levels: 14, speed: 0.09 + a.mid * 0.35,
          thickness: 0.10 + a.bass * 0.10,
          intensity: 0.8, alpha: 0.55,
          tint: [140, 235, 255],
        });
        Effects.paletteWash(ctx, t, env, { intensity: 0.16, speed: 0.09 });
      },
    },
    {
      name: '✦ Prism',
      note: 'The painting separates into its own three channels.',
      audio: true,
      draw(t, env) {
        const a = env.audio;
        Effects.chromaSplit(ctx, t, env, {
          spread: 0.008 + a.bass * 0.022,
          speed: 0.45, rotate: 0.30,
          intensity: 0.42 + a.level * 0.25,
        });
        Effects.glitter(ctx, t, env, {
          region: GLITTER_PATH, count: 40 + Math.round(a.treble * 120), intensity: 0.5,
        });
      },
    },
    {
      name: '✦ Ignite',
      note: 'A wavefront crosses; the composition draws itself in light.',
      draw(t, env) {
        Effects.ignite(ctx, t, env, {
          period: 6.5, angle: Math.PI * 0.28, width: 0.16,
          intensity: 1.0, size: 2.4, tint: [255, 208, 140],
        });
        Effects.ignite(ctx, t, env, {
          period: 9.5, angle: Math.PI * 1.15, width: 0.12,
          intensity: 0.6, size: 1.8, tint: [140, 210, 255],
        });
        Effects.breath(ctx, t, env, { base: 0.015, swing: 0.01 });
      },
    },
    {
      name: '✦ Aurora',
      note: 'Drifting fields in the painting\'s own dominant colours.',
      audio: true,
      draw(t, env) {
        const a = env.audio;
        Effects.paletteWash(ctx, t, env, {
          count: 5, intensity: 0.26 + a.level * 0.22,
          speed: 0.11 + a.mid * 0.20, radius: 0.55, saturate: 1.5,
        });
        Effects.brushflow(ctx, t, env, { count: 550, speed: 0.03, intensity: 0.28, size: 1.2 });
      },
    },
    {
      name: '✦ Nocturne',
      note: 'Raking relight with contour tracery. The full set piece.',
      audio: true,
      draw(t, env) {
        const a = env.audio;
        Effects.relight(ctx, t, env, {
          speed: 0.16, relief: 3.4, spec: 0.75,
          gain: 0.85 + a.bass * 0.5, warmth: 0.4, alpha: 0.8,
        });
        Effects.contours(ctx, t, env, {
          levels: 22, speed: 0.05, thickness: 0.05,
          intensity: 0.5, alpha: 0.3, tint: [255, 236, 200],
        });
        Effects.ignite(ctx, t, env, {
          period: 11, angle: Math.PI * 0.3, width: 0.1,
          intensity: 0.55, tint: [255, 235, 210],
        });
      },
    },
  ];

  /* ======================================================================
   * PAINTING 2 — birch trunks over green water
   *
   * A different picture wants different behaviour. Where the seascape is
   * about a sun, a horizon and a glittering reflection, this one is
   * horizontal timber over still water, in teal, sage and yellow. So the
   * vocabulary here is dappled light through leaves, wind moving through
   * the canopy, and reflections in the water below — no sun, no horizon
   * glitter path, and the bands run differently.
   * ==================================================================== */
  const B_CANOPY = [0.0, 0.42];      // leaf canopy above the trunks
  const B_GROUND = [0.74, 1.0];      // forest floor and shallow water below

  const scenesB = [
    {
      name: '● LIVE (birches)',
      note: 'Understory — six scenes, chosen by the music.',
      audio: true,
      draw(t, env) {
        const a = env.audio;
        const dt = Math.min(0.1, Math.max(0.001, t - lastFrame));
        lastFrame = t;
        updateMix(t, a, dt);

        // Band 0-5 from sustained energy; the beat envelopes stay instant.
        const band = energy < 0.06 ? 0 : energy < 0.22 ? 1 : energy < 0.42 ? 2
                   : energy < 0.68 ? 3 : energy < 0.86 ? 4 : 5;

        const sd = env.sceneDir;
        const pool = env.surfaceId === 'a' ? SEA : WOOD;
        const st = showState(t);
        // Catalogue mode owns scene selection while it is running.
        const next = catalogue.on ? sd.scene : pickScene(sd, pool, band, t, st && st.act);
        if (next !== sd.scene) {
          sd.prev = sd.scene; sd.prevStart = sd.sceneStart;
          sd.scene = next; sd.sceneStart = t; sd.xfade = 0;
        }
        sd.xfade = Math.min(1, sd.xfade + dt / 3.5);

        const musicGlow = Math.min(1, swell * 0.85 + hit * 0.55 + hit2 * 0.25);

        /* The act envelope is a FLOOR, not a multiplier.
         *
         * Multiplying it against the music meant a silent room produced zero
         * however far into the piece you were — the whole arc played in the
         * dark. The piece has to perform on its own and let the music lift it,
         * otherwise it is not a piece, it is a meter. */
        let glow;
        if (st) {
          const e = showEnvelope(st);
          glow = Math.min(1, e * 0.62 + musicGlow * e * 0.55);
          if (st.act.lead !== env.surfaceId) glow *= 0.68;
        } else {
          glow = musicGlow;
        }
        glow *= deference(env.surfaceId);
        bus.level[env.surfaceId] = glow;

        if (hit > 0.85 && Math.random() < 0.25) offerHandoff(env.surfaceId, t);
        if (claimHandoff(env.surfaceId, t)) {
          Effects.spawnStreak(t, false, env.surfaceId === 'b' ? 1 : -1);
        }

        const len = !sd.scene ? SCENE_DWELL
                  : sd.scene.peak ? PEAK_LENGTH
                  : sd.scene.fall ? FALL_LENGTH : SCENE_DWELL;
        const p = Math.min(1, (t - sd.sceneStart) / len);

        /* The picture extending past its own frame, underneath everything.
         * Grows with the music: quiet keeps it inside the canvas, a peak
         * pushes it far enough onto the wall that the two paintings' halos
         * meet in the space between them. */
        Effects.beyond(ctx, t, env, {
          // At the climax the halo is pushed to full, which is the moment the
          // two paintings' light actually meets on the wall between them.
          spread: (st && st.act.climax ? 0.75 : 0.10) + swell * 0.45 + hit2 * 0.2,
          intensity: (0.18 + swell * 0.30) * (st ? showEnvelope(st) : 1),
        });

        // Signature layer, always, under whatever the scene is doing.
        (env.surfaceId === 'a' ? BASE.a : BASE.b)(t, env, glow);

        // Cross-fade: the outgoing scene keeps drawing at falling alpha, so
        // sections dissolve into each other instead of cutting.
        if (sd.prev && sd.xfade < 1) {
          ctx.save();
          ctx.globalAlpha = 1 - sd.xfade;
          sd.prev.draw(t, env, glow, 1);
          ctx.restore();
        }
        ctx.save();
        ctx.globalAlpha = sd.prev ? sd.xfade : 1;
        if (sd.scene) sd.scene.draw(t, env, glow, p);
        ctx.restore();

        /* Branches — the one gesture that never resets.
         *
         * Driven by wall-clock time rather than the show's progress, so it
         * keeps extending across every repeat of the piece: new shoots appear
         * every eleven seconds, each takes about ninety to reach full span,
         * and leaves keep budding behind the tips. `reach` grows slowly with
         * elapsed time so later limbs push past the frame onto the wall.
         */
        Effects.branches(ctx, t, env, {
          depth: 5,
          growTime: growth.growTime,
          interval: growth.interval,
          maxTrees: growth.maxTrees,
          length: 0.19,
          /* Reach keeps climbing well past 1 now that there is wall to grow
           * into — a limb at 2.2x the base length clears the frame entirely
           * and spreads across the bare wall beside the painting. */
          reach: 1 + Math.min(1.6, t / 260),
          /* Bright and warm-white. Pale grey limbs at low alpha vanished
           * against pale grey birch bark — new growth has to out-contrast the
           * paint it grows out of, or it may as well not be drawn. */
          intensity: 0.55 + glow * 0.55,
          sway: 0.6 + swell * 1.4,
          // Sampled off the birch trunks, not chosen: warm off-white body, a
          // brighter core where the brush was loaded, near-black bark marks.
          tint: [214, 210, 203],
          coreTint: [240, 236, 229],
          barkTint: [45, 46, 50],
          leafTint: [178, 218, 132],
        });

        /* Beat events, above the scene. These are what the music actually
         * makes: rings crossing the canvas and bars of light travelling it,
         * each outliving the beat that spawned it. */
        woodBeat(t, a, env.surfaceId);

        /* The wood's own answer: a gust crossing the canopy. No expanding
         * rings and no travelling beam — those are the water's language, and
         * running them here is what made the two paintings look like one
         * effect playing twice. */
        Effects.gustField(ctx, t, env, {
          band: [0.0, 0.62],
          life: 1.8,
          amp: 18 + swell * 22,
          intensity: 0.30 + swell * 0.3,
        });

        /* Relief last and always. It is the one layer that is not literally
         * light from the source; it earns its place by making the impasto
         * catch whatever the scene above just put on the canvas. */
        const src = srcUV();
        Effects.relight(ctx, t, env, {
          angle: Math.atan2(0.5 - src[1], 0.5 - src[0]),
          relief: 2.2 + glow * 1.2,
          spec: 0.20 + glow * 0.5,
          gain: 0.30 + glow * 0.7,
          warmth: 0.55,
          alpha: 0.22 + glow * 0.38,
        });
      },
    },
    {
      name: 'Woodland',
      note: 'Shafts of light and wind in the canopy. No music needed.',
      draw(t, env) {
        Effects.relight(ctx, t, env, { speed: 0.09, relief: 3.0, gain: 0.95, warmth: 0.25 });
        Effects.godRays(ctx, t, env, { origin: [0.45, -0.15], count: 11, intensity: 0.14 });
        Effects.dapple(ctx, t, env, { count: 14, speed: 0.13, intensity: 0.26 });
        Effects.shimmer(ctx, t, env, { band: B_CANOPY, amp: 5, speed: 1.1, strength: 0.20 });
      },
    },
    {
      name: 'Understory',
      note: 'Quiet. Damp light pooling on the forest floor.',
      draw(t, env) {
        Effects.relight(ctx, t, env, { speed: 0.05, relief: 2.4, gain: 0.85, warmth: 0.2 });
        Effects.caustics(ctx, t, env, { band: B_GROUND, strength: 0.18, speed: 0.4 });
        Effects.shimmer(ctx, t, env, { band: B_GROUND, amp: 2.5, speed: 0.3, strength: 0.22 });
      },
    },
  ];

  /* ---------- Asset loading ---------------------------------------------- */

  function loadImage(src) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function buildSurface(def, sceneSet) {
    const s = {
      def, id: def.id, name: def.name, accent: def.accent,
      scenes: sceneSet, sceneIndex: 0,
      // Each painting runs its own scene arc; only the peak clock is shared.
      sceneDir: { scene: null, prev: null, sceneStart: 0, prevStart: 0, xfade: 1 },
      W: 700, H: 945, ref: null, regions: [],
      analysis: createAnalysis(),
    };

    s.stage = document.getElementById(def.dom.stage);
    s.stageCtx = s.stage.getContext('2d');
    s.light = document.createElement('canvas');
    s.ctx = s.light.getContext('2d');

    const photo = await loadImage(def.img);
    if (photo) {
      // Crop the photo down to the canvas, and make that the painting space.
      const sx = def.crop.x * photo.width;
      const sy = def.crop.y * photo.height;
      const sw = def.crop.w * photo.width;
      const sh = def.crop.h * photo.height;

      /* Cap the painting's render width. With a 68% margin on top, a 1400px
       * painting becomes a 2352x3302 target — 7.8 megapixels redrawn every
       * frame, for output that lands on a 1080p projector. The birch canvas
       * was four times the area of the seascape purely because its crop was
       * larger in the source photo. */
      s.W = Math.round(Math.min(620, sw));
      s.H = Math.round(s.W * (sh / sw));

      const off = document.createElement('canvas');
      off.width = s.W; off.height = s.H;
      off.getContext('2d').drawImage(photo, sx, sy, sw, sh, 0, 0, s.W, s.H);
      s.ref = off;   // a canvas is a valid drawImage source, same as an <img>

      // Derive this painting's structure once. Effects that read it degrade to
      // no-ops if it fails, so a missing photo costs features, not a crash.
      const t0 = performance.now();
      s.analysis.build(s.ref, 170);
      console.log(`[analysis:${def.id}] ${def.name} ${s.analysis.w}x${s.analysis.h}, ` +
                  `${s.analysis.edgePts.length} edge points, ` +
                  `${s.analysis.palette.length} palette colours, ` +
                  `${(performance.now() - t0).toFixed(0)}ms`);
    } else {
      console.warn(`[surface:${def.id}] ${def.img} not found — surface disabled`);
      s.missing = true;
    }

    /* The render target is larger than the painting. The painting occupies the
     * inner rectangle and lands exactly on the aligned corners; the margin
     * projects onto the wall around the frame, which is what lets the image
     * extend past its own edges and eventually meet the other painting. */
    s.margin = MARGIN;
    s.padX = Math.round(s.W * MARGIN);
    s.padY = Math.round(s.H * MARGIN);
    s.CW = s.W + s.padX * 2;
    s.CH = s.H + s.padY * 2;

    s.stage.width = s.CW;
    s.stage.height = s.CH;
    s.stage.style.width = s.CW + 'px';
    s.stage.style.height = s.CH + 'px';
    s.light.width = s.CW;
    s.light.height = s.CH;
    s.feather = buildFeather(s.W, s.H);

    s.mapper = createMapper({
      overlay: document.getElementById(def.dom.overlay),
      edges: document.getElementById(def.dom.edges),
      storeKey: def.store,
      accent: def.accent,
    });

    return s;
  }

  /* Swap this surface's state into the module-level bindings the effects and
   * scenes read. Cheaper and far less invasive than threading a surface
   * argument through every effect. */
  /* Only the active surface shows alignment chrome, and only while
   * calibrating. Two overlays both claiming pointer events would make the
   * upper one swallow every drag intended for the lower. */
  function syncChrome() {
    const on = document.body.classList.contains('calibrating');
    // Every surface shows its handles while calibrating; only the active one
    // is draggable. Seeing both quads at once is the point — that is how you
    // tell which painting is which.
    surfaces.forEach((s, i) => s.mapper.setChromeVisible(on, on && i === activeSurface));
  }

  function selectSurface(s) {
    stage = s.stage; stageCtx = s.stageCtx;
    light = s.light; ctx = s.ctx;
    W = s.W; H = s.H; ref = s.ref; regions = s.regions;
    currentSurfaceId = s.id;
    feather = s.feather; padX = s.padX; padY = s.padY;
    Analysis = s.analysis;      // global lexical binding from analysis.js
  }

  async function loadAssets() {
    surfaces.push(await buildSurface(SURFACE_DEFS[0], scenes));
    surfaces.push(await buildSurface(SURFACE_DEFS[1], scenesB));

    try {
      const res = await fetch('regions.json');
      if (res.ok) surfaces[0].regions = await res.json();
    } catch { /* optional file */ }

    selectSurface(surfaces[0]);
  }

  /* ---------- Loop -------------------------------------------------------- */

  /* ---------- Director ----------------------------------------------------
   * Picks the scene from what the music is doing. Three things keep it from
   * behaving like a strobe: a long-window energy average (music is spiky, and
   * reacting to instantaneous level would switch constantly), hysteresis so a
   * value hovering on a boundary doesn't oscillate, and a minimum dwell so a
   * scene always gets time to read before it's replaced.
   */
  const director = {
    on: false,
    energy: 0,          // slow average, 0..1
    beatRate: 0,        // onsets per second, smoothed
    lastSwitch: -99,
    band: -1,
    rot: 0,             // index within the current band's scene list
  };

  const DWELL = 6;          // seconds a scene must run before being replaced
  const MAX_HOLD = 24;      // rotate within the band rather than stagnating
  const HYSTERESIS = 0.05;  // how far past a boundary to commit to a change

  /* Energy bands, quietest first. Each lists several scenes rather than one:
   * a single scene per band means a track that sits at one energy level shows
   * you exactly one animation for its whole duration, and the scenes outside
   * the ladder are never seen at all. Every scene appears in some band. */
  const LADDER = [
    { upTo: 0.14, scenes: ['Nightfall', '✦ Relight', 'Waking'] },
    { upTo: 0.30, scenes: ['Sunset', '✦ Aurora', 'Golden hour'] },
    { upTo: 0.46, scenes: ['✦ Brushflow', 'Rays', 'Raking light'] },
    { upTo: 0.62, scenes: ['♪ Resonate', '✦ Nocturne', '✦ Cartography'] },
    { upTo: 0.80, scenes: ['Downpour', '✦ Prism', 'Storm'] },
    { upTo: 1.01, scenes: ['♪ Tempest', '✦ Ignite', 'Downpour'] },
  ];

  function runDirector(t, aud) {
    if (!director.on || !AudioIn.ready) return;

    // Loudness plus how busy it is — a quiet track with a fast pulse should
    // still rank above a loud drone.
    const inst = Math.min(1, aud.level * 0.55 + aud.bass * 0.25 + director.beatRate * 0.12);
    director.beatRate += ((aud.onset ? 6 : 0) - director.beatRate) * 0.02;
    director.energy += (inst - director.energy) * 0.022;   // ~0.75s time constant

    let target = 0;
    while (target < LADDER.length - 1 && director.energy > LADDER[target].upTo) target++;

    const held = t - director.lastSwitch;
    let pick = null;

    if (target !== director.band) {
      // Require clearing the boundary by the hysteresis margin, and require the
      // current scene to have had its time.
      const movingUp = target > director.band;
      const edge = movingUp
        ? LADDER[Math.max(0, target - 1)].upTo + HYSTERESIS
        : LADDER[target].upTo - HYSTERESIS;
      const committed = movingUp ? director.energy > edge : director.energy < edge;
      if (committed && held > DWELL) {
        director.band = target;
        director.rot = 0;
        pick = LADDER[target].scenes[0];
      }
    } else if (held > MAX_HOLD) {
      // Energy is steady but the scene has run long enough — move to the next
      // one in this band so a constant-level track still varies.
      const band = LADDER[Math.max(0, director.band)];
      director.rot = (director.rot + 1) % band.scenes.length;
      pick = band.scenes[director.rot];
    }

    if (pick) {
      const i = scenes.findIndex(s => s.name === pick);
      const cur = surfaces[activeSurface];
      if (i >= 0 && cur && i !== cur.sceneIndex) {
        cur.sceneIndex = i;
        fadeFrom = t;                // cross-fade rather than cutting
      }
      director.lastSwitch = t;
    }
  }

  // Scene changes fade rather than cut; an instant swap on a wall reads as a glitch.
  let fadeFrom = -99;
  const FADE = 1.1;
  function fadeAmount(t) {
    const age = t - fadeFrom;
    if (age < 0 || age > FADE) return 1;
    // Dip to 25% and back, so the outgoing scene doesn't vanish entirely.
    return 0.25 + 0.75 * Math.abs(Math.cos(Math.PI * age / FADE));
  }

  function frame() {
    const t = (performance.now() - start) / 1000;
    const cam = Camera.sample();
    const aud = AudioIn.sample(t);
    runCatalogue(t);
    runDirector(t, aud);

    // Both paintings render every frame; each swaps its own state in first.
    for (const s of surfaces) {
      if (s.missing) continue;
      selectSurface(s);
      drawSurface(s, t, cam, aud);
    }

    checkViewport();          // fullscreen, display change, window resize

    lastRafAt = performance.now();
    fpsFrames++;
    if (lastRafAt - fpsSince > 500) {
      fps = Math.round(fpsFrames * 1000 / (lastRafAt - fpsSince));
      fpsFrames = 0; fpsSince = lastRafAt;
    }
    if (document.body.classList.contains('calibrating')) updateStatus(cam, aud);
    requestAnimationFrame(safeFrame);
  }

  /* Never let one bad frame kill the wall.
   *
   * requestAnimationFrame does not reschedule a callback that throws, so a
   * single exception anywhere in the draw path stops rendering permanently —
   * and it looks identical to a backgrounded tab: DOM responsive, keys
   * working, canvas frozen. Catching here keeps the loop alive and surfaces
   * the fault instead of leaving a dead wall and a misleading warning. */
  let frameErrors = 0;
  let lastFrameError = null;
  function safeFrame() {
    try {
      frame();
    } catch (err) {
      frameErrors++;
      lastFrameError = (err && err.stack) || String(err);
      if (frameErrors <= 3) console.error('[frame]', lastFrameError);
      requestAnimationFrame(safeFrame);   // keep going regardless
    }
  }

  function drawSurface(s, t, cam, aud) {
    const scenes = s.scenes;
    const sceneIndex = s.sceneIndex;
    const env = {
      surfaceId: s.id,
      sceneDir: s.sceneDir,
      W, H, ref,
      // Padded-target geometry, so effects that keep a persistent layer can
      // size and align one to the same space the light layer uses.
      padX, padY, CW: s.CW, CH: s.CH,
      presence: cam.presence,
      x: cam.x,
      energy: cam.energy,
      audio: aud,   // always present; all zeros when there is no microphone
    };

    // --- Light layer: everything the projector emits, on transparent black ---
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, s.CW, s.CH);
    ctx.globalCompositeOperation = 'lighter';
    ctx.save();
    ctx.translate(padX, padY);      // effects keep working in painting space
    if (!showTest) scenes[sceneIndex].draw(t, env);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';

    // Confine the finished light to part of the painting. LIVE only — the
    // single-effect presets exist to be judged in isolation, so masking them
    // would make them harder to read, not better.
    if (!showTest && scenes[sceneIndex].name === '● LIVE') applyMask(t);

    // --- Stage: the painting, then the light on top ---
    /* Clear to transparent, not opaque black.
     *
     * Black is "no light" on a wall, so filling it was harmless while the two
     * targets were small. With a wide margin they overlap, and an opaque fill
     * meant whichever painting drew second punched a black rectangle over the
     * other one's branches and halo. Transparent lets the overlap composite,
     * and the page behind is black anyway. */
    stageCtx.globalCompositeOperation = 'source-over';
    stageCtx.clearRect(0, 0, s.CW, s.CH);

    /* Stand-in for the physical painting, at full strength.
     *
     * This was drawn at 0.45 to simulate a dark room, on the theory that a dim
     * backdrop keeps the preview honest about how much the projector adds. It
     * did the opposite: the painting looked washed out, and every additive
     * wash on top turned the whole thing milky grey. On the wall the projector
     * lights the canvas, so the paint reads at full richness with light added
     * over it — which is what this now shows. */
    if (preview && ref && !showTest) {
      stageCtx.globalAlpha = 1;
      stageCtx.drawImage(ref, padX, padY, W, H);
      stageCtx.globalAlpha = 1;
    }

    if (showTest) {
      Effects.testPattern(stageCtx, t, env);
    } else {
      /* Feather the light layer's edges. Two jobs: it hides the small
       * alignment error that always remains at the painting's border, and it
       * stops the breathing scale below from showing a hard rectangle edge as
       * the light draws back. */
      // Feathering is deliberately not applied any more: it clipped the light
      // to the painting rectangle, which is exactly what the halo must escape.

      // Beat pop at composite time. Because it scales the entire light layer,
      // it is the single most legible beat cue — every layer flashes together.
      /* Kick. On a heavy beat the whole image shoves and springs back —
       * an elastic settle rather than a scale pop, so it reads as the canvas
       * being struck rather than a brightness change. */
      const kickAge = t - kickAt;
      const kick = kickAge < 0.45
        ? Math.exp(-kickAge * 11) * Math.cos(kickAge * 34) * kickPower : 0;
      const bs = breathScale(t, aud) + kick * 0.03;
      const dw = s.CW * bs, dh = s.CH * bs;
      const dx = (s.CW - dw) / 2, dy = (s.CH - dh) / 2;

      stageCtx.globalCompositeOperation = 'lighter';
      // No global flash on the beat. Brightening the entire frame is the
      // laziest possible mapping and it is what made this read as a lamp on a
      // dimmer; beats now spawn ripples and streaks that travel instead.
      stageCtx.globalAlpha = Math.min(2.4, intensity * (1 + hit * 0.10)) * fadeAmount(t);
      stageCtx.drawImage(light, dx + kick * W * 0.012, dy + kick * H * 0.006, dw, dh);
      stageCtx.globalAlpha = 1;
      stageCtx.globalCompositeOperation = 'source-over';
    }

    /* Mark the sun while aligning. Everything radial starts here, so if it is
     * in the wrong place every ray points the wrong way — better to see it
     * than to infer it from the output. */
    if (document.body.classList.contains('calibrating')) {
      const sp = SUN[s.id];
      if (sp) {
        const sx = sp.u * W + padX, sy = sp.v * H + padY;
        stageCtx.save();
        stageCtx.strokeStyle = 'rgba(255,200,60,0.95)';
        stageCtx.lineWidth = 2;
        stageCtx.beginPath();
        stageCtx.arc(sx, sy, 16, 0, Math.PI * 2);
        stageCtx.stroke();
        for (let k = 0; k < 8; k++) {
          const ang = k * Math.PI / 4;
          stageCtx.beginPath();
          stageCtx.moveTo(sx + Math.cos(ang) * 21, sy + Math.sin(ang) * 21);
          stageCtx.lineTo(sx + Math.cos(ang) * 31, sy + Math.sin(ang) * 31);
          stageCtx.stroke();
        }
        stageCtx.fillStyle = 'rgba(255,200,60,0.95)';
        stageCtx.font = '13px ui-monospace, monospace';
        stageCtx.fillText(`sun ${sp.u.toFixed(2)},${sp.v.toFixed(2)}`, sx + 26, sy - 20);
        stageCtx.restore();
      }
    }

    if (document.body.classList.contains('calibrating') && s.id === 'a') {
      // Horizon guide. Seascape only — the birch painting has no horizon band. Drawn on the stage so it passes through the same
      // perspective transform as the effects — it shows where the band edge
      // actually lands on the painting, not where it is in flat canvas space.
      const y = HORIZON * H;
      stageCtx.save();
      /* Painting space, not padded-canvas space. Effects draw through a
       * translate of the margin; the guide did not, so it was drawn offset by
       * padX/padY — outside the painting entirely once the margin grew. */
      stageCtx.translate(padX, padY);
      stageCtx.strokeStyle = 'rgba(255,72,160,.9)';
      stageCtx.lineWidth = 2;
      stageCtx.setLineDash([14, 10]);
      stageCtx.beginPath();
      stageCtx.moveTo(0, y);
      stageCtx.lineTo(W, y);
      stageCtx.stroke();
      stageCtx.setLineDash([]);
      stageCtx.fillStyle = 'rgba(255,72,160,.9)';
      stageCtx.font = '600 13px ui-monospace, monospace';
      stageCtx.fillText(`horizon ${HORIZON.toFixed(3)}`, 10, y - 8);
      stageCtx.restore();
    }
  }

  /* The viewport can change with no usable event — Safari fires
   * fullscreenchange before the new size is settled, and nothing fires at all
   * for a display switch. apply() only runs from remap(), which is the change
   * handler, so nothing was re-checking. Polling two integers per frame is
   * cheaper than any event dance and cannot fall out of step. */
  let lastVP = [0, 0];
  function checkViewport() {
    const w = window.innerWidth, h = window.innerHeight;
    if (!w || !h) return;
    if (w === lastVP[0] && h === lastVP[1]) return;
    lastVP = [w, h];
    remap();                     // rescales every quad and redraws its handles
  }

  function remap() {
    for (const s of surfaces) s.mapper.apply(s.stage, s.CW, s.CH, 1 + 2 * s.margin);
    // Mode can change by dragging as well as by key, so keep the HUD in sync.
    if (document.body.classList.contains('calibrating')) renderHud();
  }

  /* ---------- HUD --------------------------------------------------------- */

  function renderHud() {
    const quad = Mapper.mode === 'quad';
    hud.innerHTML =
      `<b>PROJECTION WALL — calibration</b>\n\n` +
      `<b>1.</b> Drag anywhere to move  ·  scroll to resize\n` +
      `<b>2.</b> Then drag single corners for the skew\n\n` +
      `mode  <b>${quad ? 'WHOLE QUAD' : 'CORNER ' + ['TL','TR','BR','BL'][Mapper.selected]}</b>` +
      `   <kbd>Space</kbd> switch\n` +
      `<kbd>←↑→↓</kbd>  nudge 1px  ·  <kbd>Shift</kbd> 10px\n` +
      `<kbd>+</kbd> <kbd>-</kbd>  resize  ·  <kbd>Tab</kbd>  next corner\n` +
      `<kbd>K</kbd>  ${surfaces[0] && surfaces[0].mapper.rectLocked
          ? 'rectangle locked — press for free corners (keystone)'
          : '<b>free corners</b> — press to lock back to a rectangle'}\n` +
      `<kbd>T</kbd>  test pattern  ·  <kbd>R</kbd>  reset to painting shape\n` +
      `<kbd>1</kbd>  ● LIVE — the whole piece. Leave it here.\n` +
      `<kbd>2</kbd>…<kbd>9</kbd><kbd>0</kbd> <kbd>⇧</kbd><kbd>1</kbd>…<kbd>8</kbd>  single-effect presets (${scenes.length - 1})\n` +
      `<kbd>O</kbd>  play a music file (or drop one on the window)\n` +
      `<kbd>g</kbd> <kbd>G</kbd>  noise gate down / up\n` +
      `<kbd>D</kbd>  demo sweep — play the whole arc without music\n` +
      `<kbd>V</kbd>  <b>catalogue</b> — every scene, with its music bindings\n` +
      `      <kbd>[</kbd> <kbd>]</kbd> step  ·  <kbd>0</kbd> hold this scene\n` +
      `<kbd>S</kbd>  restart piece  ·  <kbd>B</kbd>  jump to climax  ·  <kbd>X</kbd>  free-run\n` +
      `<kbd>P</kbd>  preview  ·  <kbd>A</kbd>  retry mic (asked automatically)\n` +
      `<kbd>M</kbd>  cycle presets by energy  ·  <kbd>,</kbd> <kbd>.</kbd>  brightness\n` +
      `<kbd>;</kbd> <kbd>'</kbd>  horizon up/down  ·  <kbd>Shift</kbd> 4x\n` +
      `<kbd>H</kbd>  hide text only  ·  <kbd>C</kbd>  hide alignment overlay\n` +
      `<kbd>F</kbd>  fullscreen\n`;
  }

  // Little text VU bar, so you can see the analyser working before trusting it.
  function meter(v, width = 10) {
    const n = Math.round(Math.min(1, Math.max(0, v)) * width);
    return '█'.repeat(n) + '·'.repeat(width - n);
  }

  function updateStatus(cam, aud) {
    const camLine = Camera.ready
      ? `camera  presence ${meter(cam.presence)} x ${cam.x.toFixed(2)}`
      : `camera  ${cam.error ? 'unavailable' : 'starting…'}`;
    const audLine = AudioIn.ready
      ? `audio   bass ${meter(aud.bass, 8)} mid ${meter(aud.mid, 8)} ` +
        `treb ${meter(aud.treble, 8)} beat ${meter(aud.beat, 5)}`
      : `audio   ${aud.error ? 'unavailable' : 'press A to enable'}`;
    const cur = surfaces[activeSurface];
    if (!cur) return;
    const scene = cur.scenes[cur.sceneIndex];
    // Live mix readout — which layers are actually carrying the piece.
    const bar = v => {
      const n = Math.round(Math.max(0, Math.min(1, v)) * 8);
      return '█'.repeat(n) + '·'.repeat(8 - n);
    };
    // Raw-vs-gate readout: the fastest way to tell "mic hears nothing" from
    // "mic hears it but the gate is eating it".
    const dg = AudioIn.diagnose();
    const rawLine = dg.raw
      ? `raw    lvl ${dg.raw.level}  bass ${dg.raw.bass}\n` +
        `gate   lvl ${dg.gate.level}  bass ${dg.gate.bass}   ` +
        `<b>x${AudioIn.gate.toFixed(2)}</b>  (g / G)  ` +
        `${dg.raw.level > dg.gate.level ? '<span style="color:#0f8">OPEN</span>'
                                        : '<span style="color:#fc4">closed</span>'}\n`
      : '';
    const mixLine = scene.name === '● LIVE'
      ? `movement <b>${MOVEMENTS[movTo].name}</b>` +
        (movX < 1 ? `  ← ${MOVEMENTS[movFrom].name} ${(movX * 100) | 0}%` : '') + `\n` +
        `focus    <b>${MASKS[maskTo].name}</b>` +
        (maskX < 1 ? `  ← ${MASKS[maskFrom].name} ${(maskX * 100) | 0}%` : '') + `\n` +
        `energy ${bar(energy)} ${AudioIn.ready
            ? (AudioIn.source.includes('stalled')
                ? `<span style="color:#f66">STALLED · feed stopped, reconnecting</span>`
                : `<span style="color:#0f8">LIVE · ${AudioIn.source}</span>`)
            : '<span style="color:#fc4">NO AUDIO — idle mode. Press O or drop a track.</span>'}\n` +
        // Surface the whole diagnostic here rather than only in the console —
        // "NO MIC" alone gives you nothing to act on.
        (AudioIn.ready ? '' : (() => {
          const d = AudioIn.diagnose();
          const yn = v => v ? '<span style="color:#0f8">yes</span>'
                            : '<span style="color:#f66">NO</span>';
          return `<span style="color:#fc4">` +
            `origin   ${d.origin}\n` +
            `secure   ${yn(d.secure)}   getUserMedia ${yn(d.hasMediaDevices)}\n` +
            `permit   ${d.permission}   audioctx ${d.ctxState}\n` +
            `error    ${d.error || '(none — never requested)'}\n` +
            `tries    ${micAttempts}   ← must increase each time you press A` +
            `</span>\n`;
        })()) +
        `punch  ${bar(punch)}\n` +
        Object.keys(mix).map(k => `${k.padEnd(9)}${bar(mix[k])}`).join('\n')
      : '';

    // Where we are in the piece — act, elapsed, and remaining.
    const stNow = showState((performance.now() - start) / 1000);
    const health =
      `<b style="color:${fps < 20 ? '#f66' : '#0f8'}">${fps} fps</b>   ` +
      `canvas-filter ${CANVAS_FILTER_OK
        ? '<span style="color:#0f8">yes</span>'
        : '<span style="color:#f66">NO — bloom and halo will not blur</span>'}   ` +
      `${navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome')
        ? 'Safari' : 'Chromium'}\n`;
    const showLine = stNow
      ? `<b style="color:#0f8">SHOW</b>  ${stNow.act.name}  ` +
        `${Math.floor(stNow.p * SHOW.duration / 60)}:` +
        `${String(Math.floor(stNow.p * SHOW.duration) % 60).padStart(2, '0')}` +
        ` / ${SHOW.duration / 60}:00   ` +
        `lead ${stNow.act.lead === 'a' ? 'Seascape' : 'Birches'}   ` +
        `${bar(showEnvelope(stNow))}\n`
      : `<span style="color:#666">no show running — press S</span>\n`;
    const dirLine = director.on
      ? `<span style="color:#0f8">AUTO</span>  energy ${meter(director.energy)} ` +
        `→ band ${Math.max(0, director.band)} [${LADDER[Math.max(0, director.band)].scenes.join(', ')}]`
      : `manual  (press M for music-directed scenes)`;
    statusEl.innerHTML =
      `surface <b style="color:${cur.accent}">${cur.name}</b>  (\\ to switch)\n` +
      `scene  ${cur.sceneIndex + 1}/${cur.scenes.length}  ${scene.name}\n` +
      // Which of the twenty is actually on the wall, and what follows it.
      (cur.sceneDir && cur.sceneDir.scene
        ? `       <b style="color:${cur.accent}">${cur.sceneDir.scene.name}</b>` +
          `${cur.sceneDir.prev && cur.sceneDir.xfade < 1
              ? `  ← ${cur.sceneDir.prev.name} ${Math.round((1 - cur.sceneDir.xfade) * 100)}%` : ''}` +
          `   (${cur.id === 'a' ? 20 : 20} in pool)\n`
        : '') +
      `       ${scene.note}\n` +
      `bright ${meter(intensity / 2)} ${intensity.toFixed(1)}x   ` +
      `space ${W}x${H}   photo ${ref ? 'ok' : 'none'}\n` +
      health + showLine + dirLine + `\n` + rawLine + (mixLine ? mixLine + `\n` : '') +
      camLine + `\n` + audLine +
      (preview
        ? `\n<span style="color:#ff5">PREVIEW ON — press P before projecting</span>`
        : '');
  }

  /* ---------- Input ------------------------------------------------------- */

  window.addEventListener('keydown', ev => {
    const calibrating = document.body.classList.contains('calibrating');
    const step = ev.shiftKey ? 10 : 1;

    switch (ev.key) {
      case 'c': case 'C':
        document.body.classList.toggle('calibrating');
        syncChrome();
        renderHud();
        return;
      case 't': case 'T':
        showTest = !showTest;
        return;
      case 'p': case 'P':
        preview = !preview;
        return;
      case '\\':
        // Switch which painting the alignment keys act on. Only the active
        // surface shows its handles, so the two quads never fight for drags.
        activeSurface = (activeSurface + 1) % Math.max(1, surfaces.length);
        syncChrome();
        renderHud();
        return;
      case 'h': case 'H':
        // Text panels only. C toggles the alignment overlay; these are separate
        // so either can be dismissed without losing the other.
        document.body.classList.toggle('nohud');
        return;
      case 's': case 'S':
        // Start or stop the piece. Restarting from the top is deliberate —
        // a show has a beginning.
        // Restart from the top if running, or resume the piece if stopped.
        SHOW.startedAt = (performance.now() - start) / 1000;
        renderHud();
        return;
      case 'k': case 'K': {
        // Rectangle lock. Off = free corners for keystone on an off-axis
        // projector; on = the quad can only ever be a rectangle.
        const locked = surfaces.map(s => s.mapper.toggleRectLock())[0];
        renderHud();
        return;
      }
      case '0':
        if (catalogue.on) {
          catalogue.paused = !catalogue.paused;
          catalogue.at = (performance.now() - start) / 1000;
          return;
        }
        break;
      case '[':
        if (catalogue.on) { stepCatalogue(-1, (performance.now() - start) / 1000); return; }
        break;
      case ']':
        if (catalogue.on) { stepCatalogue(1, (performance.now() - start) / 1000); return; }
        break;
      case 'v': case 'V':
        /* Walk every scene, naming on screen what each one listens to.
         * The key always restores the default hold — a fast walk set from the
         * console for a one-off should not silently persist and leave the
         * catalogue strobing next time it is opened. */
        catalogue.hold = CATALOGUE_HOLD;
        Projection.catalogue();
        renderHud();
        return;
      case 'b': case 'B':
        // Jump straight to the climax. Checking the bright end of the piece
        // should not require waiting three and a half minutes.
        SHOW.startedAt = (performance.now() - start) / 1000 - SHOW.duration * 0.72;
        renderHud();
        return;
      case 'x': case 'X':
        // Leave the piece and fall back to the free-running reactive loop.
        SHOW.startedAt = null;
        renderHud();
        return;
      case 'd': case 'D':
        // Demo: sweep the bands so all six scenes play in about two minutes.
        // Reviewing the arc should not require a stereo.
        demoUntil = demoUntil > 0 ? 0 : 1e9;
        if (demoUntil) lastPeakAt = -999;      // let the peak fire straight away
        renderHud();
        return;
      case 'g':
        // Lower the gate: more of the room counts as music.
        AudioIn.setGate(AudioIn.gate - 0.15);
        return;
      case 'G':
        // Raise the gate: only louder sound gets through.
        AudioIn.setGate(AudioIn.gate + 0.15);
        return;
      case 'a': case 'A':
        // Retry the microphone. The keypress is itself the user gesture Safari
        // requires, so this is the reliable moment to ask.
        micAttempts++;
        AudioIn.start().then(() => {
          AudioIn.resume();
          if (!AudioIn.ready) console.warn('[mic] attempt failed:', AudioIn.signal.error);
        });
        return;
      case 'o': case 'O':
        filePicker.click();          // the click itself is the user gesture
        return;
      case 'm': case 'M':
        // Music-directed mode: the scene follows the track's energy.
        director.on = !director.on;
        if (director.on) {
          AudioIn.start().then(AudioIn.resume);
          director.band = -1;
          director.lastSwitch = -99;
        }
        return;
      case ';':
        setHorizon(HORIZON - (ev.shiftKey ? 0.02 : 0.005));   // raise
        return;
      case "'":
        setHorizon(HORIZON + (ev.shiftKey ? 0.02 : 0.005));   // lower
        return;
      case ',': case '<':
        intensity = Math.max(0.1, intensity - 0.1);
        return;
      case '.': case '>':
        intensity = Math.min(2.0, intensity + 0.1);
        return;
      case 'r': case 'R':
        if (calibrating) { Mapper.reset(); renderHud(); }
        return;
      case 'f': case 'F':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
        return;
      case ' ':
        if (calibrating) {
          ev.preventDefault();
          Mapper.toggleMode();
          renderHud();
        }
        return;
      case '=': case '+':
        if (calibrating) { Mapper.scaleBy(ev.shiftKey ? 1.05 : 1.01); }
        return;
      case '-': case '_':
        if (calibrating) { Mapper.scaleBy(ev.shiftKey ? 1 / 1.05 : 1 / 1.01); }
        return;
      case 'Tab':
        if (calibrating) {
          ev.preventDefault();
          Mapper.selectCorner((Mapper.selected + 1) % 4);
          renderHud();
        }
        return;
      case 'ArrowLeft':  if (calibrating) { ev.preventDefault(); Mapper.nudge(-step, 0); } return;
      case 'ArrowRight': if (calibrating) { ev.preventDefault(); Mapper.nudge( step, 0); } return;
      case 'ArrowUp':    if (calibrating) { ev.preventDefault(); Mapper.nudge(0, -step); } return;
      case 'ArrowDown':  if (calibrating) { ev.preventDefault(); Mapper.nudge(0,  step); } return;
    }

    if (ev.key === 'a' || ev.key === 'A') {
      AudioIn.start().then(() => {
        AudioIn.resume();
        // Enabling the mic while on a scene that ignores audio looks like
        // nothing happened. Jump to the first sound-reactive scene so the
        // effect itself is the confirmation.
        if (!surfaces[activeSurface].scenes[surfaces[activeSurface].sceneIndex].name.startsWith('♪')) {
          const i = scenes.findIndex(s => s.name.startsWith('♪'));
          if (i >= 0) { surfaces[activeSurface].sceneIndex = i; showTest = false; }
        }
      });
      return;
    }

    // 1-9 select scenes 1-9; 0 selects the tenth. Shift+1..7 reach 11-17.
    // Read ev.code for the shifted case: ev.key would be '!' '@' '#' etc,
    // which differs by keyboard layout.
    let n = parseInt(ev.key, 10);
    if (ev.key === '0') n = 10;
    if (ev.shiftKey && /^Digit[1-8]$/.test(ev.code)) {
      n = 10 + parseInt(ev.code.slice(5), 10);
    }
    const cur = surfaces[activeSurface];
    if (!cur) return;
    if (ev.key === '[') n = ((cur.sceneIndex - 1 + cur.scenes.length) % cur.scenes.length) + 1;
    if (ev.key === ']') n = (cur.sceneIndex + 1) % cur.scenes.length + 1;

    if (n >= 1 && n <= cur.scenes.length) {
      cur.sceneIndex = n - 1;
      showTest = false;
      /* Sound-reactive scenes need a microphone; ask for it only when one is
       * actually selected, rather than prompting on load.
       *
       * This keys off an explicit per-scene flag, not the '♪' name prefix it
       * used to test: eight scenes read env.audio but only two are named with
       * the prefix, so the rest ran with silently zeroed audio and never
       * prompted. A declared capability can't drift out of sync with the name. */
      if (cur.scenes[cur.sceneIndex].audio) {
        // Bridge first — it needs no browser permission at all. The mic is the
        // fallback for when the bridge server isn't running.
        AudioIn.startBridge();
        AudioIn.start().then(AudioIn.resume);
      }
    }
  });

  // An AudioContext stays suspended until a user gesture, whatever we do at boot.
  /* Safari (and Chrome under stricter settings) refuse getUserMedia when there
   * has been no user gesture — and LIVE requests the mic during page load,
   * before any interaction exists. That attempt fails and nothing retried it,
   * so the piece stayed in idle mode forever. Any interaction is a valid
   * gesture, so retry here. Throttled, so a denial doesn't spam prompts on
   * every click. */
  let micAttempts = 0;
  let lastMicTry = -99;
  ['click', 'keydown', 'pointerdown'].forEach(e =>
    window.addEventListener(e, () => {
      AudioIn.resume();
      const now = performance.now() / 1000;
      const act = surfaces[activeSurface];
      if (!AudioIn.ready && act && act.scenes[act.sceneIndex].audio && now - lastMicTry > 2) {
        lastMicTry = now;
        AudioIn.start().then(AudioIn.resume);
      }
    }, { once: false }));

  /* Browsers suspend requestAnimationFrame in hidden tabs, so switching tabs
   * freezes the wall until you switch back. Nothing can keep it running while
   * hidden, but the clock keeps advancing — without this reset, returning
   * would hand the scene a multi-minute dt and jump every animation forward.
   * A visible-but-unfocused window is not "hidden", so clicking another app is
   * fine; only changing tabs in this window is a problem. */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) lastFrame = (performance.now() - start) / 1000;
  });

  /* ---------- Audio file input -------------------------------------------
   * Drop a track on the window, or press O. Analysing the file directly beats
   * the microphone for a fixed installation — no permission prompt in any
   * browser, and the signal is the track rather than a room recording of it. */
  const filePicker = document.createElement('input');
  filePicker.type = 'file';
  filePicker.accept = 'audio/*';
  filePicker.style.display = 'none';
  document.body.appendChild(filePicker);
  filePicker.addEventListener('change', () => {
    if (filePicker.files?.[0]) AudioIn.startFile(filePicker.files[0]);
  });

  window.addEventListener('dragover', ev => ev.preventDefault());
  window.addEventListener('drop', ev => {
    ev.preventDefault();
    const f = ev.dataTransfer?.files?.[0];
    if (f && f.type.startsWith('audio')) AudioIn.startFile(f);
  });

  /* A small control surface on `window`, for tuning without editing the file.
   *   Projection.showDuration(600)   set the runtime in seconds
   *   Projection.startShow() / stopShow()
   *   Projection.state()             what is running right now
   */
  /* Branch growth pace, tunable at runtime. The right speed depends on how
   * long anyone stands in front of the wall, which is not knowable from here. */
  const growth = { growTime: 85, interval: 11, maxTrees: 10 };

  /* ---------- Catalogue mode ----------------------------------------------
   * Walks every scene in turn and names, on screen, what it listens to.
   *
   * The bindings are read out of each draw function's own source at runtime
   * rather than maintained as metadata — fifty scenes would drift out of sync
   * with a hand-written list within a day, and the source cannot lie about
   * which signals it actually reads.
   */
  const CATALOGUE_HOLD = 14;     // seconds per scene when opened with V
  const catalogue = { on: false, i: 0, at: 0, hold: CATALOGUE_HOLD, surface: 0, paused: false };

  /* Step by hand. Waiting out a fourteen-second hold to see the next scene is
   * the wrong interaction when you are hunting for a specific one. */
  function stepCatalogue(dir, t) {
    const pool = (surfaces[catalogue.surface].id === 'a' ? SEA : WOOD);
    catalogue.i += dir;
    if (catalogue.i >= pool.length) {
      catalogue.i = 0;
      catalogue.surface = (catalogue.surface + 1) % surfaces.length;
    } else if (catalogue.i < 0) {
      catalogue.surface = (catalogue.surface - 1 + surfaces.length) % surfaces.length;
      catalogue.i = (surfaces[catalogue.surface].id === 'a' ? SEA : WOOD).length - 1;
    }
    catalogue.at = t;            // restart the hold from this scene
  }

  const SIGNAL_LABEL = {
    'a.bass': 'BASS', 'a.mid': 'MID', 'a.treble': 'TREBLE', 'a.level': 'LEVEL',
    'a.onset': 'BEAT', 'hit2': 'beat (slow)', 'hit': 'beat', 'swell': 'sustained energy',
  };

  function sceneSignals(scene) {
    const src = scene.draw.toString();
    const found = [];
    // Signals the scene reads explicitly in its own code.
    for (const [k, label] of Object.entries(SIGNAL_LABEL)) {
      if (src.includes(k) && !found.includes(label)) found.push(label);
    }
    /* Plus the bands it inherits through the binding facade — those are just
     * as real, and a scene reporting "level only" while its glitter tracks
     * treble would be a lie. */
    for (const m of src.matchAll(/FX\.(\w+)/g)) {
      const b = BIND[m[1]];
      if (!b) continue;
      const label = { treble: 'TREBLE', bass: 'BASS', mid: 'MID', level: 'LEVEL' }[b.band];
      const tag = `${label} (${m[1]})`;
      if (label && !found.includes(tag)) found.push(tag);
    }
    return found;
  }

  function sceneEffects(scene) {
    const src = scene.draw.toString();
    return [...new Set([...src.matchAll(/(?:Effects|FX)\.(\w+)/g)].map(m => m[1]))];
  }

  function runCatalogue(t) {
    if (!catalogue.on) return;
    const surf = surfaces[catalogue.surface] || surfaces[0];
    const pool = surf.id === 'a' ? SEA : WOOD;

    if (!catalogue.paused && t - catalogue.at > catalogue.hold) {
      catalogue.at = t;
      catalogue.i++;
      if (catalogue.i >= pool.length) {
        // Finished this painting — move to the other one.
        catalogue.i = 0;
        catalogue.surface = (catalogue.surface + 1) % surfaces.length;
      }
    }

    const cur = (surfaces[catalogue.surface].id === 'a' ? SEA : WOOD)[catalogue.i];
    if (!cur) return;

    // Force every surface onto this scene so it is unambiguous which is which.
    for (const s of surfaces) {
      const p = s.id === 'a' ? SEA : WOOD;
      const match = p.find(x => x.name === cur.name) || p[Math.min(catalogue.i, p.length - 1)];
      if (s.sceneDir.scene !== match) {
        s.sceneDir.prev = s.sceneDir.scene;
        s.sceneDir.scene = match;
        s.sceneDir.sceneStart = t;
        s.sceneDir.xfade = 0;
      }
    }

    const sig = sceneSignals(cur);
    const a = AudioIn.signal;
    const bar = v => '█'.repeat(Math.round(Math.max(0, Math.min(1, v)) * 12))
                     .padEnd(12, '·');
    document.getElementById('catWhich').textContent =
      `${surfaces[catalogue.surface].name}   ${catalogue.i + 1} / ${(surfaces[catalogue.surface].id === 'a' ? SEA : WOOD).length}` +
      `   ·   bands ${cur.bands.join(',')}${cur.peak ? '   · PEAK' : ''}${cur.fall ? '   · COMEDOWN' : ''}`;
    document.getElementById('catName').textContent =
      cur.name + (catalogue.paused ? '   ⏸' : '');
    document.getElementById('catFx').textContent = sceneEffects(cur).join(' · ');
    document.getElementById('catMusic').textContent = sig.length
      ? 'listens to: ' + sig.join(', ')
      : 'listens to: overall level only (no band binding)';
    document.getElementById('catBars').innerHTML =
      `bass ${bar(a.bass)}  mid ${bar(a.mid)}  treb ${bar(a.treble)}  lvl ${bar(a.level)}`;
  }

  window.Projection = {
    /* Projection.sun('a', 0.40, 0.28) — where the light in a painting comes
     * from, in painting fractions. Everything radial originates here. */
    sun(id, u, v) {
      if (u == null) return SUN;
      return setSun(id, u, v);
    },

    /* Projection.catalogue(seconds) — walk every scene, naming what it hears. */
    catalogue(hold) {
      catalogue.on = !catalogue.on;
      if (hold) catalogue.hold = hold;
      /* Resume where it left off rather than restarting. Toggling the overlay
       * off to look at something and back on should not throw away your place
       * in a fifty-scene walk. Projection.catalogue and the V key both reset
       * only via restartCatalogue(). */
      // Restart the hold from now. Zeroing it meant that on any page older
      // than the hold the scene was instantly overdue and ticked forward the
      // moment the overlay reopened.
      catalogue.at = (performance.now() - start) / 1000;
      document.body.classList.toggle('catalogue', catalogue.on);
      SHOW.startedAt = catalogue.on ? null : 0;   // the arc would fight it
      return catalogue.on ? `catalogue on, ${catalogue.hold}s per scene` : 'catalogue off';
    },
    /* Projection.growth(180) — seconds for one shoot to reach full span.
     * New shoots arrive at a proportional rate, so the thicket stays as dense,
     * it just fills in more slowly. */
    growth(seconds, trees) {
      if (seconds) {
        growth.growTime = Math.max(10, seconds);
        growth.interval = Math.max(2, seconds / 7.7);
      }
      if (trees) growth.maxTrees = Math.max(2, trees);
      return { ...growth };
    },
    showDuration(sec) { SHOW.duration = Math.max(20, sec); return SHOW.duration; },
    startShow() { SHOW.startedAt = (performance.now() - start) / 1000; },
    // Jump to a fraction of the piece, 0..1 — for reviewing the climax without
    // sitting through the build.
    seek(frac) {
      const t = (performance.now() - start) / 1000;
      SHOW.startedAt = t - Math.max(0, Math.min(0.999, frac)) * SHOW.duration;
      return this.state().show;
    },
    stopShow() { SHOW.startedAt = null; },
    state() {
      const t = (performance.now() - start) / 1000;
      const st = showState(t);
      return {
        show: st ? { act: st.act.name, percent: +(st.p * 100).toFixed(1),
                     lead: st.act.lead, envelope: +showEnvelope(st).toFixed(2) } : null,
        surfaces: surfaces.map(s => ({
          name: s.name, scene: s.sceneDir.scene && s.sceneDir.scene.name })),
        energy: +energy.toFixed(2),
        frameErrors, lastFrameError,
        // What srcUV() actually returns for each painting — the value every
        // radial effect is handed.
        sunUsed: surfaces.map(s => {
          const prev = currentSurfaceId;
          currentSurfaceId = s.id;
          const uv = srcUV();
          currentSurfaceId = prev;
          return { id: s.id, name: s.name, uv };
        }),
      };
    },
  };

  /* Freeze detector.
   *
   * requestAnimationFrame is suspended in a background or fully-occluded tab,
   * which stops the canvas dead while the DOM chrome keeps working — so the
   * alignment handles still drag and the painting never changes. That failure
   * is invisible and looks exactly like broken content.
   *
   * setInterval keeps running (throttled) when rAF does not, so it can watch
   * for the stall and say so in the DOM, where it will still be seen. */
  let lastRafAt = performance.now();
  /* Live frame rate, and whether this browser supports the canvas filter
   * property. Safari only gained ctx.filter recently; without it `bloom` and
   * the beyond-the-frame halo silently draw unblurred, which changes the look
   * completely and reports no error anywhere. Both belong on screen, because
   * this is the information needed to tell a content problem from a browser one. */
  let fps = 0, fpsFrames = 0, fpsSince = performance.now();
  const CANVAS_FILTER_OK = (() => {
    const c = document.createElement('canvas').getContext('2d');
    c.filter = 'blur(2px)';
    return c.filter === 'blur(2px)';
  })();
  const freezeWarn = document.createElement('div');
  freezeWarn.style.cssText =
    'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:99999;' +
    'background:#a00;color:#fff;padding:18px 26px;font:600 15px/1.5 ui-monospace,monospace;' +
    'border-radius:6px;display:none;text-align:center;pointer-events:none;max-width:80vw';
  freezeWarn.innerHTML =
    'RENDERING PAUSED<br><span style="font-weight:400;font-size:13px">' +
    'This browser tab is in the background, so the canvas is frozen.<br>' +
    'Bring this tab to the front — switching apps is fine, switching tabs is not.</span>';
  document.body.appendChild(freezeWarn);

  setInterval(() => {
    const stalled = performance.now() - lastRafAt > 1000;
    freezeWarn.style.display = stalled ? 'block' : 'none';
  }, 700);

  /* Report health back to the bridge every few seconds. This exists so the
   * behaviour of a browser that cannot be inspected remotely still shows up
   * somewhere readable — the server log. */
  setInterval(() => {
    const t = (performance.now() - start) / 1000;
    const st = showState(t);
    const d = AudioIn.diagnose();
    const payload = {
      ua: navigator.userAgent.includes('Chrome') ? 'Chromium'
        : navigator.userAgent.includes('Safari') ? 'Safari' : 'other',
      fps,
      canvasFilter: CANVAS_FILTER_OK,
      hidden: document.hidden,
      show: st ? { act: st.act.name, pct: +(st.p * 100).toFixed(0), env: +showEnvelope(st).toFixed(2) } : null,
      preview,
      showTest,
      intensity: +intensity.toFixed(2),
      audio: { source: d.source, ready: d.started, raw: d.raw },
      surfaces: surfaces.map(s => ({
        id: s.id, scene: s.sceneDir.scene && s.sceneDir.scene.name,
        canvas: [s.CW, s.CH],
      })),
      // What the stage is actually emitting, which is the number that matters.
      stageMean: (() => {
        try {
          const c = surfaces[0] && surfaces[0].stage;
          if (!c) return null;
          const g = c.getContext('2d');
          // Centre of the canvas — the corner is padding and always black.
          const w = Math.min(200, c.width), h = Math.min(200, c.height);
          const im = g.getImageData((c.width - w) / 2 | 0, (c.height - h) / 2 | 0, w, h).data;
          let sum = 0;
          for (let i = 0; i < im.length; i += 4) sum += (im[i] + im[i + 1] + im[i + 2]) / 3;
          return +(sum / (im.length / 4)).toFixed(1);
        } catch { return 'blocked'; }
      })(),
    };
    fetch('/diag', { method: 'POST', body: JSON.stringify(payload) }).catch(() => {});
  }, 4000);

  /* ---------- Boot -------------------------------------------------------- */

  (async () => {
    AudioIn.startBridge();      // harmless if the bridge server isn't running
    await loadAssets();
    // Each surface's quad starts at its own painting's proportions.
    surfaces.forEach((surf, i) => {
      surf.mapper.init(remap, surf.W / surf.H);
      /* A surface with no stored alignment is laid out side by side rather
       * than at centre, and saved immediately. Otherwise both default to the
       * middle, stack, and the one drawn second hides the other entirely. */
      if (!surf.mapper.hasSaved) surf.mapper.placeInSlot(i, surfaces.length);
      // The measured sun overrides whatever the detector guessed.
      if (surf.analysis && SUN[surf.id]) {
        surf.analysis.setLightSource(SUN[surf.id].u, SUN[surf.id].v);
      }
    });
    syncChrome();
    remap();
    renderHud();
    safeFrame();
    Camera.start();   // async; effects run fine before it resolves
  })();
})();
