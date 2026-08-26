// The player car: steer left/right, adjust speed, take damage from barriers and
// from ramming. Drawn as a neon wireframe. From Phase 1 on it is constrained to
// the road, whose left/right edges are passed in each frame as `bounds`
// (screen x).

import { drawCarCached } from "./sprites.js";
import { Exhaust } from "./exhaust.js";
import { glowOrb } from "../engine/neon.js";
import { steerAxis, throttleAxis } from "../engine/input.js";
import { PLAYER, PLAYER_THRUST, HAZARD, SHIELD_FLICKER } from "../engine/palette.js";
import * as gameConsole from "../engine/console.js";

// Exported: the traffic catalogue is pinned to both ends of the player's speed
// band (see cartypes.js), and that relation is asserted in test/road-and-caches.test.js.
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

// The hull the player STARTS a run with, and the floor every CHASSIS tier is
// added to (game/upgrades.js). Exported for that reason alone: the upgrade
// catalogue prices a tier as a delta on this figure rather than restating it,
// so retuning the starting hull retunes the whole ladder with it.
export const BASE_MAX_HEALTH = 200;
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

// The shield buff (game/pickuptypes.js's SHIELD entry activates this). ONE
// blurred ball of light wrapped around the whole car (engine/neon.js's
// glowOrb), breathing in and out — it replaced a pair of counter-rotating
// dashed rings, which drew the eye to the rings' own motion instead of to the
// car being protected. A halo that just pulses stays legible at speed and
// still reads as "this thing is wrapped in something".
//
// The radius spans the car with room to spare (the body is 34x64), so the
// glow's bright band sits just outside the wireframe rather than on top of it.
const SHIELD_ORB_R = 44; // radius at the top of the breath
const SHIELD_ORB_PULSE = 7; // px the radius shrinks by at the bottom of it
const SHIELD_PULSE_RATE = 4.2; // rad/sec — roughly a breath every 1.5s
const SHIELD_ORB_ALPHA = 0.3; // peak alpha; halved at the bottom of the breath
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

