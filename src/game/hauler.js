// THE CARGO DRONE — the shopping interlude's pickup and return.
//
// Every SHOP_INTERVAL player-units (the DIST readout's own scale, not raw world
// units — see road.js's DIST_UNITS) a heavy cargo drone comes down out of the
// sky band, closes its jaws on the player's car and carries it off to the shop.
// When the player undocks it flies the car back and sets it down on an empty
// stretch of road.
//
// THIS FILE IS THE TRANSITION, NOT THE SHOP. What the player does while they
// are up there belongs to the shop screen (Phase 11); this module's entire job
// is to make the car leaving the road and coming back to it feel like something
// that happened rather than a cut. main.js owns the state machine that hangs
// off it — see the "lifting"/"shopping"/"lowering" states there.
//
// THE HULL IS ALREADY DRAWN. bossshapes.js's CLAW LIFTER was designed for
// exactly this job and says so in its own header: two end beams instead of a
// fuselage so the car stays visible between them, a C-clamp jaw per flank
// sitting where the car's door would be, and `hover: { blot: false }` because
// the ground blot is opaque and would be painted straight over the very car the
// vehicle exists to carry. Nothing here draws a new silhouette; it drives that
// one.
//
// THREE PHASES, AND ONLY THE FIRST IS PLAYABLE:
//
//   1. APPROACH  The world is LIVE. main.js stays in "playing" — the player
//      keeps driving, steering and shooting — while the drone descends and
//      homes on the car. This is the warning, and it is a warning the player
//      can act on (finish a kill, grab a crate) rather than a cut-scene that
//      starts without asking. It ends when the jaws are in position.
//   2. LIFT      The world is FROZEN, exactly the way it is during
//      game/jackin.js's boot and game/disconnect.js's death: every layer is
//      still built and still drawn, but nothing under "playing" advances it.
//      The jaws close, then the drone and the car rise off the top of the frame
//      together, and a flash covers the cut to the shop.
//   3. LOWER     The same again, backwards, onto a road main.js has just
//      rebuilt (see respawnWorld() there) — so the car is set down on clear
//      tarmac instead of on top of whatever it was about to hit two seconds
//      before it was picked up.
//
// A PURE FUNCTION OF PROGRESS, the same discipline jackin.js, disconnect.js and
// effects.js hold to: every frame recomputes its geometry from `elapsed`, and
// nothing here allocates per frame beyond the one small frame() record.
//
// THE CAR IS NOT DRAWN HERE. During the lift and the lower it has to move with
// the drone, but it is still the PLAYER'S car — player.render() draws it, with
// its own thruster, damage flash and shield, all of which this module has no
// business reimplementing. So this exposes carOffsetY() instead: a screen-space
// y offset main.js applies around its existing player.render() call. One number
// crossing the boundary, and the car keeps every visual it has on the road.

import { glowText } from "../engine/neon.js";
import { drawShapeObject } from "./carshapes.js";
import { BOSS_SHAPES } from "./bossshapes.js";
import { ENEMY, ENEMY_THRUST, GREEN_PALE } from "../engine/palette.js";
import { HINT } from "../engine/console.js";
import * as gameConsole from "../engine/console.js";

// How far the player drives between shop visits, in DIST_UNITS — i.e. in the
// same units the HUD's DIST readout and every catalogue's `minDistance` gate
// are written in (road.js). A FEEL dial: it decides how often the run is
// interrupted, which is the whole rhythm of the shopping loop.
export const SHOP_INTERVAL = 400;

// Seconds of LIVE gameplay between the drone appearing and the jaws closing.
// This is the only part of the sequence the player can still play through, so
// it is the part that decides whether the pickup feels announced or feels like
// being grabbed — long enough to look up, notice it and finish what you were
// doing, short enough that it isn't a lull.
export const APPROACH_DURATION = 2.0;

// Seconds for each frozen half. Deliberately shorter than jackin.js's 2.2s
// CONNECT_DURATION: that ceremony runs once per run and can afford to be an
// event, this one runs every SHOP_INTERVAL and has to stay punctuation. The two
// halves are the same length so the return reads as the pickup rewound.
export const LIFT_DURATION = 1.4;

