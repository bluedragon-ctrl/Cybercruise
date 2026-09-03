// Player death — "DISCONNECT". The car is never a physical object that blows
// up; it's a signal the player is jacked into (see engine/neon.js's whole
// wireframe aesthetic). So dying doesn't look like effects.js's drawWreck —
// no shrapnel, nothing tumbles — it looks like the FEED failing, and the game
// reports CONNECTION LOST rather than showing a wreck.
//
// SINCE PHASE 15E-I THIS MODULE DRAWS ALMOST NOTHING. The collapse is a
// fragment shader — engine/gl/shaders.js's GLITCH_FS, run by
// engine/present.js over the finished frame — and what is left here is the
// TIMELINE that drives it plus the one thing the pass cannot do (the hit
// core, below). Read GLITCH_FS's header for what the effect IS; read this one
// for when.
//
// WHAT THE COLLAPSE IS MADE OF, in the data vocabulary the whole game is
// written in: blocks of the picture stop arriving, in no particular order, and
// stay gone; the colour depth falls away as the bandwidth does; rows arrive out
// of order or not at all; the channels lose sync with each other. It ends
// nearly black with a scatter of flattened fragments still on screen.
//
// LOCAL-THEN-GLOBAL IS GONE, AND THAT IS THE ONE REAL LOSS HERE. Through 15d
// the car's OWN outline broke up first (effects.js's drawChromaticSplit) and
// the world followed a beat later, which is what sold this as a CONNECTION
// collapsing rather than a vehicle being destroyed. 15e-i deletes that stage on
// the project owner's call: it does not read under the pass. Keeping the order
// by biasing the block failure toward the car's position WAS built — the feed
// starting to fail where the car is and spreading outward — and rejected on
// sight: it opens a black hole around the car, which reads as a cutout rather
// than as data loss. What carries the fiction now is that the failure is
// SCATTERED (GLITCH_FS's `order`, near 1 here) rather than a sweep: a feed
// coming apart everywhere at once is not something happening to the car.
//
// PACING. The sequence deliberately holds still for a beat right after the
// hit (see HOLD_END) before anything glitches — a death that starts breaking
// up instantly doesn't give the player time to register that they died before
// they're staring at a game-over screen. Through that beat feed() reports
// nothing to do at all, so present.js does not even run the pass and the frame
// is bit-for-bit an ordinary one. DISCONNECT_DURATION is 2.6s for the same
// reason: long enough to read as a moment, not a flicker.
//
// THE READOUT IS ON THE HUD CANVAS, which the pass cannot reach — see
// jackin.js's header, which states that once for both ends. CONNECTION LOST
// stays pin-sharp over a frame that is failing: the instruments work, the feed
// does not.
//
// ONE INSTANCE, not a pool: only one player can ever be dying at a time, so
// this is a single stateful object main.js owns directly (trigger/update/
// render, reset() between games), the same shape as player.js itself rather
// than effects.js's Explosions pool.
//
// A PURE FUNCTION OF PROGRESS, same discipline as effects.js: feed(), shake()
// and render() all recompute from `elapsed` and the seed captured at trigger()
// rather than storing any state, so nothing here allocates per frame.

import { neonStroke, glowText } from "../engine/neon.js";
import { rng } from "./effects.js";
import { GREEN_PALE } from "../engine/palette.js";

// Seconds from the killing hit to the game-over screen taking over.
export const DISCONNECT_DURATION = 2.6;

// Fractions of DISCONNECT_DURATION (not seconds) each beat runs for, kept as
// fractions so retuning the total duration reshapes every beat with it. Read
// top to bottom, this IS the sequence's timeline:
//   flash -> held silence -> the feed starts losing sync -> blocks stop
//   arriving and the colour depth goes with them -> readout resolves and holds
//   -> game-over takes over.
const FLASH_END = 0.05;      // white hit-core
const HOLD_END = 0.17;       // frozen beat: nothing glitches or moves yet, so
                             // the hit has a moment to register. The desync
                             // (shake) starts here
const WORLD_START = 0.30;    // the feed itself starts failing — a beat after
                             // the desync, cause then effect
