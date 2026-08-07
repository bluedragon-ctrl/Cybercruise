// The in-game "console": a small translucent log, bottom-right (clear of the
// weapon/hull HUD, which owns the bottom-left, and clear of the road itself),
// showing the last MAX_MESSAGES lines any system pushed (pickup hints, hull
// damage call-outs, ...). Module-level singleton, called the way
// road.js/scenery.js are ("import * as gameConsole"), so any system can
// push() a line without main.js having to wire an instance through to it.
//
// No history beyond MAX_MESSAGES — a pushed line either sits in the log or
// has already scrolled off it; nothing is kept once it drops.

import { glowText } from "./neon.js";
import { GREEN_PALE, GREEN_DIM, NEUTRAL, HAZARD } from "./palette.js";

export const HINT = "hint";
export const WARN = "warn";
export const CRITICAL = "critical";

const COLORS = { [HINT]: GREEN_PALE, [WARN]: NEUTRAL, [CRITICAL]: HAZARD };

const MAX_MESSAGES = 5;
// Narrow enough to sit clear of the road's own right barrier (up to
// ROAD_HALF_WIDTH=143px either side of a centre that itself drifts with the
// curve — see game/road.js) rather than sitting over the tarmac.
const PANEL_W = 160;
const PANEL_MARGIN = 12; // gap from the bottom-right corner, both axes
const PADDING = 8;
const HEADER_H = 16;
const ROW_HEIGHT = 16;
// Convergence rate for the slide: how fast a row eases toward its target
// slot each second, not a fixed-duration tween — see update().
const EASE_RATE = 12;
const LIFETIME = 5; // seconds a line stays before it auto-retires, even if never pushed out

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Oldest first; a freshly pushed line is always the last entry. `slot` is a
// row position that EASES toward `target` (see update()) rather than
// snapping to it, which is what makes the log scroll instead of jump: slot 0
// is the bottom (newest) row, MAX_MESSAGES-1 the top (oldest) row, and a
// `removing` entry's target sits one row above that so it slides up and off
// the panel instead of vanishing.
let messages = [];

export function push(text, severity = HINT) {
  messages.push({ text, severity, slot: -1, target: 0, removing: false, age: 0 });
  // Normally this drops at most one entry — the loop only matters if two
  // lines are pushed inside the same frame, before update() has had a
  // chance to actually retire the previous overflow.
  let kept = messages.filter((m) => !m.removing);
  while (kept.length > MAX_MESSAGES) {
    messages.find((m) => !m.removing).removing = true;
    kept = messages.filter((m) => !m.removing);
  }
}

export function update(dt) {
  for (const m of messages) {
    m.age += dt;
    // Same exit as an overflow eviction (scrolls up and off) rather than a
    // separate fade, so a line that outlives its 5s reads the same way one
    // pushed out by newer lines does.
    if (!m.removing && m.age >= LIFETIME) m.removing = true;
  }
  const kept = messages.filter((m) => !m.removing);
  kept.forEach((m, i) => {
    m.target = kept.length - 1 - i;
  });
  for (const m of messages) {
    if (m.removing) m.target = MAX_MESSAGES;
    m.slot += (m.target - m.slot) * Math.min(1, EASE_RATE * dt);
  }
  messages = messages.filter((m) => !(m.removing && m.slot >= MAX_MESSAGES - 0.02));
}

// Fades a row in as it slides up from below the panel (slot -1 -> 0) and out
// as a removing row slides past the top row (slot MAX_MESSAGES-1 -> MAX_MESSAGES).
function messageAlpha(m) {
  if (m.removing) return clamp01(1 - (m.slot - (MAX_MESSAGES - 1)));
  return clamp01(m.slot + 1);
}

export function render(ctx, W, H) {
  if (messages.length === 0) return;

  const bodyH = MAX_MESSAGES * ROW_HEIGHT;
  const panelH = HEADER_H + bodyH + PADDING * 2;
  const x = W - PANEL_W - PANEL_MARGIN;
  const panelY = H - panelH - PANEL_MARGIN;

  // Same flat translucent plate the weapon stack backdrop uses (main.js's
  // drawHud) — reads as one HUD plate rather than another glowing element.
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(x, panelY, PANEL_W, panelH);
  ctx.restore();

  glowText(ctx, "SYS LOG", x + PADDING, panelY + PADDING - 2, GREEN_DIM, 10, "left", 4);

  const bodyTop = panelY + PADDING + HEADER_H;
  for (const m of messages) {
    const alpha = messageAlpha(m);
    if (alpha <= 0) continue;
    const rowY = bodyTop + (MAX_MESSAGES - 1 - m.slot) * ROW_HEIGHT;
    ctx.save();
    ctx.globalAlpha = alpha;
    glowText(ctx, m.text, x + PADDING, rowY, COLORS[m.severity] ?? GREEN_PALE, 11, "left", 5);
    ctx.restore();
  }
}

// Read-only: is the log currently showing anything at all (a still-fading
// line counts). Exists for callers OUTSIDE this file that must never crowd
// out the log's real job — pickup hints, hull-damage call-outs — with their
// own chatter (Phase 7e's city SYS LOG lines, game/links.js): those callers
// need to know the log is busy before deciding to push, and guessing that
// from outside (no messages pushed in the last N seconds? counting some
// other system's own calls?) would be both more code and less accurate than
// this file just answering the question directly.
export function isBusy() {
  return messages.length > 0;
}

export function reset() {
  messages = [];
}