// Fractions of LIFT_DURATION (not seconds), kept as fractions so retuning the
// total reshapes every beat with it — jackin.js's timeline is written the same
// way. Read top to bottom, this IS the lift: jaws bite, car goes up, flash.
const JAW_CLOSE_END = 0.35; // the claws have clamped onto the car's flanks
const RISE_START = 0.30;    // ...and it starts to leave the road just before
                            // they finish, so the two beats overlap rather than
                            // the car sitting still for a moment between them
const FLASH_START = 0.86;   // white hand-over flash into the shop screen

// The LOWER half is not a mirrored playback of the numbers above — a descent
// wants a different shape from a lift. Coming down, the car is placed first and
// the drone leaves afterwards, so the beats are: fall, set down, jaws open,
// drone climbs away.
const FALL_END = 0.55;      // the car is back on the tarmac
const JAW_OPEN_END = 0.78;  // the claws have released it
const DEPART_END = 1.0;     // the drone has climbed back out of frame

// How wide the jaws stand while open, as a multiplier on the hull's own width.
// The claws sit at 0.90 of half-width on the CLAW LIFTER and `overhang.x` runs
// to 1.04, so scaling the whole hull horizontally scales the gap between them
// with it — the cheap way to animate the grab without threading a new parameter
// through carshapes.js's drawShapeObject and every shape callback in it. It
// reads as the jaws opening because the jaws are the widest thing on the hull;
// a later pass that wants the claws to pivot on their hinge shoulders can do it
// properly in the shape, and nothing here will need to change but this line.
const JAW_OPEN_SCALE = 1.3;

// How much bigger the drone draws once it is right down on the car than when it
// first appears. Altitude, sold as scale: this is a top-down game, so a drone
// descending cannot move DOWN the screen to show it — the only cue available is
// that it gets closer to the camera. Small on purpose; a big swing reads as the
// drone growing rather than dropping.
//
// THE APPROACH MUST END EXACTLY ON SCALE_HIGH, because the lift BEGINS there —
// the two phases are consecutive frames of one continuous shot, and any gap
// between the scale one ends at and the scale the next starts from is a visible
// pop on the very frame the jaws start closing. Measured at 600x800: an
// approach that ramped only part of the way here left the hull jumping 14px
// wider on that frame. So the ramp below runs the whole interval, and these two
// numbers are the only place the size of it is set.
const SCALE_LOW = 1.0;
const SCALE_HIGH = 1.22; // ...and it keeps climbing past this as it carries the
                         // car up toward the camera and out of frame

// How far off the top of the frame the drone starts and finishes, in px beyond
// its own half-height — so it is genuinely gone, not clipped at y=0.
const OFFSCREEN_MARGIN = 40;

// How fast the drone's x converges on the car's, per second, as a fraction of
// the gap closed. Exponential smoothing rather than a hard follow: the drone is
// a heavy thing matching a moving car's lane, and a lag the player can SEE is
// what makes it read as matching rather than as being glued on. High enough
// that it is always in position by the time the jaws close, even if the player
// swerves for the whole approach.
const TRACK_RATE = 4.5;

// Rotor speed, in carshapes.js's own `wheelPhase` units per second — see
// render() below for why this module supplies its own instead of taking the
// caller's. drawRotor turns the value into an angle at `phase * 0.05` rad, so
// this is ~11 rad/s: fast enough that four rotors read as spinning without
// strobing backwards at 60fps.
const ROTOR_RATE = 220;

// SYS LOG beats during the approach, as [fraction of APPROACH_DURATION, text] —
// pushed by this module itself, the way jackin.js, links.js and sectors.js all
// push their own lines rather than having main.js narrate for them.
const APPROACH_BEATS = [
  [0.00, "CARGO DRONE INBOUND"],
  [0.40, "MATCHING VECTOR - HOLD YOUR LANE"],
  [0.78, "GRAPPLE ARMED"],
];