const SCAN_END = 0.85;       // reordering and channel desync run out here,
                             // leaving the block loss and the colour collapse
                             // to deepen alone into the final hold
const SHAKE_END = 0.75;      // world desync settles before that final hold
const TEXT_START = 0.55;     // CONNECTION LOST starts fading in
const TEXT_FULL = 0.75;      // ...fully in, held to the end

// Peak darkness of the world collapse (GLITCH_FS's uFade). Short of full black
// — the readout no longer needs something to read against, since Phase 15c put
// it on a layer of its own, but a frame that reached pure black would throw
// away the surviving fragments that are the point of the end state.
const DESAT_MAX = 0.85;

// How much of the feed is still arriving when the game-over screen takes over.
// Not zero: the last frame should be a picture that is mostly gone, not an
// empty one, so that what the cut interrupts is still recognisably a signal.
const RESOLVE_FLOOR = 0.30;

// How scattered the block failure is (GLITCH_FS's `order`, 0 a top-to-bottom
// wavefront, 1 no order at all). Near the top of that range, and deliberately
// not AT it: a trace of the wavefront left in keeps this reading as the mirror
// of jackin.js's raster rather than as unrelated noise.
const FAIL_ORDER = 0.70;

// Peak channel desync during the collapse, against jackin.js's own 1.0 — the
// death disagrees with itself less than the boot does, because on the way in
// that beat is the picture RESOLVING and here it is one symptom among several.
const SPLIT_MAX = 0.55;

export class Disconnect {
  constructor() {
    this.active = false;
    this.elapsed = 0;
    this.x = 0;
    this.y = 0;
    this.w = 34;
    this.h = 60;
    this.seed = 1;
  }

  // Freeze-frame the car where it died. `x, y, w, h` are the player's own
  // fields at the moment its hull hit zero — main.js stops calling
  // player.update() once this fires, so they stay put on their own; this just
  // takes a copy rather than depending on that. Still needed after 15e-i: the
  // hit core in render() is drawn at the car's centre.
  trigger(x, y, w, h) {
    this.active = true;
    this.elapsed = 0;
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.seed = (Math.random() * 0x7fffffff) | 0;
  }

  // Between games, so a restarted run doesn't inherit a finished sequence's
  // `active` flag (harmless, since progress >= 1 already, but this is what
  // keeps a stale disconnect from ever being drawn for a frame on restart).
  reset() {
    this.active = false;
    this.elapsed = 0;
  }

  update(dt) {
    if (this.active) this.elapsed += dt;
  }

  get progress() {
    return Math.min(1, this.elapsed / DISCONNECT_DURATION);
  }

  get done() {
    return this.progress >= 1;
  }

  // A screen-space [dx, dy] the WHOLE feed is offset by. Deliberately re-rolled
  // from a seed keyed to elapsed time rather than eased toward zero, so it
  // reads as the feed losing sync rather than a physical jolt settling — see
  // the header for why this isn't a camera SHAKE. Silent through HOLD_END (the
  // freeze beat) and dead by SHAKE_END so the last stretch holds steady on the
  // readout.
  //
  // UNCHANGED BY 15E-I, DOWN TO THE NUMBERS — only what the caller DOES with
  // it moved. main.js used to ctx.translate the whole world block by this; it
  // now hands it to the pass as a UV offset (present.js's `feed`), which
  // composes with everything else the pass is doing, cannot reach the HUD layer
  // by construction rather than by careful save/restore placement, and lands on
  // whole device pixels for free because the frame texture is NEAREST.
  shake() {
    if (!this.active) return [0, 0];
    const t = this.progress;
    if (t < HOLD_END || t >= SHAKE_END) return [0, 0];
    const k = 1 - (t - HOLD_END) / (SHAKE_END - HOLD_END);
    const rand = rng((this.seed + Math.floor(this.elapsed * 45)) >>> 0);
    return [(rand() - 0.5) * 14 * k, (rand() - 0.5) * 4 * k];
  }

