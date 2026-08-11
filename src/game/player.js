// The player car: steer left/right, adjust speed, take damage from barriers and
// from ramming. Drawn as a neon wireframe. From Phase 1 on it is constrained to
// the road, whose left/right edges are passed in each frame as `bounds`
// (screen x).

import { drawCarCached } from "./sprites.js";
import { glowDashedRing } from "../engine/neon.js";
import { steerAxis, throttleAxis } from "../engine/input.js";
import { PLAYER, PLAYER_THRUST, HAZARD, SHIELD_FLICKER } from "../engine/palette.js";
import * as gameConsole from "../engine/console.js";

// Exported: the traffic catalogue is pinned to both ends of the player's speed
// band (see cartypes.js), and that relation is asserted in test/invariants.test.js.
export const MIN_SPEED = 120; // world units/sec (also the road scroll speed)
export const MAX_SPEED = 620;
export const ACCEL = 380; // speed change per second at full throttle
const STEER_SPEED = 260; // horizontal px/sec at full lock

// Steering RAMPS rather than snapping. A keyboard axis is on or off, so applying
// it straight to position means the smallest input the player can give is a
// whole frame at full lock — and the shortest tap a human can manage is more
// like 5-8 frames, which at STEER_SPEED covers a quarter of a lane (lanes are
// 65px). That is why fine adjustments were impossible: there was no such thing
// as a small steering input.
//
// So the axis drives a sideways VELOCITY that accelerates toward full lock
// instead of arriving there. Measured over a 60Hz step, a 100ms tap now travels
// 8px (an eighth of a lane, was 26px) and a 150ms one 14px (was 39px), which is
// the range fine corrections live in. Held inputs barely change: full lock
// arrives in 0.29s and a full second of steering still crosses 3.6 lanes of the
// 4-lane road, so lane changes and dodges cost about what they always did.
//
// Releasing decays faster than pressing builds, so the car settles where you
// let go instead of coasting past it; the same asymmetry makes a reversal snap
// through zero rather than wallow there.
const STEER_ACCEL = 900; // px/sec² while a steering key is held
const STEER_RELEASE = 2600; // px/sec² while returning to centre (or reversing)

const MAX_HEALTH = 200;
const WALL_DAMAGE = 3; // health lost per wall-scrape tick
const WALL_DAMAGE_INTERVAL = 0.25; // seconds between scrape ticks (rate-limits damage)
const WALL_SPEED_SCRUB = 0.985; // per-tick speed multiplier while grinding a barrier

// Ramming mass, in the same arbitrary units as a car type's (cartypes.js). Sits
// between the sedan (1) and the bruiser (2): the player shoves a roadster around
// easily, trades evenly with an interceptor and loses to a truck.
export const PLAYER_MASS = 1.4;

// Sideways velocity from being rammed (collisions.js writes it; this class
// integrates it). Damped hard, because tyres bite — a shove is a lurch, not a
// skid across the road.
const SHOVE_DAMP = 5; // per second

const HIT_FLASH = 0.18; // seconds the car flashes after taking a hit

// Hull damage call-outs to the in-game console (engine/console.js). `frac` is
// the health fraction remaining at which the line fires, so these read as
// "25% damage taken", "50%", "75%" even though the check below is against
// health LEFT, not damage taken. Fires once per crossing (see healthWarned
// below), and re-arms if the player heals back above the threshold, so a
// later crossing of the same line warns again.
const DAMAGE_THRESHOLDS = [
  { frac: 0.75, text: "HULL DAMAGE 25%", severity: gameConsole.WARN },
  { frac: 0.5, text: "HULL DAMAGE 50%", severity: gameConsole.WARN },
  { frac: 0.25, text: "HULL DAMAGE 75%", severity: gameConsole.CRITICAL },
];

// The shield buff (game/pickuptypes.js's SHIELD entry activates this). Two
// dashed rings, spun in opposite directions by an animated dash offset (see
// engine/neon.js's glowDashedRing) — a genuine rotation, not a squashed
// ellipse standing in for one. Sized in px/sec of dash travel rather than
// rad/sec, since setLineDash works in the stroke's own units.
const SHIELD_RING_A_SPEED = 46; // outer ring
const SHIELD_RING_B_SPEED = -62; // inner ring, opposite direction
const SHIELD_RING_A_R = 30;
const SHIELD_RING_B_R = 23;
// The last stretch of the window flickers toward SHIELD_FLICKER — the same
// "about to lose it" tell CRITICAL_FLASH gives a dying car (traffic.js),
// moved into the player's own family. Kept short: a flicker that ran the
// whole duration would just read as the wrong colour, not as a countdown.
// Exported: Phase 8 step 3's shield_drone (audio/sustainedfx.js) reuses this
// exact threshold to time its own audible fade-out, rather than hand-picking
// a second number that could quietly drift from the visual one — see that
// file's own comment on why it's HALVED there.
export const SHIELD_EXPIRING = 1; // seconds left when the flicker starts
const SHIELD_FLICKER_RATE = 26; // rad/sec of the flicker's own sine