// ...and on the way back down, onto the road main.js has just cleared.
const RETURN_BEATS = [
  [0.00, "RELEASING TO ROAD"],
  [0.80, "GRAPPLE CLEAR - YOU HAVE THE CAR"],
];

// The CLAW LIFTER, looked up once at module load rather than per frame. Found
// by NAME so a reorder of BOSS_SHAPES can't silently swap the hull out for the
// gun ring; if it is ever renamed this throws at load, which is the loud
// failure a silently-wrong drone is not.
const LIFTER = BOSS_SHAPES.find((s) => s.name === "CLAW LIFTER");
if (!LIFTER) throw new Error("hauler: CLAW LIFTER hull missing from BOSS_SHAPES");

// Smoothstep, for beats that should ease in AND out (the drone settling onto
// the car). Plain linear reads mechanical on something this size.
const smooth = (t) => t * t * (3 - 2 * t);

// Clamp a raw progress value into [0,1] over an arbitrary sub-range of the
// sequence — the "which fraction of THIS beat are we in" question every staged
// timeline above asks, written once.
function span(t, from, to) {
  return Math.max(0, Math.min(1, (t - from) / (to - from)));
}

export class Hauler {
  constructor(H) {
    // Canvas height, kept so the off-screen start/end positions can be derived
    // without threading H through every call. Only ever read.
    this.H = H;
    this.phase = "idle"; // "idle" | "approach" | "lift" | "lower"
    this.elapsed = 0;
    this.x = 0;          // the drone's own screen x, smoothed toward the car's
    this.y = 0;          // the car's screen row — where the drone comes to rest
    this.beat = 0;       // index of the next log line still to be pushed
    // Which shop visit is next, as a count of SHOP_INTERVAL milestones already
    // consumed. THIS is the edge detector's memory (see main.js's own
    // wasSectorGlitching and sectors.js's "an edge needs memory") — a shop
    // visit fires on the tick this number would change, not on a distance
    // comparison that would re-fire on every frame afterwards.
    this.milestone = 0;
  }

  // Between games. Same role as jackin.js's and disconnect.js's reset(), called
  // from the same place (main.js's newGame()) — so a fresh run neither inherits
  // a half-played sequence nor thinks it has already shopped.
  reset() {
    this.phase = "idle";
    this.elapsed = 0;
    this.beat = 0;
    this.milestone = 0;
  }

  // Has the player just driven past the next shop milestone? A pure edge: it
  // answers true on exactly one tick per interval and books the milestone as it
  // does, so the caller cannot double-fire it. `distance` is raw world units;
  // the interval is in DIST_UNITS, which is what `distUnits` converts.
  //
  // Never fires while a sequence is already running — a player who somehow
  // covered a whole interval mid-approach would otherwise restart it.
  crossedMilestone(distance, distUnits) {
    if (this.phase !== "idle") return false;
    const reached = Math.floor(distance / (SHOP_INTERVAL * distUnits));
    if (reached <= this.milestone) return false;
    this.milestone = reached;
    return true;
  }

  // THE DRONE APPEARS, with the world still running. `carX`/`carY` are the
  // player's current screen position: the drone enters directly above the lane
  // the car is in right now and then tracks it from there.
  approach(carX, carY) {
    this.phase = "approach";
    this.elapsed = 0;
    this.beat = 0;
    this.x = carX;
    this.y = carY;
  }

  // THE JAWS CLOSE and the world freezes. Called by main.js on the tick
  // `grabbed` goes true, as it flips into its own "lifting" state.
  lift() {
    this.phase = "lift";
    this.elapsed = 0;
    this.beat = 0;
  }

  // ...and the return trip, out of the shop screen. By the time this is called
  // main.js has already rebuilt the road below (respawnWorld()), so the car is
  // being set down on clear tarmac.
  lower(carX, carY) {
    this.phase = "lower";
    this.elapsed = 0;
    this.beat = 0;
    this.x = carX;
    this.y = carY;
  }

