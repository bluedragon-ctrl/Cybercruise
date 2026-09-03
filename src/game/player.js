// The player car: steer left/right, adjust speed, take damage from barriers and
// from ramming. Drawn as a neon wireframe. From Phase 1 on it is constrained to
// the road, whose left/right edges are passed in each frame as `bounds`
// (screen x).

import { drawCarCached } from "./sprites.js";
import { Exhaust } from "./exhaust.js";
import { neonStroke } from "../engine/neon.js";
import { steerAxis, throttleAxis } from "../engine/input.js";
import { PLAYER, PLAYER_THRUST, HAZARD, SHIELD_FLICKER } from "../engine/palette.js";
import * as gameConsole from "../engine/console.js";

// Exported: the traffic catalogue is pinned to both ends of the player's speed
// band (see cartypes.js), and that relation is asserted in test/road-and-caches.test.js.
export const MIN_SPEED = 100; // world units/sec (also the road scroll speed)
export const MAX_SPEED = 620;
export const ACCEL = 380; // speed change per second at full throttle
// How fast a car sitting OUTSIDE its speed band is pulled back into it — the
// overdrive buff's raised floor pulling up, its expired ceiling pulling down,
// and a wall scrape's scrubbed speed climbing back to the floor. One engine's
// worth (ACCEL), so a band that moves under the car feels like the car driving
// to meet it rather than like a number being reassigned; at the overdrive's
// 200 that is a little over half a second at each end. See update()'s own
// comment for why this is a ramp and not the clamp it used to be.
//
// A RAMP CAN BE OUTRUN, which is the one thing this rate cannot defend against
// on its own: anything taking speed away per TICK, faster than this puts it
// back, holds the car wherever it likes for as long as it keeps doing so. The
// case that did is a car sat in front of you — see `speedFloor` below and
// collisions.js's rearEnd, which is where that is answered rather than here.
// Raising this rate was tried first and is not the fix: the bill contact sent
// grew with closing speed, so a faster ramp only bought a bigger bill.
export const BAND_RECOVER = ACCEL;
const STEER_SPEED = 300; // horizontal px/sec at full lock

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
export const PLAYER_MASS = 1.5;

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

// The shield buff (game/pickuptypes.js's SHIELD entry activates this). A ring
// of light wrapped around the whole car, breathing in and out — it replaced a
// pair of counter-rotating dashed rings, which drew the eye to the rings' own
// motion instead of to the car being protected. A halo that just pulses stays
// legible at speed and still reads as "this thing is wrapped in something".
// STILL A RING, NOT THE SAME REJECTED DESIGN: nothing here rotates or dashes,
// only the radius and the alpha breathe — the thing that made the old pair
// distracting was the two rings visibly turning against each other, not the
// fact that they were rings.
//
// THROUGH PHASE 15D-I THIS WAS engine/neon.js's glowOrb: a radial gradient,
// bright in a band partway out and fading to nothing at the edge, drawn
// ADDITIVELY so it brightened the wireframe rather than veiling it. 15D-II
// RETIRES THE GRADIENT for the same reason neonStroke's overdraw went: bloom
// (engine/present.js) now supplies a soft falloff around anything bright
// enough to cross its threshold, so a second, hand-authored falloff doubles
// up with it. What is left is a single plain stroked ring — still additive,
// still nothing drawn over the car's own centre (a filled disc would wash the
// wireframe out there, which is exactly what the gradient's dimmed middle
// stop was avoiding; a ring keeps avoiding it by construction, drawing
// nothing inside its own radius at all).
//
// The radius spans the car with room to spare (the body is 34x64), so the
// ring sits just outside the wireframe rather than on top of it.
const SHIELD_ORB_R = 44; // radius at the top of the breath
const SHIELD_ORB_PULSE = 7; // px the radius shrinks by at the bottom of it
const SHIELD_ORB_WIDTH = 2.5; // stroke width — bloom supplies the spread now,
                               // this only has to be thick enough to bloom
