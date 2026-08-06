// Player death — "DISCONNECT". The car is never a physical object that blows
// up; it's a signal the player is jacked into (see engine/neon.js's whole
// wireframe aesthetic). So dying doesn't look like effects.js's drawWreck —
// no shrapnel, nothing tumbles — it looks like the FEED failing, and it fails
// in STAGES rather than all at once: the car's own outline breaks up first
// (LOCAL — your own signal died), then a beat later the rest of the world
// follows it down (GLOBAL — full-width scanline tears and the whole scene
// dimming toward black), before the game reports CONNECTION LOST. That local-
// then-global order is what sells this as a CONNECTION collapsing rather than
// a vehicle being destroyed. Reuses effects.js's rng() for the same
// stable-per-seed jitter it uses, and carshapes.js's carShapeOutline(0, ...) —
// shape 0 is what drawCarCached already renders the player as (see
// sprites.js's drawCarCached: an omitted `shape` keeps the player's look) —
// so the local glitch is built from the exact silhouette that was on screen.
//
// PACING. The sequence deliberately holds still for a beat right after the
// hit (see HOLD_END) before anything glitches — a death that starts breaking
// up instantly doesn't give the player time to register that they died before
// they're staring at a game-over screen. DISCONNECT_DURATION is 2.6s for the
// same reason: long enough to read as a moment, not a flicker.
//
// ONE INSTANCE, not a pool: only one player can ever be dying at a time, so
// this is a single stateful object main.js owns directly (trigger/update/
// render, reset() between games), the same shape as player.js itself rather
// than effects.js's Explosions pool.
//
// A PURE FUNCTION OF PROGRESS, same discipline as effects.js: render() and
// shake() both recompute their jitter from `elapsed` and the seed captured at
// trigger() rather than storing particle state, so nothing here allocates
// per frame.

import { neonStroke, glowLine, glowText } from "../engine/neon.js";
import { carShapeOutline } from "./carshapes.js";
import { rng } from "./effects.js";
import { PLAYER, PLAYER_THRUST, GREEN_PALE } from "../engine/palette.js";

// Seconds from the killing hit to the game-over screen taking over.
export const DISCONNECT_DURATION = 2.6;

// Fractions of DISCONNECT_DURATION (not seconds) each beat runs for, kept as
// fractions so retuning the total duration reshapes every beat with it. Read
// top to bottom, this IS the sequence's timeline:
//   flash -> held silence -> car breaks up locally -> world follows globally
//   -> readout resolves and holds -> game-over takes over.
const FLASH_END = 0.05;      // white hit-core
const HOLD_END = 0.17;       // frozen beat: nothing else glitches or moves
                              // yet, so the hit has a moment to register
const CAR_GLITCH_END = 0.55; // the car's own LOCAL chromatic-split breakup,
                              // starting right at HOLD_END
const WORLD_START = 0.30;    // the rest of the feed starts following — a beat
                              // after the car itself does, cause then effect
const SCAN_END = 0.85;       // full-screen scanline sweeps run out here
const SHAKE_END = 0.75;      // world desync settles before the final hold
const TEXT_START = 0.55;     // CONNECTION LOST starts fading in (the same
                              // moment the car's own breakup finishes)
const TEXT_FULL = 0.75;      // ...fully in, held to the end

// Peak darkness of the world-collapse overlay (see render()'s GLOBAL block).
// Short of full black, so CONNECTION LOST still reads against something
// rather than a void.
const DESAT_MAX = 0.85;

export class Disconnect {
  constructor() {
    this.active = false;
    this.elapsed = 0;
    this.x = 0;
    this.y = 0;
    this.w = 34;
    this.h = 60;
    this.seed = 1;
  }

  // Freeze-frame the car where it died. `x, y, w, h` are the player's own
  // fields at the moment its hull hit zero — main.js stops calling
  // player.update() once this fires, so they stay put on their own; this just
  // takes a copy rather than depending on that.
  trigger(x, y, w, h) {
    this.active = true;
    this.elapsed = 0;
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.seed = (Math.random() * 0x7fffffff) | 0;
  }

  // Between games, so a restarted run doesn't inherit a finished sequence's
  // `active` flag (harmless, since progress >= 1 already, but this is what
  // keeps a stale disconnect from ever being drawn for a frame on restart).
  reset() {
    this.active = false;
    this.elapsed = 0;
  }

  update(dt) {
    if (this.active) this.elapsed += dt;
  }

  get progress() {
    return Math.min(1, this.elapsed / DISCONNECT_DURATION);
  }

  get done() {
    return this.progress >= 1;
  }

  // A screen-space [dx, dy] for the caller to translate the WHOLE scene by
  // (road, traffic, buildings, the glitching car — everything but the fixed
  // HUD and this module's own renderOverlay). Deliberately re-rolled from a
  // seed keyed to elapsed time rather than eased toward zero, so it reads as
  // the feed losing sync rather than a physical jolt settling — see the
  // header for why this isn't a camera SHAKE. Silent through HOLD_END (the
  // freeze beat) and dead by SHAKE_END so the last stretch holds steady on
  // the readout.
  shake() {
    if (!this.active) return [0, 0];
    const t = this.progress;
    if (t < HOLD_END || t >= SHAKE_END) return [0, 0];
    const k = 1 - (t - HOLD_END) / (SHAKE_END - HOLD_END);
    const rand = rng((this.seed + Math.floor(this.elapsed * 45)) >>> 0);
    return [(rand() - 0.5) * 14 * k, (rand() - 0.5) * 4 * k];
  }