// The overdrive buff (game/pickuptypes.js's BOOST entry activates this).
// While it runs, the car's whole speed BAND slides up by a flat amount: the
// floor the throttle can fall back to and the ceiling it can climb to both
// move by the same number, which is what makes the buff felt without the
// player having to do anything about it.
//
// LIFTING THE FLOOR IS THE HALF THAT MATTERS. A raised ceiling alone sells a
// top speed the car needs the better part of a second at ACCEL (380/sec) to
// climb into, and only holds while the throttle is held — most of a short
// buff would be spent getting there. The floor is enforced by update()'s own
// clamp every tick, so raising it puts the car at the new speed on the frame
// the crate is collected, whatever the player is doing with the throttle.
//
// Exported for the same reason SHIELD_EXPIRING is: main.js's HUD readout
// flickers on this clock rather than hand-picking a second number that could
// quietly drift from it.
export const BOOST_EXPIRING = 1; // seconds left when the HUD readout starts flickering
export const BOOST_FLICKER_RATE = 26; // rad/sec — the shield readout's own, so the two blink alike

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

    this.health = BASE_MAX_HEALTH;
    // PER-INSTANCE, not the module constant — the shop's CHASSIS tiers raise
    // this mid-run (see applyUpgrades below).
    this.maxHealth = BASE_MAX_HEALTH;
    // Likewise per-instance: MAX_SPEED and PLAYER_MASS above are the BASE
    // figures a run starts from, and the shop's ENGINE and RAM PLATE tiers
    // move these copies. Nothing else may read the constants for the player's
    // LIVE values — cartypes.js is pinned to the band the CONSTANTS describe
    // (a car catalogue must not shift under an upgrade the player bought),
    // which is exactly why the two are now separate things.
    this.maxSpeed = MAX_SPEED;
    this.mass = PLAYER_MASS;
    // Extra seconds every shield the player picks up (or buys) is worth — the
    // DEFLECTOR tiers. Added in activateShield rather than baked into the
    // pickup catalogue, so one upgrade covers every shield source at once.
    this.shieldBonus = 0;
    this.hitWall = false; // true on frames the car is pressed against a barrier
    this.wallTimer = 0; // counts down between scrape-damage ticks
    this.wheelPhase = 0; // accumulated roll distance, drives the wheel tread

    this.vSteer = 0; // sideways velocity from steering, ramped toward the axis
    this.vLateral = 0; // sideways velocity from ramming (see collisions.js)
    this.flash = 0; // counts down after a hit; flashes the car red

    // The speed tell: a plume off the tail pipes that grows with speed. Drawn
    // live rather than baked into the car sprite — see exhaust.js's header for
    // why the sprite cache forbids the obvious alternative.
    this.exhaust = new Exhaust();

    this.shieldTime = 0; // seconds of invulnerability left (game/pickuptypes.js's SHIELD)
    this.shieldPhase = 0; // accumulated only while shielded — drives the pulse and the flicker

    this.boostTime = 0; // seconds of overdrive left (game/pickuptypes.js's BOOST)
    this.boostAmount = 0; // world units/sec the whole band is lifted by while it runs
    this.boostPhase = 0; // accumulated only while boosted — drives the HUD's expiry flicker

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
  // `shieldBonus` (the shop's DEFLECTOR tiers) is added to whatever the source
  // offered, so a 5s crate becomes a 7s one rather than the upgrade having to
  // be applied at every call site that grants a shield.
  activateShield(seconds) {
    if (seconds <= 0) return;
    this.shieldTime = Math.max(this.shieldTime, seconds + this.shieldBonus);
  }

  // Grant `seconds` of overdrive worth `amount` world units/sec on both ends
  // of the speed band (see BOOST_EXPIRING's header for what that means and
  // why it is both ends). NOT ADDITIVE, on either axis, and for exactly the
  // reason activateShield gives above: a cluster of crates must cap out at
  // "the strongest one, for as long as the longest one" rather than chaining
  // into a car that is permanently 600 units faster than the catalogue says.
  //
  // The two maxima are taken INDEPENDENTLY, which is the one place this
  // differs from the shield. Collecting a weak-but-long crate while a
  // strong-but-short one is running keeps the strong lift AND the long clock
  // — the player is never made worse off by driving over a pickup, which is
  // the rule the whole catalogue is built on (see pickuptypes.js's header on
  // a crate always being spent, even wastefully).
  activateBoost(amount, seconds) {
    if (amount <= 0 || seconds <= 0) return;
    this.boostAmount = Math.max(this.boostTime > 0 ? this.boostAmount : 0, amount);
    this.boostTime = Math.max(this.boostTime, seconds);
  }

  // How much the band is lifted RIGHT NOW — 0 whenever no boost is running,
  // so the two accessors below are the only thing anything else has to read.
  get boost() {
    return this.boostTime > 0 ? this.boostAmount : 0;
  }

  // The live ends of the speed band, boost included. EVERYTHING that clamps,
  // normalises against or displays the band goes through these rather than
  // through MIN_SPEED/this.maxSpeed, so a boosted car's exhaust plume, HUD and
  // clamp all agree on where its band currently sits.
  get minSpeed() {
    return MIN_SPEED + this.boost;
  }

  get topSpeed() {
    return this.maxSpeed + this.boost;
  }

  // Re-point this car at the stat block the shop's tiers add up to
  // (game/upgrades.js's Garage.stats). ABSOLUTE, not incremental: every field
  // is the base figure plus the tiers owned, recomputed from scratch, so
  // calling this twice for one purchase cannot double an upgrade — which is
  // what lets main.js simply re-apply after every sale rather than diffing.
  //
  // THE HULL IS THE ONE THAT ALSO HEALS. Raising the ceiling without filling
  // the new room would sell the player a bar that is instantly LESS full than
  // it was a moment ago — the opposite of what "MORE HULL" is supposed to feel
  // like — so the capacity gained is granted as health too. heal() caps itself
  // and re-arms the damage call-outs on the way past, which is what a car
  // coming out of a workshop should do.
  applyUpgrades(stats) {
    this.maxSpeed = stats.maxSpeed;
    this.mass = stats.mass;
    this.shieldBonus = stats.shieldBonus;
    const gained = stats.maxHealth - this.maxHealth;
    this.maxHealth = stats.maxHealth;
    if (gained > 0) this.heal(gained);
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

    // The overdrive clock, ticked BEFORE the speed clamp below rather than
    // alongside the shield's at the end of this method. The clamp reads the
    // band this tick's `boost` describes, so running the clock afterwards
    // would leave the car a whole frame above a ceiling that had already
    // expired — the buff would visibly outlast its own countdown.
    if (this.boostTime > 0) {
      this.boostTime = Math.max(0, this.boostTime - dt);
      this.boostPhase += dt;
      if (this.boostTime === 0) this.boostAmount = 0; // the band is back to stock
    } else {
      this.boostPhase = 0; // same reset the shield's phase gets at the end of
                           // this method, and for the same reason: a later
                           // boost's readout should start from a known point
    }

    // Speed control.
    const throttle = throttleAxis();
    this.speed += throttle * ACCEL * dt;
    // Against the LIVE band, not the constants: while an overdrive crate is
    // running both ends of it sit `boost` higher (see activateBoost). The
    // floor is what puts a boosted car at speed immediately, and the same
    // clamp is what drops it back the tick the buff expires — a hard step
    // down rather than a coast, so the end of the buff reads as clearly as
    // the start of it did.
    if (this.speed < this.minSpeed) this.speed = this.minSpeed;
    if (this.speed > this.topSpeed) this.speed = this.topSpeed;

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

    // Fed AFTER the wall scrub above, so grinding a barrier visibly chokes the
    // plume on the same frame it costs speed. The throttle axis goes across
    // too, so the flame answers the key rather than the momentum — see the
    // flare constants in exhaust.js.
    // Normalised against the car's OWN band, not the module's: an upgraded car
    // should still be showing its longest plume when it is flat out, rather
    // than topping the flame off partway up a band it can now exceed.
    // BOOSTED CARS RUN THE PLUME FLAT OUT, whatever the throttle is doing.
    // Normalising against the lifted band instead would leave a boosted car
    // at its new floor showing exactly the plume it showed at the old one —
    // the buff would move the car without changing anything the player can
    // see. Pinning the band to 1 for the duration is the tell: the thrusters
    // are open because something else is holding them there.
    const band = this.boost > 0
      ? 1
      : (this.speed - this.minSpeed) / (this.topSpeed - this.minSpeed);
    this.exhaust.update(dt, band, throttle);

    if (this.flash > 0) this.flash -= dt;

    if (this.shieldTime > 0) {
      this.shieldTime = Math.max(0, this.shieldTime - dt);
      this.shieldPhase += dt;
    } else {
      this.shieldPhase = 0; // reset so a later shield's glow starts at the
                            // bottom of a breath, not mid-pulse from a run
                            // that ended a while ago
    }
  }

  // `angle` is the road's heading at the player's row (road.headingAt(distance),
  // since the player is pinned to worldY === distance). Passed in rather than
  // derived here for the same reason `bounds` is: this class knows about steering
  // and damage, not about the shape of the road.
  // Where the car is being DRAWN this frame, as opposed to where the logic
  // step left it: x interpolated between the last two steps. Public because
  // anything that has to touch the car's on-screen position — the link's dish
  // wallet.js hangs off its flank — has to use the same number render() does,
  // or it rides a frame behind the car it is attached to.
  renderX(alpha) {
    return this.prevX + (this.x - this.prevX) * alpha;
  }

  render(ctx, alpha, angle = 0) {
    // Interpolate x between the last two logic steps for smooth motion.
    const x = this.renderX(alpha);

    // Flash red while grinding a barrier or just after a ram, else the usual
    // cyan. Both use the same colour, so the cache gains one extra key, not two.
    const color = this.hitWall || this.flash > 0 ? HAZARD : this.color;

    // Under the car: the chassis fill is opaque, so drawing the body over the
    // plume is what buries its root in the tail and leaves only the flame that
    // escapes the pipes.
    this.exhaust.render(ctx, x, this.y, angle);

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

  // One blurred, pulsing halo around the car. Drawn OVER the car (after
  // drawCarCached above) but ADDITIVELY (see glowOrb), so it brightens the
  // wireframe underneath instead of veiling it — the same "a layer on top"
  // logic the hit-flash colour follows.
  renderShield(ctx, x) {
    const expiring = this.shieldTime < SHIELD_EXPIRING;
    const flicker = expiring && Math.sin(this.shieldPhase * SHIELD_FLICKER_RATE) > 0;
    const color = flicker ? SHIELD_FLICKER : PLAYER;
    // One sine drives both radius and brightness, so the halo swells as it
    // brightens — two out-of-step curves would read as a wobble, not a breath.
    const breath = (Math.sin(this.shieldPhase * SHIELD_PULSE_RATE) + 1) / 2; // 0..1
    const r = SHIELD_ORB_R - SHIELD_ORB_PULSE * (1 - breath);
    const alpha = SHIELD_ORB_ALPHA * (0.5 + 0.5 * breath);
    glowOrb(ctx, x, this.y, r, color, alpha);
  }
}
