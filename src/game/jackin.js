// START GAME — "JACK IN". The deliberate mirror image of game/disconnect.js:
// the same fiction (the car is a signal the player is jacked into, not a
// physical object), the same machinery (one instance main.js owns, staged
// fractions of a duration constant, a frozen-but-still-drawn world), run
// BACKWARDS. Death is a feed collapsing; this is a feed resolving.
//
// THREE THINGS HAPPEN AT ONCE, and they finish in this order:
//
//   1. RASTER BOOT. A resolve line sweeps top-to-bottom. Below it the screen
//      is still black (nothing has been rendered yet, as far as the fiction is
//      concerned); above it the real world is on screen but still tearing —
//      band shifts and scanline noise that decay as the line moves on. Then a
//      whole-scene chromatic split (cyan/magenta ghosts of the composited
//      frame) collapses to zero: the picture stops disagreeing with itself.
//      That last beat is disconnect.js's own car-breakup trick applied to the
//      WHOLE screen and run in reverse.
//   2. VEHICLE UPLOAD. The player's car assembles out of three offset
//      wireframe copies of its own silhouette — literally disconnect.js's
//      LOCAL breakup with its progress term inverted — arriving solid just
//      before the sweep's own flash.
//   3. THE DECK REPORTING ON ITSELF. Boot lines into the SYS LOG (this module
//      pushes them itself, the way links.js and sectors.js push theirs — see
//      BEATS below), plus a centred percentage readout sitting in the exact
//      spot disconnect.js's CONNECTION LOST occupies.
//
// RUNS ON EVERY START, NOT JUST THE FIRST. main.js triggers this from START
// GAME and from the game-over screen's RESTART alike — a run always begins
// with the rig coming up. The AUDIO ceremony is the one thing that stays
// once-per-page (music.jackIn() freezes backend selection and starts the
// scheduler; see synth.js), so a restart plays this silently over music that
// has been running since the first jack-in. Nothing here knows or cares which
// of the two it is.
//
// ON THE DURATION. 2.2s, against the audio riser's own 1.5s
// (audio/sfx.js's JACK_IN_DURATION), so the music's first downbeat lands at
// ~68% of this — under the vehicle upload rather than at the cut to gameplay.
// That is deliberate: the beat arriving while the car is still assembling is
// what makes the world feel like it comes up UNDERNEATH the music, and it buys
// the SYS LOG boot log (BEATS below) enough room to step a line at a time
// instead of dumping a block. The two numbers are independent on purpose —
// neither ceremony is trying to end on the other.
//
// A PURE FUNCTION OF PROGRESS, same discipline as disconnect.js and
// effects.js: every frame recomputes its jitter from `elapsed` plus the seed
// captured at trigger(), so nothing here allocates per frame. The one
// exception is the ghost canvas the chromatic split needs (see ghostCanvas
// below), which is allocated once and reused.

import { neonStroke, glowLine, glowText } from "../engine/neon.js";
import { rng, drawChromaticSplit } from "./effects.js";
import { PLAYER, PLAYER_THRUST, GREEN_PALE, GREEN_BRIGHT } from "../engine/palette.js";
import * as gameConsole from "../engine/console.js";
import { HINT } from "../engine/console.js";

// Seconds from START GAME (or RESTART) to the first gameplay tick — see the
// header on why this is 2.2s and not the audio riser's 1.5s.
export const CONNECT_DURATION = 2.2;

// Fractions of CONNECT_DURATION (not seconds), kept as fractions so retuning
// the total reshapes every beat with it — exactly how disconnect.js's own
// timeline is written. Read top to bottom, this IS the sequence:
//   raster sweeps down -> car assembles -> tearing settles -> scene split
//   collapses -> flash -> live.
const SWEEP_END = 0.40;    // the resolve line reaches the bottom of the screen
const TEAR_END = 0.72;     // band shifts and scanline noise run out
const CAR_START = 0.30;    // the car's wireframe copies appear, far apart —
                           // just after the sweep line has passed the row it
                           // sits on (H*0.62), so it is uncovered and already
                           // assembling rather than waiting in the open
const CAR_END = 0.90;      // ...and have converged into the real car. THE SAME
                           // instant as FLASH_START below, deliberately: what
                           // this module draws is the car's OUTLINE, and what
                           // main.js takes over drawing is the full car
                           // (fills, thruster, detail — see sprites.js), so
                           // the swap is a visible pop unless it happens
                           // underneath the flash that is already covering the
                           // screen for its own reasons
