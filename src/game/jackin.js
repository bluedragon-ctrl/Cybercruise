// START GAME — "JACK IN". The deliberate mirror image of game/disconnect.js:
// the same fiction (the car is a signal the player is jacked into, not a
// physical object), the same machinery (one instance main.js owns, staged
// fractions of a duration constant, a frozen-but-still-drawn world), run
// BACKWARDS. Death is a feed collapsing; this is a feed resolving.
//
// SINCE PHASE 15E-I THIS MODULE DRAWS ALMOST NOTHING. The boot's picture is a
// fragment shader now — engine/gl/shaders.js's GLITCH_FS, run by
// engine/present.js over the finished frame — and what is left here is the
// TIMELINE that drives it plus the two things the pass cannot do. Read
// GLITCH_FS's header for what the effect IS; read this one for when.
//
// TWO THINGS HAPPEN AT ONCE:
//
//   1. THE FEED RESOLVES. feed() below describes it to the renderer, beat by
//      beat: blocks arriving on a top-to-bottom wavefront, the arrived region
//      still reordering and refining behind it, the colour channels stopping
//      disagreeing, and a white hand-over flash at the end.
//   2. THE DECK REPORTS ON ITSELF. Boot lines into the SYS LOG (this module
//      pushes them itself, the way links.js and sectors.js push theirs — see
//      BEATS below), plus a centred percentage readout sitting in the exact
//      spot disconnect.js's CONNECTION LOST occupies.
//
// THE READOUT IS ON THE HUD CANVAS AND THAT IS THE WHOLE POINT OF IT. `hudCtx`
// is a separate DOM layer that is never uploaded to the GPU (Phase 15c), so the
// pass CANNOT REACH IT — physically, not by draw order. The world tears, drops
// blocks and flattens to three colours while the percentage stays pin-sharp on
// top of it. That is the right fiction and it costs nothing: the instruments
// work, the feed does not. disconnect.js's readout gets the same for free.
//
// THE CAR HAS NO SEQUENCE OF ITS OWN ANY MORE. It used to assemble out of three
// offset wireframe copies of its own silhouette (effects.js's
// drawChromaticSplit, run backwards) across a CAR_START..CAR_END window, with
// main.js swapping to the real car at the end of it. 15e-i deleted all of that,
// on the project owner's call, because it does not read under the pass: a
// wireframe easing together inside a block-corrupted feed is mush. The car is
// now simply drawn, from frame one, and RESOLVES WITH THE REST OF THE FRAME —
// which is the more honest version of the fiction anyway, since the car was
// never meant to be a special object. CAR_START, CAR_END and `carSolid` went
// with it; FLASH_START used to be pinned to CAR_END to hide the draw-ownership
// swap, and there is no swap left to hide, so it keeps only its other reason
// (below).
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
// ~68% of this — while the feed is still resolving rather than at the cut to
// gameplay. That is deliberate: the beat arriving while the picture is still
// coming together is what makes the world feel like it comes up UNDERNEATH the
// music, and it buys the SYS LOG boot log (BEATS below) enough room to step a
// line at a time instead of dumping a block. The two numbers are independent on
// purpose — neither ceremony is trying to end on the other.
//
// A PURE FUNCTION OF PROGRESS, same discipline as disconnect.js and
// effects.js: feed() recomputes every field from `elapsed` and the seed
// captured at trigger(), and writes them into a block the renderer owns, so
// nothing here allocates per frame. Through 15d this module ALSO owned the
// codebase's only device-sized scratch canvas (the chromatic split's tinted
// copies needed one); the pass needs no scratch surface at all, and it is gone.

import { glowText } from "../engine/neon.js";
import { GREEN_PALE, GREEN_BRIGHT } from "../engine/palette.js";
import * as gameConsole from "../engine/console.js";
import { HINT } from "../engine/console.js";

// Seconds from START GAME (or RESTART) to the first gameplay tick — see the
// header on why this is 2.2s and not the audio riser's 1.5s.
export const CONNECT_DURATION = 2.2;

// Fractions of CONNECT_DURATION (not seconds), kept as fractions so retuning
// the total reshapes every beat with it — exactly how disconnect.js's own
// timeline is written. Read top to bottom, this IS the sequence:
//   blocks sweep in -> the arrived picture settles and refines -> the colour
//   channels stop disagreeing -> flash -> live.
const SWEEP_END = 0.40;    // the arrival wavefront reaches the bottom of the
                           // screen; every block has been received
const TEAR_END = 0.72;     // block reordering, line dropout and the bit-depth
                           // refinement all run out together — one beat,
                           // because "the picture stops being wrong" is one
                           // idea however many terms express it
