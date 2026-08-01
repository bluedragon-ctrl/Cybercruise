// Bullets — everything that is in the air between a gun and a car.
//
// COORDINATE MODEL, same as traffic's: a bullet lives at (worldY, offset), and
// screen position is derived from those exactly as a car's is, which is what
// keeps a shot welded to the tarmac it was fired over. Cars are compared against
// with plain arithmetic because everything is in the same two numbers.
//
// TWO WAYS TO FLY, and the difference is entirely in what is held CONSTANT as
// the bullet runs up the road (see weapons.js for which weapon takes which):
//
//   FLIGHT_TRACKING  `offset` is constant. The bullet keeps its distance from
//                    the centre-line, so it follows the road round a bend and
//                    stays in the lane it was fired up. It cannot leave the
//                    road, so it never meets a barrier.
//   FLIGHT_STRAIGHT  `screenX` is constant, and `offset` is RECOMPUTED from it
//                    every tick as screenX - centerXAt(worldY). The bullet holds
//                    the line it was fired along and the road slides out from
//                    under it — which means that into a bend it crosses the
//                    lanes and eventually hits the barrier, where it dies.
//
// Deriving offset for the straight case rather than tracking a screen position
// separately is what keeps ONE hit test and ONE render path for both: by the
// time anything reads `offset`, it is correct for this tick either way.
//
// SPEED IS ABSOLUTE. A bullet stores the speed it actually travels at — the
// shooter's speed plus the weapon's muzzle speed — rather than a speed relative
// to anything. Two consequences that both matter: a shot fired at 600 units/sec
// keeps its 600 when the player brakes, so slowing down doesn't drag your own
// bullets back; and an enemy shooting forward in the next step needs no new
// maths, only a different `speed` at spawn.
//
// SWEPT HITS. A bullet covers ~15 world units per tick and the shortest car is
// 54 long, so a naive point-in-box test would already be marginal, and any
// faster weapon (Phase 5) would shoot straight through a cycle. Every bullet is
// therefore tested along the SEGMENT it travelled this tick, and when that
// segment crosses several cars the NEAREST one is what stops it. Nothing here
// depends on the tick rate.
//
// ONE BULLET, ONE CAR. A hit is consumed: the bullet dies where it struck. Shots
// that punch through (a railgun) would be a weapon-type flag, not a change here.
//
// WHO CAN BE HIT is the CALLER'S choice — update() takes the list of targets.
// This file has no idea what a faction is, which is what lets enemy bullets
// (next step) reuse it by passing the player's body instead of the traffic.
//
// NO ALLOCATION. Bullets are spawned mid-frame, several per second, forever, so
// the pool is built once and reused; a spawn on a full pool overwrites the
// oldest, which is off-screen or nearly so by definition.

import { neonStroke } from "../engine/neon.js";
import { centerXAt, ROAD_HALF_WIDTH } from "./road.js";
import { FLIGHT_TRACKING } from "./weapons.js";

const MAX_SHOTS = 32;  // in flight at once. The cannon fires ~6/sec and a shot
                       // lives well under a second, so this is roomy
const MAX_SPARKS = 12; // impact flashes alive at once

const SPARK_DURATION = 0.12; // seconds
const SPARK_SIZE = 9;        // px the impact flash reaches at its widest

export class Projectiles {
  constructor() {
    this.shots = Array.from({ length: MAX_SHOTS }, () => ({
      alive: false,
      worldY: 0,
      prevWorldY: 0, // where it was last tick — the near end of the swept test
      offset: 0,     // lateral px from the centre-line. AUTHORITATIVE for hits
                     // and drawing; derived per tick when the flight is straight
      tracking: false, // FLIGHT_TRACKING — hold `offset` instead of `screenX`
      screenX: 0,    // the fired line, for a straight shot. Unused when tracking
      speed: 0,      // absolute, world units/sec
      damage: 0,
      length: 14,
      width: 4,
      color: "#ffffff",
      glow: "#ffffff",
    }));
    this.sparks = Array.from({ length: MAX_SPARKS }, () => ({
      alive: false,
      elapsed: 0,
      worldY: 0,
      offset: 0,
      color: "#ffffff",
    }));
    this.next = 0;      // round-robin cursor for a full pool
    this.nextSpark = 0;
    this.batchColors = []; // scratch for render's per-colour batching, reused
  }

  // Fire one round. `type` is a WEAPON_TYPES entry (weapons.js); `worldY` and
  // `offset` are the muzzle, `shooterSpeed` is what the bullet inherits, and `W`
  // is the canvas width the centre-line is measured against.
  //
  // Both flight modes are spawned from the same (worldY, offset) muzzle — the
  // straight shot simply converts it, ONCE, into the screen line it will hold.
  spawn(worldY, offset, shooterSpeed, type, W) {
    let s = this.shots.find((b) => !b.alive);
    if (!s) {
      s = this.shots[this.next];
      this.next = (this.next + 1) % this.shots.length;
    }
    s.alive = true;
    s.worldY = worldY;
    s.prevWorldY = worldY;
    s.offset = offset;
    s.tracking = type.flight === FLIGHT_TRACKING;
    s.screenX = centerXAt(worldY, W) + offset;
    s.speed = shooterSpeed + type.muzzleSpeed;
    s.damage = type.damage;
    s.length = type.length;
    s.width = type.width;
    s.color = type.color;
    s.glow = type.glow;
    return s;
  }