const SPLIT_START = 0.45;  // whole-scene chromatic ghosts, at their widest...
const SPLIT_END = 0.93;    // ...collapsed onto the picture they came from
const FLASH_START = 0.90;  // white hand-over flash (disconnect.js opens with
                           // one; this one closes)
const TEXT_LOCK = 0.90;    // the percentage hits 100 and the readout swaps

// How dark the unresolved region below the sweep line is. Matches neon.js's
// clear() colour rather than pure black, so the mask is indistinguishable from
// "nothing has been drawn here yet".
const VOID = "#05060a";

// Widest chromatic ghost offset, px. Generous on purpose — this is the beat
// that has to read as a picture not agreeing with itself from across the room.
const SPLIT_MAX = 10;
// Widest band-tear shift, px, at the top of the sweep.
const TEAR_MAX = 26;
const TEAR_BANDS = 7;

// SYS LOG boot lines: [progress, text]. Owned here rather than in main.js
// because the whole timeline is here — a beat table split across two files is
// a beat table that drifts. Pushing straight into engine/console.js is the
// same thing links.js, sectors.js, pickups.js and player.js already do, and it
// buys the console's own per-severity chime for free (see console.js's onPush
// seam, wired to audio from main.js). All HINT: a successful boot is not a
// warning about anything.
//
// MANY SHORT LINES, EVENLY SPACED, rather than a handful of long ones. Two
// rules, both learned from how it reads on screen rather than on paper:
//
//   1. ~0.1 of the duration apart (~240ms), so a line has landed and settled
//      before the next arrives. Bunch them any tighter and console.js's own
//      ease (EASE_RATE) has no time to slide one row up before the next
//      pushes in, and five lines arrive looking like one pasted block.
//   2. AT MOST 20 CHARACTERS. The panel is PANEL_W (160px) minus padding, at
//      11px type — a longer line runs out past its own plate and reads as a
//      wall of text rather than a log entry.
//
// There are more lines here than the panel's MAX_MESSAGES can hold, which is
// the point: the earliest ones scroll off the top while the boot is still
// running, which is exactly what a machine coming up looks like.
const BEATS = [
  [0.00, "RIG ONLINE"],
  [0.10, "NEURAL LINK // OPEN"],
  [0.20, "HANDSHAKE // OK"],
  [0.31, "FEED SYNC // RASTER"],
  [0.43, "CITY MAP // LOADED"],
  [0.55, "HULL // NOMINAL"],
  [0.67, "VEHICLE UPLOAD // 01"],
  [0.79, "WEAPONS // ARMED"],
  [0.92, "UPLINK STABLE"],
];

// The scratch canvas the chromatic split builds its tinted copies in. ONE,
// module-level, reused for both the cyan and the magenta pass of every frame
// (build cyan, draw it, then overwrite it with magenta and draw that) and
// across runs — a full-screen canvas is not something to allocate per frame,
// and there is never more than one jack-in on screen at a time.
let ghost = null;
let ghostCtx = null;

function ghostCanvas(W, H) {
  if (!ghost || ghost.width !== W || ghost.height !== H) {
    ghost = document.createElement("canvas");
    ghost.width = W;
    ghost.height = H;
    ghostCtx = ghost.getContext("2d");
  }
  return ghost;
}

// A copy of `source` with everything but `color`'s own channels multiplied
// away — i.e. the cyan-only or magenta-only version of the frame. "multiply"
// against a flat fill is the cheap way to get a real channel split rather than
// a plain offset ghost: black stays black (so the masked region below the
// sweep contributes nothing when this is composited back with "lighter"), and
// the neon lines keep only the part of themselves that colour admits.
function tintedCopy(source, color, W, H) {
  const g = ghostCanvas(W, H);
  ghostCtx.globalCompositeOperation = "source-over";
  ghostCtx.clearRect(0, 0, W, H);
  ghostCtx.drawImage(source, 0, 0);
  ghostCtx.globalCompositeOperation = "multiply";
  ghostCtx.fillStyle = color;
  ghostCtx.fillRect(0, 0, W, H);
  ghostCtx.globalCompositeOperation = "source-over";
  return g;
}

export class JackIn {
  constructor() {
    this.active = false;
    this.elapsed = 0;
    this.x = 0;
    this.y = 0;
    this.w = 34;
    this.h = 60;
    this.seed = 1;
    this.beat = 0; // index of the next BEATS entry still to be pushed
  }