export class Player {
  // `onDamage` is optional: `(hp, deflected) => void`, called every time
  // damage() below is invoked with hp > 0 — `deflected` is true when the
  // shield ate the hit (the guard a few lines down), false when hull was
  // actually lost. A CALLBACK rather than an import, mirroring traffic.js's
  // own onDestroyed/obstacles.js's onDestroyed — this keeps player.js
  // ignorant of the audio engine (see the Phase 8 design brief's own rule:
  // "game modules stay ignorant of audio") while still giving main.js a
  // single, reliable hook onto the ONE funnel every damage source in the
  // game already reaches (see damage()'s own header below).
  constructor(x, y, onDamage) {
    this.x = x;
    this.y = y;
    this.onDamage = onDamage;
    this.prevX = x; // previous-frame x, for render interpolation
    this.w = 34;
    this.h = 60;
    this.speed = 260; // current forward/scroll speed
    this.color = PLAYER; // cyan accent — stands out against the green world

    this.health = MAX_HEALTH;
    this.maxHealth = MAX_HEALTH;
    this.hitWall = false; // true on frames the car is pressed against a barrier
    this.wallTimer = 0; // counts down between scrape-damage ticks
    this.wheelPhase = 0; // accumulated roll distance, drives the wheel tread

    this.vSteer = 0; // sideways velocity from steering, ramped toward the axis
    this.vLateral = 0; // sideways velocity from ramming (see collisions.js)
    this.flash = 0; // counts down after a hit; flashes the car red

    this.shieldTime = 0; // seconds of invulnerability left (game/pickuptypes.js's SHIELD)
    this.shieldSpin = 0; // accumulated only while shielded — drives the ring animation

    this.healthWarned = DAMAGE_THRESHOLDS.map(() => false);
  }

  // Take `hp` off the hull. Health floors at 0 — main.js is watching this
  // field and switches the game over to game/disconnect.js's death sequence
  // the instant it sees zero, so this class itself does not need to know that
  // a hull can run out; it only has to stop going negative.
  //
  // THE SHIELD'S ENTIRE IMPLEMENTATION IS THIS GUARD. Every damage source in
  // the game — bullets, blast, ramming, wall-scrape — already funnels through
  // this one method (collisions.js's PlayerBody.damage, obstacles.js's
  // playerBox.damage, and the wall-scrape call a few lines below in update()
  // all end up here), so making it a no-op while shieldTime > 0 covers every
  // one of them without touching any of those call sites. No flash either —
  // flashing on a hit that did nothing would read as damage that wasn't.
  damage(hp) {
    if (hp <= 0) return;
    if (this.shieldTime > 0) {
      if (this.onDamage) this.onDamage(hp, true); // deflected — the shield_deflect branch, see the constructor's own comment
      return;
    }
    this.health = Math.max(0, this.health - hp);
    this.flash = HIT_FLASH;

    const frac = this.health / this.maxHealth;
    DAMAGE_THRESHOLDS.forEach((t, i) => {
      if (!this.healthWarned[i] && frac <= t.frac) {
        this.healthWarned[i] = true;
        gameConsole.push(t.text, t.severity);
      }
    });

    if (this.onDamage) this.onDamage(hp, false); // a real hull loss — the player_hit branch
  }

  // Restore `hp` of hull, capped at maxHealth (game/pickuptypes.js's FIX).
  heal(hp) {
    if (hp <= 0) return;
    this.health = Math.min(this.maxHealth, this.health + hp);

    // Re-arm any threshold healed back past, so a later crossing warns again.
    const frac = this.health / this.maxHealth;
    DAMAGE_THRESHOLDS.forEach((t, i) => {
      if (this.healthWarned[i] && frac > t.frac) this.healthWarned[i] = false;
    });
  }

  // Grant `seconds` of invulnerability. NOT additive with time already
  // banked — a shield picked up while one is running EXTENDS to at least
  // `seconds` rather than stacking on top, so a cluster of shield pickups
  // caps out at "however long the strongest one lasts" instead of chaining
  // into effectively permanent invulnerability.
  activateShield(seconds) {
    this.shieldTime = Math.max(this.shieldTime, seconds);
  }