  // THE SEQUENCE ITSELF, as numbers rather than as pixels — see jackin.js's
  // feed() for the shape and present.js's `feed` for the rule that replaced
  // "no module under src/game/ knows the GPU path exists".
  //
  // Returns whether the pass has anything to do. THROUGH THE HELD BEAT IT
  // RETURNS FALSE, which is not a micro-optimisation: it is what makes the
  // pause after the hit an ordinary frame rather than an ordinary frame put
  // through a shader that happens to be the identity. The hit core in render()
  // is drawn on the 2D canvas, so it is unaffected either way.
  feed(out) {
    if (!this.active) return false;
    const t = this.progress;
    if (t < HOLD_END) return false;

    out.time = this.elapsed;
    // Reduced to a fraction: the shader adds this to block indices in a
    // 32-bit float, where a raw seed of this size would swallow them whole.
    // See present.js's `feed`.
    out.seed = (this.seed & 0x3ff) / 1024;
    out.order = FAIL_ORDER;
    out.flash = 0;

    const [sx, sy] = this.shake();
    out.shakeX = sx;
    out.shakeY = sy;

    // THE COLLAPSE, on one axis: how far past WORLD_START the feed is. Blocks
    // stop arriving and stay gone, and the colour depth falls with them. Both
    // keep deepening right up to the cut, which is what leaves the game-over
    // screen taking over from a picture that is nearly gone rather than one
    // that has finished going.
    const w = t > WORLD_START ? (t - WORLD_START) / (1 - WORLD_START) : 0;
    out.resolve = 1 - w * (1 - RESOLVE_FLOOR);
    out.quant = w;
    out.fade = w * DESAT_MAX;

    // Reordering and channel desync, decaying out by SCAN_END so the last
    // stretch is the loss alone. The square wave is the one thing carried over
    // literally from the 2D version: a dropped feed CUTS, it doesn't fade, and
    // blinking the reordering on and off is what says so. Only `corrupt`
    // blinks — quantisation and block loss are permanent, and strobing them
    // would say the opposite.
    const scan = t > WORLD_START && t < SCAN_END
      ? 1 - (t - WORLD_START) / (SCAN_END - WORLD_START)
      : 0;
    out.corrupt = Math.sin(this.elapsed * 22) > 0.1 ? scan : 0;
    out.split = scan * SPLIT_MAX;
    return true;
  }

  // ALL THAT IS LEFT ON THE 2D CANVAS: the hit flash. A brief white core at the
  // car's own centre, so the instant still reads as an impact. It stays here,
  // and did not move into the pass with everything else, because it is not a
  // screen effect — it is GEOMETRY at a position, and the pass has the frame
  // but not the car. (jackin.js's closing flash DID move, because that one is
  // a full-screen fill and has to whiten what the pass produced.)
  //
  // Drawn INSTEAD of player.render() while active, in the same block the frozen
  // world draws in. Done well before HOLD_END, so it never overlaps anything
  // the pass is doing.
  //
  // NO `W, H` ANY MORE: the two beats that spanned the whole screen (the
  // full-width scanline tears and the dim toward black) are feed() fields now,
  // and nothing left in here knows or needs the canvas size.
  render(ctx) {
    if (!this.active) return;
    const t = this.progress;
    if (t >= FLASH_END) return;
    const { x: cx, y: cy, h } = this;
    const k = 1 - t / FLASH_END;
    const r = h * 0.4 * k;
    neonStroke(ctx, (c) => {
      c.moveTo(cx + r, cy);
      c.arc(cx, cy, r, 0, Math.PI * 2);
    }, "#ffffff", 3, k);
  }

  // The HUD readout: CONNECTION LOST, fixed in screen space, on the layer the
  // pass cannot reach — see the header, and jackin.js's for the full argument.
  renderOverlay(ctx, W, H) {
    if (!this.active) return;
    const t = this.progress;
    if (t < TEXT_START) return;
    const alpha = Math.min(1, (t - TEXT_START) / (TEXT_FULL - TEXT_START));
    ctx.save();
    ctx.globalAlpha = alpha;
    glowText(ctx, "CONNECTION LOST", W / 2, H * 0.42, "#ffffff", 26, "center", 14);
    glowText(ctx, "REACQUIRING SIGNAL...", W / 2, H * 0.42 + 34, GREEN_PALE, 13, "center", 8);
    ctx.restore();
  }
}
