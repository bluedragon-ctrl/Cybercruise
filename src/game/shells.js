// Artillery — the boss's shells, and the ground they are about to land on.
//
// WHY THIS IS NOT A WEAPON IN projectiles.js. Everything in that file is a
// BULLET: it leaves a muzzle, it flies up or down the road at a speed, and it
// hits the first thing its swept segment crosses. A shell does none of that. It
// is fired at a PLACE rather than at a body, it is not in the world while it is
// in the air, and what it hits is decided when it arrives, not while it travels.
// Bolting that onto Projectiles would mean a bullet that skips the hit test, has
// no speed and draws nothing where it is — three exceptions to the three things
// that file is about.
//
// So the model here is the opposite one, and it is much smaller: a shell IS its
// impact. One record holds where it will land and how long until it does. There
// is no position in flight because the round is deliberately never on screen —
// see carshapes.js's SIEGE MORTAR, whose whole pitch is that the shells arrive
// from off-screen.
//
// THE FUSE IS THE MECHANIC. A mine punishes where you drive; a shell punishes
// where you KEEP driving. The reticle is on the tarmac for `fuse` seconds before
// anything happens, welded to (worldY, offset) exactly as a car or a bullet is,
// so it slides down the screen with the road. A player holding their speed and
// their lane drives into it; changing either is the dodge. That is the entire
// fight, and it is why the marker is generous and loud rather than subtle: this
// is not an ambush, it is a demand that you move.
//
// AIMED AT WHERE YOU WILL BE. The battery leads its target (game/armament.js
// picks the impact point, not this file — the same split every other weapon
// gets, where the tactic decides whether to fire and the pool only carries the
// round). This file's job starts once somebody has said "here, in this many
// seconds".
//
// WHAT IT HITS: everything, and that is on purpose. The blast reads the target
// list it is handed, exactly as Projectiles.detonate does, so a shell that lands
// on the boss's own escort kills the escort. Indirect fire is not careful, the
// player can bait it, and a battery that could never hurt its own side would be
// the game quietly explaining that the shells are only ever about the player.
//
// NO ALLOCATION, same as the bullet pool: built once, reused, and a spawn on a
// full pool overwrites the oldest — which is the one closest to landing, so the
// worst case is a shell that detonates a hair early rather than a missing frame.

import { neonStroke } from "../engine/neon.js";
import { centerXAt } from "./road.js";
import { ENEMY } from "../engine/palette.js";

// In the air at once. The heaviest barrage the boss can throw is a straddle of
// three (game/armament.js), and at the fastest phase interval a second salvo is
// launched before the first lands — so six is already double the real ceiling
// and leaves room for a second battery later without a thought.
const MAX_SHELLS = 6;

// THE MARK IS TWO RINGS, and splitting it in two is the whole of what makes it
// readable. One of them answers WHERE and the other answers WHEN, and a single
// ring trying to do both says neither clearly:
//
//   THE FOOTPRINT  a ring at the blast's own radius. It never moves and never
//                  changes size, so it is the thing the player steers out of.
//                  This is the honest statement of which tarmac is about to be
//                  dangerous.
//   THE TIMER      a second ring that starts well outside it and CLOSES onto
//                  it. Its distance from the footprint is the fuse, read at a
//                  glance and without a number.
//
// The first version of this had one ring closing from 74px to the blast's 72,
// which is to say it did not visibly move at all: the countdown was there in
// the arithmetic and invisible on the screen, and the mark read as a static
// circle that appeared and then, a beat later, exploded.
//
// THE START RADIUS IS A MULTIPLE OF THE BLAST, not a constant, so the timer
// always has a visible distance to travel however the blast is retuned. 1.9 is
// about as wide as the road allows before the ring starts colliding with the
// barriers and reading as scenery.
const MARK_START_SCALE = 1.9;