const SHIELD_PULSE_RATE = 4.2; // rad/sec — roughly a breath every 1.5s
// PEAK ALPHA, AND WHY IT IS 0.85 NOT 0.3. Bloom (engine/present.js) thresholds
// PER CHANNEL — see BRIGHT_FS's softKnee — so a stroke's COMPOSITED brightness
// has to clear that on at least one channel or it contributes nothing at all,
// gradient or no gradient. glowOrb's old alpha of 0.3 was tuned for a
// HAND-DRAWN falloff that never needed to cross any threshold; carried over
// unchanged when this became a plain bloomed stroke, it measured as a ring
// with literally zero bloom — `PLAYER` (#39f6ff) at alpha 0.3 composites to
// (0.07, 0.29, 0.30), nowhere near a threshold at either 0.75 (this ring's
// original figure) or 0.55 (BLOOM_THRESHOLD, FINAL as of Phase 15c) on any
// channel. 0.85 clears 0.55 on both G (0.82) and B (0.85), with far more
// margin than it was chosen for — it was picked against the OLDER 0.75 figure
// (0.82/0.85 cleared that by 0.07/0.10), and the threshold has since moved
// down without this constant being revisited. RE-EXAMINED AT 0.55 (Phase
// 15e-ii-a): the extra headroom (0.27/0.30 of margin now, versus the
// 0.07/0.10 this was tuned for) means a noticeably lower alpha would still
// clear — but 0.85 is also the shipped, already-verified-live look, and nothing
// about the fade-halo defect this phase otherwise addresses (see neon.js's
// neonStroke header) is about the SHIELD specifically, which is a steady-state
// glow, not a fade. Left unchanged rather than re-tuned on spec; a future pass
// with a reason to dim the ring can spend the new margin then. The trade this
// makes ON PURPOSE: at the bottom of the breath (0.5x this = 0.425, still
// under 0.55) the ring goes briefly bloomless rather than merely dimmer — the
// glow now pulses with the breath instead of just the radius, which reads as
// MORE alive than the old orb did, not less.
const SHIELD_ORB_ALPHA = 0.85;
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
// While it runs, the car's speed band CLOSES onto a single value: the ceiling
// goes up by a flat amount and the floor comes up to meet it, so for the
// duration the car has exactly one speed and the throttle has nothing left to
// ask for.
//
// THE FLOOR IS THE HALF THAT MATTERS. A raised ceiling alone sells a top speed
// that only holds while the throttle is held — most of a short buff would be
// spent asking the player to hold a key. The floor is enforced by update()
// every tick, so putting it AT the ceiling drives the car up to the new speed
// whatever the player is doing, and takes away the option of slowing down while
// the buff runs: an overdrive is something that happens TO the car, not
// something to be opted out of. See minSpeed for why the floor has to reach the
// ceiling rather than rise by the crate's amount.
//
// Both ends move by RAMP, not by jump — see BAND_RECOVER and update()'s own
// comment on the band clamp.
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
    // THE TEST OPTION (src/testoptions.js's INVULNERABILITY), set by main.js
    // from the menu row rather than by anything in here — this class knows
    // only that a flag makes damage() a no-op, not that a menu exists. Off on
    // a fresh car, so a build with the row switched off behaves exactly as it
    // did before the flag existed.
    this.invulnerable = false;
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
    // The RAM PLATE's top tier, not the mass figure above — collisions.js's
    // PlayerBody reads this to arm the two bonuses that ride on the LAST tier
    // rather than on mass itself (see upgrades.js's `ram` entry).
    this.ramMaxed = false;
    // Extra seconds every shield the player picks up (or buys) is worth — the
    // DEFLECTOR tiers. Added in activateShield rather than baked into the
    // pickup catalogue, so one upgrade covers every shield source at once.
    this.shieldBonus = 0;
    // The SIPHON RIG tier, 0..3 (game/upgrades.js's `siphon` stat). Read
    // straight off by game/wallet.js wherever a node's reach, drain time or
    // payout is decided — see its own SIPHON_TIERS header for why this is a
    // tier index rather than a figure like the other upgrades above.
    this.siphonLevel = 0;
    // The SPECIALS this run has bought (game/upgrades.js's SPECIALS shelf), as
    // a block of ownership flags keyed by the upgrade's own `special` string —
    // { twinCannon, twinRocket, shieldStorm, autolock }.
    //
    // EMPTY, NOT A LIST OF FALSES, and deliberately so: this file must not
    // import the shop's catalogue to know what the keys ARE (upgrades.js
    // already imports player.js — the arrow only points one way), and every
    // reader is testing one key for truth, which a missing key answers
    // correctly. A stock car simply carries none of them.
    this.specials = {};
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
    // Seconds of shield BANKED but not yet running: a crate arms the shield
    // instead of starting it, and damage() spends the charge on the first hit
    // that would actually land. See chargeShield below.
    this.shieldCharge = 0;

    // Punctured tyres — traffic.js carries exactly this pair on every car, and
    // for the same reason: the strip that bit is usually long gone by the time
    // the crawl matters, so the speed is carried on the CAR rather than looked
    // up from a hazard that may no longer exist. See puncture() below.
    this.spikeTime = 0;  // seconds of crawl left
    this.spikeSpeed = 0; // ...and the speed it is held down to while it runs

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
    // INVULNERABILITY sits ahead of even the shield: every damage source in
    // the game funnels through here (see the header above), so one guard on
    // this line covers bullets, blast, ramming and wall-scrape alike. It
    // returns BEFORE the shield charge is spent, so a test run does not quietly
    // burn its banked shield on hits that were never going to land — and with
    // no onDamage call at all, since a hit that did nothing must not flash,
    // shake or sound.
    if (this.invulnerable) return;
    // A banked shield (chargeShield) fires HERE, before the hit is applied —
    // that is the whole point of charging rather than activating: the window
    // starts on the hit the player did not see coming, not on the crate they
    // drove over while the road happened to be empty. Only spent when nothing
    // is already running, so a hit taken mid-window cannot burn the charge.
    if (this.shieldTime <= 0 && this.shieldCharge > 0) {
      const banked = this.shieldCharge;
      this.shieldCharge = 0;
      this.activateShield(banked);
    }
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

  // Cross a spike strip (obstacletypes.js's "spikes" effect, applied by
  // obstacles.js's contact pass): a scratch of hull, and tyres that will not
  // hold a cruising speed for `slowTime`.
  //
  // THE PLAYER'S HALF OF TRAFFIC.PUNCTURE, and written against it deliberately
  // — the sower drives past and lays a strip in the player's path
  // (cartypes.js), which is the whole errand that catalogue entry describes,
  // and until this existed the strip it left was inert to the one car it was
  // laid for. The obstacle side has said so in a comment since the strip
  // shipped ("this is the one line that has to grow a Player.puncture").
  //
  // NOT BITTEN TWICE, exactly as traffic.js's guard: a car sits on a strip for
  // many ticks, and without this the scratch would be taken sixty times a
  // second and the gentlest hazard in the game would be the deadliest. A
  // SECOND strip still bites once the first one's window is up.
  //
  // A SHIELD STOPS THE PUNCTURE, NOT JUST THE SCRATCH. The shield is total
  // invulnerability while it runs (see damage()'s own header), and a shielded
  // car that still lost thirty seconds of speed would make a mockery of that —
  // the crawl is by far the larger half of what a strip costs. damage() is
  // called FIRST so a BANKED shield fires on this hit like any other (that is
  // what banking is for), and the guard below then reads the window it opened.
  // A hazard with no contactDamage at all cannot spend a bank, since damage()
  // returns early on zero — nothing that reaches the player is such a hazard
  // today, and one that was would want that decided here on purpose.
  puncture(type) {
    if (this.spikeTime > 0) return;
    this.damage(type.contactDamage);
    if (this.invulnerable || this.shieldTime > 0) return;
    this.spikeTime = type.slowTime;
    this.spikeSpeed = type.slowTo;
    // THE TELL, and the reason this is not just a number quietly changing. A
    // hostile car that limps is legible from outside — the player watches it
    // fall behind. The player's OWN car losing its top end has nothing to show
    // for itself but a speed readout that will not climb, which reads as a bug
    // in the throttle. One line in the sys log is what turns it back into a
    // thing that happened, and it is the same channel the hull warnings above
    // already use.
    gameConsole.push("TYRES // PUNCTURED", gameConsole.WARN);
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

  // Grant `seconds` of overdrive worth `amount` world units/sec on the car's
  // CEILING, which the floor is then held level with for the duration — see
  // minSpeed below for why the band closes rather than sliding up.
  //
  // THE TWO HALVES BEHAVE DIFFERENTLY, deliberately. The LIFT is a MAXIMUM:
  // a cluster of crates caps out at the strongest one rather than chaining
  // into a car that is permanently 600 units faster than the catalogue says.
  // The CLOCK is ADDITIVE: a crate driven over while overdrive is running
  // PROLONGS the run rather than being swallowed by a clock that was already
  // longer. Duration is the half that cannot break the speed band no matter
  // how much of it stacks up, so it is the half allowed to stack — and a
  // player who drives out of their way for a second crate mid-overdrive has
  // to be able to see what they bought.
  //
  // Either way the player is never made worse off by driving over a pickup,
  // which is the rule the whole catalogue is built on (see pickuptypes.js's
  // header on a crate always being spent, even wastefully).
  activateBoost(amount, seconds) {
    if (amount <= 0 || seconds <= 0) return;
    this.boostAmount = Math.max(this.boostTime > 0 ? this.boostAmount : 0, amount);
    this.boostTime += seconds; // boostTime is 0 when nothing runs, so this is `seconds` then
  }

  // How much the CEILING is lifted RIGHT NOW — 0 whenever no boost is running,
  // so the two accessors below are the only thing anything else has to read.
  get boost() {
    return this.boostTime > 0 ? this.boostAmount : 0;
  }

  // The live ends of the speed band, boost included. EVERYTHING that clamps,
  // normalises against or displays the band goes through these rather than
  // through MIN_SPEED/this.maxSpeed, so a boosted car's exhaust plume, HUD and
  // clamp all agree on where its band currently sits.
  //
  // AN OVERDRIVE CLOSES THE BAND: the floor is not lifted BY the crate's amount,
  // it is lifted TO the ceiling the crate just raised. For the duration the car
  // has one speed — its boosted top — and the throttle has nothing left to ask
  // for. That is the whole buff: the crate takes the car, wherever it was, and
  // spools it up to a speed it cannot otherwise reach (BAND_RECOVER, so ~0.8s
  // from a mid-band cruise) and holds it there.
  //
  // Lifting the floor BY the amount instead was what shipped first, and it is
  // the wrong shape. A player at 503 of a 100..620 band who drove over a crate
  // got a floor of 300 — under where they already were — so the car did not
  // move, did not accelerate, and the only thing that happened was a number in
  // the HUD. The crate has to be felt from any speed the player might be doing
  // when they take it, and only a floor at the top does that.
  get minSpeed() {
    return this.boost > 0 ? this.topSpeed : MIN_SPEED;
  }

  get topSpeed() {
    return this.maxSpeed + this.boost;
  }

  // The floor as the COLLISION SOLVER sees it: the lowest speed another car is
  // allowed to hold this one at by leaning on it (collisions.js's rearEnd, via
  // PlayerBody). Not the same question as `minSpeed`, which is where update()
  // is driving the car back TO, and the difference is the puncture: a strip
  // overrules the band's floor (see update()), so while one is running the car
  // has genuinely lost the ability the floor describes and traffic gets to
  // hold it down there. Math.min rather than the puncture speed outright,
  // because an UNBOOSTED car's crawl (150) sits above its floor (100) and must
  // not be read as traffic having lifted it.
  get speedFloor() {
    return this.spikeTime > 0 ? Math.min(this.spikeSpeed, this.minSpeed) : this.minSpeed;
  }

  // Bank `seconds` of shield WITHOUT starting the clock. This is what a SHIELD
  // crate now does (game/pickuptypes.js): the window opens on the first hit
  // that would otherwise hurt (see damage() above), so the buff is spent on
  // damage rather than on whatever stretch of empty road happened to follow
  // the crate. ADDITIVE, unlike activateShield: a shield already banked and
  // not yet running has not started costing the player anything, so a second
  // crate driven over before the first hit lands is a crate that was worth
  // taking, not a wasted pickup capped at whichever one was longer. The
  // DEFLECTOR bonus is still added at ACTIVATION time, so a bonus bought
  // between the crate(s) and the hit still counts.
  //
  // WITH A SHIELD ALREADY RUNNING there is nothing left to bank for: the
  // window is open, and a crate taken now is one the player wants spent on
  // the fight they are already in — banking it behind a window that is
  // deflecting hits right now would read as the pickup doing nothing. So it
  // PROLONGS the running window instead, bonus included: this is a shield
  // source like any other, and the bonus is applied wherever a shield
  // actually starts or extends its clock.
  chargeShield(seconds) {
    if (seconds <= 0) return;
    if (this.shieldTime > 0) {
      this.shieldTime += seconds + this.shieldBonus;
      return;
    }
    this.shieldCharge += seconds;
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
    this.ramMaxed = stats.ramMaxed;
    this.shieldBonus = stats.shieldBonus;
    this.siphonLevel = stats.siphonLevel;
    // The Garage's own flag block, by reference — see its `stats` getter. The
    // ?? keeps a caller that predates the specials shelf (the tests hand
    // hand-built stat blocks in) from blanking the field with undefined.
    this.specials = stats.specials ?? this.specials;
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
    const before = this.speed;
    this.speed += throttle * ACCEL * dt;
    // Against the LIVE band, not the constants: while an overdrive crate is
    // running both ends of it sit `boost` higher (see activateBoost).
    //
    // NOT A HARD CLAMP. A car found outside its band is DRIVEN back into it at
    // BAND_RECOVER, without overshoot, rather than teleported to the edge: an
    // overdrive spools the car up to its raised floor over half a second, and
    // its expiry lets the car coast back down from the raised ceiling over the
    // same half second. Both ends read as the engine doing something, which a
    // one-frame jump of 200 units never did.
    //
    // The recovery is measured from `before` — the speed at the TOP of this
    // tick — not from the post-throttle figure, which is what stops the two
    // from compounding. Below the floor a full-throttle tick and a coasting
    // one both climb at exactly BAND_RECOVER, and a player holding the brake
    // at the floor stays pinned to it instead of sinking through.
    if (this.speed < this.minSpeed) {
      this.speed = Math.min(this.minSpeed, Math.max(this.speed, before + BAND_RECOVER * dt));
    } else if (this.speed > this.topSpeed) {
      this.speed = Math.max(this.topSpeed, Math.min(this.speed, before - BAND_RECOVER * dt));
    }

    // PUNCTURED TYRES OVERRULE THE WHOLE BAND, and are therefore applied after
    // it — the same position, and the same argument, traffic.js's own update
    // gives: the crawl is the ONE deliberate exception to the floor, and inside
    // the clamp it would be clamped straight back up next tick and do nothing.
    //
    // INCLUDING AN OVERDRIVE'S RAISED FLOOR. A boost lifts `minSpeed` above the
    // 150 crawl (player.js's BOOST band, obstacletypes.js's slowTo), and when
    // the two disagree the puncture wins. One rule for the player and the
    // traffic beats an exception nobody could see the shape of, and a strip
    // that could be no-sold by having drunk a crate first would stop being the
    // thing the sower's whole errand is built around.
    //
    // EASED DOWN AT BAND_RECOVER, not snapped — the ceiling branch above,
    // measured from `before` for the same reason. A car that dropped 200 units
    // the instant it touched the strip would read as hitting a wall, which is
    // the mine's job, not this one.
    if (this.spikeTime > 0) {
      this.spikeTime = Math.max(0, this.spikeTime - dt);
      this.speed = Math.max(this.spikeSpeed, Math.min(this.speed, before - BAND_RECOVER * dt));
    }

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

  // One pulsing ring around the car. Drawn OVER the car (after drawCarCached
  // above) but ADDITIVELY ("lighter"), so it brightens the wireframe
  // underneath instead of veiling it — the same "a layer on top" logic the
  // hit-flash colour follows. See SHIELD_ORB_R's own comment for why this is
  // a plain stroke rather than glowOrb's old radial gradient.
  renderShield(ctx, x) {
    const expiring = this.shieldTime < SHIELD_EXPIRING;
    const flicker = expiring && Math.sin(this.shieldPhase * SHIELD_FLICKER_RATE) > 0;
    const color = flicker ? SHIELD_FLICKER : PLAYER;
    // One sine drives both radius and brightness, so the halo swells as it
    // brightens — two out-of-step curves would read as a wobble, not a breath.
    const breath = (Math.sin(this.shieldPhase * SHIELD_PULSE_RATE) + 1) / 2; // 0..1
    const r = SHIELD_ORB_R - SHIELD_ORB_PULSE * (1 - breath);
    const alpha = SHIELD_ORB_ALPHA * (0.5 + 0.5 * breath);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    neonStroke(ctx, (c) => {
      c.moveTo(x + r, this.y);
      c.arc(x, this.y, r, 0, Math.PI * 2);
    }, color, SHIELD_ORB_WIDTH, alpha);
    ctx.restore();
  }
}