  // Move every bullet, then resolve what it hit.
  //
  // `targets` is any array of bodies exposing { worldY, offset, w, h, alive,
  // damage(hp) } — traffic cars satisfy it directly, and so does the player's
  // collision body, which is what enemy fire will pass. `world` supplies the
  // bounds a bullet is retired at.
  update(dt, targets, { distance, playerY, W, H }) {
    const ahead = distance + playerY + H;       // a long way past the top edge
    const behind = distance - (H - playerY) - H;

    for (const s of this.shots) {
      if (!s.alive) continue;
      s.prevWorldY = s.worldY;
      s.worldY += s.speed * dt;

      // A straight shot holds its screen line, so its offset has to be re-derived
      // against the road that has just curved under it. Done BEFORE the hit test,
      // so what the bullet is tested against is where it actually is now.
      if (!s.tracking) {
        s.offset = s.screenX - centerXAt(s.worldY, W);
        // ...and a line that has run off the tarmac has run into the barrier.
        // This is the whole cost of a straight weapon through a bend, and it is
        // why the tracker is worth carrying.
        if (Math.abs(s.offset) > ROAD_HALF_WIDTH - s.width / 2) {
          this.spark(s.worldY, Math.sign(s.offset) * (ROAD_HALF_WIDTH - s.width / 2), s.glow);
          s.alive = false;
          continue;
        }
      }

      const hit = this.firstHit(s, targets);
      if (hit) {
        hit.damage(s.damage);
        // The flash goes where the BULLET stopped, not at the car's centre, so
        // a long rig shows hits along its flank rather than one spot amidships.
        this.spark(s.worldY, s.offset, s.glow);
        s.alive = false;
        continue;
      }

      if (s.worldY > ahead || s.worldY < behind) s.alive = false;
    }

    for (const p of this.sparks) {
      if (!p.alive) continue;
      p.elapsed += dt;
      if (p.elapsed >= SPARK_DURATION) p.alive = false;
    }
  }

  // The nearest target the bullet's path crossed this tick, or null. "Nearest"
  // is measured from where the bullet CAME FROM, so a shot that would reach two
  // cars in one tick stops at the first one.
  firstHit(s, targets) {
    let best = null;
    let bestEntry = Infinity;
    const from = Math.min(s.prevWorldY, s.worldY);
    const to = Math.max(s.prevWorldY, s.worldY);

    for (const t of targets) {
      if (!t.alive) continue;
      if (Math.abs(t.offset - s.offset) >= (t.w + s.width) / 2) continue;
      // The car's box, inflated by the bullet's own length so a shot that has
      // only just touched it counts.
      const near = t.worldY - (t.h + s.length) / 2;
      const far = t.worldY + (t.h + s.length) / 2;
      if (far < from || near > to) continue;
      if (near < bestEntry) {
        bestEntry = near;
        best = t;
      }
    }
    return best;
  }

  spark(worldY, offset, color) {
    let p = this.sparks.find((q) => !q.alive);
    if (!p) {
      p = this.sparks[this.nextSpark];
      this.nextSpark = (this.nextSpark + 1) % this.sparks.length;
    }
    p.alive = true;
    p.elapsed = 0;
    p.worldY = worldY;
    p.offset = offset;
    p.color = color;
  }

  // No interpolation, for the same reason traffic's y isn't interpolated: screen
  // y comes from the raw worldY against the raw distance, so a bullet tracks the
  // road rather than sliding against it.
  render(ctx, distance, playerY, W, H) {
    // Every bullet is one straight line, so a volley goes into ONE batched path
    // and pays for neonStroke's three passes once (see neon.js). A path can only
    // carry one colour, so the batch is PER WEAPON COLOUR — swapping weapons
    // leaves rounds of both kinds in the air, and that is two strokes, not one
    // stroke per bullet.
    const colors = this.batchColors;
    colors.length = 0;
    for (const s of this.shots) {
      if (s.alive && !colors.includes(s.color)) colors.push(s.color);
    }

    for (const color of colors) {
      const sample = this.shots.find((s) => s.alive && s.color === color);
      neonStroke(
        ctx,
        (c) => {
          for (const s of this.shots) {
            if (!s.alive || s.color !== color) continue;
            const sy = playerY - (s.worldY - distance);
            if (sy < -s.length || sy > H + s.length) continue;
            const sx = centerXAt(s.worldY, W) + s.offset;
            c.moveTo(sx, sy + s.length / 2);
            c.lineTo(sx, sy - s.length / 2);
          }
        },
        color,
        sample.width,
        3.5,
        0.16,
        1,
      );
    }

    // Impacts: a small cross that opens and fades. Each is its own stroke, since
    // they differ in alpha — but there are at most MAX_SPARKS of them and they
    // last an eighth of a second.
    for (const p of this.sparks) {
      if (!p.alive) continue;
      const t = p.elapsed / SPARK_DURATION;
      const sy = playerY - (p.worldY - distance);
      if (sy < -SPARK_SIZE || sy > H + SPARK_SIZE) continue;
      const sx = centerXAt(p.worldY, W) + p.offset;
      const r = SPARK_SIZE * (0.4 + t * 0.6);
      neonStroke(
        ctx,
        (c) => {
          c.moveTo(sx - r, sy);
          c.lineTo(sx + r, sy);
          c.moveTo(sx, sy - r);
          c.lineTo(sx, sy + r);
          c.moveTo(sx - r * 0.6, sy - r * 0.6);
          c.lineTo(sx + r * 0.6, sy + r * 0.6);
          c.moveTo(sx + r * 0.6, sy - r * 0.6);
          c.lineTo(sx - r * 0.6, sy + r * 0.6);
        },
        p.color,
        2,
        4,
        0.15,
        1 - t,
      );
    }
  }
}