// THE MARK IS DRAWN IN THE ENEMY'S OWN RED, not in the damage-flash red.
//
// Both are red and the difference is small on paper (#ff3b3b against #ff4d4d),
// but they mean different things and the palette says so: HAZARD is the
// INSTRUMENT red — a damage flash, an empty magazine, the hull bar running
// out — while ENEMY is the faction, the family every hostile car on the road is
// painted from. This mark is not a readout about the player's condition. It is
// a thing the enemy is doing to a piece of road, and it should read as coming
// from the crimson vehicle at the top of the screen.
//
// It is also simply redder. The instrument red sits pinker and, under three
// glow passes on a near-black road, drifts warm enough to be mistaken for the
// amber the CIVILIAN family owns — which is the one thing a danger mark must
// never look like.
//
// The hull meter under the boss (effects.js) deliberately stays on the
// instrument red: that one IS a readout, and it belongs with the player's own
// hull bar rather than with the enemy's paintwork.
const MARK_COLOR = ENEMY;

// The crosshair inside the rings. It does NOT shrink: the timer is the clock,
// the cross is the place, and animating everything at once would leave the
// player nothing steady to aim their dodge against.
const MARK_ARM = 13;

// How far off screen a mark is still worth drawing, in px — generous, since the
// timer ring at full size reaches a long way past the impact point.
const MARK_CULL = 200;

// How fast the ring blinks in its last second — the same device the target
// reticle uses for a designation running out (effects.js's drawTargetMark), so
// "this is about to expire" reads the same way twice in the same game.
const MARK_URGENT = 1;   // seconds left when the blink starts
const MARK_BLINK = 22;   // rad/sec

export class Shells {
  // `explosions` is the shared Explosions pool (effects.js), optional exactly as
  // Projectiles takes it: the suite drives this class with no canvas and no
  // effects and only cares where the damage went.
  constructor(explosions = null) {
    this.explosions = explosions;
    this.list = Array.from({ length: MAX_SHELLS }, () => ({
      alive: false,
      worldY: 0,     // where it lands, on the tarmac, for the whole fuse
      offset: 0,     // lateral px from the centre-line — road-relative, so the
                     // mark follows the road round a bend like everything else
      fuse: 0,       // seconds until impact
      fuseTotal: 0,  // what the fuse started at, for the ring's progress
      radius: 0,     // blast reach in px from the impact point
      damage: 0,     // hull at the centre, falling off linearly to nothing
      screenX: 0,    // where the mark was drawn this frame — derived in render,
      screenY: 0,    // never simulated, and meaningless outside it
    }));
    this.next = 0;   // round-robin cursor for a full pool
    // Scratch for render's visible set, reused rather than rebuilt: the marks
    // are re-gathered every frame, forever, and this pool is six entries long.
    this.visible = [];
  }

  // Everything is dropped: a new run starts with no shells in the air, and
  // nothing here outlives the encounter that fired them.
  reset() {
    for (const s of this.list) s.alive = false;
    this.next = 0;
  }

  // Called by armament.js through the world hook (see main.js). `worldY` and
  // `offset` are the IMPACT POINT, already led — this file does no aiming.
  fire(worldY, offset, fuse, radius, damage) {
    let s = this.list.find((x) => !x.alive);
    if (!s) {
      s = this.list[this.next];
      this.next = (this.next + 1) % this.list.length;
    }
    s.alive = true;
    s.worldY = worldY;
    s.offset = offset;
    s.fuse = fuse;
    s.fuseTotal = fuse;
    s.radius = radius;
    s.damage = damage;
    return s;
  }

  // Whether anything is still in the air. The encounter reads this so a boss
  // that dies with shells already fired still lands them — killing the battery
  // does not recall what it has already thrown, which is both fair and the more
  // interesting last second of the fight.
  get live() {
    return this.list.some((s) => s.alive);
  }

  // Run the fuses and detonate whatever reached zero.
  //
  // `targets` is any array of bodies exposing { worldY, offset, w, h, alive,
  // damage(hp) } — the same duck type Projectiles.update takes, so the caller
  // hands over the same list it already built for the bullets.
  update(dt, targets) {
    for (const s of this.list) {
      if (!s.alive) continue;
      s.fuse -= dt;
      if (s.fuse > 0) continue;
      s.alive = false;
      this.detonate(s, targets);
    }
  }

  // The blast, with the same geometry Projectiles.detonate uses: distance is
  // measured from the target's BOX EDGE rather than its centre, so a long car
  // is not given a free extra radius along its own length, and damage falls off
  // linearly to nothing at the rim.
  detonate(s, targets) {
    this.explosions?.spawnFireball(s.worldY, s.offset);
    for (const t of targets) {
      if (!t.alive) continue;
      const dx = Math.max(0, Math.abs(t.offset - s.offset) - t.w / 2);
      const dy = Math.max(0, Math.abs(t.worldY - s.worldY) - t.h / 2);
      const dist = Math.hypot(dx, dy);
      if (dist >= s.radius) continue;
      t.damage(s.damage * (1 - dist / s.radius));
    }
  }

