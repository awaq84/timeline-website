/* mapper.js — perspective mapping from painting space onto the wall.
 *
 * The stage canvas is drawn in "painting space": a fixed WxH rectangle where
 * (0,0) is the painting's top-left corner and (W,H) its bottom-right, no matter
 * how the projector is angled. A homography warps that rectangle onto the four
 * corners you drag during calibration, so effects can be written in the
 * painting's own coordinates and forget the projector geometry entirely.
 */

/* A factory, not a singleton: each painting on the wall needs its own quad,
 * its own saved alignment and its own overlay, and they are all live at once
 * so you can align one while the other keeps running.
 *
 * config: { overlay, edges, stage, storeKey, accent, aspect }
 *   overlay/edges/stage  DOM elements owned by this surface
 *   accent               CSS colour for this surface's handles and guides,
 *                        so two quads on one screen are told apart at a glance
 */
function createMapper(config) {
  const STORE_KEY = config.storeKey;
  const ACCENT = config.accent || '#0f8';

  // Corners of the projected quad, in projector pixels, in the order
  // top-left, top-right, bottom-right, bottom-left — matching the unit square
  // (0,0), (1,0), (1,1), (0,1).
  let corners = null;
  let dragging = -1;
  let aspect = 0.74;          // painting w/h; set by init()

  // Two modes, because they solve different problems. QUAD moves/scales all
  // four corners together and gets you 90% of the way in seconds; CORNER
  // adjusts one at a time and is only needed for the perspective skew.
  let mode = 'quad';

  /* Keep the quad a true rectangle by default.
   *
   * Free corners exist for keystone — a projector mounted off-axis sees the
   * painting as a trapezoid and the quad has to match it. But nothing here
   * infers the geometry of the room, so a skew is only ever correct if you put
   * it there deliberately; dragged by accident it silently distorts the whole
   * projection. Locked, moving any corner resizes the rectangle against the
   * opposite one, which is what you want whenever the projector is square on.
   * Press K to unlock when you actually need keystone. */
  let rectLock = false;   // free corners by default; K constrains to a rectangle

  /* Rebuild an axis-aligned rectangle from a moved corner and its opposite,
   * preserving the TL, TR, BR, BL winding the homography expects. */
  function squareUp(movedIdx) {
    const a = corners[movedIdx], b = corners[(movedIdx + 2) % 4];
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
    const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }

  function centroid() {
    let x = 0, y = 0;
    for (const c of corners) { x += c[0]; y += c[1]; }
    return [x / 4, y / 4];
  }

  function bbox(quad = corners) {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [x, y] of quad) {
      a = Math.min(a, x); b = Math.max(b, x);
      c = Math.min(c, y); d = Math.max(d, y);
    }
    return { minX: a, maxX: b, minY: c, maxY: d };
  }

  /* Keep the quad inside the viewport. A corner dragged off-screen can't be
   * grabbed again, which reads as "drag is broken" — the handle is simply gone.
   * Clamping the translation as a group keeps the shape intact. */
  const EDGE = 10;
  function translate(dx, dy) {
    const w = window.innerWidth, h = window.innerHeight;
    const { minX, maxX, minY, maxY } = bbox();
    if (maxX - minX < w - EDGE * 2) {
      if (minX + dx < EDGE) dx = EDGE - minX;
      if (maxX + dx > w - EDGE) dx = w - EDGE - maxX;
    }
    if (maxY - minY < h - EDGE * 2) {
      if (minY + dy < EDGE) dy = EDGE - minY;
      if (maxY + dy > h - EDGE) dy = h - EDGE - maxY;
    }
    for (const c of corners) { c[0] += dx; c[1] += dy; }
  }

  function clampCorner(i) {
    corners[i][0] = Math.min(window.innerWidth - EDGE, Math.max(EDGE, corners[i][0]));
    corners[i][1] = Math.min(window.innerHeight - EDGE, Math.max(EDGE, corners[i][1]));
  }

  function scale(factor) {
    const [cx, cy] = centroid();
    const next = corners.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
    // Refuse a scale that would push the quad off-screen, rather than allowing
    // it and stranding the handles.
    const { minX, maxX, minY, maxY } = bbox(next);
    const grew = factor > 1;
    if (grew && (minX < EDGE || minY < EDGE ||
                 maxX > window.innerWidth - EDGE || maxY > window.innerHeight - EDGE)) return;
    if (maxX - minX < 40 || maxY - minY < 40) return;   // don't shrink to nothing
    corners = next;
  }

  function defaultCorners() {
    // A window that reports 0x0 (backgrounded tab, not yet laid out) would
    // otherwise produce a zero-area quad, which collapses the transform to a
    // black screen with no error anywhere. Fall back to something usable.
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 720;
    // Start at the painting's own proportions rather than an arbitrary box —
    // then placing it is just move and scale, with no reshaping needed.
    const qh = h * 0.7;
    const qw = qh * aspect;
    const x0 = (w - qw) / 2, y0 = (h - qh) / 2;
    return [[x0, y0], [x0 + qw, y0], [x0 + qw, y0 + qh], [x0, y0 + qh]];
  }

  // A quad is usable only if every number is finite and it encloses real area.
  // Anything else maps the whole stage to a point — nothing is drawn, and the
  // failure is silent, so reject it here rather than debugging it on a wall.
  function isUsable(quad) {
    if (!Array.isArray(quad) || quad.length !== 4) return false;
    for (const p of quad) {
      if (!Array.isArray(p) || p.length !== 2) return false;
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
    }
    // Shoelace area of the quad.
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = quad[i], [x2, y2] = quad[(i + 1) % 4];
      area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area / 2) > 100; // px², i.e. anything but degenerate
  }

  /* Viewport the current pixel corners were authored against. Needed because
   * corners live in pixels (the homography and the DOM handles both need
   * pixels) while the alignment is conceptually a fraction of the display. */
  let vpW = 0, vpH = 0;

  /* Rescale the quad proportionally when the viewport changes. Without this,
   * entering fullscreen leaves the corners at their old pixel positions and
   * the whole alignment shifts off the painting. */
  /* Bring the quad in line with the current viewport, whatever changed it.
   *
   * Rescaling only on resize/fullscreenchange events was fragile: Safari fires
   * fullscreenchange before the viewport has settled, so the quad was scaled
   * against stale dimensions and then never corrected — the handles ended up
   * off the painting and stayed there. Called from apply() and drawChrome(),
   * this costs two comparisons a frame and cannot get out of step, because it
   * checks the actual size rather than trusting an event to have told it. */
  let syncing = false;
  function syncViewport() {
    if (syncing) return;                 // drawChrome calls back in here
    const w = window.innerWidth, h = window.innerHeight;
    if (!w || !h) return;
    if (w === vpW && h === vpH) return;
    syncing = true;
    rescale(w, h);
    /* Redraw the handles too. apply() runs every frame so the projection
     * corrected itself immediately, but drawChrome() only runs on interaction —
     * so the warped image moved to the right place and the alignment circles
     * stayed where they were. Persist as well, or the next load restores the
     * pre-fullscreen alignment. */
    drawChrome();
    onChange();
    save();
    syncing = false;
  }

  function rescale(newW, newH) {
    if (!isUsable(corners) || vpW <= 0 || vpH <= 0) { vpW = newW; vpH = newH; return; }
    const sx = newW / vpW, sy = newH / vpH;
    if (sx === 1 && sy === 1) return;
    for (const c of corners) { c[0] *= sx; c[1] *= sy; }
    vpW = newW; vpH = newH;
  }

  let loadedFromStore = false;

  /* Place this quad in one of `n` slots across the screen. Two paintings both
   * defaulting to centre land exactly on top of each other, and since the
   * second draws over the first, half the work is invisible and the wall looks
   * like it is running one painting. */
  function placeInSlot(i, n) {
    const w = window.innerWidth || 1280, h = window.innerHeight || 720;
    const slotW = w / n;
    const qh = h * 0.62;
    const qw = Math.min(qh * aspect, slotW * 0.82);
    const cx = slotW * (i + 0.5);
    const x0 = cx - qw / 2, y0 = (h - qh) / 2;
    corners = [[x0, y0], [x0 + qw, y0], [x0 + qw, y0 + qh], [x0, y0 + qh]];
    vpW = w; vpH = h;
    save();
    drawChrome();
  }

  function load() {
    const w = window.innerWidth || 1280, h = window.innerHeight || 720;
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY));
      if (Array.isArray(saved) && saved.length === 4 &&
          saved.every(p => Array.isArray(p) && p.length === 2)) {
        // Entries are fractions of the viewport. Older saves were raw pixels;
        // any coordinate above 1.5 can only be pixels, so convert accordingly.
        const normalised = saved.every(([x, y]) => x <= 1.5 && y <= 1.5);
        const px = normalised ? saved.map(([x, y]) => [x * w, y * h]) : saved;
        if (isUsable(px)) { vpW = w; vpH = h; loadedFromStore = true; return px; }
      }
    } catch { /* fall through to defaults */ }
    vpW = w; vpH = h;
    return defaultCorners();
  }

  function save() {
    // Never persist a degenerate quad — it would strand the next session.
    if (!isUsable(corners)) return;
    const w = window.innerWidth || 1, h = window.innerHeight || 1;
    // Stored as fractions so the alignment survives fullscreen, a window
    // resize, or being reopened on a different display.
    localStorage.setItem(STORE_KEY,
      JSON.stringify(corners.map(([x, y]) => [x / w, y / h])));
  }

  /* Projective transform taking the unit square to an arbitrary quad.
   * Returns [a,b,c,d,e,f,g,h] for the matrix
   *     | a b c |
   *     | d e f |
   *     | g h 1 |
   * (Heckbert, "Fundamentals of Texture Mapping and Image Warping", §2.)
   */
  function squareToQuad(p) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
    const sx = x0 - x1 + x2 - x3;
    const sy = y0 - y1 + y2 - y3;

    // A parallelogram needs no perspective term — the affine case.
    if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
      return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0];
    }

    const dx1 = x1 - x2, dx2 = x3 - x2;
    const dy1 = y1 - y2, dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-9) return null; // degenerate quad (collinear corners)

    const g = (sx * dy2 - dx2 * sy) / den;
    const h = (dx1 * sy - sx * dy1) / den;
    return [
      x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
      y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
      g, h,
    ];
  }

  /* Apply the homography to the stage element. The stage draws at WxH pixels,
   * so we fold a 1/W, 1/H scale into the matrix to normalise it to the unit
   * square first. CSS matrix3d is column-major. */
  /* `expand` grows the mapped quad outward from its centre, so a render target
   * larger than the painting can spill light onto the wall around it. The
   * painting still lands exactly on the corners you aligned — the extra
   * margin falls outside them. */
  /* Push a point through a homography. */
  function project(m, u, v) {
    const [a, b, c, d, e, f, g, h] = m;
    const w = g * u + h * v + 1;
    return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
  }

  function apply(stage, W, H, expand = 1) {
    syncViewport();          // self-heal before building the transform
    let quad = corners;
    if (expand !== 1) {
      /* Expand the quad *projectively*, not by scaling the corners about the
       * centroid.
       *
       * Scaling about a centre is a linear operation; a quad with perspective
       * is not. On a rectangle the two agree, which is why this looked correct
       * until a corner was dragged — from then on the painting's edges drifted
       * off the alignment circles, and at margin 0.70 the error is multiplied
       * by 2.4.
       *
       * The right expansion maps the padded canvas through the homography that
       * the painting's own corners define: solve unit-square -> corners, then
       * project the padded rectangle's corners, which in painting space run
       * from -m to 1+m. The painting then lands exactly on the handles no
       * matter how much perspective the quad carries.
       */
      const base = squareToQuad(corners);
      if (!base) return;
      const m = (expand - 1) / 2;          // margin as a fraction, per side
      quad = [
        project(base, -m, -m),
        project(base, 1 + m, -m),
        project(base, 1 + m, 1 + m),
        project(base, -m, 1 + m),
      ];
    }
    const m = squareToQuad(quad);
    if (!m) return; // leave the last good transform in place
    const [a, b, c, d, e, f, g, h] = m;
    stage.style.transform = `matrix3d(
      ${a / W}, ${d / W}, 0, ${g / W},
      ${b / H}, ${e / H}, 0, ${h / H},
      0, 0, 1, 0,
      ${c}, ${f}, 0, 1)`;
  }

  function drawChrome() {
    syncViewport();
    const svg = config.edges;
    const pts = corners.map(([x, y]) => `${x},${y}`).join(' ');
    // A filled quad in QUAD mode signals "drag anywhere in here to move it".
    const fill = mode === 'quad' ? hexToRgba(ACCENT, 0.07) : 'none';
    svg.innerHTML = `
      <polygon points="${pts}" fill="${fill}" stroke="${ACCENT}" stroke-width="1.5"
               stroke-dasharray="8 6" opacity="0.9" />`;

    const overlay = config.overlay;
    overlay.querySelectorAll('.handle').forEach(n => n.remove());
    const labels = ['TL', 'TR', 'BR', 'BL'];
    corners.forEach(([x, y], i) => {
      const el = document.createElement('div');
      const isSel = mode === 'corner' && selected === i;
      el.className = 'handle' + (dragging === i || isSel ? ' active' : '');
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      // Per-surface colour, so two quads on one screen are distinguishable.
      el.style.borderColor = ACCENT;
      el.style.color = ACCENT;
      el.style.background = hexToRgba(ACCENT, dragging === i || isSel ? 0.35 : 0.12);
      el.textContent = labels[i];
      el.addEventListener('pointerdown', ev => {
        ev.stopPropagation();     // don't also start a whole-quad drag
        dragging = i;
        selected = i;
        mode = 'corner';
        // Capture is an optimisation, not a requirement. If it throws, the
        // drag must still work — otherwise `dragging` stays set and the corner
        // sticks to the cursor with no way to release it.
        try { el.setPointerCapture(ev.pointerId); } catch {}
        drawChrome();
      });
      el.addEventListener('pointermove', ev => {
        if (dragging !== i) return;
        corners[i] = [ev.clientX, ev.clientY];
        clampCorner(i);
        if (rectLock) squareUp(i);
        drawChrome();     // keep the handle under the cursor as it moves
        onChange();
      });
      el.addEventListener('pointerup', ev => {
        dragging = -1;
        try { el.releasePointerCapture(ev.pointerId); } catch {}
        save();
        onChange();
      });
      // A pointer lost mid-drag (window blur, gesture cancelled) must also
      // clear the drag state, or the corner stays glued to the cursor.
      el.addEventListener('pointercancel', () => { dragging = -1; drawChrome(); });
      overlay.appendChild(el);
    });
  }

  let onChange = () => {};
  let selected = 0;

  /* Accepts '#rgb', '#rrggbb' or any 'rgb(...)' string and returns it at the
   * given alpha, so a surface's accent colour can be reused for fills. */
  function hexToRgba(c, a) {
    if (c.startsWith('rgb')) return c.replace(/rgba?\(([^)]+)\)/, (_, v) =>
      `rgba(${v.split(',').slice(0, 3).join(',')},${a})`);
    let h = c.replace('#', '');
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* Dragging anywhere inside the quad moves the whole thing. This is the big
   * time-saver: getting the rectangle roughly onto the painting is one gesture
   * rather than four. */
  function attachQuadDrag() {
    const overlay = config.overlay;
    let last = null;

    overlay.addEventListener('pointerdown', ev => {
      if (dragging !== -1) return;      // a corner handle owns this gesture
      mode = 'quad';
      last = [ev.clientX, ev.clientY];
      try { overlay.setPointerCapture(ev.pointerId); } catch {}
      drawChrome();
    });
    overlay.addEventListener('pointermove', ev => {
      if (!last) return;
      translate(ev.clientX - last[0], ev.clientY - last[1]);
      last = [ev.clientX, ev.clientY];
      drawChrome();
      onChange();
    });
    const end = ev => {
      if (!last) return;
      last = null;
      try { overlay.releasePointerCapture(ev.pointerId); } catch {}
      save();
    };
    overlay.addEventListener('pointerup', end);
    overlay.addEventListener('pointercancel', end);

    /* Scroll to resize about the centre. The factor must be proportional to
     * deltaY and clamped: a trackpad flick fires dozens of wheel events, so a
     * fixed 2% step per event compounds to 3x in one gesture. */
    overlay.addEventListener('wheel', ev => {
      ev.preventDefault();
      const step = Math.max(-40, Math.min(40, ev.deltaY));
      scale(Math.exp(-step * 0.0018));
      drawChrome();
      onChange();
      save();
    }, { passive: false });
  }

  // Arrows nudge — the whole quad in QUAD mode, one corner in CORNER mode.
  // The last few pixels of alignment are far easier by keyboard than by drag.
  function nudge(dx, dy) {
    if (mode === 'quad') translate(dx, dy);
    else {
      corners[selected][0] += dx;
      corners[selected][1] += dy;
      clampCorner(selected);
      if (rectLock) squareUp(selected);
    }
    drawChrome();
    save();
    onChange();
  }

  return {
    init(handler, paintingAspect) {
      if (paintingAspect > 0) aspect = paintingAspect;
      corners = load();
      onChange = handler;
      attachQuadDrag();
      drawChrome();
      const onResize = () => {
        const w = window.innerWidth, h = window.innerHeight;
        if (!w || !h) return;
        // If the quad was built against a zero-sized viewport, rebuild it now
        // that we have real dimensions; otherwise scale it to the new size.
        if (!isUsable(corners)) { corners = defaultCorners(); vpW = w; vpH = h; }
        else rescale(w, h);
        drawChrome();
        onChange();
        save();
      };
      window.addEventListener('resize', onResize);
      // Safari fires fullscreenchange without always firing a useful resize
      // first; the viewport is settled by the next frame.
      document.addEventListener('fullscreenchange', () => requestAnimationFrame(onResize));
      document.addEventListener('webkitfullscreenchange', () => requestAnimationFrame(onResize));
    },
    apply,
    redraw: drawChrome,
    toggleRectLock() {
      rectLock = !rectLock;
      if (rectLock) { squareUp(0); save(); drawChrome(); onChange(); }
      return rectLock;
    },
    get rectLocked() { return rectLock; },
    nudge,
    scaleBy(f) { scale(f); save(); drawChrome(); onChange(); },
    toggleMode() {
      mode = mode === 'quad' ? 'corner' : 'quad';
      drawChrome();
    },
    get mode() { return mode; },
    selectCorner(i) { selected = i; mode = 'corner'; drawChrome(); },
    get selected() { return selected; },
    reset() { corners = defaultCorners(); mode = 'quad'; save(); drawChrome(); onChange(); },
    get corners() { return corners; },
    get accent() { return ACCENT; },
    get hasSaved() { return loadedFromStore; },
    placeInSlot,
    /* Both surfaces show their handles at once, so you can see where each
     * painting's quad sits. Only the active one takes pointer events — two
     * overlapping overlays both accepting drags would mean the upper one
     * silently swallows every gesture aimed at the lower.
     *   visible     draw this surface's handles and guides
     *   interactive accept drags (the active surface only) */
    setChromeVisible(visible, interactive) {
      config.overlay.style.display = visible ? 'block' : 'none';
      config.overlay.style.pointerEvents = interactive ? 'auto' : 'none';
      config.overlay.classList.toggle('inert', !interactive);
    },
  };
}
