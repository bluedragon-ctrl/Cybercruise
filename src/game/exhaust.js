// The player car's exhaust plume: two magenta flames trailing the tail pipes,
// growing with speed so the player can read how fast they are going without
// looking at the HUD.
//
// WHY THIS IS NOT IN THE SHAPE CATALOGUE. game/carshapes.js already draws a
// static twin exhaust stub (its `exhaust` field, step 8 of drawCarShape), and
// growing THAT with speed would be the obvious place to put this. It is the
// wrong place: the car body is blitted from a sprite cache keyed
// `car|shape|color|thrust|accent|w|h|frame` (game/sprites.js's drawCarCached),
// so anything that varies continuously with speed becomes a new cache
// dimension — a fresh sprite per speed bucket, rebuilt constantly. The stubs
// stay as the NOZZLES, baked into the sprite; the plume is drawn live on top
// of the blit, which is the only layer that may vary per frame for free.
//
// Cost: three batched neonStroke calls per frame, both flames in each path.
// Per engine/neon.js's own note, `build` may batch disjoint segments into one
// path, so the three overdraw passes are paid once, not once per flame. Big
// linear glow uses overdraw and never ctx.shadowBlur (see the render-profile
// notes in the README).

import { neonStroke } from "../engine/neon.js";
import { PLAYER, PLAYER_THRUST } from "../engine/palette.js";
import { CAR_SHAPES } from "./carshapes.js";

// Plume length in px, at zero intensity and at full. The floor is deliberately
// non-zero: a car crawling at MIN_SPEED should look idling, not dead. The
// ceiling stays under half a car length (h = 60) so that at redline the plume
// still reads as part of the car rather than as the loudest object on screen.
const LEN_MIN = 4;
const LEN_MAX = 26;

// Stroke widths for the two body layers. The plume is drawn as a short wide
// ROOT overlapping a long thin TIP, which is what gives it a taper — a single
// constant-width stroke reads as a rod, and neonStroke has no width ramp.
// Deliberately wide and soft rather than sharp: a thin bright line reads as a
// rod or a leg poking out of the tail, not as burning gas. The `spread` and
// `halo` arguments in render() are pushed up to match, so most of what the eye
// sees is the outer overdraw pass, not the core.
const ROOT_WIDTH = 5.2;
const TIP_WIDTH = 2.6;
const ROOT_FRAC = 0.42; // how much of the plume's length the root covers

// A faint wisp reaching past the tip. Without it the plume ends where the tip
// layer's round cap ends, and since the halo is wide enough to bridge the two
// ports the whole thing reads as a magenta slab with a chopped-off bottom
// edge. The wisp has no core of its own to speak of (WISP_ALPHA is low), so
// what it contributes is a gradient out to nothing.
const WISP_FRAC = 1.35;  // length as a multiple of the plume's own
const WISP_WIDTH = 1.8;
const WISP_ALPHA = 0.35;

// The white-hot core: a stub of PLAYER cyan laid over the magenta root once the
// car is genuinely fast, so the flame changes COLOUR near the top of the band
// and not just size. Below the threshold it is not drawn at all.
const CORE_SPEED = 0.55; // intensity at which the core starts to show
const CORE_FRAC = 0.3;   // fraction of the plume length it covers
const CORE_WIDTH = 2.2;

// Flicker. Two sines at incommensurate frequencies, so the plume never repeats
// a visible cycle, and the FREQUENCIES themselves scale with intensity: a lazy
// pulse at cruise, a fast crackle at redline. Speed then reads from the motion
// as well as from the size, which survives the player not consciously
// comparing plume lengths frame to frame.
//
// It modulates BRIGHTNESS, not length, and both flames share one phase. Two
// earlier choices were wrong together: flickering the length made each flame
// extend and retract, and offsetting the sides' phases meant they did it
// alternately — which the eye reads as a pair of little legs walking along
// behind the car. Length is now a pure function of speed (so the size cue
// stays perfectly steady and readable), and the flicker lives entirely in
// alpha, where a pulse looks like combustion instead of movement.
const FLICKER_BASE = 7;   // rad/sec at zero intensity
const FLICKER_GAIN = 22;  // extra rad/sec at full intensity
const FLICKER_A = 0.18;   // depth of the first sine, as a fraction of alpha
const FLICKER_B = 0.10;   // depth of the second
const FLICKER_RATIO = 2.7; // second sine's frequency multiple (irrational-ish)

