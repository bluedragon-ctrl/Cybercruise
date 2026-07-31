// The player car: steer left/right, adjust speed, take damage from barriers and
// from ramming. Drawn as a neon wireframe. From Phase 1 on it is constrained to
// the road, whose left/right edges are passed in each frame as `bounds`
// (screen x).

import { drawCarCached } from "./sprites.js";
import { steerAxis, throttleAxis } from "../engine/input.js";
import { PLAYER, PLAYER_THRUST, HAZARD } from "../engine/palette.js";

const MIN_SPEED = 120; // world units/sec (also the road scroll speed)
const MAX_SPEED = 620;
const ACCEL = 380; // speed change per second at full throttle
const STEER_SPEED = 260; // horizontal px/sec at full lock

const MAX_HEALTH = 100;
const WALL_DAMAGE = 6; // health lost per wall-scrape tick
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

export class Player {
  constructor(x, y) {
    this.x = x;
    this.y = y;
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

    this.vLateral = 0; // sideways velocity from ramming (see collisions.js)
    this.flash = 0; // counts down after a hit; flashes the car red
  }

  // Take `hp` off the hull. Health floors at 0 — the wreck/game-over state is
  // Phase 6, so for now an empty hull just means the next hit is free.
  damage(hp) {
    if (hp <= 0) return;
    this.health = Math.max(0, this.health - hp);
    this.flash = HIT_FLASH;
  }

  // `bounds` = { left, right } road edges in screen x for the player's row.
  update(dt, bounds) {
    this.prevX = this.x;

    // Steering, plus whatever is left of the last shove.
    this.x += steerAxis() * STEER_SPEED * dt;
    this.x += this.vLateral * dt;
    this.vLateral -= this.vLateral * Math.min(1, SHOVE_DAMP * dt);

    // Speed control.
    this.speed += throttleAxis() * ACCEL * dt;
    if (this.speed < MIN_SPEED) this.speed = MIN_SPEED;
    if (this.speed > MAX_SPEED) this.speed = MAX_SPEED;

    // Constrain to the road; scraping a barrier costs health and scrubs speed.
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
      if (this.wallTimer <= 0) {
        this.damage(WALL_DAMAGE);
        this.wallTimer = WALL_DAMAGE_INTERVAL;
      }
    }

    if (this.flash > 0) this.flash -= dt;
  }

  render(ctx, alpha) {
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
    });
  }
}