  // The full sequence: the hit flash, then the car's own local breakup, then —
  // a beat later — the rest of the feed following it down. Draw this INSTEAD
  // of player.render() while active, inside the same translated/shaken block
  // the rest of the frozen world draws in, so everything glitches in the same
  // space it died in. `W, H` are the canvas size: the world-wide beats (the
  // sweep, the collapse overlay) span the whole screen, not just the car's
  // footprint, which is the whole point of them.
  render(ctx, W, H) {
    if (!this.active) return;
    const t = this.progress;
    const { x: cx, y: cy, w, h, seed } = this;
    // Reseeded per frame off elapsed (not just the trigger seed) so the jitter
    // itself animates rather than freezing into one fixed distortion.
    const rand = rng((seed + Math.floor(this.elapsed * 60)) >>> 0);

    ctx.save();

    // The hit flash: a brief white core, so the instant still reads as an
    // impact. First chronologically (done well before anything else below
    // starts), so no ordering conflict with what follows.
    if (t < FLASH_END) {
      const k = 1 - t / FLASH_END;
      const r = h * 0.4 * k;
      neonStroke(ctx, (c) => {
        c.moveTo(cx + r, cy);
        c.arc(cx, cy, r, 0, Math.PI * 2);
      }, "#ffffff", 3, 5, 0.18, k);
    }

    // LOCAL: the car's own chromatic split. The SAME wireframe outline,
    // redrawn three times a few px apart in cyan / white / magenta — the
    // signal is still recognisably the player's own car, it just no longer
    // agrees with itself about where it is. Fragments ease apart along their
    // own radius (`drift`) rather than being hurled outward the way
    // drawWreck's shell is; this is desync, not an explosion. Starts right at
    // HOLD_END, once the frozen beat is over.
    if (t > HOLD_END && t < CAR_GLITCH_END) {
      const u = (t - HOLD_END) / (CAR_GLITCH_END - HOLD_END);
      const k = 1 - u;
      const jitter = 6 * k;
      const drift = 10 * u;
      for (const [color, spread] of [[PLAYER, -1], ["#ffffff", 0], [PLAYER_THRUST, 1]]) {
        neonStroke(ctx, (c) => {
          for (const loop of carShapeOutline(0, w, h)) {
            for (let i = 0; i < loop.length; i++) {
              const [x1, y1] = loop[i];
              const [x2, y2] = loop[(i + 1) % loop.length];
              const mx = (x1 + x2) / 2;
              const my = (y1 + y2) / 2;
              const d = Math.hypot(mx, my) || 1;
              const ox = (mx / d) * drift + spread * 3 + (rand() - 0.5) * jitter;
              const oy = (my / d) * drift + (rand() - 0.5) * jitter;
              c.moveTo(cx + x1 + ox, cy + y1 + oy);
              c.lineTo(cx + x2 + ox, cy + y2 + oy);
            }
          }
        }, color, 2, 4, 0.13, spread === 0 ? k : k * 0.7);
      }
    }

    // GLOBAL: the rest of the feed following the car down. A beat after the
    // car itself starts breaking up (WORLD_START), full-WIDTH scanline tears
    // sweep the whole canvas — not just where the car was — so the loss
    // reads as the CONNECTION failing, not the vehicle. Blinking on a hard
    // square wave rather than fading, because a dropped feed cuts, it
    // doesn't dim.
    if (t > WORLD_START && t < SCAN_END && Math.sin(this.elapsed * 22) > 0.1) {
      const bandAlpha = 1 - (t - WORLD_START) / (SCAN_END - WORLD_START);
      ctx.save();
      ctx.globalAlpha = bandAlpha;
      for (let i = 0; i < 2; i++) {
        const yy = rand() * H;
        glowLine(ctx, 0, yy, W, yy, "#ffffff", 1.5, 7);
      }
      ctx.restore();
    }

    // GLOBAL: the whole scene dims toward black as the feed goes. Drawn LAST,
    // so it darkens everything above it this frame together — the world
    // behind, the car's own local breakup, the sweep — which is what makes
    // this read as the WORLD disconnecting rather than a filter sitting over
    // one broken car. Starts alongside the sweep and keeps deepening past it,
    // right up to the cut to the game-over screen.
    if (t > WORLD_START) {
      const k = Math.min(1, (t - WORLD_START) / (1 - WORLD_START));
      ctx.save();
      ctx.globalAlpha = k * DESAT_MAX;
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    ctx.restore();
  }

  // The HUD readout: CONNECTION LOST, fixed in screen space. Call this
  // OUTSIDE the shaken/translated block render() draws in — it reports the
  // desync, so it has to stay legible through it rather than jittering along
  // with everything it's reporting on.
  renderOverlay(ctx, W, H) {
    if (!this.active) return;
    const t = this.progress;
    if (t < TEXT_START) return;
    const alpha = Math.min(1, (t - TEXT_START) / (TEXT_FULL - TEXT_START));
    ctx.save();
    ctx.globalAlpha = alpha;
    glowText(ctx, "CONNECTION LOST", W / 2, H * 0.42, "#ffffff", 26, "center", 14);
    glowText(ctx, "REACQUIRING SIGNAL...", W / 2, H * 0.42 + 34, GREEN_PALE, 13, "center", 8);
    ctx.restore();
  }
}