// Throttle flare. Speed itself takes ~1.3s to cross the band (ACCEL is 380 and
// the band is 500 wide), so a plume driven by speed ALONE lags the player's
// input by most of a second and stops feeling like feedback. Adding the
// throttle axis makes stamping the accelerator flare the plume immediately,
// before the car has actually gained the speed. Asymmetric on purpose: lifting
// off collapses the flame much harder than flooring it grows it, because a
// dying flame is the more useful signal ("you ARE slowing down now") and it
// matches how the car's own momentum feels.
const FLARE_UP = 0.12;
const FLARE_DOWN = 0.35;

// How fast the drawn intensity chases its target, per second. Fast enough that
// the flare above still registers as instant, slow enough that a tapped key
// does not make the plume snap.
const INTENSITY_CHASE = 9;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Exhaust {
  // `shape` indexes CAR_SHAPES; the nozzle positions come from that shape's own
  // `exhaust` field, so the plume stays glued to the pipes if the silhouette is
  // ever retuned. Defaults to 0 (the supercar the player drives).
  constructor(shape = 0) {
    this.shape = shape;
    this.intensity = 0; // 0..1, smoothed — what the render actually uses
    this.phase = 0;     // accumulated flicker angle
  }

  // `band` is the player's speed as a 0..1 fraction of its own MIN_SPEED..
  // MAX_SPEED range, and `throttle` the raw axis (-1..1). The caller
  // normalises rather than handing over a raw speed: player.js owns those two
  // limits, and importing them back out of it would make the two modules
  // mutually dependent for the sake of one division.
  update(dt, band, throttle) {
    const flare = throttle * (throttle > 0 ? FLARE_UP : FLARE_DOWN);
    const target = clamp01(band + flare);

    this.intensity += (target - this.intensity) * Math.min(1, INTENSITY_CHASE * dt);
    this.phase += dt * (FLICKER_BASE + FLICKER_GAIN * this.intensity);
  }

  // (cx, cy) is the car's centre and `angle` the road heading it is drawn at —
  // the same pair game/sprites.js's blitSpriteRotated uses, so the plume turns
  // with the body instead of sliding off it in a bend.
  //
  // Draw this BEFORE the car blit: the chassis is filled opaque (CAR_FILL), so
  // painting the car over the plume is what hides its root inside the tail and
  // leaves only the part that escapes the pipes.
  render(ctx, cx, cy, angle = 0) {
    const shape = CAR_SHAPES[this.shape] ?? CAR_SHAPES[0];
    if (!shape.exhaust) return;

    const [ex, , y2] = shape.exhaust;
    const [w, h] = shape.size;
    const px = ex * (w / 2);   // nozzle x, mirrored for the other side
    const py = y2 * (h / 2);   // nozzle mouth: where the stub ends and we start

    // One length for both flames, straight off the speed — see the flicker
    // note above for why nothing wobbles it.
    const len = LEN_MIN + (LEN_MAX - LEN_MIN) * this.intensity;

    // The flicker, as a brightness multiplier around 1. Clamped at the top so
    // a peak of both sines cannot push a layer past full opacity, which would
    // clip the pulse flat instead of rounding it.
    const flicker = Math.min(
      1,
      1 - (FLICKER_A + FLICKER_B) * 0.5
        + FLICKER_A * Math.sin(this.phase)
        + FLICKER_B * Math.sin(this.phase * FLICKER_RATIO),
    );

    // Both flames in ONE path per layer — see the batching note at the top.
    const layer = (frac) => (c) => {
      c.moveTo(-px, py);
      c.lineTo(-px, py + len * frac);
      c.moveTo(px, py);
      c.lineTo(px, py + len * frac);
    };

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // Outermost first, brightest last: wisp, then tip, then root. Each layer is
    // shorter and wider than the one under it, and the overlap near the pipes
    // is what makes the flame read as tapering — neonStroke has no width ramp,
    // so a taper has to be built out of stacked constant-width passes.
    neonStroke(ctx, layer(WISP_FRAC), PLAYER_THRUST, WISP_WIDTH, 8, 0.18, flicker * WISP_ALPHA);
    neonStroke(ctx, layer(1), PLAYER_THRUST, TIP_WIDTH, 7, 0.17, flicker);
    neonStroke(ctx, layer(ROOT_FRAC), PLAYER_THRUST, ROOT_WIDTH, 5, 0.19, flicker);

    // The hot core, only near the top of the speed band. Its alpha ramps from
    // 0 at the threshold to 1 at redline, so it arrives as a colour shift
    // rather than as a layer switching on.
    if (this.intensity > CORE_SPEED) {
      const heat = (this.intensity - CORE_SPEED) / (1 - CORE_SPEED);
      neonStroke(ctx, layer(CORE_FRAC), PLAYER, CORE_WIDTH, 5, 0.18, heat * flicker);
    }

    ctx.restore();
  }
}