  // `x, y, w, h` are the player's fields at the moment START GAME (or RESTART)
  // was confirmed — copied, not held by reference, the same way
  // disconnect.js's trigger() takes a freeze-frame: main.js doesn't run
  // player.update() while this is playing, so they wouldn't move anyway, but
  // nothing here depends on that.
  trigger(x, y, w, h) {
    this.active = true;
    this.elapsed = 0;
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.seed = (Math.random() * 0x7fffffff) | 0;
    this.beat = 0;
  }

  // Between games, so a restart never inherits a finished sequence's `active`
  // flag or a half-consumed beat cursor. Same role as disconnect.js's reset(),
  // called from the same place (main.js's newGame()).
  reset() {
    this.active = false;
    this.elapsed = 0;
    this.beat = 0;
  }

  // Advances the clock and pushes any boot line whose beat has arrived. The
  // cursor only ever moves forward, so a frame long enough to cross two beats
  // pushes both (in order) rather than dropping one.
  update(dt) {
    if (!this.active) return;
    this.elapsed += dt;
    const t = this.progress;
    while (this.beat < BEATS.length && t >= BEATS[this.beat][0]) {
      gameConsole.push(BEATS[this.beat][1], HINT);
      this.beat++;
    }
  }

  get progress() {
    return Math.min(1, this.elapsed / CONNECT_DURATION);
  }

  get done() {
    return this.progress >= 1;
  }

  // Has the car finished assembling? Once true, main.js draws the REAL car
  // (player.render) instead of asking for renderCar() below — so the handover
  // into gameplay is a car that was already solid a beat before the world
  // started moving, not a wireframe that pops.
  get carSolid() {
    return this.progress >= CAR_END;
  }

  // The car assembling, drawn INSTEAD of player.render() while
  // `carSolid` is false — inside the same block the frozen world draws in, so
  // it lands in the space it is about to start driving in. The exact inverse
  // of disconnect.js's LOCAL breakup: three copies of the same silhouette,
  // offset along their own radius and jittered, easing back together. The
  // CENTRE copy is the player's own cyan (not white, as it is on the way out)
  // so the moment it hands over to the real car there is no colour pop; the
  // two side copies fade out as they arrive, leaving exactly the one outline
  // player.render is about to take over drawing.
  renderCar(ctx) {
    if (!this.active) return;
    const t = this.progress;
    if (t < CAR_START || t >= CAR_END) return;

    const p = (t - CAR_START) / (CAR_END - CAR_START); // 0 scattered -> 1 assembled
    const k = 1 - p;                                    // breakup strength
    const { x: cx, y: cy, w, h, seed } = this;
    // Reseeded per frame off elapsed, like disconnect.js's own, so the jitter
    // animates rather than freezing into one fixed distortion.
    const rand = rng((seed + Math.floor(this.elapsed * 60)) >>> 0);
    const jitter = 7 * k;
    const drift = 14 * k;

    // Assembling IN, so this is disconnect.js's split run backwards: the centre
    // copy (the player's own cyan, not white — see the header) rises 0.35 -> 1
    // as the car arrives while the side copies fade to nothing, and the offset
    // itself closes with k so the three converge rather than merely dimming.
    ctx.save();
    drawChromaticSplit(ctx, cx, cy, w, h, {
      drift,
      jitter,
      spreadPx: 3 * k,
      rand,
      layers: [
        ["#ffffff", -1, 0.75 * k],
        [PLAYER, 0, 0.35 + 0.65 * p],
        [PLAYER_THRUST, 1, 0.75 * k],
      ],
    });
    ctx.restore();
  }

