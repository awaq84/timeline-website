/* camera.js — presence and position sensing from a webcam.
 *
 * Deliberately not machine learning. In a dark room with a projector running,
 * a slowly-adapting background model plus frame differencing is more robust
 * than pose estimation and costs nothing: it tolerates the projection's own
 * brightness changes (they fade into the background model) while still
 * reacting instantly to a person walking up.
 *
 * Exposes a smoothed signal:
 *   presence  0..1   how much someone is there
 *   x         0..1   horizontal centroid of motion (0 = camera left)
 *   energy    0..1   instantaneous motion, unsmoothed-ish; good for triggers
 */

const Camera = (() => {
  const W = 160, H = 120;          // tiny — we only need coarse blobs
  const ADAPT = 0.02;              // background adaptation rate per frame
  const THRESH = 18;               // per-pixel difference that counts as motion
  const SMOOTH = 0.12;             // output smoothing

  let video = null, ctx = null, bg = null, ready = false;
  const signal = { presence: 0, x: 0.5, energy: 0, ready: false, error: null };

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      });
      video = document.createElement('video');
      video.srcObject = stream;
      video.playsInline = true;
      video.muted = true;
      await video.play();

      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      ctx = c.getContext('2d', { willReadFrequently: true });
      ready = true;
      signal.ready = true;
    } catch (err) {
      // No camera, or permission denied. Effects fall back to autonomous mode.
      signal.error = err.message || String(err);
      console.warn('[camera] unavailable —', signal.error);
    }
    return signal;
  }

  function sample() {
    if (!ready) return signal;

    ctx.drawImage(video, 0, 0, W, H);
    const frame = ctx.getImageData(0, 0, W, H).data;

    // Luma at quarter resolution, which is plenty for blob centroids.
    const n = W * H;
    const lum = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      lum[i] = 0.299 * frame[p] + 0.587 * frame[p + 1] + 0.114 * frame[p + 2];
    }

    if (!bg) { bg = lum.slice(); return signal; }

    let moved = 0, sumX = 0;
    for (let i = 0; i < n; i++) {
      const diff = Math.abs(lum[i] - bg[i]);
      if (diff > THRESH) {
        moved++;
        sumX += i % W;
      }
      // Adapt the background toward the current frame. Slow enough that a
      // standing person still registers for a while, fast enough that a
      // changing projection doesn't read as permanent motion.
      bg[i] += (lum[i] - bg[i]) * ADAPT;
    }

    const fraction = moved / n;
    // ~6% of frame covered reads as full presence; tune for your room.
    const rawPresence = Math.min(1, fraction / 0.06);
    const rawX = moved > 0 ? (sumX / moved) / W : signal.x;

    signal.presence += (rawPresence - signal.presence) * SMOOTH;
    signal.x += (rawX - signal.x) * SMOOTH;
    signal.energy = rawPresence;
    return signal;
  }

  return { start, sample, signal, get ready() { return ready; } };
})();
