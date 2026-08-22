/* effects.js — additive effects drawn in painting space.
 *
 * EVERY effect here composites with 'lighter' (additive blending), because a
 * projector can only add light to the painting — it can never darken it. An
 * effect that relies on drawing something dark will simply be invisible on the
 * wall. Think in glows, embers, rays, shimmer, warm washes.
 *
 * Each effect gets (ctx, t, env) where:
 *   ctx  2D context in painting space, origin at the painting's top-left
 *   t    seconds since start
 *   env  { W, H, presence, x, energy, ref }  — ref is the painting photo or null
 */

const Effects = (() => {

  /* ---------- Raking light ------------------------------------------------
   * A soft bar of light sweeping across, as if a window were opening somewhere
   * off-frame. Reads as texture and depth on impasto or canvas weave. */
  function sweep(ctx, t, env) {
    const { W, H } = env;
    const period = 9;
    const p = ((t % period) / period);
    const cx = -0.3 * W + p * 1.6 * W;
    const width = W * 0.28;

    const g = ctx.createLinearGradient(cx - width, 0, cx + width, 0);
    g.addColorStop(0.0, 'rgba(255,240,214,0)');
    g.addColorStop(0.5, 'rgba(255,240,214,0.30)');
    g.addColorStop(1.0, 'rgba(255,240,214,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /* ---------- Shimmer -----------------------------------------------------
   * Redraws horizontal strips of the painting's own photograph, each offset by
   * a travelling sine. Because it composites additively, the result is a
   * brightening ripple that follows the painting's real content — water,
   * foliage and cloth come alive; flat areas stay quiet.
   *
   * Confine it with `band` so only part of the painting ripples. */
  function shimmer(ctx, t, env, opts = {}) {
    const { W, H, ref } = env;
    if (!ref) return;
    const band = opts.band || [0.6, 1.0];      // fraction of height to affect
    const amp = opts.amp ?? 4;                 // px of horizontal displacement
    const speed = opts.speed ?? 1.4;
    const strength = opts.strength ?? 0.35;

    const y0 = Math.floor(band[0] * H);
    const y1 = Math.floor(band[1] * H);
    const step = 2;

    ctx.save();
    ctx.globalAlpha = strength;
    const sx = ref.width / W, sy = ref.height / H;

    for (let y = y0; y < y1; y += step) {
      // Fade the ripple in at the band's top edge so it has no hard seam.
      const depth = (y - y0) / Math.max(1, y1 - y0);
      const dx = Math.sin(y * 0.06 + t * speed) * amp * depth
               + Math.sin(y * 0.17 - t * speed * 0.7) * amp * 0.4 * depth;
      ctx.drawImage(
        ref,
        0, y * sy, ref.width, step * sy,   // source strip
        dx, y, W, step                      // destination, displaced
      );
    }
    ctx.restore();
  }

  /* ---------- Glitter -----------------------------------------------------
   * Sharp twinkling points confined to a rectangle — sun glitter on water.
   * The high exponent on the sine is what makes it read as glinting rather
   * than pulsing: each point is dark most of the time and flares briefly.
   * Positions are hash-derived, so the pattern is stable across reloads. */
  function glitter(ctx, t, env, opts = {}) {
    const { W, H } = env;
    const [rx, ry, rw, rh] = opts.region || [0.30, 0.58, 0.32, 0.42];
    const count = opts.count ?? 90;
    const speed = opts.speed ?? 2.2;
    const size = opts.size ?? 2.4;
    const intensity = opts.intensity ?? 0.75;
    const tint = opts.tint || [255, 228, 150];

    for (let i = 0; i < count; i++) {
      // Cheap deterministic hash — same layout every run.
      const h1 = Math.abs(Math.sin(i * 127.1) * 43758.5453) % 1;
      const h2 = Math.abs(Math.sin(i * 311.7) * 24634.6345) % 1;
      const h3 = Math.abs(Math.sin(i * 74.7) * 51893.7621) % 1;

      // Concentrate toward the centre of the band, as a real glitter path is.
      // `uniform` spreads them evenly instead — that's what makes stars.
      const bias = opts.uniform ? h1 : (h1 - 0.5) * (0.6 + 0.4 * h3) + 0.5;
      const px = (rx + bias * rw) * W + Math.sin(t * 0.4 + i) * 3;
      const py = (ry + h2 * rh) * H;

      const flare = Math.pow(Math.max(0, Math.sin(t * speed * (0.6 + h3) + h1 * 9)), 9);
      if (flare < 0.02) continue;
      const a = flare * intensity;
      const r = size * (0.6 + h3 * 1.2);

      const g = ctx.createRadialGradient(px, py, 0, px, py, r * 4);
      g.addColorStop(0, `rgba(${tint[0]},${tint[1]},${tint[2]},${a})`);
      g.addColorStop(1, `rgba(${tint[0]},${tint[1]},${tint[2]},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, r * 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---------- Cascade -----------------------------------------------------
   * Vertical flow: narrow vertical strips scrolled downward at varying rates.
   * Built for falling water. This painting is a seascape, so it goes unused by
   * the stock scenes — kept because it suits any painting with vertical
   * movement (waterfalls, rain, drapery). */
  function cascade(ctx, t, env, opts = {}) {
    const { W, H, ref } = env;
    if (!ref) return;
    const band = opts.band || [0.55, 0.88];   // fraction of width to affect
    const speed = opts.speed ?? 110;          // px/sec, before per-lane variance
    const strength = opts.strength ?? 0.30;
    const stripW = opts.stripW ?? 3;

    const x0 = Math.floor(band[0] * W);
    const x1 = Math.floor(band[1] * W);
    const span = Math.max(1, x1 - x0);
    const sx = ref.width / W, sy = ref.height / H;

    ctx.save();
    for (let x = x0; x < x1; x += stripW) {
      const u = (x - x0) / span;
      // Deterministic per-lane variance — same lanes every run, no jitter.
      const noise = (Math.sin((x + 1) * 12.9898) * 43758.5453) % 1;
      const rate = speed * (0.55 + 0.9 * Math.abs(noise));
      const dy = (t * rate) % H;

      // Taper alpha at the band edges so there is no hard vertical seam.
      const edge = Math.min(u, 1 - u) / 0.18;
      ctx.globalAlpha = strength * Math.min(1, Math.max(0, edge));

      const sw = stripW * sx;
      // Two draws give a seamless wrap as the strip scrolls off the bottom.
      ctx.drawImage(ref, x * sx, 0, sw, ref.height, x, dy,     stripW, H);
      ctx.drawImage(ref, x * sx, 0, sw, ref.height, x, dy - H, stripW, H);
    }
    ctx.restore();
  }

  /* ---------- Lightning ---------------------------------------------------
   * Rare, brief, full-field flash with a double-strike. Cheap, and it resets
   * the viewer's attention — very effective on a stormy painting. */
  let nextStrike = 6 + Math.random() * 10;
  let strikeAt = -99;
  function lightning(ctx, t, env, opts = {}) {
    const { W, H } = env;
    // `trigger` lets a caller fire on a musical hit rather than the timer.
    // The 1.2s floor keeps a dense passage from turning this into a strobe.
    // `timer: false` disables the free-running schedule entirely, for callers
    // driving this purely from beats — otherwise the timer fires once on the
    // first frame, since nextStrike starts at zero.
    const forced = opts.trigger && t - strikeAt > 1.2;
    const scheduled = (opts.timer ?? true) && t > nextStrike;
    if (forced || scheduled) {
      strikeAt = t;
      nextStrike = t + (opts.minGap ?? 9) + Math.random() * (opts.jitter ?? 14);
    }
    const age = t - strikeAt;
    if (age < 0 || age > 0.42) return;

    // Two pulses: sharp initial strike, weaker echo ~180ms later.
    const pulse = Math.exp(-age * 22) + 0.45 * Math.exp(-Math.abs(age - 0.18) * 30);
    const a = Math.min(0.85, pulse * (opts.intensity ?? 0.6));
    ctx.fillStyle = `rgba(214,232,255,${a})`;
    ctx.fillRect(0, 0, W, H);
  }

  /* ---------- Embers ------------------------------------------------------
   * Drifting motes. Additive by nature, so they read beautifully over dark
   * regions of a painting and vanish over bright ones — which is usually the
   * effect you want anyway. */
  const motes = [];
  function embers(ctx, t, env, opts = {}) {
    const { W, H } = env;
    const target = opts.count ?? 70;
    const rise = opts.rise ?? 14;

    while (motes.length < target) {
      motes.push({
        x: Math.random() * W,
        y: H + Math.random() * H * 0.4,
        r: 0.8 + Math.random() * 2.2,
        drift: (Math.random() - 0.5) * 8,
        phase: Math.random() * Math.PI * 2,
        life: 0,
        span: 6 + Math.random() * 8,
      });
    }

    const dt = 1 / 60;
    for (const m of motes) {
      m.life += dt;
      m.y -= rise * dt;
      m.x += Math.sin(t * 0.7 + m.phase) * m.drift * dt;

      if (m.life > m.span || m.y < -20) {
        m.x = Math.random() * W;
        m.y = H + 10;
        m.life = 0;
      }

      // Fade in and out over the mote's lifetime.
      const k = m.life / m.span;
      const alpha = Math.sin(k * Math.PI) * 0.55;
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r * 5);
      g.addColorStop(0, `rgba(255,196,120,${alpha})`);
      g.addColorStop(1, 'rgba(255,140,60,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r * 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---------- God rays ----------------------------------------------------
   * Shafts of light fanning out from the sun. This painting already shows the
   * sun breaking through cloud, so the rays extend something the paint is
   * doing rather than imposing a new idea on it — which is why it reads as the
   * painting moving rather than as a projection sitting on top of it.
   */
  function godRays(ctx, t, env, opts = {}) {
    const { W, H } = env;
    const [ox, oy] = (opts.origin || [0.45, 0.30]);
    const count = opts.count ?? 9;
    const len = (opts.length ?? 1.2) * Math.max(W, H);
    const spread = opts.spread ?? 1.6;          // radians of fan
    const base = opts.angle ?? Math.PI / 2;     // default: downward
    const intensity = opts.intensity ?? 0.15;

    ctx.save();
    ctx.translate(ox * W, oy * H);
    for (let i = 0; i < count; i++) {
      const f = count === 1 ? 0.5 : i / (count - 1);
      // Each ray drifts and breathes on its own phase; in lockstep they read
      // as a rotating fan rather than as light.
      const a = base + (f - 0.5) * spread + Math.sin(t * 0.13 + i * 1.3) * 0.05;
      const wobble = 1 + 0.35 * Math.sin(t * 0.5 + i * 1.7);
      const width = (0.015 + 0.045 * Math.abs(Math.sin(i * 2.4))) * wobble;
      const alpha = intensity * (0.45 + 0.55 * Math.sin(t * 0.37 + i * 2.1));
      if (alpha <= 0) continue;

      ctx.save();
      ctx.rotate(a);
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0.00, `rgba(255,238,196,${alpha})`);
      g.addColorStop(0.35, `rgba(255,226,164,${alpha * 0.45})`);
      g.addColorStop(1.00, 'rgba(255,220,150,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(len, -len * width);
      ctx.lineTo(len, len * width);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  /* ---------- Caustics ----------------------------------------------------
   * The wavering net of light you see on the floor of a pool. Built from four
   * interfering sine fields, raised to a high power so the bright ridges go
   * thin and sharp. Rendered at low resolution and scaled up — the browser's
   * smoothing does the softening for free, and it costs almost nothing. */
  let causticBuf = null, causticCtx = null;
  function caustics(ctx, t, env, opts = {}) {
    const { W, H } = env;
    const band = opts.band || [0.55, 1.0];
    const strength = opts.strength ?? 0.30;
    const scale = opts.scale ?? 1;
    const speed = opts.speed ?? 1;
    const BW = 128, BH = 80;

    if (!causticBuf) {
      causticBuf = document.createElement('canvas');
      causticBuf.width = BW; causticBuf.height = BH;
      causticCtx = causticBuf.getContext('2d');
    }

    const img = causticCtx.createImageData(BW, BH);
    const d = img.data;
    for (let y = 0; y < BH; y++) {
      for (let x = 0; x < BW; x++) {
        const u = (x / BW) * 9 * scale;
        const v = (y / BH) * 14 * scale;
        const s =
          Math.sin(u + t * 0.6 * speed) +
          Math.sin(v - t * 0.4 * speed) +
          Math.sin((u + v) * 0.8 + t * 0.9 * speed) +
          Math.sin((u - v) * 0.6 - t * 0.5 * speed);
        // Normalise to 0..1, then sharpen the peaks into filaments.
        const k = Math.pow(Math.max(0, (s + 4) / 8), 7);
        const i = (y * BW + x) * 4;
        d[i] = 210; d[i + 1] = 238; d[i + 2] = 255;
        d[i + 3] = Math.min(255, k * 255);
      }
    }
    causticCtx.putImageData(img, 0, 0);

    const y0 = band[0] * H, y1 = band[1] * H;
    ctx.save();
    ctx.globalAlpha = strength;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(causticBuf, 0, y0, W, y1 - y0);
    ctx.restore();
  }

  /* ---------- Bloom -------------------------------------------------------
   * Re-projects the painting's own highlights, blurred. Because it composites
   * additively, only the already-bright areas contribute meaningfully, so the
   * sun and its reflection appear to glow from inside the canvas. Three lines
   * of real work and arguably the most convincing effect here. */
  function bloom(ctx, t, env, opts = {}) {
    const { W, H, ref } = env;
    if (!ref) return;
    const amount = opts.amount ?? 0.22;
    const radius = opts.radius ?? 28;
    ctx.save();
    // contrast() crushes the mid-tones so mostly highlights survive the add.
    ctx.filter = `blur(${radius}px) brightness(1.25) contrast(1.7)`;
    ctx.globalAlpha = amount;
    ctx.drawImage(ref, 0, 0, W, H);
    ctx.restore();
  }

  /* ---------- Rain --------------------------------------------------------
   * Slanted streaks. Batched into a single path — 200 individual strokes per
   * frame would cost more than the whole rest of the scene. */
  /* Pools are per-surface. With two paintings on one screen the coordinate
   * spaces differ, so a shared pool would fling particles between them every
   * frame. `env.surfaceId` keys them apart. */
  /* Offscreen buffers, keyed per surface. Keying only on dimensions was a
   * silent performance bug: the two paintings analyse to different heights, so
   * a shared buffer was reallocated twice every frame, for every per-pixel
   * effect. */
  const buffers = new Map();
  function buffer(env, name, w, h) {
    const key = (env.surfaceId || 'a') + ':' + name;
    let b = buffers.get(key);
    if (!b || b.canvas.width !== w || b.canvas.height !== h) {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      b = { canvas, ctx, img: ctx.createImageData(w, h) };
      buffers.set(key, b);
    }
    return b;
  }

  const pools = new Map();
  function pool(env, name) {
    const key = (env.surfaceId || 'a') + ':' + name;
    if (!pools.has(key)) pools.set(key, []);
    return pools.get(key);
  }
  function rain(ctx, t, env, opts = {}) {
    const { W, H } = env;
    const count = opts.count ?? 160;
    const speed = opts.speed ?? 900;
    const slant = opts.slant ?? 0.18;
    const alpha = opts.alpha ?? 0.42;
    // Hairline strokes disappear on a textured canvas at throw distance —
    // streaks need visible width to register as rain rather than noise.
    const width = opts.width ?? 1.6;

    // Stable pool with a faded tail, for the same reason as brushflow: cutting
    // the array mid-fall makes a block of rain vanish between frames.
    const drops = pool(env, 'rain');
    const POOL = opts.pool ?? 420;
    while (drops.length < POOL) {
      drops.push({
        x: Math.random() * W, y: Math.random() * H,
        len: 10 + Math.random() * 26, v: 0.65 + Math.random() * 0.7,
      });
    }
    const visible = Math.min(1, count / POOL);

    const dt = 1 / 60;
    ctx.save();
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    for (let i = 0; i < drops.length; i++) {
      const band = (visible - i / drops.length) * 6;
      if (band <= 0) continue;
      const p = drops[i];
      p.y += speed * p.v * dt;
      p.x += speed * p.v * slant * dt;
      if (p.y > H + p.len) { p.y = -p.len; p.x = Math.random() * W * 1.3 - W * 0.2; }
      ctx.strokeStyle = `rgba(198,222,255,${(alpha * Math.min(1, band)).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.len * slant, p.y - p.len);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------- Follow-spot -------------------------------------------------
   * A soft pool of light tracking the viewer's horizontal position. This is
   * the effect that makes people realise the painting is watching them. */
  function spotlight(ctx, t, env, opts = {}) {
    const { W, H, presence, x } = env;
    if (presence < 0.05) return;

    const radius = (opts.radius ?? 0.38) * W;
    // Camera x is mirrored relative to the wall the viewer faces.
    const cx = (1 - x) * W;
    const cy = H * (opts.height ?? 0.45);
    const intensity = presence * (opts.intensity ?? 0.32);

    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    g.addColorStop(0, `rgba(255,246,228,${intensity})`);
    g.addColorStop(0.55, `rgba(255,236,200,${intensity * 0.35})`);
    g.addColorStop(1, 'rgba(255,230,190,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /* ---------- Breath ------------------------------------------------------
   * Very slow global warm pulse. On its own it's almost subliminal; under other
   * effects it keeps the piece from ever feeling static. */
  function breath(ctx, t, env, opts = {}) {
    const { W, H } = env;
    const base = opts.base ?? 0.05;
    const swing = opts.swing ?? 0.05;
    const a = base + Math.sin(t * 0.22) * swing;
    if (a <= 0) return;
    ctx.fillStyle = `rgba(255,226,180,${a})`;
    ctx.fillRect(0, 0, W, H);
  }

  /* ---------- Region glow -------------------------------------------------
   * Lights one named polygon — a lantern, a window, a face. Regions come from
   * regions.json; see the README for generating that from a photo. */
  function regionGlow(ctx, t, env, region, opts = {}) {
    const { W, H } = env;
    const pts = region.polygon;
    if (!pts || pts.length < 3) return;

    const period = opts.period ?? 4;
    const a = (opts.base ?? 0.15) +
              Math.sin(t * (Math.PI * 2 / period) + (region.phase || 0)) * (opts.swing ?? 0.12);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * W, pts[0][1] * H);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * W, pts[i][1] * H);
    ctx.closePath();
    ctx.filter = `blur(${opts.blur ?? 24}px)`;
    ctx.fillStyle = region.color || `rgba(255,214,150,${Math.max(0, a)})`;
    ctx.fill();
    ctx.restore();
  }

  /* ---------- Alignment test pattern --------------------------------------
   * Not an effect — the thing you actually calibrate against. A border plus a
   * grid: when the border sits exactly on the painting's frame, you're mapped. */
  function testPattern(ctx, t, env) {
    const { W, H } = env;
    ctx.strokeStyle = '#0f8';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, W - 3, H - 3);

    ctx.strokeStyle = 'rgba(0,255,136,0.30)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 12; i++) {
      const x = (i / 12) * W, y = (i / 12) * H;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Corner ticks make sub-pixel alignment judgeable by eye.
    ctx.strokeStyle = '#f0f';
    ctx.lineWidth = 4;
    const k = Math.min(W, H) * 0.08;
    [[0, 0, 1, 1], [W, 0, -1, 1], [W, H, -1, -1], [0, H, 1, -1]].forEach(([x, y, sx, sy]) => {
      ctx.beginPath();
      ctx.moveTo(x, y + sy * k); ctx.lineTo(x, y); ctx.lineTo(x + sx * k, y);
      ctx.stroke();
    });

    ctx.fillStyle = '#0f8';
    ctx.font = '600 20px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${W} x ${H} painting space`, W / 2, H / 2);
  }

  /* Stars: glitter, spread evenly, small, slow and cool. Best over the dark
   * upper-left cloud mass — added light does nothing against the pale sky. */
  function stars(ctx, t, env, opts = {}) {
    glitter(ctx, t, env, {
      region: opts.region || [0.0, 0.0, 0.55, 0.42],
      count: opts.count ?? 70,
      speed: opts.speed ?? 0.7,
      size: opts.size ?? 1.1,
      intensity: opts.intensity ?? 0.5,
      tint: opts.tint || [214, 232, 255],
      uniform: true,
    });
  }

  /* =======================================================================
   * Image-derived effects. These read the painting's own structure via
   * Analysis rather than laying generic motion over the top — the difference
   * between projecting onto a painting and projecting *with* one.
   * ===================================================================== */

  // Shared low-res buffer. Per-pixel work at stage resolution is far too slow
  // in JS; these fields are smooth, so we render small and let drawImage
  // upscale with interpolation — which also softens them pleasantly.
  let lowCanvas = null, lowCtx = null, lowData = null;
  function lowBuffer(w, h) {
    if (!lowCanvas || lowCanvas.width !== w || lowCanvas.height !== h) {
      lowCanvas = document.createElement('canvas');
      lowCanvas.width = w; lowCanvas.height = h;
      lowCtx = lowCanvas.getContext('2d');
      lowData = lowCtx.createImageData(w, h);
    }
    return { c: lowCanvas, g: lowCtx, d: lowData };
  }

  function blitLow(ctx, buf, W, H, alpha) {
    buf.g.putImageData(buf.d, 0, 0);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(buf.c, 0, 0, W, H);
    ctx.restore();
  }

  /* ---------- Relight -----------------------------------------------------
   * Treats the painting's luminance as a height field, derives surface
   * normals from it, and lights it from a moving virtual source. On real
   * impasto this is uncanny: the projected shading lines up with the physical
   * ridges of paint, so the brushwork appears to cast shadows that travel.
   * This is the "light and shadow" effect proper — everything else is glow. */
  function relight(ctx, t, env, opts = {}) {
    if (!Analysis.ready) return;
    const { W, H } = env;
    const aw = Analysis.w, ah = Analysis.h;
    const buf = lowBuffer(aw, ah);
    const d = buf.d.data;
    const gxA = Analysis.gx, gyA = Analysis.gy, lumA = Analysis.lum, rgbA = Analysis.rgb;

    const relief = opts.relief ?? 2.6;      // how pronounced the fake 3D is
    const warmth = opts.warmth ?? 1.0;
    const ambient = opts.ambient ?? 0.12;
    const spec = opts.spec ?? 0.55;
    const gain = opts.gain ?? 1.0;

    // Light orbits; elevation dips so it rakes across the surface periodically.
    const ang = opts.angle ?? t * (opts.speed ?? 0.35);
    const elev = 0.30 + 0.26 * Math.sin(t * 0.21);
    let lx = Math.cos(ang), ly = Math.sin(ang), lz = elev;
    const ll = Math.hypot(lx, ly, lz); lx /= ll; ly /= ll; lz /= ll;

    for (let i = 0, n = aw * ah; i < n; i++) {
      // Normal from the gradient. Negated: bright means "raised" here.
      let nx = -gxA[i] * relief, ny = -gyA[i] * relief, nz = 1;
      const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;

      const diff = Math.max(0, nx * lx + ny * ly + nz * lz);
      // Blinn-style highlight against a fixed viewer straight on.
      let hx = lx, hy = ly, hz = lz + 1;
      const hl = Math.hypot(hx, hy, hz); hx /= hl; hy /= hl; hz /= hl;
      const sp = Math.pow(Math.max(0, nx * hx + ny * hy + nz * hz), 26) * spec;

      const shade = (ambient + diff * 0.95 + sp) * gain;
      /* Tint with the local paint colour so the light belongs to the picture.
       * The luminance term keeps a floor at 0.55 rather than scaling from near
       * zero: this painting is largely dark, and weighting output purely by
       * local brightness left most of the canvas emitting nothing at all. */
      const k = shade * (0.55 + 0.45 * lumA[i]) * 255;
      d[i * 4]     = Math.min(255, k * (0.72 + 0.28 * warmth) * (0.55 + rgbA[i * 3] / 380));
      d[i * 4 + 1] = Math.min(255, k * 0.94 * (0.55 + rgbA[i * 3 + 1] / 380));
      d[i * 4 + 2] = Math.min(255, k * (1.06 - 0.22 * warmth) * (0.55 + rgbA[i * 3 + 2] / 380));
      d[i * 4 + 3] = 255;
    }
    blitLow(ctx, buf, W, H, opts.alpha ?? 0.85);
  }

  /* ---------- Brush flow --------------------------------------------------
   * Particles advected along iso-luminance lines — perpendicular to the
   * gradient, which is to say *along* the brushstrokes. The painting's own
   * mark-making becomes the motion. Each particle takes the colour of the
   * paint beneath it, so the canvas appears to dissolve into moving light. */
  function brushflow(ctx, t, env, opts = {}) {
    if (!Analysis.ready) return;
    const { W, H } = env;
    const count = opts.count ?? 1400;
    const speed = opts.speed ?? 0.055;
    const life = opts.life ?? 3.2;
    const size = opts.size ?? 1.5;

    /* Stable pool. Truncating the array to `count` deletes particles mid-flight,
     * which reads as a visible pop every time the music changes the density.
     * Instead the pool is allocated once at max size and the tail is faded out
     * smoothly, so density changes are continuous. */
    const flowP = pool(env, 'flow');
    const POOL = opts.pool ?? 2400;
    while (flowP.length < POOL) {
      const u = Math.random(), v = Math.random();
      flowP.push({ u, v, pu: u, pv: v, age: Math.random() * life });
    }
    const visible = Math.min(1, count / POOL);

    const dt = 1 / 60;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = size;
    for (let pi = 0; pi < flowP.length; pi++) {
      // Smooth cutoff at the visibility boundary rather than a hard slice.
      const band = (visible - pi / flowP.length) * 6;
      if (band <= 0) continue;
      const vis = Math.min(1, band);
      const p = flowP[pi];
      p.pu = p.u; p.pv = p.v;
      const gx = Analysis.gxAt(p.u, p.v);
      const gy = Analysis.gyAt(p.u, p.v);
      // Rotate 90 degrees: follow the contour rather than climbing it.
      let dx = -gy, dy = gx;
      const m = Math.hypot(dx, dy);
      if (m < 1e-4) {
        // Flat paint has no direction to offer — drift, don't freeze.
        dx = Math.cos(p.v * 9 + t * 0.4); dy = Math.sin(p.u * 9 - t * 0.3);
      } else { dx /= m; dy /= m; }

      p.u += dx * speed * dt;
      p.v += dy * speed * dt;
      p.age += dt;

      if (p.age > life || p.u < 0 || p.u > 1 || p.v < 0 || p.v > 1) {
        p.u = Math.random(); p.v = Math.random(); p.age = 0;
        p.pu = p.u; p.pv = p.v;          // no streak across the respawn jump
      }

      // Fade in and out so respawns don't pop.
      const f = Math.sin(Math.PI * Math.min(1, p.age / life));
      const [r, g, b] = Analysis.rgbAt(p.u, p.v);
      const boost = opts.saturate ?? 1.5;
      ctx.strokeStyle = `rgba(${Math.min(255, r * boost) | 0},${Math.min(255, g * boost) | 0},${Math.min(255, b * boost) | 0},${(f * vis * (opts.intensity ?? 0.5)).toFixed(3)})`;
      // A segment from the previous position, scaled up so the stroke reads as
      // a streak of motion rather than a dot. Dots make this look like dust.
      const tail = opts.tail ?? 9;
      ctx.beginPath();
      ctx.moveTo(p.pu * W, p.pv * H);
      ctx.lineTo((p.pu + (p.u - p.pu) * tail) * W, (p.pv + (p.v - p.pv) * tail) * H);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------- Contours ----------------------------------------------------
   * The painting as a topographic map: bands at fixed luminance levels, with
   * the levels migrating over time so the lines crawl across the forms. */
  function contours(ctx, t, env, opts = {}) {
    if (!Analysis.ready) return;
    const { W, H } = env;
    const aw = Analysis.w, ah = Analysis.h;
    const buf = lowBuffer(aw, ah);
    const d = buf.d.data;
    const lumA = Analysis.lum;

    const levels = opts.levels ?? 15;
    const phase = t * (opts.speed ?? 0.10);
    const thickness = opts.thickness ?? 0.14;
    const tint = opts.tint || [150, 240, 255];

    for (let i = 0, n = aw * ah; i < n; i++) {
      const band = lumA[i] * levels + phase;
      const frac = band - Math.floor(band);
      // Distance to the nearest band edge, wrapped.
      const dist = Math.min(frac, 1 - frac);
      const on = dist < thickness ? 1 - dist / thickness : 0;
      const a = on * on * (opts.intensity ?? 0.85);
      d[i * 4]     = tint[0] * a;
      d[i * 4 + 1] = tint[1] * a;
      d[i * 4 + 2] = tint[2] * a;
      d[i * 4 + 3] = 255;
    }
    blitLow(ctx, buf, W, H, opts.alpha ?? 0.7);
  }

  /* ---------- Chromatic split --------------------------------------------
   * Draws the painting's own three channels back onto itself with diverging
   * offsets — a prism passing over the canvas. Colour comes entirely from the
   * artwork, so it reads as the picture separating rather than a filter. */
  let chanCache = null;
  function chromaSplit(ctx, t, env, opts = {}) {
    const { W, H, ref } = env;
    if (!ref) return;

    if (!chanCache || chanCache.src !== ref) {
      chanCache = { src: ref, layers: [] };
      const masks = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      for (const m of masks) {
        const c = document.createElement('canvas');
        c.width = ref.width; c.height = ref.height;
        const g = c.getContext('2d');
        g.drawImage(ref, 0, 0);
        // Keep one channel by multiplying the others away.
        g.globalCompositeOperation = 'multiply';
        g.fillStyle = `rgb(${m[0] * 255},${m[1] * 255},${m[2] * 255})`;
        g.fillRect(0, 0, c.width, c.height);
        chanCache.layers.push(c);
      }
    }

    const spread = (opts.spread ?? 0.012) * W * (0.5 + 0.5 * Math.sin(t * (opts.speed ?? 0.5)));
    const ang = t * (opts.rotate ?? 0.33);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = opts.intensity ?? 0.6;
    for (let j = 0; j < 3; j++) {
      const a = ang + (j * Math.PI * 2) / 3;
      ctx.drawImage(chanCache.layers[j], Math.cos(a) * spread, Math.sin(a) * spread, W, H);
    }
    ctx.restore();
  }

  /* ---------- Ignite ------------------------------------------------------
   * A wavefront travels across the canvas; the painting's strongest edges
   * light up as it passes and fade behind it. The composition draws itself. */
  function ignite(ctx, t, env, opts = {}) {
    if (!Analysis.ready) return;
    const { W, H } = env;
    const pts = Analysis.edgePts;
    if (!pts.length) return;

    const period = opts.period ?? 7;
    const ang = opts.angle ?? Math.PI * 0.25;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    // Wavefront position along the sweep axis. Free-running on its own timer by
    // default; pass `head` (0..1) to drive it from a beat instead, which is
    // what makes it land on the music rather than near it.
    const head = opts.head != null
      ? opts.head * 1.6 - 0.3
      : ((t % period) / period) * 1.6 - 0.3;
    const width = opts.width ?? 0.14;
    const tint = opts.tint || [255, 214, 150];

    ctx.save();
    for (const p of pts) {
      const proj = p.x * ca + p.y * sa;      // where this point sits on the axis
      const dist = head - proj;
      if (dist < 0 || dist > width) continue;
      const f = 1 - dist / width;            // bright at the front, fading behind
      const a = f * f * p.m * (opts.intensity ?? 1.0);
      if (a < 0.01) continue;
      const r = (opts.size ?? 2.2) * (0.5 + p.m);
      ctx.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ---------- Palette wash ------------------------------------------------
   * Broad drifting fields of colour sampled from the painting's own dominant
   * hues. Because the colours are already in the picture, this deepens the
   * work rather than tinting it. */
  function paletteWash(ctx, t, env, opts = {}) {
    if (!Analysis.ready) return;
    const { W, H } = env;
    const pal = Analysis.palette;
    if (!pal.length) return;

    const n = Math.min(opts.count ?? 4, pal.length);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let j = 0; j < n; j++) {
      const c = pal[j].rgb;
      const ph = t * (opts.speed ?? 0.13) + (j * Math.PI * 2) / n;
      const cx = (0.5 + 0.42 * Math.cos(ph * 1.1 + j)) * W;
      const cy = (0.5 + 0.42 * Math.sin(ph * 0.8 - j)) * H;
      const rad = (opts.radius ?? 0.5) * W * (0.75 + 0.25 * Math.sin(ph * 1.7));
      const a = (opts.intensity ?? 0.30) * (0.55 + 0.45 * Math.sin(ph * 0.9 + j));

      const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      const boost = opts.saturate ?? 1.35;
      const rr = Math.min(255, c[0] * boost) | 0;
      const gg = Math.min(255, c[1] * boost) | 0;
      const bb = Math.min(255, c[2] * boost) | 0;
      grd.addColorStop(0, `rgba(${rr},${gg},${bb},${Math.max(0, a).toFixed(3)})`);
      grd.addColorStop(1, `rgba(${rr},${gg},${bb},0)`);
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  /* ---------- Colour bleed ------------------------------------------------
   * One colour floods outward from a seed and takes over the painting, then
   * recedes. The front is not a circle: its reach at each point is scaled by
   * the local luminance and slowed by strong edges, so the colour runs quickly
   * through open bright passages and pools against painted contours — the way
   * ink spreads through paper rather than a wipe sliding over the top.
   *
   * Runs at analysis resolution and is scaled up; the front is soft enough
   * that the upscale costs nothing visually.
   */

  function bleed(ctx, t, env, opts = {}) {
    // Bare reference, matching the other analysis-driven effects: `Analysis` is
    // a top-level const, which is a lexical binding and NOT a window property,
    // so `window.Analysis` is undefined and would disable this permanently.
    if (!Analysis.ready) return;
    const { W, H } = env;
    const AW = Analysis.w, AH = Analysis.h;
    const lumA = Analysis.lum, edgeA = Analysis.edge;

    const progress = opts.progress ?? 0;         // 0..1, caller drives it
    if (progress <= 0 || progress >= 1) return;

    const seed = opts.seed || [0.5, 0.5];
    const tint = opts.tint || [255, 180, 90];
    const strength = opts.strength ?? 0.55;

    const { canvas: bleedBuf, ctx: bleedCtx, img: bleedImg } = buffer(env, 'bleed', AW, AH);

    // Rise then fall, so the colour floods in and drains away.
    const env01 = Math.sin(Math.PI * progress);
    // Reach past the far corner at full progress, so the flood can complete.
    const front = progress * 1.55;
    const sx = seed[0] * AW, sy = seed[1] * AH;
    const diag = Math.hypot(AW, AH);
    const d = bleedImg.data;

    for (let y = 0; y < AH; y++) {
      for (let x = 0; x < AW; x++) {
        const i = y * AW + x;
        const dist = Math.hypot(x - sx, y - sy) / diag;

        // Bright open paint carries the colour further; edges hold it back.
        const ease = 0.55 + 0.85 * lumA[i] - 0.9 * edgeA[i];
        const reach = front * Math.max(0.15, ease);

        // Soft front, a few percent of the diagonal wide.
        const a = Math.max(0, Math.min(1, (reach - dist) / 0.10));
        if (a <= 0) { d[i * 4 + 3] = 0; continue; }

        const k = a * env01 * strength * (0.45 + 0.55 * lumA[i]) * 255;
        d[i * 4]     = tint[0];
        d[i * 4 + 1] = tint[1];
        d[i * 4 + 2] = tint[2];
        d[i * 4 + 3] = Math.min(255, k);
      }
    }

    bleedCtx.putImageData(bleedImg, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bleedBuf, 0, 0, W, H);
    ctx.restore();
  }

  /* ---------- Dappled light -----------------------------------------------
   * Soft overlapping pools of sunlight drifting as if filtered through a
   * canopy. Each pool travels on its own slow ellipse and breathes at its own
   * rate, so they never form a visible repeating pattern — the giveaway that
   * kills the illusion on a wooded painting.
   */
  function dapple(ctx, t, env, opts = {}) {
    const { W, H } = env;
    const count = opts.count ?? 14;
    const speed = opts.speed ?? 0.14;
    const radius = (opts.radius ?? 0.16) * Math.min(W, H);
    const intensity = opts.intensity ?? 0.32;
    const tint = opts.tint || [255, 246, 190];

    for (let i = 0; i < count; i++) {
      // Deterministic per-pool parameters — stable across reloads.
      const h1 = Math.abs(Math.sin(i * 91.7) * 43758.5453) % 1;
      const h2 = Math.abs(Math.sin(i * 47.3) * 24634.6345) % 1;
      const h3 = Math.abs(Math.sin(i * 133.1) * 51893.7621) % 1;

      const rate = speed * (0.5 + h3);
      const px = (0.10 + 0.80 * h1) * W + Math.sin(t * rate + h2 * 6.3) * W * 0.10;
      const py = (0.05 + 0.85 * h2) * H + Math.cos(t * rate * 0.8 + h1 * 6.3) * H * 0.07;

      // Breathe: pools open and close as the canopy moves.
      const breath = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * rate * 1.7 + h3 * 6.3));
      const r = radius * (0.55 + 0.9 * h3) * breath;
      const a = intensity * breath;
      if (a < 0.01) continue;

      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0.0, `rgba(${tint[0]},${tint[1]},${tint[2]},${a.toFixed(3)})`);
      g.addColorStop(0.55, `rgba(${tint[0]},${tint[1]},${tint[2]},${(a * 0.35).toFixed(3)})`);
      g.addColorStop(1.0, `rgba(${tint[0]},${tint[1]},${tint[2]},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---------- Radiance ----------------------------------------------------
   * The piece's central effect: light welling out of the painting's own light
   * source and spreading across the canvas, in the colour the artist mixed
   * for it.
   *
   * Two things stop it reading as a projected blob. It is tinted from the
   * source's own colour, so it never introduces a hue the painting does not
   * already contain. And its reach at each point is scaled by the local paint
   * — bright passages take light readily and dark ones resist it — so the
   * light runs along the sunlit water, or the gaps between trunks, instead of
   * expanding as a circle. What you see is the picture lighting itself.
   *
   * `reach` is the whole music mapping: 0 is an unlit painting, 1 floods it.
   */

  function radiance(ctx, t, env, opts = {}) {
    if (!Analysis.ready) return;
    const src = Analysis.lightSource;
    // A source may be set manually and lack a sampled colour; fall back to a
    // warm default rather than throwing inside the per-pixel loop.
    const srcRgb = (src && src.rgb) || [255, 220, 170];
    if (!src) return;

    const { W, H } = env;
    const AW = Analysis.w, AH = Analysis.h;
    const lumA = Analysis.lum, rgbA = Analysis.rgb;

    const reach = Math.max(0, Math.min(1.6, opts.reach ?? 0.5));
    if (reach <= 0.01) return;
    const intensity = opts.intensity ?? 0.6;
    const warm = opts.warm ?? 0;              // push toward the source hue

    const { canvas: radBuf, ctx: radCtx, img: radImg } = buffer(env, 'radiance', AW, AH);

    const sx = src.u * AW, sy = src.v * AH;
    const diag = Math.hypot(AW, AH);
    // A slow breath so the light is never perfectly static, even held.
    const pulse = 1 + 0.05 * Math.sin(t * 0.5);
    const d = radImg.data;

    for (let y = 0; y < AH; y++) {
      for (let x = 0; x < AW; x++) {
        const i = y * AW + x;
        const dist = Math.hypot(x - sx, y - sy) / diag;

        // Paint that is already bright carries the light further.
        const carry = 0.45 + 1.05 * lumA[i];
        const front = reach * pulse * carry;
        // Soft edge, so the boundary is a falloff rather than a rim.
        const a = Math.max(0, Math.min(1, (front - dist) / 0.22));
        if (a <= 0.004) { d[i * 4 + 3] = 0; continue; }

        // Blend the local paint colour toward the source's colour: near the
        // sun the light is the sun's, further out it is the paint's own.
        const near = Math.max(0, 1 - dist / Math.max(0.05, front)) * warm;
        const r = rgbA[i * 3]     * (1 - near) + srcRgb[0] * near;
        const g = rgbA[i * 3 + 1] * (1 - near) + srcRgb[1] * near;
        const b = rgbA[i * 3 + 2] * (1 - near) + srcRgb[2] * near;

        const k = a * a * intensity * (0.35 + 0.65 * lumA[i]);
        d[i * 4]     = Math.min(255, r * 1.15);
        d[i * 4 + 1] = Math.min(255, g * 1.15);
        d[i * 4 + 2] = Math.min(255, b * 1.15);
        d[i * 4 + 3] = Math.min(255, k * 255);
      }
    }

    radCtx.putImageData(radImg, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(radBuf, 0, 0, W, H);
    ctx.restore();
  }

  /* ---------- Colour flow -------------------------------------------------
   * The painting's own colours drifting along its own forms.
   *
   * For each point we sample the picture from a slightly displaced position,
   * where the displacement runs *along* the luminance contour — perpendicular
   * to the gradient — and oscillates over time. Colour therefore travels the
   * way the brush travelled: around the trunks, along the water, following the
   * cloud edges, instead of sliding across them.
   *
   * The depth comes from displacing bright and dark paint by different
   * amounts. Highlights swim further than shadows, which is the same parallax
   * cue the eye uses for relief, so a flat canvas starts to look volumetric.
   */

  function colourFlow(ctx, t, env, opts = {}) {
    if (!Analysis.ready) return;
    const { W, H } = env;
    const AW = Analysis.w, AH = Analysis.h;
    const lumA = Analysis.lum, rgbA = Analysis.rgb;
    const gxA = Analysis.gx, gyA = Analysis.gy;

    const amount = opts.amount ?? 0.5;         // 0..1, how far colour travels
    if (amount <= 0.01) return;
    const speed = opts.speed ?? 0.35;
    const intensity = opts.intensity ?? 0.5;
    const depth = opts.depth ?? 1.0;           // how much brights outrun darks

    const { canvas: flowBuf, ctx: flowCtx, img: flowImg } = buffer(env, 'flow', AW, AH);

    const d = flowImg.data;
    const maxPush = amount * AW * 0.055;

    for (let y = 0; y < AH; y++) {
      for (let x = 0; x < AW; x++) {
        const i = y * AW + x;

        // Along the contour, not across it.
        const ang = Math.atan2(gyA[i], gxA[i]) + Math.PI / 2;
        // Brights travel further — this is what produces the relief.
        const reliefScale = 0.35 + depth * lumA[i];
        // Two incommensurate oscillators so the motion never visibly loops.
        const phase = (x * 0.05 + y * 0.037);
        const swing = Math.sin(t * speed + phase)
                    + 0.45 * Math.sin(t * speed * 0.61 - phase * 0.7);
        const push = maxPush * reliefScale * swing;

        let sxp = Math.round(x + Math.cos(ang) * push);
        let syp = Math.round(y + Math.sin(ang) * push);
        if (sxp < 0) sxp = 0; else if (sxp >= AW) sxp = AW - 1;
        if (syp < 0) syp = 0; else if (syp >= AH) syp = AH - 1;
        const j = syp * AW + sxp;

        // Additive, so this can only add light — and weighted by how bright
        // the displaced paint is, so shadows stay put and stay dark.
        const k = intensity * (0.25 + 0.75 * lumA[j]);
        d[i * 4]     = rgbA[j * 3];
        d[i * 4 + 1] = rgbA[j * 3 + 1];
        d[i * 4 + 2] = rgbA[j * 3 + 2];
        d[i * 4 + 3] = Math.min(255, k * 255);
      }
    }

    flowCtx.putImageData(flowImg, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(flowBuf, 0, 0, W, H);
    ctx.restore();
  }

  /* ---------- Cloud drift -------------------------------------------------
   * Sideways advection confined to a band, for skies. Distinct from colourFlow,
   * which follows contours: weather does not care about the forms underneath
   * it, it travels across them. Layers at different heights move at different
   * rates, which is what stops a drifting sky reading as one sliding sheet.
   */
  function drift(ctx, t, env, opts = {}) {
    const { W, H, ref } = env;
    if (!ref) return;
    const band = opts.band || [0.0, 0.45];
    const speed = opts.speed ?? 14;             // px/sec at the fastest layer
    const strength = opts.strength ?? 0.22;
    const turbulence = opts.turbulence ?? 1.0;

    const y0 = Math.floor(band[0] * H), y1 = Math.floor(band[1] * H);
    const step = 3;
    const sy = ref.height / H;

    ctx.save();
    ctx.globalAlpha = strength;
    for (let y = y0; y < y1; y += step) {
      const d = (y - y0) / Math.max(1, y1 - y0);
      // Higher cloud runs faster, as it does in a real sky.
      const rate = speed * (0.35 + 1.3 * (1 - d));
      const wobble = Math.sin(y * 0.03 + t * 0.35) * 6 * turbulence
                   + Math.sin(y * 0.011 - t * 0.21) * 11 * turbulence;
      // Wrap so the band can drift indefinitely without running out of paint.
      let dx = ((t * rate + wobble) % W + W) % W;

      // Fade at both edges of the band so it has no seam.
      const edge = Math.min(d, 1 - d) / 0.18;
      ctx.globalAlpha = strength * Math.min(1, Math.max(0, edge));

      ctx.drawImage(ref, 0, y * sy, ref.width, step * sy, dx,     y, W, step);
      ctx.drawImage(ref, 0, y * sy, ref.width, step * sy, dx - W, y, W, step);
    }
    ctx.restore();
  }

  /* ---------- Colour accent -----------------------------------------------
   * Picks one colour out of the painting and lights only the paint that
   * already matches it — the yellows come up alone, then the teals, then the
   * whites. Because the match is against the artist's own pigment, an accent
   * looks like that colour catching the light rather than a wash laid over it.
   */
  function accent(ctx, t, env, opts = {}) {
    if (!Analysis.ready) return;
    const { W, H } = env;
    const AW = Analysis.w, AH = Analysis.h;
    const rgbA = Analysis.rgb, lumA = Analysis.lum;

    const tint = opts.tint || [255, 220, 120];
    const amount = opts.amount ?? 0.6;
    if (amount <= 0.01) return;
    const tol = opts.tolerance ?? 90;        // RGB distance counted as a match
    const boost = opts.boost || tint;        // colour to light matches with

    const { canvas, ctx: bctx, img } = buffer(env, 'accent', AW, AH);
    const d = img.data;
    const tol2 = tol * tol;

    for (let i = 0; i < AW * AH; i++) {
      const dr = rgbA[i * 3] - tint[0];
      const dg = rgbA[i * 3 + 1] - tint[1];
      const db = rgbA[i * 3 + 2] - tint[2];
      const dist2 = dr * dr + dg * dg + db * db;
      if (dist2 > tol2) { d[i * 4 + 3] = 0; continue; }

      // Squared falloff so only close matches light strongly.
      const w = 1 - dist2 / tol2;
      const k = w * w * amount * (0.35 + 0.65 * lumA[i]);
      d[i * 4]     = boost[0];
      d[i * 4 + 1] = boost[1];
      d[i * 4 + 2] = boost[2];
      d[i * 4 + 3] = Math.min(255, k * 255);
    }

    bctx.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas, 0, 0, W, H);
    ctx.restore();
  }

  /* ---------- Growth ------------------------------------------------------
   * A front of light climbing the canvas, leaving what it passes lit. Written
   * for the birches: light rises up the trunks and they appear to grow. The
   * front is brightest at its leading edge, and it favours pale vertical paint
   * so it climbs the trunks rather than washing the whole canvas upward.
   *
   * `progress` 0..1 drives it, so the caller owns the timing.
   */
  function grow(ctx, t, env, opts = {}) {
    if (!Analysis.ready) return;
    const { W, H } = env;
    const AW = Analysis.w, AH = Analysis.h;
    const lumA = Analysis.lum, rgbA = Analysis.rgb, gxA = Analysis.gx;

    const progress = Math.max(0, Math.min(1, opts.progress ?? 0));
    if (progress <= 0.001) return;
    const intensity = opts.intensity ?? 0.7;
    const edgeWidth = opts.edgeWidth ?? 0.14;

    const { canvas, ctx: bctx, img } = buffer(env, 'grow', AW, AH);
    const d = img.data;
    const front = 1 - progress;         // 1 = bottom, 0 = top

    for (let y = 0; y < AH; y++) {
      const v = y / AH;
      // Behind the front: lit, fading with distance. At it: a bright edge.
      const behind = v > front ? 1 : 0;
      const nearEdge = Math.max(0, 1 - Math.abs(v - front) / edgeWidth);
      if (!behind && nearEdge <= 0) {
        for (let x = 0; x < AW; x++) d[(y * AW + x) * 4 + 3] = 0;
        continue;
      }
      for (let x = 0; x < AW; x++) {
        const i = y * AW + x;
        // Vertical structure: a trunk has strong horizontal gradient (its
        // edges) and pale paint. This keeps growth on the trees.
        const vertical = Math.min(1, Math.abs(gxA[i]) * 1.6);
        const trunk = (0.25 + 0.75 * lumA[i]) * (0.4 + 0.6 * vertical);
        const k = (behind * 0.5 + nearEdge * 1.3) * intensity * trunk;
        if (k < 0.004) { d[i * 4 + 3] = 0; continue; }
        d[i * 4]     = Math.min(255, rgbA[i * 3] * 1.25);
        d[i * 4 + 1] = Math.min(255, rgbA[i * 3 + 1] * 1.25);
        d[i * 4 + 2] = Math.min(255, rgbA[i * 3 + 2] * 1.2);
        d[i * 4 + 3] = Math.min(255, k * 255);
      }
    }

    bctx.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas, 0, 0, W, H);
    ctx.restore();
  }

  /* ---------- Leaves ------------------------------------------------------
   * Soft points opening in the canopy, more of them as `progress` rises, each
   * swelling from nothing to full size. Positions are hash-derived so the
   * canopy fills in the same order every time — leaves appear where the last
   * ones were, which reads as growth rather than as random flicker.
   */
  function leaves(ctx, t, env, opts = {}) {
    const { W, H } = env;
    const [rx, ry, rw, rh] = opts.region || [0.05, 0.0, 0.9, 0.45];
    const max = opts.max ?? 90;
    const progress = Math.max(0, Math.min(1, opts.progress ?? 0));
    if (progress <= 0.001) return;
    const intensity = opts.intensity ?? 0.5;
    const size = opts.size ?? 7;
    const tint = opts.tint || [190, 245, 150];

    const live = max * progress;
    for (let i = 0; i < max; i++) {
      if (i > live) break;
      const h1 = Math.abs(Math.sin(i * 51.3) * 43758.5453) % 1;
      const h2 = Math.abs(Math.sin(i * 97.1) * 24634.6345) % 1;
      const h3 = Math.abs(Math.sin(i * 23.7) * 51893.7621) % 1;

      // Each leaf opens over the last stretch before its index is reached.
      const open = Math.min(1, (live - i));
      if (open <= 0) continue;

      const sway = Math.sin(t * (0.5 + h3 * 0.8) + h1 * 6.3) * 4;
      const px = (rx + h1 * rw) * W + sway;
      const py = (ry + h2 * rh) * H + Math.cos(t * 0.4 + h2 * 6.3) * 2;
      const r = size * (0.5 + h3) * open;
      const a = intensity * open * (0.6 + 0.4 * Math.sin(t * 0.9 + i));

      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(${tint[0]},${tint[1]},${tint[2]},${(a).toFixed(3)})`);
      g.addColorStop(1, `rgba(${tint[0]},${tint[1]},${tint[2]},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---------- Fireflies ---------------------------------------------------
   * Slow wandering points of warm light. Each follows its own looping path at
   * its own rate and blinks on a rhythm of its own, so they never pulse
   * together — synchronised blinking is what makes cheap particle work read as
   * a screensaver. Positions are hash-derived, so the swarm is the same every
   * run and the piece is reproducible.
   */
  function fireflies(ctx, t, env, opts = {}) {
    const { W, H } = env;
    const [rx, ry, rw, rh] = opts.region || [0.03, 0.15, 0.94, 0.8];
    const count = opts.count ?? 22;
    const size = opts.size ?? 5;
    const intensity = opts.intensity ?? 0.5;
    const speed = opts.speed ?? 1;
    const tint = opts.tint || [255, 236, 150];

    for (let i = 0; i < count; i++) {
      const h1 = Math.abs(Math.sin(i * 41.7) * 43758.5453) % 1;
      const h2 = Math.abs(Math.sin(i * 78.3) * 24634.6345) % 1;
      const h3 = Math.abs(Math.sin(i * 19.1) * 51893.7621) % 1;

      // Two out-of-phase circles make a wandering path that never repeats
      // visibly, at a fraction of the cost of real noise.
      const rate = speed * (0.10 + h3 * 0.16);
      const ax = Math.sin(t * rate + h1 * 6.3) * 0.10 + Math.sin(t * rate * 0.53 + h2 * 6.3) * 0.05;
      const ay = Math.cos(t * rate * 0.8 + h2 * 6.3) * 0.07 + Math.cos(t * rate * 0.37 + h1 * 6.3) * 0.04;

      const px = (rx + h1 * rw + ax) * W;
      const py = (ry + h2 * rh + ay) * H;

      // Blink: mostly dim, briefly bright, each on its own clock.
      const blink = Math.pow(Math.max(0, Math.sin(t * (0.5 + h3 * 0.9) + h1 * 9)), 3);
      const a = intensity * (0.15 + 0.85 * blink);
      if (a < 0.01) continue;
      const r = size * (0.6 + h3 * 0.8);

      const g = ctx.createRadialGradient(px, py, 0, px, py, r * 3.2);
      g.addColorStop(0, `rgba(${tint[0]},${tint[1]},${tint[2]},${a.toFixed(3)})`);
      g.addColorStop(0.4, `rgba(${tint[0]},${tint[1]},${tint[2]},${(a * 0.3).toFixed(3)})`);
      g.addColorStop(1, `rgba(${tint[0]},${tint[1]},${tint[2]},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, r * 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---------- Waves -------------------------------------------------------
   * A continuous swell across the water: long low crests travelling toward the
   * viewer, drawn as bands of the painting's own water displaced vertically.
   * Slower and larger than `shimmer`, which is surface chop — this is the body
   * of the sea moving underneath it.
   */
  function waves(ctx, t, env, opts = {}) {
    const { W, H, ref } = env;
    if (!ref) return;
    const band = opts.band || [0.58, 1.0];
    const amp = opts.amp ?? 4;
    const speed = opts.speed ?? 0.5;
    const strength = opts.strength ?? 0.18;
    const wavelength = opts.wavelength ?? 0.22;

    const y0 = Math.floor(band[0] * H), y1 = Math.floor(band[1] * H);
    const step = 3;
    const sy = ref.height / H;

    ctx.save();
    for (let y = y0; y < y1; y += step) {
      const d = (y - y0) / Math.max(1, y1 - y0);
      // Crests grow toward the foreground, as perspective demands.
      const scale = 0.35 + 1.3 * d;
      const phase = d / wavelength;
      const lift = Math.sin(phase * 6.28 - t * speed * 6.28) * amp * scale
                 + Math.sin(phase * 3.1 - t * speed * 3.4) * amp * 0.4 * scale;

      const edge = Math.min(1, d / 0.15);
      ctx.globalAlpha = strength * edge;
      ctx.drawImage(ref, 0, y * sy, ref.width, step * sy, 0, y + lift, W, step);
    }
    ctx.restore();
  }

  /* ---------- Ripples -----------------------------------------------------
   * The answer to "it just flashes on every beat".
   *
   * A beat does not brighten anything here — it drops a stone in the canvas.
   * Each hit spawns an expanding ring that travels outward for a couple of
   * seconds, displacing the paint it passes over and lighting its own crest.
   * Rings from successive beats overlap and cross, so rhythm becomes visible
   * as structure moving through the picture rather than as a lamp on a dimmer.
   *
   * The displacement samples the painting itself, so what ripples is the
   * artist's own brushwork — water, cloud and trunks all deform in their own
   * colours.
   */
  /* Event pools are per surface. These were single shared arrays, so both
   * paintings drew the very same ripples and beams at the very same instant —
   * not merely a shared vocabulary but literally one set of events rendered
   * twice, which is what made the wall look mechanical. */
  const ripplesBy = new Map();
  const streaksBy = new Map();
  const poolFor = (map, id) => {
    let a = map.get(id || 'a');
    if (!a) { a = []; map.set(id || 'a', a); }
    return a;
  };

  function spawnRipple(t, u, v, strength, id) {
    const ripples = poolFor(ripplesBy, id);
    ripples.push({ t0: t, u, v, strength });
    if (ripples.length > 6) ripples.shift();   // cap the cost
  }

  function rippleField(ctx, t, env, opts = {}) {
    const ripples = poolFor(ripplesBy, env.surfaceId);
    if (!Analysis.ready || !ripples.length) return;
    const { W, H } = env;
    const AW = Analysis.w, AH = Analysis.h;
    const rgbA = Analysis.rgb, lumA = Analysis.lum;

    const life = opts.life ?? 2.2;
    const speed = opts.speed ?? 0.55;          // canvas-widths per second
    const amp = opts.amp ?? 9;                 // px of displacement at the crest
    const intensity = opts.intensity ?? 0.55;

    // Retire finished ripples before doing any per-pixel work.
    for (let i = ripples.length - 1; i >= 0; i--) {
      if (t - ripples[i].t0 > life) ripples.splice(i, 1);
    }
    if (!ripples.length) return;

    const { canvas, ctx: bctx, img } = buffer(env, 'ripple', AW, AH);
    const d = img.data;
    const diag = Math.hypot(AW, AH);

    for (let y = 0; y < AH; y++) {
      for (let x = 0; x < AW; x++) {
        const i = y * AW + x;
        let push = 0, crest = 0, dirx = 0, diry = 0;

        for (const r of ripples) {
          const age = t - r.t0;
          const radius = age * speed * diag;
          const dx = x - r.u * AW, dy = y - r.v * AH;
          const dist = Math.hypot(dx, dy);
          // Only the band near the wavefront is affected.
          const off = dist - radius;
          if (Math.abs(off) > diag * 0.09) continue;

          const fall = 1 - age / life;                    // ring fades as it goes
          const band = Math.cos((off / (diag * 0.09)) * 1.57);  // 1 at the crest
          const w = band * band * fall * r.strength;
          push += w;
          crest += w;
          if (dist > 0.01) { dirx += (dx / dist) * w; diry += (dy / dist) * w; }
        }

        if (crest < 0.01) { d[i * 4 + 3] = 0; continue; }

        // Sample the painting pulled back toward the ring's centre.
        const sxp = Math.max(0, Math.min(AW - 1, Math.round(x - dirx * amp)));
        const syp = Math.max(0, Math.min(AH - 1, Math.round(y - diry * amp)));
        const j = syp * AW + sxp;

        const k = Math.min(1, crest) * intensity * (0.3 + 0.7 * lumA[j]);
        d[i * 4]     = Math.min(255, rgbA[j * 3] * 1.3);
        d[i * 4 + 1] = Math.min(255, rgbA[j * 3 + 1] * 1.3);
        d[i * 4 + 2] = Math.min(255, rgbA[j * 3 + 2] * 1.25);
        d[i * 4 + 3] = Math.min(255, k * 255);
      }
    }

    bctx.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas, 0, 0, W, H);
    ctx.restore();
  }

  /* ---------- Streak -------------------------------------------------------
   * A bar of light that travels the full width or height of the canvas once,
   * spawned by a beat and outliving it. Unlike a flash, it has a direction and
   * a destination, so a run of beats reads as movement across the picture.
   */
  function spawnStreak(t, vertical, dir, id) {
    const streaks = poolFor(streaksBy, id);
    streaks.push({ t0: t, vertical, dir });
    if (streaks.length > 4) streaks.shift();
  }

  function streakField(ctx, t, env, opts = {}) {
    const streaks = poolFor(streaksBy, env.surfaceId);
    const { W, H } = env;
    const life = opts.life ?? 1.4;
    const width = opts.width ?? 0.16;
    const intensity = opts.intensity ?? 0.4;
    const tint = opts.tint || [255, 245, 215];

    for (let i = streaks.length - 1; i >= 0; i--) {
      const s = streaks[i];
      const age = t - s.t0;
      if (age > life) { streaks.splice(i, 1); continue; }

      const p = age / life;
      const fade = Math.sin(Math.PI * p);          // in and out
      const span = s.vertical ? H : W;
      const pos = (s.dir > 0 ? p : 1 - p) * span * 1.3 - span * 0.15;
      const w = span * width;

      const g = s.vertical
        ? ctx.createLinearGradient(0, pos - w, 0, pos + w)
        : ctx.createLinearGradient(pos - w, 0, pos + w, 0);
      const a = intensity * fade;
      g.addColorStop(0, `rgba(${tint[0]},${tint[1]},${tint[2]},0)`);
      g.addColorStop(0.5, `rgba(${tint[0]},${tint[1]},${tint[2]},${a.toFixed(3)})`);
      g.addColorStop(1, `rgba(${tint[0]},${tint[1]},${tint[2]},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* ---------- Beyond the frame --------------------------------------------
   * The picture continuing past its own edges, onto the wall.
   *
   * Built from the painting's own border: each edge is mirrored outward and
   * blurred progressively, so the colours, values and rough forms carry on
   * rather than a generic glow appearing around the frame. Mirroring matters —
   * a stretched edge pixel gives streaks, while a mirror continues the
   * brushwork's direction and reads as more painting.
   *
   * `spread` 0..1 is how far it reaches; at 1 the halo is wide enough that two
   * paintings hung near each other meet on the wall between them.
   *
   * Drawn in painting coordinates with the caller's translate already applied,
   * so negative coordinates land in the render target's margin.
   */
  const haloCache = new Map();

  function buildHalo(env, maxReach, layers) {
    const { W, H, ref } = env;
    const padX = Math.round(W * maxReach), padY = Math.round(H * maxReach);
    const cw = W + padX * 2, ch = H + padY * 2;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const g = c.getContext('2d');
    g.globalCompositeOperation = 'lighter';
    g.translate(padX, padY);

    for (let L = 1; L <= layers; L++) {
      const f = L / layers;
      const rx = W * maxReach * f, ry = H * maxReach * f;
      g.filter = `blur(${(6 + f * 44).toFixed(1)}px) saturate(${1 + f * 0.5})`;
      g.globalAlpha = (1 - f * 0.72) / layers * 2.2;

      g.save(); g.translate(0, -ry); g.scale(1, -1); g.translate(0, -ry);
      g.drawImage(ref, 0, 0, W, ry * 1.2); g.restore();

      g.save(); g.translate(0, H + ry); g.scale(1, -1);
      g.drawImage(ref, 0, H - ry * 1.2, W, ry * 1.2, 0, 0, W, ry * 1.2); g.restore();

      g.save(); g.translate(-rx, 0); g.scale(-1, 1); g.translate(-rx, 0);
      g.drawImage(ref, 0, 0, rx * 1.2, H); g.restore();

      g.save(); g.translate(W + rx, 0); g.scale(-1, 1);
      g.drawImage(ref, ref.width - (rx / W) * ref.width * 1.2, 0,
                  (rx / W) * ref.width * 1.2, ref.height, 0, 0, rx * 1.2, H);
      g.restore();
    }
    g.filter = 'none';
    return { canvas: c, padX, padY, W, H };
  }

  function beyond(ctx, t, env, opts = {}) {
    const { W, H, ref } = env;
    if (!ref) return;
    const spread = Math.max(0, Math.min(1, opts.spread ?? 0.5));
    if (spread <= 0.01) return;
    const intensity = opts.intensity ?? 0.5;
    const maxReach = opts.maxReach ?? 0.34;

    /* The halo is built once and cached. Its geometry never changes — only how
     * far it reaches and how bright it is — so re-blurring sixteen copies of
     * the painting every frame was pure waste. That alone cost two thirds of
     * the frame rate. Scale and alpha do the rest. */
    const key = (env.surfaceId || 'a') + ':halo';
    let halo = haloCache.get(key);
    if (!halo || halo.W !== W || halo.H !== H) {
      halo = buildHalo(env, maxReach, opts.layers ?? 4);
      haloCache.set(key, halo);
    }

    /* Scale about the painting's centre. The floor matters: below 1.0 the halo
     * is narrower than the painting itself and covers no margin at all, which
     * is what made it vanish. 0.78 still clears the frame; 1.06 pushes well
     * out onto the wall. */
    const sc = 0.78 + 0.28 * spread;
    const dw = halo.canvas.width * sc, dh = halo.canvas.height * sc;
    const dx = W / 2 - dw / 2, dy = H / 2 - dh / 2;

    /* Fade the halo out radially before compositing.
     *
     * A blurred copy of a rectangular painting is still a rectangle: the
     * corners stay bright and the whole thing reads as a grey box sitting
     * behind the frame rather than light spilling onto a wall. A radial
     * gradient in destination-out carves that box back into a glow. */
    if (!halo.softened) {
      const hc = halo.canvas.getContext('2d');
      const cw = halo.canvas.width, ch = halo.canvas.height;
      hc.save();
      hc.globalCompositeOperation = 'destination-out';
      const g = hc.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.22,
                                        cw / 2, ch / 2, Math.max(cw, ch) * 0.60);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.55, 'rgba(0,0,0,0.35)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      hc.fillStyle = g;
      hc.fillRect(0, 0, cw, ch);
      hc.restore();
      halo.softened = true;
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = intensity;
    ctx.drawImage(halo.canvas, dx, dy, dw, dh);
    ctx.restore();
  }

  /* ---------- Region field ------------------------------------------------
   * Light, erode or dissolve one segmented part of the painting while the rest
   * is untouched. This is the pay-off from segmentation and the thing that
   * makes it mapping rather than projection: the sky can burn while the water
   * stays dark, one region can crumble away while its neighbour holds.
   *
   *   amount    how brightly the region is lit
   *   erode     0..1, eats the region inward from its boundary
   *   dissolve  0..1, breaks it up into a thinning grain
   *
   * Erosion works off the mask's own softness: the blurred edge gives a
   * gradient from 0 at the boundary to 1 inside, so raising a threshold across
   * it retreats the region inward without needing a distance transform.
   */
  function regionField(ctx, t, env, opts = {}) {
    if (!Analysis.ready) return;
    const regions = Analysis.regions;
    if (!regions.length) return;

    const ri = ((opts.index ?? 0) % regions.length + regions.length) % regions.length;
    const mask = Analysis.mask(ri);
    if (!mask) return;

    const { W, H } = env;
    const AW = Analysis.w, AH = Analysis.h;
    const rgbA = Analysis.rgb, lumA = Analysis.lum;

    const amount = opts.amount ?? 0.5;
    if (amount <= 0.01) return;
    const erode = Math.max(0, Math.min(1, opts.erode ?? 0));
    const dissolve = Math.max(0, Math.min(1, opts.dissolve ?? 0));
    const tint = opts.tint || null;
    const boost = opts.boost ?? 1.25;

    const { canvas, ctx: bctx, img } = buffer(env, 'region' + ri, AW, AH);
    const d = img.data;

    // Erosion threshold walks up through the mask's blurred edge.
    const thresh = erode * 0.92;

    for (let y = 0; y < AH; y++) {
      for (let x = 0; x < AW; x++) {
        const i = y * AW + x;
        let m = mask[i];
        if (m <= thresh) { d[i * 4 + 3] = 0; continue; }
        m = (m - thresh) / (1 - thresh);

        if (dissolve > 0) {
          // Deterministic grain, coarse enough to read as the paint breaking
          // up rather than as noise.
          const g1 = Math.sin(x * 0.31 + y * 0.17) * Math.cos(x * 0.11 - y * 0.23);
          const g2 = Math.sin((x + y) * 0.07 + t * 0.15);
          const grain = 0.5 + 0.5 * (g1 * 0.7 + g2 * 0.3);
          if (grain < dissolve) { d[i * 4 + 3] = 0; continue; }
          m *= (grain - dissolve) / Math.max(0.001, 1 - dissolve);
        }

        const k = m * amount * (0.3 + 0.7 * lumA[i]);
        if (k < 0.004) { d[i * 4 + 3] = 0; continue; }
        const r = tint ? tint[0] : rgbA[i * 3] * boost;
        const g = tint ? tint[1] : rgbA[i * 3 + 1] * boost;
        const b = tint ? tint[2] : rgbA[i * 3 + 2] * boost;
        d[i * 4]     = Math.min(255, r);
        d[i * 4 + 1] = Math.min(255, g);
        d[i * 4 + 2] = Math.min(255, b);
        d[i * 4 + 3] = Math.min(255, k * 255);
      }
    }

    bctx.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas, 0, 0, W, H);
    ctx.restore();
  }

  /* ---------- Branches ----------------------------------------------------
   * A living population of limbs, not a single timed ramp.
   *
   * The first version grew one tree over the show's five minutes and then had
   * nowhere left to go. This keeps growing indefinitely: a new shoot is born
   * every few seconds at a fresh anchor, each takes about a minute and a half
   * to reach full extension, and the oldest are retired as new ones arrive.
   * So at any moment some limbs are days old and some are seconds old, which
   * is what a thicket actually looks like — and it never resets.
   *
   * Growth is a depth budget: `grown` decrements by one per generation, so a
   * limb extends first, then forks, then those fork. That is the order a tree
   * adds wood, and it reads completely differently from a finished shape being
   * faded up.
   *
   * Leaves bud on limbs that have finished extending and keep accumulating, so
   * the canopy thickens behind the growing tips.
   *
   * Coordinates are free to leave the canvas — the caller's translate puts the
   * overflow in the render target's margin, so branches reach past the frame
   * and onto the wall.
   */
  const trees = [];
  const bakedBy = new Map();     // surfaceId -> persistent canvas of grown wood
  /* -Infinity, not a large negative number: with a finite sentinel the first
   * shoot only appears once t exceeds (interval - 999), so any interval above
   * a few hundred seconds silently produces no tree at all. */
  let lastTreeAt = -Infinity;

  function branches(ctx, t, env, opts = {}) {
    const { W, H } = env;
    const maxDepth = opts.depth ?? 6;          // 2^depth segments — keep modest
    const growTime = opts.growTime ?? 85;      // seconds from shoot to full
    const interval = opts.interval ?? 11;      // seconds between new shoots
    const maxTrees = opts.maxTrees ?? 10;
    const baseLen = (opts.length ?? 0.15) * H;
    const intensity = opts.intensity ?? 0.5;
    const tint = opts.tint || [222, 232, 226];
    const leafTint = opts.leafTint || [176, 226, 140];
    const sway = opts.sway ?? 1;
    const reach = opts.reach ?? 1;             // >1 lets limbs push past the frame

    /* Guard against the clock moving backwards (a reload, a seek, a test
     * driving this with its own time). Without it every shoot has a negative
     * age, is skipped, and the effect silently renders nothing forever. */
    if (t < lastTreeAt) { trees.length = 0; lastTreeAt = -Infinity; }

    // Birth a new shoot. Anchors wander across the canvas and drift outward
    // over time, so later growth starts nearer the edges and leaves the frame.
    if (t - lastTreeAt > interval) {
      lastTreeAt = t;
      const k = trees.length + Math.floor(t / interval);
      const h1 = Math.abs(Math.sin(k * 51.3) * 43758.5453) % 1;
      const h2 = Math.abs(Math.sin(k * 97.1) * 24634.6345) % 1;
      trees.push({
        born: t,
        /* Anchored across the full width and well up the trunks. Clustering
         * them mid-canvas meant every limb grew from the same place and the
         * canopy piled up in one spot instead of spreading over the wall. */
        x: 0.04 + h1 * 0.92,
        y: 0.38 + h2 * 0.34,
        seed: k * 7.13 + 1.7,
      });
      /* Finished trees are baked into a persistent layer, not retired.
       *
       * They used to fade out after fourteen seconds so the per-frame cost
       * stayed flat — but growth that erases itself is not growth. Once a
       * shoot has stopped extending it is drawn once into a canvas that is
       * never cleared, and dropped from the live list. The wall then keeps
       * every limb ever grown at no ongoing cost, and only the handful still
       * moving are redrawn each frame. */
      const living = trees.filter(x => !x.baked);
      if (living.length > maxTrees) living[0].bakeMe = true;
    }

    ctx.save();
    ctx.lineCap = 'round';

    /* Straight off the artist's canvas: warm off-white trunks and near-black
     * bark marks, sampled from the painting rather than invented. Pure white
     * was the single most synthetic thing about the first version. */
    const bodyCol = opts.tint || [214, 210, 203];
    const coreCol = opts.coreTint || [240, 236, 229];
    const barkCol = opts.barkTint || [45, 46, 50];

    /* Paint a limb the way the trunks are painted.
     *
     * Sampled off the artist's own canvas: the trunks are [229,223,218] — warm
     * off-white, never pure white — and the luminance across one swings from
     * 224 to 46 within a few millimetres, bright impasto slammed against dark
     * bark marks. A flat white line of constant width shares none of that,
     * which is why it read as vector graphics laid over a painting.
     *
     * So each limb is a tapered ribbon on a curved spine, laid down in three
     * passes the way a brush builds a stroke — a broad soft body, a brighter
     * core off-centre, and dark flecks across the thicker wood. The edges come
     * from stacked translucent passes rather than a blur, which is both
     * cheaper and closer to how paint actually sits.
     */
    const hash = n => Math.abs(Math.sin(n * 12.9898) * 43758.5453) % 1;

    const ribbon = (pts, widthScale, colour, alpha) => {
      // Offset the spine by half-width on each side to get the outline.
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const [x, y, w, nx, ny] = pts[i];
        const o = w * widthScale * 0.5;
        if (i === 0) ctx.moveTo(x + nx * o, y + ny * o);
        else ctx.lineTo(x + nx * o, y + ny * o);
      }
      for (let i = pts.length - 1; i >= 0; i--) {
        const [x, y, w, nx, ny] = pts[i];
        const o = w * widthScale * 0.5;
        ctx.lineTo(x - nx * o, y - ny * o);
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(${colour[0]},${colour[1]},${colour[2]},${alpha.toFixed(3)})`;
      ctx.fill();
    };

    const paintLimb = (x0, y0, x1, y1, w0, w1, seed, alpha) => {
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len < 0.5) return;
      const px = -dy / len, py = dx / len;

      /* Take colour from the paint underneath.
       *
       * A limb rendered in one fixed off-white sits on top of the picture no
       * matter how well it is drawn — it is lit by a different light than
       * everything around it. Blending toward the local pixel means a limb
       * crossing the canopy picks up green, one against the sky goes cool, and
       * one over a trunk matches it. Outside the canvas there is nothing to
       * sample, so it keeps its own colour and reads as light on the wall.
       */
      let body = bodyCol, core = coreCol;
      const u = ((x0 + x1) / 2) / W, v = ((y0 + y1) / 2) / H;
      const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;

      /* Restraint over the painting, freedom outside it.
       *
       * At full strength across the canvas the limbs became a white thicket
       * sitting on the artist's canopy — the projection competing with the
       * work instead of extending it. Over paint they drop back to a third and
       * blend toward the local colour; past the frame, where there is only
       * bare wall, they carry their full weight. The growth then reads as the
       * painting reaching out rather than being drawn over.
       */
      if (inside) alpha *= 0.34;

      if (Analysis.ready) {
        if (inside) {
          const loc = Analysis.rgbAt(u, v);
          const m = 0.42;                       // how far to meet the painting
          body = [bodyCol[0] * (1 - m) + loc[0] * m,
                  bodyCol[1] * (1 - m) + loc[1] * m,
                  bodyCol[2] * (1 - m) + loc[2] * m];
          // The core keeps more of its own light — that is the highlight.
          const cm = 0.22;
          core = [coreCol[0] * (1 - cm) + loc[0] * cm,
                  coreCol[1] * (1 - cm) + loc[1] * cm,
                  coreCol[2] * (1 - cm) + loc[2] * cm];
        }
      }

      /* A strongly curved spine. The first version bent by 22% of the length,
       * which at these scales is a couple of pixels — invisible, so every limb
       * read as a ruled line. A brush loaded with paint and drawn across a
       * canvas curves far more than that. */
      const bend = (hash(seed) - 0.5) * len * 0.62;
      const cx = (x0 + x1) / 2 + px * bend;
      const cy = (y0 + y1) / 2 + py * bend;

      const N = 7;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const u = i / N, iu = 1 - u;
        const x = iu * iu * x0 + 2 * iu * u * cx + u * u * x1;
        const y = iu * iu * y0 + 2 * iu * u * cy + u * u * y1;
        /* Taper with real variation. A brush swells where it presses and
         * starves where it lifts; 0.82-1.18 was too tight to see, so every
         * limb had the machined look of a vector stroke. */
        const wob = 0.55 + 0.95 * hash(seed + i * 3.7);
        // Non-linear taper — wood thins fast near the tip, not evenly.
        const taper = 1 - Math.pow(u, 1.6);
        const w = (w1 + (w0 - w1) * taper) * wob;
        // Local normal, from the curve tangent.
        const tu = Math.max(0.001, u);
        const tx = 2 * iu * (cx - x0) + 2 * tu * (x1 - cx);
        const ty = 2 * iu * (cy - y0) + 2 * tu * (y1 - cy);
        const tl = Math.hypot(tx, ty) || 1;
        pts.push([x, y, w, -ty / tl, tx / tl]);
      }

      /* Four passes, widest and faintest first. Stacking translucent ribbons
       * gives an edge that fades the way wet paint does, without the cost of a
       * blur — and the overlap in the middle builds the density that makes it
       * look like material rather than a line. */
      ribbon(pts, 2.7, body, alpha * 0.10);
      ribbon(pts, 1.8, body, alpha * 0.22);
      ribbon(pts, 1.0, body, alpha * 0.52);
      // The core sits slightly off-centre, as a loaded brush leaves it.
      const lit = pts.map(([x, y, w, nx, ny]) => [x + nx * w * 0.2, y + ny * w * 0.2, w, nx, ny]);
      ribbon(lit, 0.44, core, alpha * 0.8);

      // Dark bark marks across the thicker wood — the 46-to-224 jump that
      // makes a birch read as a birch.
      if (w0 > 2.2) {
        const marks = 1 + Math.floor(hash(seed * 3.3) * 2);
        for (let m = 0; m < marks; m++) {
          const u = 0.18 + hash(seed * 5.1 + m) * 0.64;
          const i = Math.min(pts.length - 1, Math.round(u * N));
          const [mx, my, mw, nx, ny] = pts[i];
          const half = mw * (0.5 + hash(seed + m) * 0.45);
          ctx.strokeStyle = `rgba(${barkCol[0]},${barkCol[1]},${barkCol[2]},${(alpha * 0.5).toFixed(3)})`;
          ctx.lineWidth = Math.max(0.7, mw * 0.28);
          ctx.beginPath();
          ctx.moveTo(mx - nx * half, my - ny * half);
          ctx.lineTo(mx + nx * half, my + ny * half);
          ctx.stroke();
        }
      }
    };

    /* Structure first, then draw it in order.
     *
     * The previous model decremented a shared depth budget, so every limb at
     * the same generation appeared at the same moment and the whole tree
     * inflated at once. What a tree does — and what a painter does — is one
     * limb at a time: run a branch out to its tip, come back for its
     * offshoots, then start the next main branch.
     *
     * So the skeleton is generated once per shoot and flattened depth-first.
     * Drawing then walks that list in order, one limb per interval, and stops
     * at the first one whose turn has not come. Depth-first order is exactly
     * "this branch, then its sub-branches, then the next branch".
     *
     * Positions cannot be baked in with the structure, because sway moves each
     * limb and its children have to follow — so every frame recomputes ends
     * from parents, which the DFS ordering guarantees are already done.
     */
    const buildSkeleton = (rootAng, rootLen, seed) => {
      const list = [];
      const rec = (parent, ang, len, depth, sd) => {
        const idx = list.length;
        list.push({ parent, ang, len, depth, seed: sd });
        if (depth <= 1) return;
        const s1 = hash(sd * 1.29), s2 = hash(sd * 7.82), s3 = hash(sd * 3.71);
        const spread = 0.28 + s1 * 0.5;
        // The leader carries on near the current heading...
        rec(idx, ang - spread * (0.3 + s2 * 0.5), len * (0.78 + s2 * 0.14),
            depth - 1, sd * 1.7 + 1);
        // ...the offshoot turns harder, is shorter, and often never happens.
        if (s3 > 0.22) {
          rec(idx, ang + spread * (0.9 + s1 * 0.8), len * (0.5 + s1 * 0.22),
              depth - 1, sd * 2.3 + 2);
        }
      };
      rec(-1, rootAng, rootLen, maxDepth, seed);
      return list;
    };

    const drawSkeleton = (tr, age) => {
      const life = t - tr.born;
      const perLimb = growTime / Math.max(1, tr.skel.length);
      const budget = life / perLimb;          // how many limbs have had their turn

      const ends = [];                        // animated endpoints, by index
      for (let i = 0; i < tr.skel.length; i++) {
        const L = tr.skel[i];
        const g = Math.min(1, budget - i);
        // Depth-first order means nothing after this has started either.
        if (g <= 0) break;

        const from = L.parent < 0
          ? [tr.x * W, tr.y * H]
          : ends[L.parent];
        if (!from) break;

        // Tips move most, the base barely at all — that is why it reads as wood.
        const flex = (maxDepth - L.depth) / maxDepth;
        const wob = Math.sin(t * (0.3 + (L.seed % 0.4)) + L.seed * 3.1) * 0.11 * flex * sway;
        const a = L.ang + wob;
        const ex = from[0] + Math.cos(a) * L.len * g;
        const ey = from[1] + Math.sin(a) * L.len * g;
        ends[i] = [ex, ey];

        const alpha = intensity * (0.45 + 0.55 * (L.depth / maxDepth)) * g * age;
        const w0 = Math.max(1.6, Math.pow(L.depth, 1.5) * 1.5);
        const w1 = Math.max(1.2, Math.pow(Math.max(1, L.depth - 1), 1.5) * 1.5);
        paintLimb(from[0], from[1], ex, ey, w0, w1, L.seed, alpha);

        /* Buds open behind the growing tip, on limbs that finished a while
         * ago — so the canopy thickens in the wake of the growth rather than
         * everywhere at once. */
        const settled = budget - i - 1;
        if (settled > 0.5 && L.depth <= maxDepth - 2) {
          const bud = Math.min(1, (settled - 0.5) * 0.35) * age;
          if (bud > 0.02) {
            const r = (2.4 + (L.seed % 2)) * bud;
            const lg = ctx.createRadialGradient(ex, ey, 0, ex, ey, r * 2.4);
            lg.addColorStop(0, `rgba(${leafTint[0]},${leafTint[1]},${leafTint[2]},${(0.5 * bud * intensity).toFixed(3)})`);
            lg.addColorStop(1, `rgba(${leafTint[0]},${leafTint[1]},${leafTint[2]},0)`);
            ctx.fillStyle = lg;
            ctx.beginPath();
            ctx.arc(ex, ey, r * 2.4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    };

    /* Persistent wood, in three generations so it can age.
     *
     * One flat layer meant every limb ever grown stayed at full strength, and
     * the canopy eventually read as uniformly bright regardless of when it
     * grew. Fading a single layer instead would decay it exponentially to
     * nothing, which is the behaviour we just removed.
     *
     * Three canvases solve both: new wood bakes into the first, and every
     * ROTATE seconds each generation hands its contents down. Drawn at
     * descending alpha, the oldest generation sits at a floor and stays there
     * — so growth recedes into the background over several minutes without
     * ever disappearing. The oldest canvas accumulates rather than being
     * replaced, so nothing is ever discarded.
     */
    const bakeKey = env.surfaceId || 'a';
    const cw = env.CW || W, ch = env.CH || H;
    let baked = bakedBy.get(bakeKey);
    if (!baked || baked.w !== cw || baked.h !== ch) {
      const mk = () => { const c = document.createElement('canvas');
        c.width = cw; c.height = ch; return { canvas: c, ctx: c.getContext('2d') }; };
      baked = { w: cw, h: ch, gens: [mk(), mk(), mk()], rotatedAt: t };
      bakedBy.set(bakeKey, baked);
    }

    const ROTATE = opts.ageEvery ?? 110;      // seconds per generation

    /* Age by draining colour, not by dimming.
     *
     * Fading alpha made old growth recede into the dark, which loses it. Wood
     * that greys instead stays exactly as present on the wall — same
     * brightness, same mass — it simply stops being new. The painting's own
     * hues belong to the fresh growth; everything behind it settles to bark.
     *
     * Done with the 'saturation' blend rather than a pixel loop: filling the
     * layer with a neutral grey under that mode pulls its saturation toward
     * zero, and globalAlpha controls how far. That runs on the GPU and costs
     * nothing, where a getImageData pass over three megapixels would hitch the
     * frame every time a generation turned over.
     */
    function drainColour(layer, amount) {
      /* Keep a copy of the layer purely for its alpha channel.
       *
       * A blend mode does not exempt a fill from alpha compositing: filling
       * the whole canvas under 'saturation' greys the content *and* paints
       * opaque grey into every transparent pixel, turning the baked layer into
       * a solid grey rectangle that covers the painting. The fill has to be
       * masked back to wherever there was actually wood. */
      const mask = document.createElement('canvas');
      mask.width = cw; mask.height = ch;
      mask.getContext('2d').drawImage(layer.canvas, 0, 0);

      const c2 = layer.ctx;
      c2.save();
      c2.globalCompositeOperation = 'saturation';
      c2.globalAlpha = amount;
      c2.fillStyle = '#808080';              // any neutral; only saturation is taken
      c2.fillRect(0, 0, cw, ch);
      // Punch the transparency back in, so only the wood was greyed.
      c2.globalAlpha = 1;
      c2.globalCompositeOperation = 'destination-in';
      c2.drawImage(mask, 0, 0);
      c2.restore();
    }

    if (t - baked.rotatedAt > ROTATE) {
      const [g0, g1, g2] = baked.gens;
      // Each handover drains a little more colour, so age reads as a gradient
      // from fresh growth through to grey rather than a single step.
      drainColour(g1, opts.ageGrey ?? 0.5);
      g2.ctx.drawImage(g1.canvas, 0, 0);     // oldest accumulates, never cleared
      g1.ctx.clearRect(0, 0, cw, ch);
      drainColour(g0, (opts.ageGrey ?? 0.5) * 0.6);
      g1.ctx.drawImage(g0.canvas, 0, 0);
      g0.ctx.clearRect(0, 0, cw, ch);
      baked.rotatedAt = t;
    }

    /* All three generations draw at full strength. Nothing dims and nothing
     * disappears — the only thing that changes with age is the colour. */
    const px = -(env.padX || 0), py = -(env.padY || 0);
    ctx.drawImage(baked.gens[2].canvas, px, py);
    ctx.drawImage(baked.gens[1].canvas, px, py);
    ctx.drawImage(baked.gens[0].canvas, px, py);

    // Drop anything baked on a previous frame.
    for (let i = trees.length - 1; i >= 0; i--) {
      if (trees[i].baked) trees.splice(i, 1);
    }

    for (const tr of trees) {
      const life = t - tr.born;
      // Fade in over the first few seconds so a shoot does not pop into being.
      const age = Math.min(1, life / 4);
      if (age <= 0.001) continue;
      if (!tr.skel) {
        // Stronger lean: limbs near the edges head outward rather than
        // straight up, which is what carries them onto the wall.
        const lean = (tr.x - 0.5) * 1.9;
        tr.skel = buildSkeleton(-Math.PI / 2 + lean, baseLen * reach, tr.seed);
      }

      /* Once a shoot has stopped extending, draw it into the persistent layer
       * at full strength and stop paying for it every frame. Growth that
       * erased itself after fourteen seconds was not growth. */
      if (life > growTime * 1.05 || tr.bakeMe) {
        const b = baked.gens[0].ctx;
        b.save();
        b.translate(env.padX || 0, env.padY || 0);
        const outer = ctx;
        ctx = b;                        // redirect the painting helpers
        drawSkeleton(tr, 1);
        ctx = outer;
        b.restore();
        tr.baked = true;
        continue;
      }
      drawSkeleton(tr, age);
    }

    ctx.restore();
  }

  /* ---------- Gust --------------------------------------------------------
   * The wood's answer to a beat, in place of the water's ripple.
   *
   * Rings spreading from a point are what a struck liquid does; a stand of
   * trees does something else entirely — a gust arrives from one side, bends
   * the canopy as it crosses, and passes. Giving both paintings the same
   * expanding ring made the wall look like one effect running twice.
   *
   * The band is displaced horizontally by a travelling wave, strongest in the
   * canopy and dying out toward the trunks, which barely move.
   */
  const gusts = new Map();
  function spawnGust(t, dir, strength, id) {
    let a = gusts.get(id || 'b');
    if (!a) { a = []; gusts.set(id || 'b', a); }
    a.push({ t0: t, dir, strength });
    if (a.length > 3) a.shift();
  }

  function gustField(ctx, t, env, opts = {}) {
    const list = gusts.get(env.surfaceId || 'b');
    if (!list || !list.length) return;
    const { W, H, ref } = env;
    if (!ref) return;

    const band = opts.band || [0.0, 0.55];
    const life = opts.life ?? 1.8;
    const amp = opts.amp ?? 26;
    const intensity = opts.intensity ?? 0.4;

    for (let i = list.length - 1; i >= 0; i--) {
      if (t - list[i].t0 > life) list.splice(i, 1);
    }
    if (!list.length) return;

    const y0 = Math.floor(band[0] * H), y1 = Math.floor(band[1] * H);
    const step = 4;
    const sy = ref.height / H;

    ctx.save();
    for (let y = y0; y < y1; y += step) {
      const d = (y - y0) / Math.max(1, y1 - y0);
      // Canopy moves; trunks hold. That gradient is the whole gesture.
      const give = Math.pow(1 - d, 1.6);
      let push = 0, lit = 0;

      for (const g of list) {
        const age = (t - g.t0) / life;
        if (age < 0 || age > 1) continue;
        // A front crossing the painting, with the canopy lagging behind it.
        const front = g.dir > 0 ? age * 1.4 - 0.2 : 1.2 - age * 1.4;
        const dist = Math.abs(d * 0.35 + 0.3 - front);
        const w = Math.max(0, 1 - dist / 0.45) * (1 - age) * g.strength;
        push += w * g.dir;
        lit += w;
      }
      if (lit < 0.01) continue;

      const dx = push * amp * give;
      ctx.globalAlpha = Math.min(1, lit * intensity * give);
      ctx.drawImage(ref, 0, y * sy, ref.width, step * sy, dx, y, W, step);
    }
    ctx.restore();
  }

  /* ---------- Boat --------------------------------------------------------
   * A small vessel crossing the horizon, with its reflection on the water.
   *
   * It has to be lit rather than silhouetted: a projector can only add light,
   * so a dark hull is not available — what reads is a boat catching the low
   * sun, brighter on the side facing the source. The reflection underneath is
   * what sells it; a hull alone floats on the surface of the image, while a
   * broken vertical smear beneath ties it into the water.
   *
   * It crosses, then leaves, then comes back the other way. A boat permanently
   * present becomes scenery; one that arrives is an event, and someone watching
   * the wall for a few minutes gets to notice it.
   */
  function boat(ctx, t, env, opts = {}) {
    const { W, H } = env;
    const horizon = opts.horizon ?? 0.6;
    const cross = opts.cross ?? 210;        // seconds to traverse
    const gap = opts.gap ?? 90;             // seconds of empty horizon between
    const size = (opts.size ?? 0.030) * W;
    const intensity = opts.intensity ?? 0.55;
    const sunU = opts.sunU ?? 0.45;         // where the light is coming from

    const period = cross + gap;
    const phase = (t % period) / cross;
    if (phase > 1) return;                  // between crossings
    // Alternate direction each pass.
    const pass = Math.floor(t / period);
    const dir = pass % 2 === 0 ? 1 : -1;
    const u = dir > 0 ? -0.12 + phase * 1.24 : 1.12 - phase * 1.24;

    // Fade in and out at the edges so it does not pop on and off.
    const edge = Math.min(1, Math.min(u + 0.08, 1.08 - u) / 0.12);
    if (edge <= 0) return;

    const bob = Math.sin(t * 0.7 + u * 9) * size * 0.05
              + Math.sin(t * 1.9) * size * 0.02;
    const x = u * W;
    const y = horizon * H + bob;
    const a = intensity * Math.max(0, edge);

    // Warm where it faces the sun, cool on the shaded side.
    const towardSun = Math.sign(sunU - u) || 1;
    const warm = opts.warm || [255, 226, 168];
    const cool = opts.cool || [188, 206, 226];

    ctx.save();

    /* Reflection first, so the hull sits over it. Broken into short dashes
     * that wander — an unbroken line looks like a pole, not water. */
    const rSteps = 7;
    for (let i = 1; i <= rSteps; i++) {
      const f = i / rSteps;
      const ry = y + f * size * 1.5;
      const wob = Math.sin(t * 2.2 + i * 1.4 + u * 6) * size * 0.16 * f;
      const rw = size * (0.5 - f * 0.3);
      const ra = a * 0.30 * (1 - f) * (0.6 + 0.4 * Math.sin(t * 3 + i));
      if (ra <= 0.004) continue;
      ctx.fillStyle = `rgba(${warm[0]},${warm[1]},${warm[2]},${Math.min(1, ra * 1.7).toFixed(3)})`;
      ctx.fillRect(x - rw / 2 + wob, ry, rw, Math.max(1, size * 0.07));
    }

    // Hull: a shallow wedge sitting on the waterline.
    ctx.beginPath();
    ctx.moveTo(x - size * 0.5, y);
    ctx.lineTo(x + size * 0.5, y);
    ctx.lineTo(x + size * 0.3, y + size * 0.16);
    ctx.lineTo(x - size * 0.34, y + size * 0.16);
    ctx.closePath();
    ctx.fillStyle = `rgba(${cool[0]},${cool[1]},${cool[2]},${(a * 0.8).toFixed(3)})`;
    ctx.fill();

    // Sunlit edge along the hull.
    ctx.strokeStyle = `rgba(${warm[0]},${warm[1]},${warm[2]},${(a * 0.8).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.8, size * 0.05);
    ctx.beginPath();
    ctx.moveTo(x + towardSun * size * 0.5, y);
    ctx.lineTo(x + towardSun * size * 0.3, y + size * 0.16);
    ctx.stroke();

    // Mast and sail, leaning slightly with the bob.
    const lean = Math.sin(t * 0.6 + u * 4) * 0.06;
    ctx.beginPath();
    ctx.moveTo(x - size * 0.05, y);
    ctx.lineTo(x - size * 0.05 + lean * size, y - size * 0.62);
    ctx.strokeStyle = `rgba(${cool[0]},${cool[1]},${cool[2]},${(a * 0.55).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.7, size * 0.035);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x - size * 0.05 + lean * size, y - size * 0.60);
    ctx.lineTo(x + size * 0.26, y - size * 0.06);
    ctx.lineTo(x - size * 0.05, y - size * 0.06);
    ctx.closePath();
    ctx.fillStyle = `rgba(${warm[0]},${warm[1]},${warm[2]},${(a * 0.55).toFixed(3)})`;
    ctx.fill();

    // A lamp, so there is one point of real light aboard.
    const lampA = a * (0.5 + 0.5 * Math.sin(t * 1.3));
    const lg = ctx.createRadialGradient(x, y - size * 0.1, 0, x, y - size * 0.1, size * 0.5);
    lg.addColorStop(0, `rgba(255,238,196,${lampA.toFixed(3)})`);
    lg.addColorStop(1, 'rgba(255,238,196,0)');
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.arc(x, y - size * 0.1, size * 0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  return {
    bleed, dapple, radiance, colourFlow, drift, accent, grow, leaves, boat,
    spawnGust, gustField,
    fireflies, waves, spawnRipple, rippleField, spawnStreak, streakField, beyond,
    regionField, branches,
    sweep, shimmer, glitter, stars, cascade, lightning,
    godRays, caustics, bloom, rain,
    embers, spotlight, breath, regionGlow, testPattern,
    // Image-derived
    relight, brushflow, contours, chromaSplit, ignite, paletteWash,
  };
})();
