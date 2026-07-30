// The player car: steer left/right, adjust speed, take damage from barriers.
// Drawn as a neon wireframe. From Phase 1 on it is constrained to the road,
// whose left/right edges are passed in each frame as `bounds` (screen x).

import { glowPoly, glowLine } from "../engine/neon.js";
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

export class Player {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.prevX = x; // previous-frame x, for render interpolation
    this.w = 30;
    this.h = 54;
    this.speed = 260; // current forward/scroll speed
    this.color = PLAYER; // cyan accent — stands out against the green world

    this.health = MAX_HEALTH;
    this.hitWall = false; // true on frames the car is pressed against a barrier
    this.wallTimer = 0; // counts down between scrape-damage ticks
  }

  // `bounds` = { left, right } road edges in screen x for the player's row.
  update(dt, bounds) {
    this.prevX = this.x;

    // Steering.
    this.x += steerAxis() * STEER_SPEED * dt;

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

    this.wallTimer -= dt;
    if (this.hitWall) {
      this.speed *= WALL_SPEED_SCRUB;
      if (this.wallTimer <= 0) {
        this.health = Math.max(0, this.health - WALL_DAMAGE);
        this.wallTimer = WALL_DAMAGE_INTERVAL;
      }
    }
  }

  render(ctx, alpha) {
    const x = this.prevX + (this.x - this.prevX) * alpha;
    const y = this.y;
    const hw = this.w / 2;
    const hh = this.h / 2;

    // Flash red on the frames we're grinding a barrier, else the usual cyan.
    const color = this.hitWall ? HAZARD : this.color;

    // Body outline (arrow-ish car pointing up).
    const body = [
      [x, y - hh],            // nose
      [x + hw, y - hh + 14],
      [x + hw, y + hh],       // rear right
      [x - hw, y + hh],       // rear left
      [x - hw, y - hh + 14],
    ];
    glowPoly(ctx, body, color, 2, 14, "rgba(20,60,80,0.35)");

    // Cockpit line + twin thruster glow at the rear.
    glowLine(ctx, x - hw + 6, y, x + hw - 6, y, color, 1.5, 8);
    glowLine(ctx, x - 8, y + hh, x - 8, y + hh + 8, PLAYER_THRUST, 3, 12);
    glowLine(ctx, x + 8, y + hh, x + 8, y + hh + 8, PLAYER_THRUST, 3, 12);
  }
}
