# Projection Wall

Camera-aware projection mapping onto a physical painting. Runs entirely in the
browser — no build step, no dependencies.

> **This folder is unrelated to the timeline site it currently sits inside.**
> The repo has a `CNAME`, so a `git add .` would publish this. Either add
> `projection/` to `.gitignore` or move the folder out.

---

## The two constraints that govern everything

**1. A projector adds light. It cannot subtract it.** You cannot darken a bright
area of the painting, cast a shadow, or turn white into black. Every effect must
be built from *added* light — glows, glints, rays, warm washes, shimmer. This is
why every effect in `effects.js` composites with `globalCompositeOperation =
'lighter'`. An effect that relies on drawing something dark will be invisible on
the wall, no matter how good it looks in preview.

**2. The room has to be dark.** Under normal room light the painting already
reflects more than the projector adds, and the whole thing washes out. This
matters more than projector brightness.

---

## Setup

1. Connect the projector as an **extended** display (not mirrored) and aim it so
   the painting sits comfortably inside the projected rectangle. Use the
   projector's own keystone correction for gross skew; the software handles the
   rest.
2. Serve the folder and open it — `getUserMedia` needs a secure context, and
   `localhost` counts, so `file://` will not work.

   ```bash
   python3 serve.py
   ```

   Use this rather than `python3 -m http.server`. It disables HTTP caching, so
   an edited `main.js` or `effects.js` always takes effect on reload. With
   caching on, the browser silently keeps running the old file — which looks
   exactly like the change did nothing, and costs a lot of time to spot.

3. Open `http://localhost:8091/`, drag the window onto the projector display,
   press <kbd>F</kbd> for fullscreen.
4. Stop the Mac sleeping mid-show:

   ```bash
   caffeinate -d
   ```

---

## Calibration

This is the step that decides whether the piece works — but it should take under
a minute, not several. Work in two passes, coarse then fine.

The quad starts at the **painting's own proportions**, so you never have to
reshape it — only place and size it.

**Pass 1 — place it (whole quad).**

1. Press <kbd>C</kbd> for calibration, <kbd>T</kbd> for the test pattern.
2. **Drag anywhere inside the quad** to move all four corners together.
3. **Scroll** (or <kbd>+</kbd> / <kbd>-</kbd>) to resize about the centre.

That gets you most of the way in one gesture. The quad is tinted while it's in
whole-quad mode, as a reminder you can grab it anywhere.

**Pass 2 — the skew (single corners).**

4. Drag an individual handle, or press <kbd>Space</kbd> and <kbd>Tab</kbd> to
   step through **TL TR BR BL**. Arrow keys nudge 1px, <kbd>Shift</kbd> 10px —
   the last few pixels are far easier by keyboard than by dragging.
5. The magenta corner ticks should land exactly on the canvas edge. When the grid
   reads square against the painting, the perspective is solved.
6. Press <kbd>T</kbd> to drop the test pattern, <kbd>C</kbd> to hide the chrome.

<kbd>R</kbd> resets to a correctly-proportioned rectangle centred on screen, which
is the fastest way to start over if you move the projector.

Corners persist in `localStorage`, so this survives reloads. <kbd>R</kbd> resets
them if you move the projector.

---

## Keys

| Key | |
|---|---|
| <kbd>C</kbd> | calibration chrome on/off |
| <kbd>T</kbd> | alignment test pattern |
| <kbd>P</kbd> | preview (composite over the painting photo) |
| <kbd>1</kbd>…<kbd>9</kbd><kbd>0</kbd> | scene (<kbd>0</kbd> = scene 10) |
| <kbd>[</kbd> <kbd>]</kbd> | previous / next scene |
| <kbd>A</kbd> | enable microphone |
| <kbd>M</kbd> | music-directed scenes (auto) |
| <kbd>,</kbd> <kbd>.</kbd> | master brightness down / up |
| <kbd>Tab</kbd> | select corner |
| <kbd>←↑→↓</kbd> | nudge corner (<kbd>Shift</kbd> = 10px) |
| <kbd>R</kbd> | reset corners |
| <kbd>F</kbd> | fullscreen |