  // `bounds` = { left, right } road edges in screen x for the player's row.
  update(dt, bounds) {
    this.prevX = this.x;

    // Steering, plus whatever is left of the last shove.
    //
    // Move vSteer toward the axis at whichever rate applies, without overshoot:
    // building up uses STEER_ACCEL, anything that reduces the current lock (a
    // release, or a reversal that has to pass through zero) uses the brisker
    // STEER_RELEASE.
    const target = steerAxis() * STEER_SPEED;
    const rate = Math.abs(target) > Math.abs(this.vSteer) && target * this.vSteer >= 0
      ? STEER_ACCEL
      : STEER_RELEASE;
    const step = rate * dt;
    const delta = target - this.vSteer;
    this.vSteer += Math.abs(delta) <= step ? delta : Math.sign(delta) * step;

    this.x += this.vSteer * dt;
    this.x += this.vLateral * dt;
    this.vLateral -= this.vLateral * Math.min(1, SHOVE_DAMP * dt);

    // Speed control.
    this.speed += throttleAxis() * ACCEL * dt;
    if (this.speed < MIN_SPEED) this.speed = MIN_SPEED;
    if (this.speed > MAX_SPEED) this.speed = MAX_SPEED;

    // Constrain to the road; scraping a barrier costs health and scrubs speed.
    //
    // This stays a plain half-WIDTH test even though the car is now drawn rotated
    // into the bend (see render). It is tempting to widen it by the rotated
    // bounding box, but that would be measuring the wrong thing: the barrier is
    // slanted by the same angle the car is. Working perpendicular to the road, a
    // car parked at this limit sits (w/2)·cos θ from the barrier line while
    // needing w/2 — at the road's steepest (17.5°) that is an overlap of 0.8px,
    // which is less than the barrier's own stroke width. The unrotated clamp was
    // the approximation; rotating the car is what made it nearly exact.
    const half = this.w / 2;
    this.hitWall = false;
    if (this.x < bounds.left + half) {
      this.x = bounds.left + half;
      this.hitWall = true;
    } else if (this.x > bounds.right - half) {
      this.x = bounds.right - half;
      this.hitWall = true;
    }

    // Roll the wheels in proportion to forward speed.
    this.wheelPhase += this.speed * dt;

    this.wallTimer -= dt;
    if (this.hitWall) {
      this.speed *= WALL_SPEED_SCRUB;
      this.vLateral = 0; // the barrier absorbs the shove that put us here
      this.vSteer = 0; // and the lock, so turning away builds from centre
      if (this.wallTimer <= 0) {
        this.damage(WALL_DAMAGE);
        this.wallTimer = WALL_DAMAGE_INTERVAL;
      }
    }

    if (this.flash > 0) this.flash -= dt;

    if (this.shieldTime > 0) {
      this.shieldTime = Math.max(0, this.shieldTime - dt);
      this.shieldSpin += dt;
    } else {
      this.shieldSpin = 0; // reset so a later shield's rings start clean, not
                            // mid-rotation from a run that ended a while ago
    }
  }

  // `angle` is the road's heading at the player's row (road.headingAt(distance),
  // since the player is pinned to worldY === distance). Passed in rather than
  // derived here for the same reason `bounds` is: this class knows about steering
  // and damage, not about the shape of the road.
  render(ctx, alpha, angle = 0) {
    // Interpolate x between the last two logic steps for smooth motion.
    const x = this.prevX + (this.x - this.prevX) * alpha;

    // Flash red while grinding a barrier or just after a ram, else the usual
    // cyan. Both use the same colour, so the cache gains one extra key, not two.
    const color = this.hitWall || this.flash > 0 ? HAZARD : this.color;

    drawCarCached(ctx, x, this.y, {
      color,
      thrust: PLAYER_THRUST,
      w: this.w,
      h: this.h,
      wheelPhase: this.wheelPhase,
      angle,
    });

    if (this.shieldTime > 0) this.renderShield(ctx, x);
  }

  // Two dashed rings, genuinely rotating (animated dash offset — see
  // engine/neon.js's glowDashedRing) in opposite directions around the car.
  // Drawn OVER the car (after drawCarCached above), same as the flash colour
  // reads as a layer on top of the sprite rather than a recolour of it.
  renderShield(ctx, x) {
    const expiring = this.shieldTime < SHIELD_EXPIRING;
    const flicker = expiring && Math.sin(this.shieldSpin * SHIELD_FLICKER_RATE) > 0;
    const color = flicker ? SHIELD_FLICKER : PLAYER;
    glowDashedRing(ctx, x, this.y, SHIELD_RING_A_R, color, this.shieldSpin * SHIELD_RING_A_SPEED);
    glowDashedRing(ctx, x, this.y, SHIELD_RING_B_R, color, this.shieldSpin * SHIELD_RING_B_SPEED);
  }
}