const SPLIT_START = 0.45;  // per-block-row channel desync, at its widest...
const SPLIT_END = 0.93;    // ...collapsed onto the picture it came from
const FLASH_START = 0.90;  // white hand-over flash (disconnect.js opens with
                           // one; this one closes, so the two ceremonies
                           // bracket a run with the same punctuation mark)
const TEXT_LOCK = 0.90;    // the percentage hits 100 and the readout swaps

// Peak alpha of the hand-over flash. Carried over unchanged from the 2D
// fillRect this replaced; it is an add in the pass now (GLITCH_FS's uFlash)
// rather than a rect over the frame, so it whitens the corruption too.
const FLASH_MAX = 0.30;

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
//
// VEHICLE UPLOAD // 01 SURVIVED 15E-I'S DELETION OF THE CAR SEQUENCE, on
// purpose: the deck reporting that it has loaded the vehicle is true whether or
// not the player watches it assemble, and these lines were never captions on
// what is happening on screen — HULL // NOMINAL and WEAPONS // ARMED never had
// a visual either.
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

export class JackIn {
  constructor() {
    this.active = false;
    this.elapsed = 0;
    this.seed = 1;
    this.beat = 0; // index of the next BEATS entry still to be pushed
  }

  // NO LONGER TAKES THE PLAYER'S FREEZE-FRAME. Through 15d this copied
  // `x, y, w, h` so renderCar() could draw the assembling wireframe where the
  // car was about to be; with that sequence gone the car is drawn by
  // player.render() like any other frame and nothing here needs its position.
  trigger() {
    this.active = true;
    this.elapsed = 0;
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

  // THE SEQUENCE ITSELF, as numbers rather than as pixels. `out` is the block
  // engine/present.js owns and main.js hands over each frame; this writes every
  // field it cares about and reads nothing back. See present.js's `feed` for
  // the rule that replaced "no module under src/game/ knows the GPU path
  // exists", and why this module still imports nothing from the engine's GL
  // side.
  //
  // Returns whether the pass has anything to do, which is what main.js turns
  // into `level` — a jack-in is never at rest while it is active, so this is
  // simply `active`, but disconnect.js's answer is not (its held beat is
  // genuinely idle) and the two are written to the same shape.
  feed(out) {
    if (!this.active) return false;
    const t = this.progress;

    out.time = this.elapsed;
    // Reduced to a fraction: the shader adds this to block indices in a
    // 32-bit float, where a raw seed of this size would swallow them whole.
    // See present.js's `feed`.
    out.seed = (this.seed & 0x3ff) / 1024;
    // A WAVEFRONT, not scattered: the boot's oldest and most load-bearing
    // visual idea is a raster resolving top to bottom, and `order` 0 is what
    // keeps it. disconnect.js uses the other end of the same field.
    out.order = 0;

    // THE UNRESOLVED REGION. Below the wavefront nothing has been received, so
    // there is nothing to draw — the pass leaves those blocks black, which is
    // what a frame buffer that has not been written to looks like. Through 15d
    // this was an opaque VOID-coloured rect under a drawn scan line; the
    // frontier is the shape of the arrival now, and its own leading blocks run
    // hot, which is what the three glowLine calls used to fake.
    out.resolve = Math.min(1, t / SWEEP_END);

    // THE RESOLVED REGION IS STILL SETTLING. Block rows arrive out of order and
    // some are missing outright, and the picture arrives coarse and refines —
    // both decaying together to TEAR_END. `corrupt` was the band-tear loop and
    // the scanline wash; `quant` is new and has no 2D ancestor.
    const k = t < TEAR_END ? 1 - t / TEAR_END : 0;
    out.corrupt = k;
    out.quant = k;

    // THE PICTURE STOPS DISAGREEING WITH ITSELF. Per-block-row channel desync
    // closing to zero — the beat that used to be two tinted full-frame copies
    // at one global offset.
    out.split = t > SPLIT_START && t < SPLIT_END
      ? 1 - (t - SPLIT_START) / (SPLIT_END - SPLIT_START)
      : 0;

    out.flash = t > FLASH_START
      ? FLASH_MAX * (1 - (t - FLASH_START) / (1 - FLASH_START))
      : 0;

    // Not this sequence's: a boot never dims or shakes.
    out.fade = 0;
    out.shakeX = 0;
    out.shakeY = 0;
    return true;
  }

  // The centred readout, in the exact screen position (and at the exact type
  // sizes) disconnect.js's CONNECTION LOST uses — the two are the same voice
  // reporting opposite events, so they should occupy the same spot. Drawn on
  // `hudCtx`, which is the layer the pass cannot reach; see the header.
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
