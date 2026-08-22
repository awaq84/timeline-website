/* analysis.js — derive structure from the painting itself.
 *
 * Generic overlays ignore the artwork underneath. These maps let effects
 * respond to what is actually painted: flow along the brushstrokes, relight
 * the impasto, trace the forms, borrow the palette.
 *
 * Built once at load from the cropped reference canvas, at a working
 * resolution well below the stage. Per-pixel work at 628x844 every frame is
 * far too slow in JS; at ~220px wide it is trivial, and every one of these
 * fields is smooth enough that upscaling costs nothing visually.
 *
 * Provides:
 *   lum[i]        0..1   luminance
 *   gx[i], gy[i]  -1..1  Sobel gradient (points uphill, toward light)
 *   edge[i]       0..1   gradient magnitude
 *   rgb[i*3..]    0..255 colour, for tinting effects in the painting's own hues
 *   edgePts[]     strongest edges, sorted, for tracing
 *   palette[]     dominant colours by k-means
 */

/* A factory plus a mutable `Analysis` pointer. Each painting needs its own
 * maps, but the effects all reference `Analysis` directly — so main.js swaps
 * this to the surface being drawn rather than threading an extra argument
 * through every effect signature. */
function createAnalysis() {
  let ready = false;
  let AW = 0, AH = 0;
  let lum = null, gx = null, gy = null, edge = null, rgb = null;
  let edgePts = [];
  let palette = [];
  let lightSource = null;
  let regionList = [];
  let regionMasks = [];
  let assignMap = null;

  const idx = (x, y) => y * AW + x;

  function build(refCanvas, targetW = 220) {
    if (!refCanvas) return false;

    AW = targetW;
    AH = Math.max(1, Math.round(targetW * refCanvas.height / refCanvas.width));

    const c = document.createElement('canvas');
    c.width = AW; c.height = AH;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(refCanvas, 0, 0, AW, AH);
    const d = g.getImageData(0, 0, AW, AH).data;

    const n = AW * AH;
    lum = new Float32Array(n);
    rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], gg = d[i * 4 + 1], b = d[i * 4 + 2];
      rgb[i * 3] = r; rgb[i * 3 + 1] = gg; rgb[i * 3 + 2] = b;
      lum[i] = (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
    }

    // Sobel. The gradient is the whole basis for relighting and flow, so it is
    // worth doing properly rather than with a cheap forward difference —
    // brushwork is noisy and a 3x3 kernel smooths across it.
    gx = new Float32Array(n);
    gy = new Float32Array(n);
    edge = new Float32Array(n);
    let maxMag = 1e-6;
    for (let y = 1; y < AH - 1; y++) {
      for (let x = 1; x < AW - 1; x++) {
        const i = idx(x, y);
        const tl = lum[i - AW - 1], tc = lum[i - AW], tr = lum[i - AW + 1];
        const ml = lum[i - 1],                        mr = lum[i + 1];
        const bl = lum[i + AW - 1], bc = lum[i + AW], br = lum[i + AW + 1];
        const sx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        const sy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
        gx[i] = sx; gy[i] = sy;
        const m = Math.hypot(sx, sy);
        edge[i] = m;
        if (m > maxMag) maxMag = m;
      }
    }
    for (let i = 0; i < n; i++) edge[i] /= maxMag;

    // Strongest edges, thinned on a grid so tracing effects get points spread
    // over the whole canvas instead of clustered on the one busiest contour.
    const cell = 3;
    const best = new Map();
    for (let y = 1; y < AH - 1; y++) {
      for (let x = 1; x < AW - 1; x++) {
        const i = idx(x, y);
        if (edge[i] < 0.16) continue;
        const key = ((y / cell) | 0) * 10000 + ((x / cell) | 0);
        const prev = best.get(key);
        if (!prev || edge[i] > prev.m) {
          best.set(key, { x: x / AW, y: y / AH, m: edge[i], i });
        }
      }
    }
    edgePts = [...best.values()].sort((a, b) => b.m - a.m).slice(0, 2600);

    palette = kmeans(d, n, 6);
    findLightSource();
    segment();
    ready = true;
    return true;
  }

  /* Split the painting into regions.
   *
   * This is what separates projection *mapping* from projection: the surface
   * has parts, and they should be able to behave independently — sky drifting
   * while the water holds still, one area dissolving while another grows.
   * Treating the canvas as a single rectangle is why everything looked like a
   * light show laid over the top.
   *
   * Clustering is on colour *and* vertical position together, because in a
   * landscape the two are correlated: sky, horizon and foreground separate
   * cleanly on that basis, where colour alone would merge a pale sky with pale
   * water. Each region ends up with a mask the effects can be confined to.
   */
  const REGION_COUNT = 5;
  function segment() {
    const n = AW * AH;
    const K = REGION_COUNT;

    // Feature per pixel: r, g, b (0..1) and y (0..1), y weighted up so vertical
    // banding dominates — that is the structure a landscape actually has.
    const YW = 1.8;
    const cent = [];
    for (let k = 0; k < K; k++) {
      const i = Math.floor(((k + 0.5) / K) * n);
      cent.push([rgb[i * 3] / 255, rgb[i * 3 + 1] / 255, rgb[i * 3 + 2] / 255,
                 ((i / AW) | 0) / AH * YW]);
    }

    const assign = new Uint8Array(n);
    for (let iter = 0; iter < 10; iter++) {
      for (let i = 0; i < n; i++) {
        const r = rgb[i * 3] / 255, g = rgb[i * 3 + 1] / 255, b = rgb[i * 3 + 2] / 255;
        const y = ((i / AW) | 0) / AH * YW;
        let best = 0, bd = Infinity;
        for (let k = 0; k < K; k++) {
          const c = cent[k];
          const dist = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2 + (y - c[3]) ** 2;
          if (dist < bd) { bd = dist; best = k; }
        }
        assign[i] = best;
      }
      const sum = Array.from({ length: K }, () => [0, 0, 0, 0, 0]);
      for (let i = 0; i < n; i++) {
        const a = assign[i];
        sum[a][0] += rgb[i * 3] / 255; sum[a][1] += rgb[i * 3 + 1] / 255;
        sum[a][2] += rgb[i * 3 + 2] / 255; sum[a][3] += ((i / AW) | 0) / AH * YW;
        sum[a][4]++;
      }
      for (let k = 0; k < K; k++) {
        if (sum[k][4]) for (let j = 0; j < 4; j++) cent[k][j] = sum[k][j] / sum[k][4];
      }
    }

    // Build per-region masks and descriptive stats, ordered top to bottom so a
    // caller can say "the upper region" without knowing what the painting is.
    const stats = Array.from({ length: K }, () => ({ n: 0, sy: 0, sx: 0, r: 0, g: 0, b: 0 }));
    for (let i = 0; i < n; i++) {
      const k = assign[i], y = (i / AW) | 0, x = i % AW;
      const st = stats[k];
      st.n++; st.sy += y; st.sx += x;
      st.r += rgb[i * 3]; st.g += rgb[i * 3 + 1]; st.b += rgb[i * 3 + 2];
    }

    regionList = stats.map((st, k) => ({
      index: k,
      area: st.n / n,
      cy: st.n ? st.sy / st.n / AH : 0.5,
      cx: st.n ? st.sx / st.n / AW : 0.5,
      rgb: st.n ? [Math.round(st.r / st.n), Math.round(st.g / st.n), Math.round(st.b / st.n)]
                : [128, 128, 128],
    })).filter(r => r.area > 0.02).sort((a, b) => a.cy - b.cy);

    // A soft mask per region. Blurring the hard cluster edge matters: a crisp
    // boundary between two effects reads as a cut-out sitting on the painting.
    regionMasks = regionList.map(r => {
      const m = new Float32Array(n);
      for (let i = 0; i < n; i++) m[i] = assign[i] === r.index ? 1 : 0;
      return blur(m, 3);
    });
    assignMap = assign;
  }

  // Separable box blur, a few passes — cheap and smooth enough for a mask.
  function blur(src, radius) {
    let a = src, b = new Float32Array(src.length);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < AH; y++) {
        for (let x = 0; x < AW; x++) {
          let s = 0, c = 0;
          for (let k = -radius; k <= radius; k++) {
            const xx = x + k;
            if (xx < 0 || xx >= AW) continue;
            s += a[y * AW + xx]; c++;
          }
          b[y * AW + x] = s / c;
        }
      }
      [a, b] = [b, a];
      for (let x = 0; x < AW; x++) {
        for (let y = 0; y < AH; y++) {
          let s = 0, c = 0;
          for (let k = -radius; k <= radius; k++) {
            const yy = y + k;
            if (yy < 0 || yy >= AH) continue;
            s += a[yy * AW + x]; c++;
          }
          b[y * AW + x] = s / c;
        }
      }
      [a, b] = [b, a];
    }
    return a;
  }

  /* Where the light in this painting comes from.
   *
   * The whole piece is built on the rule that projected light must look like
   * the painting's own, so the source cannot be a hand-picked coordinate — it
   * has to be wherever the artist actually put the brightest passage. Taking
   * the luminance-weighted centroid of the top few percent finds the sun in a
   * seascape and the sky-gap in a wood, without either being special-cased. */
  function findLightSource() {
    const n = AW * AH;
    const sorted = Float32Array.from(lum).sort();
    const cut = sorted[Math.floor(n * 0.97)];      // brightest 3%

    let sx = 0, sy = 0, wsum = 0;
    let r = 0, g = 0, b = 0;
    for (let y = 0; y < AH; y++) {
      for (let x = 0; x < AW; x++) {
        const i = y * AW + x;
        if (lum[i] < cut) continue;
        // Weight by how far above the cut it is, so the true peak dominates.
        const w = lum[i] - cut + 0.001;
        sx += x * w; sy += y * w; wsum += w;
        r += rgb[i * 3] * w; g += rgb[i * 3 + 1] * w; b += rgb[i * 3 + 2] * w;
      }
    }
    if (wsum <= 0) { lightSource = { u: 0.5, v: 0.35, rgb: [255, 240, 210] }; return; }
    lightSource = {
      u: sx / wsum / AW,
      v: sy / wsum / AH,
      rgb: [Math.round(r / wsum), Math.round(g / wsum), Math.round(b / wsum)],
    };
  }

  /* Dominant colours. Effects that tint with these read as the painting
   * generating its own light rather than having a colour pushed onto it. */
  function kmeans(d, n, k) {
    const cent = [];
    for (let j = 0; j < k; j++) {
      const s = ((j + 0.5) / k * n) | 0;
      cent.push([d[s * 4], d[s * 4 + 1], d[s * 4 + 2]]);
    }
    const assign = new Uint8Array(n);
    for (let iter = 0; iter < 8; iter++) {
      for (let i = 0; i < n; i++) {
        let bi = 0, bd = Infinity;
        for (let j = 0; j < k; j++) {
          const dr = d[i * 4] - cent[j][0];
          const dg = d[i * 4 + 1] - cent[j][1];
          const db = d[i * 4 + 2] - cent[j][2];
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bd) { bd = dist; bi = j; }
        }
        assign[i] = bi;
      }
      const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
      for (let i = 0; i < n; i++) {
        const a = assign[i];
        sum[a][0] += d[i * 4]; sum[a][1] += d[i * 4 + 1];
        sum[a][2] += d[i * 4 + 2]; sum[a][3]++;
      }
      for (let j = 0; j < k; j++) {
        if (sum[j][3]) {
          cent[j] = [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]];
        }
      }
    }
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) counts[assign[i]]++;
    return cent
      .map((c, j) => ({ rgb: c.map(v => Math.round(v)), weight: counts[j] / n }))
      .sort((a, b) => b.weight - a.weight);
  }

  // Bilinear-free nearest sample; the maps are smooth and the stage upscales.
  function sampleAt(arr, u, v, stride = 1, off = 0) {
    if (!ready) return 0;
    const x = Math.min(AW - 1, Math.max(0, (u * AW) | 0));
    const y = Math.min(AH - 1, Math.max(0, (v * AH) | 0));
    return arr[(y * AW + x) * stride + off];
  }

  return {
    build,
    get ready() { return ready; },
    get w() { return AW; },
    get h() { return AH; },
    get lum() { return lum; },
    get gx() { return gx; },
    get gy() { return gy; },
    get edge() { return edge; },
    get rgb() { return rgb; },
    get edgePts() { return edgePts; },
    get palette() { return palette; },
    get lightSource() { return lightSource; },
    /* Override the detected source. The detector picks the brightest coherent
     * blob, which on a painting with a bright horizon band and a bright
     * reflection can easily be neither of the things a viewer would call the
     * sun. When someone points at the sun, that is better information than any
     * heuristic. */
    setLightSource(u, v) {
      const cu = Math.max(0, Math.min(1, u));
      const cv = Math.max(0, Math.min(1, v));
      /* Carry the colour too. Effects blend toward the source's own hue — a
       * sun lights the paint near it in the sun's colour — so a source object
       * without `rgb` throws the moment anything radial reads it. Sampled from
       * the painting rather than assumed, so a manual sun is the same shape as
       * a detected one. */
      let rgbAt = [255, 220, 170];
      if (ready || rgb) {
        const x = Math.min(AW - 1, Math.max(0, (cu * AW) | 0));
        const y = Math.min(AH - 1, Math.max(0, (cv * AH) | 0));
        const i = (y * AW + x) * 3;
        rgbAt = [rgb[i], rgb[i + 1], rgb[i + 2]];
      }
      lightSource = { u: cu, v: cv, rgb: rgbAt, manual: true };
      return lightSource;
    },
    // Regions, ordered top to bottom. `mask(i)` is a soft 0..1 field.
    get regions() { return regionList; },
    mask(i) { return regionMasks[i] || null; },
    maskAt(i, u, v) {
      const m = regionMasks[i];
      if (!m) return 1;
      const x = Math.min(AW - 1, Math.max(0, (u * AW) | 0));
      const y = Math.min(AH - 1, Math.max(0, (v * AH) | 0));
      return m[y * AW + x];
    },
    lumAt: (u, v) => sampleAt(lum, u, v),
    edgeAt: (u, v) => sampleAt(edge, u, v),
    gxAt: (u, v) => sampleAt(gx, u, v),
    gyAt: (u, v) => sampleAt(gy, u, v),
    rgbAt(u, v) {
      if (!ready) return [255, 255, 255];
      const x = Math.min(AW - 1, Math.max(0, (u * AW) | 0));
      const y = Math.min(AH - 1, Math.max(0, (v * AH) | 0));
      const i = (y * AW + x) * 3;
      return [rgb[i], rgb[i + 1], rgb[i + 2]];
    },
  };
}

// Current surface's analysis. Reassigned per surface each frame by main.js.
let Analysis = createAnalysis();