  // The marks on the road. Drawn UNDER the traffic and the player (see main.js's
  // draw order) because this is paint on the tarmac rather than an object above
  // it — a car driving over its own impact point covers the mark, which is
  // exactly the moment the player most needs to feel it.
  //
  // BATCHED, AND THE BATCHES ARE THE READ. Every mark is the same colour, so a
  // pass goes into one path and pays for neonStroke's three glow passes once
  // however many marks are down (projectiles.js's render() follows the same
  // rule, and it matters most here because these are the largest strokes
  // anything in the game draws). The passes are split by what they SAY, not by
  // shell:
  //
  //   1  every footprint, dim — the ground that is about to be dangerous
  //   2  the timer rings and crosshairs of the calm shells, full brightness
  //   3  the same for the shells about to land, blinking
  //
  // Three strokes, worst case, for the whole barrage.
  //
  // THE VISIBLE SET IS GATHERED FIRST, into a scratch array reused every frame,
  // and this is not merely tidiness. neonStroke takes its ALPHA as an argument
  // and returns immediately when that alpha is zero — so an alpha computed from
  // a flag the build callback sets is always the flag's INITIAL value, because
  // arguments are evaluated before the callback ever runs. Written that way the
  // whole barrage silently drew nothing at all. Deciding what is on screen
  // before choosing how to draw it is what makes that class of mistake
  // impossible rather than merely fixed.
  render(ctx, distance, playerY, W, H) {
    const shown = this.visible;
    shown.length = 0;
    for (const s of this.list) {
      if (!s.alive) continue;
      const sy = playerY - (s.worldY - distance);
      if (sy < -MARK_CULL || sy > H + MARK_CULL) continue;
      s.screenX = centerXAt(s.worldY, W) + s.offset;
      s.screenY = sy;
      shown.push(s);
    }
    if (!shown.length) return;

    // 1. The footprints. Held well under the timer so the two never compete:
    // this one is a statement about PLACE and wants to sit quietly on the road
    // until the ring closes onto it.
    neonStroke(ctx, (c) => {
      for (const s of shown) {
        c.moveTo(s.screenX + s.radius, s.screenY);
        c.arc(s.screenX, s.screenY, s.radius, 0, Math.PI * 2);
      }
    }, MARK_COLOR, 1.5, 4, 0.13, 0.5);

    // 2 and 3. The timers, split so the ones about to land can carry their own
    // alpha — a batch has only one. The blink is taken from whichever URGENT
    // shell is nearest to landing, so a salvo pulses together rather than one
    // mark fighting another for the same value.
    for (const urgent of [false, true]) {
      let soonest = Infinity;
      for (const s of shown) {
        if ((s.fuse <= MARK_URGENT) === urgent) soonest = Math.min(soonest, s.fuse);
      }
      if (soonest === Infinity) continue;

      const alpha = urgent
        ? 0.5 + 0.5 * (Math.sin(soonest * MARK_BLINK) + 1) / 2
        : 0.95;

      neonStroke(ctx, (c) => {
        for (const s of shown) {
          if ((s.fuse <= MARK_URGENT) !== urgent) continue;
          // Closes from MARK_START_SCALE x the blast down ONTO the footprint,
          // so the two rings meet at the instant of impact.
          const t = 1 - Math.max(0, s.fuse) / s.fuseTotal;
          const r = s.radius * (MARK_START_SCALE + (1 - MARK_START_SCALE) * t);
          c.moveTo(s.screenX + r, s.screenY);
          c.arc(s.screenX, s.screenY, r, 0, Math.PI * 2);

          c.moveTo(s.screenX - MARK_ARM, s.screenY);
          c.lineTo(s.screenX + MARK_ARM, s.screenY);
          c.moveTo(s.screenX, s.screenY - MARK_ARM);
          c.lineTo(s.screenX, s.screenY + MARK_ARM);
        }
      }, MARK_COLOR, 2, 5, 0.13, alpha);
    }
  }
}
