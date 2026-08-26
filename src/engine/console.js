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

// Phase 8 step 4's SUBSCRIBER SEAM — the one deliberate exception to "game
// modules stay ignorant of audio". Every other system in this codebase gets
// wired to the audio engine from main.js (onCarDestroyed, onPlayerDamage,
// onPickupCollected — see main.js's own header on that pattern), because
// main.js sits above both the game module and the audio engine and can
// import both. push() is different: it is called from INSIDE game modules
// (links.js, sectors.js, player.js, pickups.js, ...), not from main.js, so
// there is no single call site main.js can wrap the way it wraps
// onCarDestroyed. Importing the audio engine into THIS file instead would
// work, but it would make console.js — an engine-layer, presentation-only
// module — depend on game/audio wiring, which is exactly the dependency
// direction this codebase avoids everywhere else (see soundtypes.js's own
// header on why sfx.js and soundtypes.js don't import each other directly,
// for the same shape of reason).
//
// So this file stays ignorant of what, if anything, is listening: onPush(fn)
// registers a callback push() invokes with (text, severity) every time a
// line is actually appended, and main.js — which already imports both
// console.js and the audio engine — is what registers the audio callback at
// startup. One subscriber, not a list: nothing here has ever needed more
// than one listener, and a single `let` is simplest to reason about and to
// reset. onPush() returns an unsubscribe function (call it to remove
// exactly that subscriber, a no-op if a later onPush() has already replaced
// it) for symmetry, though today only reset() below actually uses the
// clearing behaviour.
let subscriber = null;

export function onPush(fn) {
  subscriber = fn;
  return () => {
    if (subscriber === fn) subscriber = null;
  };
}

// DIVERT — whether something OFF the playfield is currently showing this log
// too, and this panel can therefore stop carrying the quiet half of it.
//
// engine/gutter.js's left-hand panel is that something: on a wide window it
// shows every line this log holds, with room for thirty of them instead of
// five. When it is up, keeping the full stream on the canvas as well is not
// redundancy, it is a 160px-wide plate over a 600px-wide playfield (see
// PANEL_W above, and what it had to be squeezed to in order to stay off the
// tarmac) spending a quarter of the screen to say what the gutter is already
// saying better.
//
// So when diverted, this panel keeps CRITICAL and nothing else. That split is
// the whole design and it is not a size compromise: a hull call-out has to land
// where the player's eyes already are, because the half-second it is warning
// them about is a half-second they cannot spend looking sideways. Everything
// else — pickup hints, node pings, sector names, the audio feed — is read
// BETWEEN hazards, and between hazards a glance at the gutter is free.
//
// A PRESENTATION SWITCH, AND ONLY THAT. Every line still enters `messages`,
// still ages, still ticks the subscriber, and still counts toward isBusy(). It
// has to: isBusy() is the budget links.js and wallet.js pace the city's whole
// chatter against (see announceCityLine), and a divert that quietly emptied the
// log would read as "never busy" to those callers and let them push at every
// opportunity — roughly doubling the log's real rate AND the console beep
// audio.js plays per push, on the strength of a WINDOW BEING WIDE. Nothing
// about the size of somebody's browser should change how often the city talks.
// The only thing that changes below is which of those lines this panel paints.
//
// A predicate rather than a flag, for the same reason onPush is a callback:
// the answer changes when the window resizes, and resizes have no business
// reaching into the renderer. Asked once per render, never cached.
let divert = () => false;

export function setDivert(fn) {
  divert = fn ?? (() => false);
}