**Preview mode defaults to ON** so you can tune effects on a laptop. It draws the
painting photo underneath the effects. **Turn it off before projecting** —
otherwise you project a picture of the painting onto the painting. The status
readout warns while it's on.

---

## Scenes

| # | Scene | |
|---|---|---|
| 1 | Sunset | Default. Sun breathes, water ripples, glitter on the reflection. |
| 2 | Golden hour | Warmer, slower, dense glitter. |
| 3 | Storm | Cold and restless. Choppy water, moving cloud, lightning. |
| 4 | Raking light | Slow side-light across the impasto. **Try this one first** — heavy palette-knife texture responds to it dramatically. |
| 5 | Rays | Shafts fanning down from the sun, caustics on the water, bloom throughout. |
| 6 | Nightfall | Stars over the dark cloud, deep bloom, quiet water. |
| 7 | Downpour | Rain, caustics, lightning. The full storm. |
| 8 | ♪ Resonate | Sound-reactive. Bass swells the sea, treble sparkles, beats flash the rays. |
| 9 | ♪ Tempest | Sound-reactive storm. Rain density and lightning follow the music. |
| 0 | Waking | Camera-reactive. Dormant until someone approaches. |

Scenes are just functions in `main.js` — compose effects freely.

---

## Sound reactivity

Scenes marked ♪ respond to live audio. Press <kbd>A</kbd> (or just select one —
it asks for the microphone on demand rather than prompting at load).

The analyser gives every scene four smoothed signals plus onset detection:

| Signal | Range | Typically drives |
|---|---|---|
| `bass` | ~20–250 Hz | swell — wave amplitude, bloom radius, glitter size |
| `mid` | ~250–2k Hz | body — ripple speed, caustic churn |
| `treble` | ~2k–8k Hz | sparkle — glitter count and flare rate |
| `level` | RMS | overall intensity |
| `beat` | decaying envelope | ray flares, lightning, flashes |

Onsets use **spectral flux against an adaptive threshold**, not a loudness gate —
it sums the positive frame-to-frame changes across the spectrum and fires when
that exceeds the recent mean. That's why a snare cuts through a sustained pad
instead of everything just tracking the kick drum.

The bars in the status readout show all four live, so you can confirm the
analyser is hearing something before you trust the visuals.