  // Advances whichever phase is live, and pushes any log line whose beat has
  // arrived. The cursor only moves forward, so a frame long enough to cross two
  // beats pushes both in order rather than dropping one — jackin.js's update()
  // makes the same guarantee for the same reason.
  //
  // `carX` only actually moves during the approach, when the player is still
  // steering; the frozen phases pass the car's last x and the smoothing below
  // simply converges on a value that has stopped changing.
  update(dt, carX) {
    if (this.phase === "idle") return;
    this.elapsed += dt;

    // Exponential smoothing, framerate-independent: TRACK_RATE is the fraction
    // of the gap closed per SECOND, so the per-step factor has to be an
    // exponential in dt rather than a plain dt multiply (which would converge
    // at a different rate on a different step size).
    this.x += (carX - this.x) * (1 - Math.exp(-TRACK_RATE * dt));

    const beats = this.phase === "approach" ? APPROACH_BEATS
      : this.phase === "lower" ? RETURN_BEATS
      : null;
    if (beats) {
      const t = this.progress;
      while (this.beat < beats.length && t >= beats[this.beat][0]) {
        gameConsole.push(beats[this.beat][1], HINT);
        this.beat++;
      }
    }
  }

  get duration() {
    return this.phase === "approach" ? APPROACH_DURATION : LIFT_DURATION;
  }

  get progress() {
    return Math.min(1, this.elapsed / this.duration);
  }

  // The approach is over: the drone is in position and the jaws are ready to
  // bite. main.js watches this from inside "playing" and freezes the world on
  // the tick it goes true.
  get grabbed() {
    return this.phase === "approach" && this.progress >= 1;
  }

  // The current FROZEN half has finished — the lift has cleared the frame, or
  // the lower has handed the car back. Never true during the approach, which
  // reports itself through `grabbed` above: the two are separate questions
  // because they hand over to different states.
  get done() {
    return (this.phase === "lift" || this.phase === "lower") && this.progress >= 1;
  }

  // WHERE THE PLAYER'S CAR SHOULD BE DRAWN this frame, as a screen-space y
  // offset from wherever player.render() would otherwise put it. Zero on the
  // road and through the whole approach — the car is still being driven, and
  // nothing about having a drone overhead moves it. See the header for why this
  // number crosses the boundary instead of the car being drawn in here.
  carOffsetY() {
    // How far the car has to travel to be genuinely off the top of the frame,
    // rather than clipped at y=0 — its own row plus a whole half-screen of
    // margin, so even a tall canvas sees it leave.
    const travel = this.y + this.H * 0.5 + OFFSCREEN_MARGIN;
    const t = this.progress;
    if (this.phase === "lift") {
      // Accelerating away (p², not smoothstep): a lift that eased OUT at the
      // top would look like the drone running out of power right as it cleared
      // the frame. It should look like it has plenty left.
      const p = span(t, RISE_START, 1);
      return -travel * p * p;
    }
    if (this.phase === "lower") {
      // ...and decelerating in, which is that same curve read the other way: a
      // heavy thing being SET DOWN rather than dropped.
      const k = 1 - span(t, 0, FALL_END);
      return -travel * k * k;
    }
    return 0;
  }