export function push(text, severity = HINT) {
  // `dslot`/`dtarget` are the divert-mode twin of `slot`/`target`, and they
  // exist because the two modes pack rows differently. A row's `slot` is its age
  // rank among ALL messages — so a critical with four hints pushed after it sits
  // at slot 4, four rows up from the bottom. That is right on the five-row SYS
  // LOG plate and nonsense on the ALERT plate, which is only as tall as the
  // criticals actually up: the row lands above the plate's own top edge, a hull
  // warning floating unanchored over the road. Divert mode therefore needs the
  // row's rank among the CRITICALS ALONE.
  //
  // Eased rather than computed at render time, for one multiply-add per message
  // per frame on a list capped at MAX_MESSAGES: a packed index derived on the
  // spot would snap a standing alert a full row-height the instant a second one
  // arrived beneath it, and the one line the player cannot afford to lose track
  // of is the last one that should move differently from everything else.
  messages.push({ text, severity, slot: -1, target: 0, dslot: -1, dtarget: 0, removing: false, age: 0 });
  // Normally this drops at most one entry — the loop only matters if two
  // lines are pushed inside the same frame, before update() has had a
  // chance to actually retire the previous overflow.
  let kept = messages.filter((m) => !m.removing);
  while (kept.length > MAX_MESSAGES) {
    messages.find((m) => !m.removing).removing = true;
    kept = messages.filter((m) => !m.removing);
  }
  if (subscriber) subscriber(text, severity);
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
  // The divert-mode packing, computed unconditionally rather than behind a
  // divert() check. Two reasons: the mode can flip mid-run (the player resizes
  // the window), and a dslot that had stopped tracking while diverted was off
  // would snap the whole plate into place on the frame it came back — the one
  // frame it is most obvious. Keeping it warm costs a filter over a list capped
  // at MAX_MESSAGES.
  const keptCritical = kept.filter((m) => m.severity === CRITICAL);
  keptCritical.forEach((m, i) => {
    m.dtarget = keptCritical.length - 1 - i;
  });
  for (const m of messages) {
    if (m.removing) {
      m.target = MAX_MESSAGES;
      m.dtarget = MAX_MESSAGES;
    }
    const rate = Math.min(1, EASE_RATE * dt);
    m.slot += (m.target - m.slot) * rate;
    m.dslot += (m.dtarget - m.dslot) * rate;
  }
  // Retirement stays keyed to `slot` alone. `dslot` is a second VIEW of a
  // message, not a second lifetime — letting either one decide when the entry
  // is dropped would mean the log's contents depended on the window's width,
  // which is exactly what setDivert's header promises never happens.
  messages = messages.filter((m) => !(m.removing && m.slot >= MAX_MESSAGES - 0.02));
}

// Fades a row in as it slides up from below the panel (slot -1 -> 0) and out as
// a removing row slides past the top row (slot rows-1 -> rows).
//
// `slot` and `rows` are parameters rather than read off the message and the
// module constant, because divert mode measures both differently: it eases
// `dslot` against a plate only as tall as the criticals currently showing. The
// arithmetic is identical either way, which is the point of passing them in
// rather than branching inside.
function messageAlpha(m, slot, rows) {
  if (m.removing) return clamp01(1 - (slot - (rows - 1)));
  return clamp01(slot + 1);
}

export function render(ctx, W, H) {
  if (messages.length === 0) return;

  const diverted = divert();
  // What this panel is painting this frame, and how tall it therefore is. When
  // diverted the plate shrinks to the criticals actually up — the whole reason
  // for the mode is to stop spending playfield, so leaving a five-row plate
  // standing with one line in it would give back none of it.
  const shown = diverted ? messages.filter((m) => m.severity === CRITICAL) : messages;
  if (shown.length === 0) return;
  const rows = diverted
    ? Math.max(1, Math.min(MAX_MESSAGES, shown.filter((m) => !m.removing).length))
    : MAX_MESSAGES;

  const bodyH = rows * ROW_HEIGHT;
  const panelH = HEADER_H + bodyH + PADDING * 2;
  const x = W - PANEL_W - PANEL_MARGIN;
  const panelY = H - panelH - PANEL_MARGIN;

  // Same flat translucent plate the weapon stack backdrop uses (main.js's
  // drawHud) — reads as one HUD plate rather than another glowing element.
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(x, panelY, PANEL_W, panelH);
  ctx.restore();

  // The header names what the plate IS, and when diverted the plate is no
  // longer the system log — it is the alarm channel, with the log itself now
  // running down the side of the screen. Saying so is what stops the player
  // reading the shrunken panel as the log having broken.
  glowText(
    ctx, diverted ? "ALERT" : "SYS LOG",
    x + PADDING, panelY + PADDING - 2, GREEN_DIM, 10, "left", 4,
  );

  const bodyTop = panelY + PADDING + HEADER_H;
  for (const m of shown) {
    const slot = diverted ? m.dslot : m.slot;
    const alpha = messageAlpha(m, slot, rows);
    if (alpha <= 0) continue;
    const rowY = bodyTop + (rows - 1 - slot) * ROW_HEIGHT;
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
  // Cleared, not left standing — main.js re-registers its audio callback
  // right after calling this (see main.js's own newGame()), so nothing is
  // actually silenced by this on a normal restart. What it guards against is
  // main.js ever growing a second wiring path that forgets to re-register:
  // without this, a stale subscriber from before the reset would keep firing
  // rather than failing loudly by going silent.
  subscriber = null;
  // `divert` is deliberately NOT cleared alongside it. The two look alike and
  // are not: a subscriber is per-run wiring that newGame() re-registers every
  // time, while divert answers "is there a second display on this page", which
  // is a fact about the BROWSER WINDOW and outlives any number of runs. Zeroing
  // it here would put the full log back on the playfield for the rest of the
  // session on the first restart, and the gutter would then be showing every
  // line twice.
}