  // The raster boot, drawn OVER the composited world (and over the assembling
  // car) but UNDER the HUD — the same split disconnect.js and sectors.js's
  // rescan glitch already draw on: the deck's video feed is what's booting,
  // its chrome is not.
  //
  // `canvasEl` is the game canvas itself: the band tears and the chromatic
  // ghosts are drawImage()s of the frame so far back onto itself, exactly the
  // technique sectors.js's renderGlitch uses, which is why this has to run
  // after every world layer and needs the element rather than just the context.
  render(ctx, canvasEl, W, H) {
    if (!this.active) return;
    const t = this.progress;
    const rand = rng((this.seed + Math.floor(this.elapsed * 60)) >>> 0);

    ctx.save();

    // 1. THE UNRESOLVED REGION. Everything below the sweep line is simply not
    // there yet. Opaque, not translucent — a frame buffer that hasn't been
    // written to is black, it isn't dim.
    if (t < SWEEP_END) {
      const line = (t / SWEEP_END) * H;
      ctx.fillStyle = VOID;
      ctx.fillRect(0, line, W, H - line);
      // The scan edge itself: a hot line with a brighter core, plus a short
      // gradientless "wake" of two dimmer lines just above it, so the sweep
      // reads as something travelling rather than a rectangle shrinking.
      glowLine(ctx, 0, line, W, line, "#ffffff", 2, 14);
      glowLine(ctx, 0, line - 4, W, line - 4, GREEN_BRIGHT, 1, 8);
      glowLine(ctx, 0, line - 9, W, line - 9, PLAYER, 1, 6);
    }

    // 2. THE RESOLVED REGION IS STILL TEARING. Horizontal band shifts, biggest
    // right behind the scan edge and settling as it moves on — the picture is
    // there, it just hasn't stopped moving around yet. Bands are clipped to
    // the resolved region (above the line) so nothing tears out of the void
    // below it.
    if (t < TEAR_END) {
      const k = 1 - t / TEAR_END;
      const line = t < SWEEP_END ? (t / SWEEP_END) * H : H;
      for (let i = 0; i < TEAR_BANDS; i++) {
        const y = rand() * line;
        const bandH = Math.min(3 + rand() * 22, line - y);
        if (bandH <= 0) continue;
        const dx = Math.round((rand() - 0.5) * 2 * TEAR_MAX * k);
        if (dx === 0) continue;
        ctx.drawImage(canvasEl, 0, y, W, bandH, dx, y, W, bandH);
      }
      // Scanline wash over the resolved region: alternating dark rows, fading
      // out with the tearing. Cheap, and it's what stops a torn-but-otherwise-
      // clean picture from reading as a rendering bug.
      ctx.save();
      ctx.globalAlpha = 0.22 * k;
      ctx.fillStyle = "#000000";
      for (let y = 0; y < line; y += 4) ctx.fillRect(0, y, W, 2);
      ctx.restore();
    }

    // 3. THE SCENE STOPS DISAGREEING WITH ITSELF. Cyan and magenta copies of
    // the whole composited frame, offset in opposite directions and converging
    // to zero — the same chromatic split disconnect.js pulls the car apart
    // with, here applied to everything and run backwards. Composited with
    // "lighter" because these are additive ghosts of a neon picture: where
    // they land on top of the real frame they brighten it, and where the frame
    // is black (the void below the sweep) they contribute nothing at all.
    if (t > SPLIT_START && t < SPLIT_END) {
      const k = 1 - (t - SPLIT_START) / (SPLIT_END - SPLIT_START);
      const dx = SPLIT_MAX * k;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.55 * k;
      ctx.drawImage(tintedCopy(canvasEl, PLAYER, W, H), -dx, 0);
      ctx.drawImage(tintedCopy(canvasEl, PLAYER_THRUST, W, H), dx, 0);
      ctx.restore();
    }

    // 4. THE HAND-OVER FLASH. disconnect.js opens with a white core on the
    // killing hit; this closes with one on the moment the feed goes live, so
    // the two ceremonies bracket a run with the same punctuation mark.
    if (t > FLASH_START) {
      const k = 1 - (t - FLASH_START) / (1 - FLASH_START);
      ctx.save();
      ctx.globalAlpha = 0.30 * k;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    ctx.restore();
  }

  // The centred readout, in the exact screen position (and at the exact type
  // sizes) disconnect.js's CONNECTION LOST uses — the two are the same voice
  // reporting opposite events, so they should occupy the same spot. Call this
  // OUTSIDE render()'s own work, above the HUD: it is the one thing on screen
  // that is NOT part of the booting feed and so never tears, ghosts or dims
  // with it.
  renderOverlay(ctx, W, H) {
    if (!this.active) return;
    const t = this.progress;
    if (t >= 1) return;
    ctx.save();
    // A short fade in rather than appearing on frame one, so the readout
    // arrives with the sweep instead of ahead of it.
    ctx.globalAlpha = Math.min(1, t / 0.08);
    if (t < TEXT_LOCK) {
      const pct = Math.min(100, Math.floor((t / TEXT_LOCK) * 100));
      glowText(ctx, `${pct}%`, W / 2, H * 0.42, GREEN_BRIGHT, 26, "center", 14);
      glowText(ctx, "NEURAL UPLINK", W / 2, H * 0.42 + 34, GREEN_PALE, 13, "center", 8);
    } else {
      glowText(ctx, "LINK ESTABLISHED", W / 2, H * 0.42, "#ffffff", 26, "center", 14);
      glowText(ctx, "DRIVE", W / 2, H * 0.42 + 34, GREEN_PALE, 13, "center", 8);
    }
    ctx.restore();
  }
}