  // Everything about how the drone is drawn this frame, derived from progress
  // alone — one small record, so render() below stays a list of draw calls
  // rather than a second copy of the timeline. Returns null when there is
  // nothing to draw, which is the whole of "idle".
  frame() {
    if (this.phase === "idle") return null;
    const t = this.progress;
    const [w, h] = LIFTER.size;

    // Where a drone that is NOT over the car sits: off the top of the frame.
    // The approach flies it in from there, and the lower's departure flies it
    // back out the same way.
    const away = -(h / 2 + OFFSCREEN_MARGIN);

    if (this.phase === "approach") {
      // Flying in and settling: down the screen from off-frame onto the car's
      // own row, growing as it closes the altitude. Smoothstepped, so it
      // arrives rather than stopping dead.
      const p = smooth(t);
      return {
        y: away + (this.y - away) * p,
        // Ends ON SCALE_HIGH, which is where the lift picks it up — see the
        // constants' own comment for the pop that leaves if it doesn't.
        scale: SCALE_LOW + (SCALE_HIGH - SCALE_LOW) * p,
        jaw: JAW_OPEN_SCALE,
        w, h,
      };
    }

    if (this.phase === "lift") {
      // Rides the car up on the SAME offset the car itself is drawn with, so
      // the two can never shear apart, while the jaws close and the whole thing
      // draws bigger as it comes toward the camera.
      return {
        y: this.y + this.carOffsetY(),
        scale: SCALE_HIGH * (1 + 0.5 * span(t, RISE_START, 1) ** 2),
        jaw: JAW_OPEN_SCALE + (1 - JAW_OPEN_SCALE) * smooth(span(t, 0, JAW_CLOSE_END)),
        w, h,
      };
    }

    // "lower": comes down holding the car, opens up, then climbs away alone.
    // Two motions, one after the other and never at once — the descent's own
    // offset while it still holds the car, then a straight climb out of frame
    // once the jaws are open.
    const depart = smooth(span(t, JAW_OPEN_END, DEPART_END));
    const k = 1 - span(t, 0, FALL_END);
    return {
      y: this.y + this.carOffsetY() + (away - this.y) * depart,
      scale: SCALE_HIGH * (1 + 0.5 * k * k) * (1 - 0.3 * depart),
      jaw: 1 + (JAW_OPEN_SCALE - 1) * smooth(span(t, FALL_END, JAW_OPEN_END)),
      w, h,
    };
  }

  // The drone itself, drawn INSIDE main.js's world block (so it rides the
  // frozen scene and the death shake alike) and AFTER the player's car — the
  // hull is above the car it is carrying, and the CLAW LIFTER's open middle is
  // what keeps the car visible through it. See bossshapes.js's own note on why
  // that hull carries `hover: { blot: false }`.
  //
  // Drawn in the ENEMY red rather than the player's cyan: this is not the
  // player's vehicle, and the gallery already reads these hulls as hostile
  // hardware. Whether the shop's own drone should get a friendlier colour of
  // its own is a question for the phase that gives the shop content.
  // THE ROTORS RUN OFF THIS MODULE'S OWN CLOCK, not the caller's. Every other
  // hull in the game takes `wheelPhase` from the distance its car has driven,
  // and during the lift and the lower that number has stopped — the world is
  // frozen. Rotors that stop are a drone that has stalled in mid-air while
  // holding the player's car, so this derives the phase from `elapsed`
  // instead, which keeps running through the freeze because this module is one
  // of the two things still being ticked. drawRotor reads the value as
  // `phase * 0.05` radians, so the constant here is just "fast enough that the
  // blades blur rather than strobe".
  render(ctx) {
    const f = this.frame();
    if (!f) return;
    drawShapeObject(ctx, this.x, f.y, LIFTER, {
      color: ENEMY,
      thrust: ENEMY_THRUST,
      // The jaw scale rides on the WIDTH alone — see JAW_OPEN_SCALE.
      w: f.w * f.scale * f.jaw,
      h: f.h * f.scale,
      wheelPhase: this.elapsed * ROTOR_RATE,
    });
  }

  // The white hand-over flash, over the world and under the HUD — the same
  // trick and the same purpose as jackin.js's own closing flash: it covers the
  // instant one thing stops drawing the scene and another starts. The lift ends
  // on it (into the shop screen) and the lower opens on it (out of one).
  renderOverlay(ctx, W, H) {
    if (this.phase === "idle") return;
    const t = this.progress;
    const a = this.phase === "lift" ? span(t, FLASH_START, 1)
      : this.phase === "lower" ? 1 - span(t, 0, (1 - FLASH_START) * 2)
      : 0;
    if (a <= 0) return;

    ctx.save();
    ctx.globalAlpha = a * 0.85;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // A caption under the flash on the way UP, so the cut to the shop is
    // explained before it happens rather than after. Nothing on the way down —
    // the road answering for itself is the whole point of the return.
    if (this.phase === "lift") {
      ctx.save();
      ctx.globalAlpha = a;
      glowText(ctx, "DOCKING", W / 2, H * 0.46, GREEN_PALE, 15, "center", 10);
      ctx.restore();
    }
  }
}
