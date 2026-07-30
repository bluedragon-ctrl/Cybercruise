// The player car. Phase 0: steer left/right, adjust speed, drawn as a
// neon wireframe. Constrained to the canvas for now (road comes in Phase 1).

import { glowPoly, glowLine } from "../engine/neon.js";
import { steerAxis, throttleAxis } from "../engine/input.js";

const MIN_SPEED = 120; // world units/sec (scroll speed)
const MAX_SPEED = 620;
const ACCEL = 380;
const STEER_SPEED = 260; // horizontal px/sec at full lock

export class Player {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.w = 30;
    this.h = 54;
    this.speed = 260; // current forward/scroll speed
    this.color = "#39f6ff";
  }

  update(dt, bounds) {
    this.prevX = this.x;

    // Steering.
    this.x += steerAxis() * STEER_SPEED * dt;

    // Speed control.
    this.speed += throttleAxis() * ACCEL * dt;
    if (this.speed < MIN_SPEED) this.speed = MIN_SPEED;
    if (this.speed > MAX_SPEED) this.speed = MAX_SPEED;

    // Keep on screen (temporary until road barriers exist).
    const half = this.w / 2;
    if (this.x < bounds.left + half) this.x = bounds.left + half;
    if (this.x > bounds.right - half) this.x = bounds.right - half;
  }

  render(ctx, alpha) {
    const x = this.prevX + (this.x - this.prevX) * alpha;
    const y = this.y;
    const hw = this.w / 2;
    const hh = this.h / 2;

    // Body outline (arrow-ish car pointing up).
    const body = [
      [x, y - hh],            // nose
      [x + hw, y - hh + 14],
      [x + hw, y + hh],       // rear right
      [x - hw, y + hh],       // rear left
      [x - hw, y - hh + 14],
    ];
    glowPoly(ctx, body, this.color, 2, 14, "rgba(20,60,80,0.35)");

    // Cockpit line + twin thruster glow at the rear.
    glowLine(ctx, x - hw + 6, y, x + hw - 6, y, this.color, 1.5, 8);
    glowLine(ctx, x - 8, y + hh, x - 8, y + hh + 8, "#ff36c8", 3, 12);
    glowLine(ctx, x + 8, y + hh, x + 8, y + hh + 8, "#ff36c8", 3, 12);
  }
}
