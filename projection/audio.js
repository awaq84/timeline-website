/* audio.js — live audio analysis driving the visuals.
 *
 * Exposes a smoothed signal every frame:
 *   level    0..1  overall loudness (RMS)
 *   bass     0..1  ~20-250 Hz   — swell, wave height, bloom
 *   mid      0..1  ~250-2k Hz   — body, general intensity
 *   treble   0..1  ~2k-8k Hz    — glitter, sparkle, spray
 *   beat     0..1  decaying envelope, spikes on each detected onset
 *   onset    bool  true only on the frame an onset fires
 *
 * Onset detection is spectral flux against an adaptive threshold: sum the
 * positive frame-to-frame changes across the spectrum, and fire when that
 * exceeds the recent mean by a margin. This beats a plain level gate because
 * it responds to a snare over a sustained pad, not just to "loud".
 */

const AudioIn = (() => {
  const FFT = 2048;
  const SMOOTH = 0.34;        // per-frame smoothing of band values
  const BEAT_DECAY = 0.88;    // how fast the beat envelope falls
  const MIN_ONSET_GAP = 0.09; // seconds; stops a single hit double-firing
  const HISTORY = 43;         // ~0.7s of flux history for the adaptive threshold

  /* Expansion curve applied after normalising. Music spends most of its time
   * in the lower half of its own range, so a linear mapping leaves the visuals
   * sitting near idle; an exponent below 1 lifts that region and makes ordinary
   * playback drive the full range. */
  const CURVE = 0.62;

  let actx = null, analyser = null, spectrum = null, waveform = null;
  let prevSpectrum = null, ready = false;
  let lastOnset = -1;
  const fluxHistory = [];

  const sig = {
    level: 0, bass: 0, mid: 0, treble: 0, beat: 0,
    onset: false, ready: false, error: null,
  };

  /* Running peak per band, for automatic gain. Fixed gains cannot work here:
   * the right value depends on how loud the room is, how far away the speakers
   * are and the mic's own sensitivity. Normalising against a slowly-decaying
   * peak means the visuals respond to *relative* dynamics, so quiet and loud
   * material both drive the full range without any calibration. */
  const peaks = { level: 0.02, bass: 0.02, mid: 0.02, treble: 0.02 };
  const PEAK_DECAY = 0.9985;   // ~8s half-life at 60fps — tracks the track
  /* The relative term is v/peak, so the peak floor decides how quiet a signal
   * can be and still read as full scale. At 0.012 a room's hum at 0.004 became
   * its own reference and normalised to 1.0 — every band pinned high in
   * silence. Raised so nothing below roughly a tenth of real listening level
   * can saturate. */
  const PEAK_FLOOR = 0.038;

  /* Absolute references — roughly what "loud" looks like on a mic at sensible
   * listening volume. Needed because peak-relative normalisation alone is
   * degenerate: a signal becomes its own peak within seconds, so v/peak pins
   * to 1.0 and a quiet passage measures the same as a loud one. Blending the
   * two keeps relative dynamics responsive while preserving the absolute
   * loudness the energy ladder depends on. */
  const ABS_REF = { level: 0.22, bass: 0.55, mid: 0.45, treble: 0.40 };
  const REL_MIX = 0.5;

  /* Noise gate. Without it a silent room still drives the visuals hard: the
   * relative term is degenerate at low signal — whatever the loudest recent
   * sound was becomes the reference, so v/peak pins to 1.0. Measured in a
   * quiet room, bass 0.0203 normalised to 0.66: two-thirds scale from hum.
   *
   * The threshold is measured, not fixed. A hard-coded number cannot be
   * right for every microphone, room and playback volume — set it from one
   * quiet room and it silences a different one entirely.
   *
   * Instead each band tracks its own noise floor: it drops instantly to any
   * new minimum and creeps up slowly, so it settles on the room's hum within
   * a few seconds and follows it if conditions change. The gate sits a little
   * above that floor, with a wide knee so quiet music still gets through
   * partly opened rather than being cut off. */
  const floors = { level: 0.02, bass: 0.02, mid: 0.01, treble: 0.005 };
  const FLOOR_RISE = 1.0006;      // ~30s to double during sustained silence
  const FLOOR_MIN  = { level: 0.004, bass: 0.006, mid: 0.002, treble: 0.0008 };
  /* How far above the measured noise floor the gate sits. Adjustable at
   * runtime and persisted: auto-calibration gets close, but the right value
   * depends on how much of the room's sound you want to count as music, and
   * that is a judgement call rather than something to infer. */
  let GATE_OVER = +(localStorage.getItem('proj.gate') ?? 1.25);
  const KNEE = 3.2;               // fully open at gate * KNEE — deliberately wide

  function setGate(v) {
    GATE_OVER = Math.max(1.0, Math.min(6.0, v));
    localStorage.setItem('proj.gate', GATE_OVER.toFixed(2));
    return GATE_OVER;
  }

  function noiseFloor(key, v) {
    if (v < floors[key]) floors[key] = v;                       // fall fast
    else floors[key] = Math.min(v, floors[key] * FLOOR_RISE);   // rise slowly
    return Math.max(FLOOR_MIN[key], floors[key]);
  }

  /* An absolute floor, underneath the adaptive one.
   *
   * The adaptive gate is proportional to the measured noise floor, so in a very
   * quiet room it shrinks to match — and then passes that same quiet room
   * through. Music played at any listening volume sits far above these; room
   * tone and mic self-noise sit below. */
  const ABS_GATE = { level: 0.006, bass: 0.009, mid: 0.0035, treble: 0.0018 };

  function normalise(key, v) {
    if (v < ABS_GATE[key]) { peaks[key] *= PEAK_DECAY; return 0; }
    const g = noiseFloor(key, v) * GATE_OVER;
    if (v <= g) { peaks[key] *= PEAK_DECAY; return 0; }
    // How far through the knee we are, 0..1.
    const open = Math.min(1, (v - g) / (g * (KNEE - 1)));

    peaks[key] = Math.max(v, peaks[key] * PEAK_DECAY);
    const rel = Math.min(1, v / Math.max(PEAK_FLOOR, peaks[key]));
    const abs = Math.min(1, v / ABS_REF[key]);
    return Math.pow(REL_MIX * rel + (1 - REL_MIX) * abs, CURVE) * open;
  }

  let sourceKind = 'none';
  let player = null;         // <audio> element, when playing a file

  /* The analyser is source-agnostic — a microphone stream and a decoded file
   * both feed the same graph. Built once, by whichever source arrives first. */
  function ensureContext() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (!analyser) {
      analyser = actx.createAnalyser();
      analyser.fftSize = FFT;
      analyser.smoothingTimeConstant = 0.55;
      spectrum = new Uint8Array(analyser.frequencyBinCount);
      waveform = new Uint8Array(analyser.frequencyBinCount);
      prevSpectrum = new Float32Array(analyser.frequencyBinCount);
    }
    return actx;
  }

  /* Play a local audio file and analyse it directly. For a fixed installation
   * this is the better input: no permission prompt in any browser, no room
   * noise, no automatic gain control flattening the dynamics, and the signal
   * is the actual track rather than a re-recording of it through the air. */
  async function startFile(file) {
    try {
      ensureContext();
      if (player) { player.pause(); URL.revokeObjectURL(player.src); }
      player = new Audio(URL.createObjectURL(file));
      player.loop = true;
      // Unlike the mic path this *does* reach the speakers — it is the playback.
      actx.createMediaElementSource(player).connect(analyser);
      analyser.connect(actx.destination);
      await actx.resume();
      await player.play();
      ready = true;
      sig.ready = true;
      sig.error = null;
      sourceKind = 'file · ' + file.name;
    } catch (err) {
      sig.error = err.message || String(err);
      console.warn('[audio] file failed —', sig.error);
    }
    return sig;
  }

  /* Live audio via the local bridge: a native capture tool holds the microphone
   * permission and streams band levels over Server-Sent Events. This is the
   * reliable path for a live room — the browser never calls getUserMedia, so
   * Safari's secure-context rules and the certificate trust question simply
   * do not arise. Falls back silently if the bridge is not running. */
  let bridgeES = null;
  let lastBridgeAt = 0;          // wall-clock ms of the last frame received
  let bridgeReconnects = 0;

  /* The feed can stop without the connection reporting an error — the bridge
   * process is replaced, the machine sleeps, Safari suspends the stream. The
   * old code held the last value forever, so the meters froze at whatever they
   * happened to be showing while `ready` still claimed the mic was live. That
   * is the input "getting stuck".
   *
   * Two guards: a staleness check that zeroes the signal when frames stop, and
   * a hard reconnect if they do not come back. */
  const STALE_MS = 2500;         // no frames for this long = not live
  const REVIVE_MS = 6000;        // ...and this long = tear the stream down

  function openBridge() {
    try { if (bridgeES) bridgeES.close(); } catch {}
    bridgeES = new EventSource('/audio');
    bridgeES.onmessage = ev => {
      try {
        bridgeRaw = JSON.parse(ev.data);
        lastBridgeAt = Date.now();
        if (!ready) { ready = true; sig.ready = true; sig.error = null; }
        sourceKind = 'bridge (live mic)';
      } catch { /* ignore malformed frame */ }
    };
    bridgeES.onerror = () => {
      if (!bridgeRaw) sig.error = 'bridge not running — start: node bridge/serve.js';
    };
  }

  function startBridge() {
    if (bridgeES) return sig;
    try { openBridge(); }
    catch (err) { sig.error = err.message || String(err); }
    return sig;
  }

  /* Called every frame from sample(). Cheap, and it is the only thing standing
   * between a dead feed and a wall that looks alive but is not listening. */
  function checkBridgeHealth() {
    if (!bridgeES || !lastBridgeAt) return;
    const idle = Date.now() - lastBridgeAt;
    if (idle > STALE_MS) {
      // Stop reporting stale numbers as if they were live.
      bridgeRaw = null;
      sig.level = sig.bass = sig.mid = sig.treble = sig.beat = 0;
      sig.error = `bridge silent for ${(idle / 1000).toFixed(0)}s`;
      sourceKind = 'bridge (stalled)';
    }
    if (idle > REVIVE_MS) {
      bridgeReconnects++;
      lastBridgeAt = Date.now();       // don't retry every frame
      openBridge();
    }
  }
  let bridgeRaw = null;
  let prevBands = [0, 0, 0];

  async function start() {
    if (ready) return sig;
    /* Safari does not exempt http://localhost from the secure-context rule the
     * way Chrome does, and in an insecure context navigator.mediaDevices is
     * undefined rather than throwing something legible. Say so plainly instead
     * of surfacing "undefined is not an object". */
    if (!navigator.mediaDevices?.getUserMedia) {
      sig.error = window.isSecureContext
        ? 'no getUserMedia in this browser'
        : 'insecure context — Safari needs https://, use the HTTPS URL or Chrome';
      console.warn('[audio] unavailable —', sig.error);
      return sig;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Defeat the processing that would flatten exactly what we want.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      ensureContext();
      // Deliberately not connected to destination — that would be a feedback loop.
      actx.createMediaStreamSource(stream).connect(analyser);
      sourceKind = 'microphone';
      ready = true;
      sig.ready = true;
    } catch (err) {
      sig.error = err.message || String(err);
      console.warn('[audio] unavailable —', sig.error);
    }
    return sig;
  }

  // Browsers start an AudioContext suspended until a user gesture.
  function resume() {
    if (actx && actx.state === 'suspended') actx.resume();
  }

  function binRange(loHz, hiHz) {
    const nyquist = (actx ? actx.sampleRate : 48000) / 2;
    const n = analyser.frequencyBinCount;
    return [
      Math.max(1, Math.floor((loHz / nyquist) * n)),
      Math.min(n - 1, Math.ceil((hiHz / nyquist) * n)),
    ];
  }

  /* Blend of mean and peak across the band. Mean alone buries sparse content:
   * the treble band spans ~256 bins, so a cymbal occupying a handful of them
   * averages away to nearly nothing. Peak alone is too jumpy. Mixing the two
   * keeps sustained material readable while letting transients punch through. */
  function bandLevel(loHz, hiHz) {
    const [a, b] = binRange(loHz, hiHz);
    let sum = 0, max = 0;
    for (let i = a; i <= b; i++) {
      const v = spectrum[i];
      sum += v;
      if (v > max) max = v;
    }
    const mean = sum / Math.max(1, b - a + 1) / 255;
    return 0.45 * mean + 0.55 * (max / 255);
  }

  function sample(t) {
    sig.onset = false;
    checkBridgeHealth();
    if (!ready) return sig;

    /* Bridge path: bands already computed natively. Normalisation, smoothing
     * and onset detection still run here so the two sources behave identically
     * downstream — only the spectrum acquisition differs. */
    if (bridgeRaw) {
      const bass   = normalise('bass',   bridgeRaw.bass);
      const mid    = normalise('mid',    bridgeRaw.mid);
      const treble = normalise('treble', bridgeRaw.treble);
      const level  = normalise('level',  bridgeRaw.level);

      sig.level  += (level  - sig.level)  * SMOOTH;
      sig.bass   += (bass   - sig.bass)   * SMOOTH;
      sig.mid    += (mid    - sig.mid)    * SMOOTH;
      sig.treble += (treble - sig.treble) * SMOOTH;

      // Flux over the three bands stands in for the full spectrum here.
      const flux = Math.max(0, bass - prevBands[0])
                 + Math.max(0, mid - prevBands[1])
                 + Math.max(0, treble - prevBands[2]);
      prevBands = [bass, mid, treble];
      fluxHistory.push(flux);
      if (fluxHistory.length > HISTORY) fluxHistory.shift();
      if (fluxHistory.length === HISTORY) {
        let mean = 0;
        for (const f of fluxHistory) mean += f;
        mean /= HISTORY;
        let variance = 0;
        for (const f of fluxHistory) variance += (f - mean) ** 2;
        const sd = Math.sqrt(variance / HISTORY);
        if (flux > mean + sd * 1.15 + 0.02 && t - lastOnset > MIN_ONSET_GAP) {
          lastOnset = t;
          sig.onset = true;
          sig.beat = 1;
        }
      }
      sig.beat *= BEAT_DECAY;
      return sig;
    }

    analyser.getByteFrequencyData(spectrum);
    analyser.getByteTimeDomainData(waveform);

    // RMS from the waveform, centred on 128.
    let sq = 0;
    for (let i = 0; i < waveform.length; i++) {
      const v = (waveform[i] - 128) / 128;
      sq += v * v;
    }
    const rms = Math.sqrt(sq / waveform.length);

    const bass   = normalise('bass',   bandLevel(20, 250));
    const mid    = normalise('mid',    bandLevel(250, 2000));
    const treble = normalise('treble', bandLevel(2000, 8000));
    const level  = normalise('level',  rms);

    sig.level  += (level  - sig.level)  * SMOOTH;
    sig.bass   += (bass   - sig.bass)   * SMOOTH;
    sig.mid    += (mid    - sig.mid)    * SMOOTH;
    sig.treble += (treble - sig.treble) * SMOOTH;

    // --- Spectral flux onset detection -----------------------------------
    let flux = 0;
    for (let i = 0; i < spectrum.length; i++) {
      const v = spectrum[i] / 255;
      const d = v - prevSpectrum[i];
      if (d > 0) flux += d;          // rises only; falls aren't onsets
      prevSpectrum[i] = v;
    }

    fluxHistory.push(flux);
    if (fluxHistory.length > HISTORY) fluxHistory.shift();

    if (fluxHistory.length === HISTORY) {
      let mean = 0;
      for (const f of fluxHistory) mean += f;
      mean /= HISTORY;
      let variance = 0;
      for (const f of fluxHistory) variance += (f - mean) ** 2;
      const sd = Math.sqrt(variance / HISTORY);

      const threshold = mean + sd * 1.15 + 0.32;
      if (flux > threshold && t - lastOnset > MIN_ONSET_GAP) {
        lastOnset = t;
        sig.onset = true;
        sig.beat = 1;
      }
    }

    sig.beat *= BEAT_DECAY;
    return sig;
  }

  /* Everything needed to work out why the mic is not running, in one place.
   * Read off the screen rather than the console — Safari hides the console
   * behind an off-by-default Develop menu, and "NO MIC" alone is unactionable. */
  let permState = 'unknown';
  (async () => {
    try {
      const p = await navigator.permissions?.query({ name: 'microphone' });
      if (p) { permState = p.state; p.onchange = () => { permState = p.state; }; }
    } catch { permState = 'unsupported'; }
  })();

  function diagnose() {
    return {
      origin: location.origin,
      secure: window.isSecureContext,
      hasMediaDevices: !!navigator.mediaDevices?.getUserMedia,
      permission: permState,
      source: sourceKind,
      bridgeIdleMs: lastBridgeAt ? Date.now() - lastBridgeAt : null,
      bridgeReconnects,
      // Raw (pre-gate) input and the gate it must clear — so a dead-looking
      // wall can be diagnosed as "no signal" vs "signal but gated out".
      raw: bridgeRaw ? {
        level: +bridgeRaw.level.toFixed(4), bass: +bridgeRaw.bass.toFixed(4),
        mid: +bridgeRaw.mid.toFixed(4), treble: +bridgeRaw.treble.toFixed(4),
      } : null,
      gate: {
        level: +(Math.max(FLOOR_MIN.level, floors.level) * GATE_OVER).toFixed(4),
        bass: +(Math.max(FLOOR_MIN.bass, floors.bass) * GATE_OVER).toFixed(4),
      },
      started: ready,
      error: sig.error,
      ctxState: actx ? actx.state : 'none',
    };
  }

  return {
    start, startFile, startBridge, resume, sample, diagnose,
    setGate, get gate() { return GATE_OVER; },
    signal: sig,
    get ready() { return ready; },
    get source() { return sourceKind; },
  };
})();