**Feeding it audio.** The microphone hears the room, so simply playing music near
the painting works, and so does speech or applause. To drive it from music
playing *on the Mac* with no acoustic path, install a loopback device
([BlackHole](https://github.com/ExistentialAudio/BlackHole)) and select it as the
input — that gives a clean signal with no room noise or feedback.

**Gain is automatic.** Each band normalises against a slowly-decaying running
peak (~23s half-life), so the visuals respond to *relative* dynamics and work at
any room volume without calibration. The trade-off: it needs a few seconds of
music to find its range, so the opening of a track can look muted.

Band levels blend mean and peak across the band rather than taking the mean
alone. The treble band spans ~256 FFT bins, so a cymbal occupying a handful of
them averages away to nearly nothing — mean-only made the sparkle effects dead.

**Tuning.** If onsets fire too often or too rarely, adjust the `1.5` multiplier
on the standard deviation in `audio.js`; higher is stricter.

---

## Music-directed scenes

Press <kbd>M</kbd>. The scene then follows the track's energy up and down a
ladder, quietest to loudest:

`Nightfall → Sunset → Golden hour → Rays → ♪ Resonate → ♪ Tempest`

Three things stop it behaving like a strobe:

- **A long-window energy average** (~1.6s time constant). Music is spiky;
  reacting to instantaneous level would switch scenes constantly.
- **Hysteresis** — a value hovering on a boundary must clear it by a margin
  before committing, so it can't oscillate between two neighbours.
- **A minimum dwell** of 9 seconds, so a scene always gets time to read.

Scene changes cross-fade over ~1.1s rather than cutting; an instant swap on a
wall reads as a glitch.

Energy is `0.55·level + 0.25·bass + 0.12·beat-rate`, so a quiet track with a fast
pulse still ranks above a loud drone. The status readout shows the live energy
bar and the scene it's currently selecting.

---

## Brightness

Effects render into a separate **light layer** — everything the projector emits —
composited additively over the painting. <kbd>,</kbd> and <kbd>.</kbd> scale that
whole layer from 0.1× to 2×.

This exists because the right level depends entirely on the room: projector
lumens, ambient light, how reflective the canvas is. Rather than re-tuning
individual effect constants on the wall, turn the master up until the effects
read without blowing out the highlights.

It also makes the preview honest. The painting stand-in is drawn at 45%
brightness on purpose: in a dark room the canvas reflects little and projected
light dominates, so a bright backdrop would make every soft wash look far weaker
in preview than it will be in reality.

---

## The reference photo

`painting.jpg` is a photo of the painting, used two ways: as the shimmer source
(so ripples follow the painting's real content) and as the preview backdrop.

It includes the frame and wall, so `CANVAS_CROP` in `main.js` trims it to the
canvas only. If the shimmer picks up gold from the frame, or the preview shows a
sliver of frame at an edge, nudge those four numbers — they're fractions of the
photo, and the current values were measured from this specific photo:

```js
const CANVAS_CROP = { x: 0.2195, y: 0.2145, w: 0.5235, h: 0.5275 };
```

Reshoot square-on if you can: this photo was taken at an angle, so the crop is a
rectangle approximating a slight trapezoid. It's imperceptible for soft additive
effects, but a square-on photo would be exact.

`HORIZON = 0.545` marks where sky meets water. Effect bands respect it — a ripple
running across the horizon breaks the illusion faster than anything else.

---

## Camera

Frame differencing against a slowly-adapting background model, at 160×120.
Deliberately not pose estimation: this is more robust in a dark room, costs
nothing, and tolerates the projection's own brightness changes because they fade
into the background model.

It gives `presence` (0–1), `x` (horizontal centroid) and `energy`. Scene 5 uses
them; the others ignore them.

Two practical notes. **Aim the camera at the approach area, not the painting** —
pointing it at your own projection invites a feedback loop. And on a MacBook the
lid camera faces you, not the wall, so use **Continuity Camera** (mount an iPhone
near the projector) or a USB webcam. Everything still runs without a camera;
presence just stays at zero.

---

## Writing effects

Each effect takes `(ctx, t, env)` where `ctx` is in painting space (origin at the
canvas's top-left, `env.W × env.H`), `t` is seconds, and `env` carries
`presence`, `x`, `energy` and `ref` (the cropped photo).

| Effect | |
|---|---|
| `godRays` | shafts fanning from a point — set `origin` to the sun |
| `caustics` | pool-floor light net; four interfering sine fields, rendered small and scaled up |
| `bloom` | re-projects the painting's own highlights, blurred — makes it glow from within |
| `shimmer` | horizontal strip displacement; water surface |
| `cascade` | vertical strip flow; waterfalls. Unused here, kept for other paintings |
| `glitter` | sharp twinkling points; sun glitter on water |
| `stars` | glitter, spread evenly, small and cool |
| `rain` | slanted streaks, batched into one path |
| `lightning` | rare double-strike flash |
| `sweep` | raking bar of light; impasto reveal |
| `embers` | drifting rising motes |
| `spotlight` | soft pool, follows `env.x` |
| `breath` | slow global warm pulse |
| `regionGlow` | lights one named polygon from `regions.json` |

Two rules: **stay additive**, and **respect the horizon**.

---

## Regions, and where AI actually belongs here

`regions.json` names areas of the painting as normalised polygons — `sun`,
`reflection`, `clouds-dark`, `water`. Effects target them by name.

The useful place for a model in this project is **authoring, not runtime**. Claude
can't be in the render loop — an API call is ~a second and this runs at 60fps.
But sending it the photo once and asking for a scene description is exactly the
right job: which regions exist, what each depicts, what motion suits it. That
returns structured JSON your shaders then run locally with no network in the loop.

The current `regions.json` was written by reading the painting directly. To
regenerate for a different painting, ask for `output_config.format` with a schema
matching this file's shape, so you get renderable JSON rather than prose.
