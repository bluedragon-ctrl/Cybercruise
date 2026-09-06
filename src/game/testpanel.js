// THE DEV PANEL — one screen, opened with F1, holding every cheat the game has
// and every readout worth watching while one is armed.
//
// WHY IT IS A SCREEN AND NOT ROWS ON THE MENU. The cheats used to be two
// checkboxes at the foot of game/menu.js's start/pause screen, hidden until F1
// and flippable by mouse click only. Both guards existed for one reason: they
// shared a screen with SOUND and MUSIC, so a stray Down or a Left meant for a
// volume slider could arm a cheat. On a screen where EVERY row is a cheat there
// is nothing to guard against — this navigates like any other menu, and menu.js
// went back to being just the options menu. See src/testoptions.js's header.
//
// IT NEVER TOUCHES THE WORLD, exactly like menu.js and for the same reason:
// main.js owns the wiring between a screen and the game. update() REPORTS what
// the player asked for as an `action` and main.js is what sets the wallet, moves
// `distance` and rebuilds the road under the car. render() is handed the numbers
// it prints. Nothing in this file imports a system.
//
// FOUR ROWS AND A WAY OUT:
//
//   INVULNERABILITY  a level, not an action — main.js re-asserts it onto the
//                    player every tick, so it holds across a death and a shop
//                    visit. The one row with no FIRE step.
//   CREDITS          a figure to SET the wallet to, seeded at
//                    EXTRA_CASH_AMOUNT so the common case is one FIRE. Setting
//                    it to 0 is as easy as setting it to everything, which is
//                    what tests the shop's own cannot-afford path.
//   DISTANCE         where to warp to, in the DIST units the HUD prints.
//   PASSED EVENTS    what a warp does with the one-shot encounters it skips
//                    over — SKIP them, or leave them to FIRE on arrival.
//   (footer)         F1 or ESC leaves, back to whichever state opened it.
//
// TWO OF THE FOUR ARE DEAD ON THE START MENU, and say so rather than lying.
// CREDITS and DISTANCE act on a RUN, and main.js's newGame() builds a fresh
// wallet and puts `distance` back to 0 the moment CONNECT is pressed — so a
// figure set before there is a run to set it on would be silently thrown away,
// which is the worst thing a dev tool can do. open() is told whether a run is
// live; when it is not, those two rows draw greyed with the reason under them
// and FIRE does nothing. INVULNERABILITY and PASSED EVENTS are unaffected: both
// are levels this panel holds itself, and both survive a newGame() — which is
// the whole reason F1 opens from the start menu at all.
//
// FORWARD-ONLY ON DISTANCE. The pending value clamps at the distance the panel
// opened on. Several systems only ever count UP with distance — game/sectors.js
// says so about its own index — and a backwards warp buys nothing a restart plus
// a forwards one does not, so the restriction costs nothing and makes those
// assumptions true by construction rather than by inspection.
//
// TAP FOR THE FIGURE, HOLD FOR THE ORDER OF MAGNITUDE. There is no text field:
// typing digits onto a canvas means dragging in game/nameentry.js's machinery
// for a value nobody needs to the unit. A tap of Left/Right moves one step
// (testoptions.js's CREDITS_STEP/DISTANCE_STEP); holding repeats, and after
// HOLD_ACCEL_AT the step goes ten times larger, which crosses the whole useful
// range of both rows in about two seconds.
//
// ADJUST WITH LEFT/RIGHT, APPLY WITH FIRE — one rule for both number rows, and
// the reason the rule exists is DISTANCE: a warp rebuilds every car, hazard and
// crate on the road (main.js), so a row that committed on every keypress would
// do that sixty times crossing a sector. Making CREDITS work the same way costs
// nothing and means there is one sentence to remember rather than two.

import { consumePress, isDown } from "../engine/input.js";
import { glowText, vectorText } from "../engine/neon.js";
import { GREEN, GREEN_DIM, GREEN_PALE, GREEN_BRIGHT, PLAYER, HAZARD } from "../engine/palette.js";
import { drawHorizon } from "./menu.js";
import { CREDITS_STEP, DISTANCE_STEP, EXTRA_CASH_AMOUNT } from "../testoptions.js";

// Held-key repeat. HOLD_DELAY is the pause before a held key starts repeating at
// all (so a tap is never read as the start of a sweep), HOLD_RATE how fast it
// repeats once it does, and past HOLD_ACCEL_AT seconds each repeat is worth
// HOLD_MULTIPLIER steps instead of one — see the header's "tap for the figure".
const HOLD_DELAY = 0.35;
const HOLD_RATE = 0.045;
const HOLD_ACCEL_AT = 1.1;
const HOLD_MULTIPLIER = 10;

// The rows, in screen order. `key` is what update() switches on, so the row list
// and the behaviour cannot drift into disagreeing about which row is which.
// Exported for test/test-options.test.js, which drives the cursor by counting
// rows and would otherwise keep a second copy of this list.
export const PANEL_ROWS = [
  { key: "invulnerable", label: "INVULNERABILITY" },
  { key: "credits", label: "CREDITS" },
  { key: "distance", label: "DISTANCE" },
  { key: "passed", label: "PASSED EVENTS" },
];

// The two strings this screen sets in vector type, exported for the same reason
// menu.js exports its own list: test/vectorfont.test.js asserts the alphabet
// covers every one of them, over the ACTUAL strings rather than a copy that
// could drift. Everything else here is Courier through glowText.
export const PANEL_VECTOR_STRINGS = ["TEST PANEL", "DEV BUILD ONLY"];

// Layout. The rows are a two-column table — label left, value right — rather
// than menu.js's centred stack, because half of what is on this screen is a
// NUMBER, and a column of numbers sharing a right edge can be read down where a
// centred one sits wherever each value's own width put it.
const TITLE_Y = 96;
const SUBTITLE_Y = 152;
const ROWS_Y = 236;
const ROW_PITCH = 46;
const COL_LEFT = 90;
const COL_RIGHT = 510;
const ROW_FONT = 17;

// The readout block below the rows: what the world currently is, sampled by
// main.js and handed to render(). It is here because the screen already freezes
// the world to be edited — printing what the world IS beside what you are about
// to set it to costs one call and turns a cheat menu into a debug panel.
const READOUT_Y = 496;
const READOUT_PITCH = 24;
const READOUT_FONT = 13;

// The chevrons marking the selected row — menu.js's drawBrackets over a centred
// label, restated for a row that spans a table instead. Same marker, so the two
// screens read as the same game.
function drawCursor(ctx, y, cap, color) {
  const top = y + cap * 0.12, bot = y + cap * 0.88;
  const mid = (top + bot) / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(COL_LEFT - 26, top); ctx.lineTo(COL_LEFT - 12, mid); ctx.lineTo(COL_LEFT - 26, bot);
  ctx.moveTo(COL_RIGHT + 26, top); ctx.lineTo(COL_RIGHT + 12, mid); ctx.lineTo(COL_RIGHT + 26, bot);
  ctx.stroke();
  ctx.restore();
}

export function createTestPanel() {
  let selected = 0;

  // The one LEVEL on this screen (see the header) — read by main.js every tick,
  // so it holds across a death and a shop visit. The other three rows are edited
  // here and applied on FIRE.
  let invuln = false;

  // What a warp does with the one-shot encounters it passes. SKIP by default:
  // the ordinary reason to warp is to look at the road twenty minutes deep, and
  // arriving there under a queue of every boss below it is not that.
  let skipPassed = true;

  // The pending figures, seeded by open() from the live world. CREDITS seeds to
  // EXTRA_CASH_AMOUNT rather than to the current balance — "give me everything"
  // is the case worth making one keypress, and the live balance is printed in
  // the readouts a few lines below it either way. DISTANCE seeds to where the
  // car actually is, because it is the row that can only go forward from there.
  let credits = EXTRA_CASH_AMOUNT;
  let distance = 0;
  let floorDistance = 0; // what DISTANCE clamps at — the distance open() saw

  // Whether there is a run for the two world rows to act on — see the header.
  let live = true;

  // The held-key repeat's own state, all three reset by open() so a key still
  // down from the last visit cannot arrive mid-sweep.
  let holdDir = 0;
  let holdTime = 0;
  let repeatIn = 0;

  // Called by main.js every time F1 opens the panel, handed the live figures the
  // two number rows seed from. Resets the cursor to row 0 for the same reason
  // menu.open() does: re-entering always lands somewhere predictable.
  function open(world = {}) {
    selected = 0;
    live = world.live !== false;
    credits = EXTRA_CASH_AMOUNT;
    floorDistance = Math.max(0, Math.floor(world.dist ?? 0));
    distance = floorDistance;
    holdDir = 0;
    holdTime = 0;
    repeatIn = 0;
  }

  // How many steps Left/Right asked for this tick, tap and hold-repeat together,
  // already scaled by the acceleration multiplier. Consumes both presses
  // unconditionally — every row on this screen uses Left/Right for something, so
  // there is no row a press could usefully be left sitting for, and one left in
  // input.js's `fresh` buffer would fire again on whichever row the cursor
  // moves to next.
  function stepsThisTick(dt) {
    let steps = 0;
    if (consumePress("left")) steps -= 1;
    if (consumePress("right")) steps += 1;

    const dir = (isDown("right") ? 1 : 0) - (isDown("left") ? 1 : 0);
    if (dir === 0 || dir !== holdDir) {
      // Either nothing is held, or the direction just changed — in both cases
      // the repeat starts over, so reversing never inherits the old sweep's
      // accumulated speed.
      holdDir = dir;
      holdTime = 0;
      repeatIn = HOLD_DELAY;
    } else {
      holdTime += dt;
      repeatIn -= dt;
      if (repeatIn <= 0) {
        repeatIn = HOLD_RATE;
        steps += dir;
      }
    }

    return steps * (holdTime >= HOLD_ACCEL_AT ? HOLD_MULTIPLIER : 1);
  }

  // Returns { closed, action, adjusted }:
  //
  //   closed    true the tick F1 or ESC asked to leave. main.js restores
  //             whichever state opened the panel.
  //   action    null, or the one thing FIRE asked main.js to do to the world —
  //             { kind: "credits", value } or { kind: "warp", dist, skipPassed }.
  //             INVULNERABILITY is not here: it is a level main.js reads every
  //             tick (see `invuln` above), not an event.
  //   adjusted  true the tick anything on the screen moved, so main.js can play
  //             the menu's own adjust tone — the same signal menu.update()
  //             reports for its sliders.
  function update(dt) {
    if (consumePress("testOptions") || consumePress("pause")) {
      // Drained, not merely ignored: a Left still buffered when the panel closes
      // would otherwise steer the car on the first playing tick.
      consumePress("left");
      consumePress("right");
      consumePress("fire");
      return { closed: true, action: null, adjusted: false };
    }

    let adjusted = false;
    if (consumePress("up")) { selected = (selected + PANEL_ROWS.length - 1) % PANEL_ROWS.length; adjusted = true; }
    if (consumePress("down")) { selected = (selected + 1) % PANEL_ROWS.length; adjusted = true; }

    const steps = stepsThisTick(dt);
    const fire = consumePress("fire");
    const row = PANEL_ROWS[selected].key;

    // The two TOGGLE rows: Left/Right and FIRE all mean the same thing on a
    // two-state row, so all three flip it rather than FIRE being reserved for an
    // apply step these rows do not have.
    if (row === "invulnerable" && (steps !== 0 || fire)) { invuln = !invuln; adjusted = true; }
    if (row === "passed" && (steps !== 0 || fire)) { skipPassed = !skipPassed; adjusted = true; }

    // The two world rows are inert until there is a run — see the header. The
    // presses are still CONSUMED above (stepsThisTick, and `fire` at the top),
    // so nothing is left in the buffer to fire on the row the cursor moves to.
    if (!live && (row === "credits" || row === "distance")) {
      return { closed: false, action: null, adjusted };
    }

    if (row === "credits" && steps !== 0) {
      credits = Math.max(0, credits + steps * CREDITS_STEP);
      adjusted = true;
    }
    if (row === "distance" && steps !== 0) {
      // Forward-only — see the header. Clamped rather than refused, so holding
      // Left simply parks at the car's own distance instead of doing nothing
      // visible and leaving you wondering which key you pressed.
      distance = Math.max(floorDistance, distance + steps * DISTANCE_STEP);
      adjusted = true;
    }

    if (fire && row === "credits") {
      return { closed: false, action: { kind: "credits", value: credits }, adjusted: true };
    }
    if (fire && row === "distance") {
      // A warp to where the car already is would rebuild the whole road for
      // nothing, so it is not an action at all.
      if (distance <= floorDistance) return { closed: false, action: null, adjusted };
      return { closed: false, action: { kind: "warp", dist: distance, skipPassed }, adjusted: true };
    }

    return { closed: false, action: null, adjusted };
  }

  // `world` is main.js's own deck snapshot (its deckSnapshot()), reused whole
  // rather than assembled again here — it already carries every figure this
  // screen wants to print, and a second copy of that arithmetic could disagree
  // with the rig panel about the same run.
  //
  // TWO CONTEXTS, the same split menu.js and shop.js take (main.js's render()):
  // the title is display type on the bloomed world canvas, everything else is
  // the HUD's own size class and goes on `hudCtx` where the bloom threshold
  // will not chew it.
  function render(ctx, hudCtx, W, H, world = {}) {
    drawHorizon(ctx, W, H);
    vectorText(ctx, PANEL_VECTOR_STRINGS[0], W / 2, TITLE_Y, GREEN_BRIGHT, 34, "center", 2.6, 0.16);
    vectorText(ctx, PANEL_VECTOR_STRINGS[1], W / 2, SUBTITLE_Y, HAZARD, 13, "center", 1.3, 0.34);

    for (let i = 0; i < PANEL_ROWS.length; i++) {
      const y = ROWS_Y + i * ROW_PITCH;
      const isSelected = i === selected;
      const key = PANEL_ROWS[i].key;

      // ARMED READS AS UNUSUAL AT A GLANCE, without having to read the value:
      // anything set away from its harmless default lifts to the pale green the
      // menu already uses for an armed cheat.
      const dead = !live && (key === "credits" || key === "distance");
      const armed = key === "invulnerable" ? invuln
        : key === "distance" ? distance > floorDistance
        : key === "passed" ? !skipPassed
        : false;
      const color = dead ? GREEN_DIM : isSelected ? PLAYER : armed ? GREEN_PALE : GREEN;

      glowText(hudCtx, PANEL_ROWS[i].label, COL_LEFT, y, color, ROW_FONT, "left", isSelected ? 8 : 4);

      const value = dead ? "-"
        : key === "invulnerable" ? (invuln ? "ON" : "OFF")
        : key === "credits" ? String(credits)
        : key === "distance" ? (distance > floorDistance ? `${floorDistance} > ${distance}` : String(distance))
        : (skipPassed ? "SKIP" : "FIRE");
      glowText(hudCtx, value, COL_RIGHT, y, color, ROW_FONT, "right", isSelected ? 8 : 4);

      if (isSelected) drawCursor(hudCtx, y, ROW_FONT, color);
    }

    // What FIRE would do from here, spelled out under the cursor rather than
    // left to the footer: two of these rows act on the world and two only flip a
    // switch, and which is which should not have to be remembered.
    const hint = !live && (selected === 1 || selected === 2)
      ? "NO RUN YET — CONNECT FIRST, THEN F1 AGAIN"
      : selected === 1 ? "FIRE — SET THE WALLET TO THIS FIGURE"
      : selected === 2 ? "FIRE — WARP, AND REBUILD THE ROAD THERE"
      : "LEFT / RIGHT / FIRE — FLIP IT";
    glowText(hudCtx, hint, W / 2, ROWS_Y + PANEL_ROWS.length * ROW_PITCH + 8, GREEN_DIM, 12, "center", 4);

    const readouts = [
      ["DIST", world.dist ?? 0],
      ["SECTOR", world.sector ?? "-"],
      ["CREDITS", world.credits ?? 0],
      ["HULL", `${world.hullPct ?? 0}%`],
      ["SPEED", world.speed ?? 0],
      ["ENTITIES", world.entities ?? 0],
      ["SCORE", world.points ?? 0],
    ];
    glowText(hudCtx, "LIVE READOUT", W / 2, READOUT_Y - 28, GREEN_DIM, 11, "center", 4);
    for (let i = 0; i < readouts.length; i++) {
      const y = READOUT_Y + i * READOUT_PITCH;
      glowText(hudCtx, readouts[i][0], COL_LEFT, y, GREEN_DIM, READOUT_FONT, "left", 3);
      glowText(hudCtx, String(readouts[i][1]), COL_RIGHT, y, GREEN_PALE, READOUT_FONT, "right", 3);
    }

    glowText(hudCtx, "F1 / ESC — RESUME    SEE src/testoptions.js", W / 2, H - 40, GREEN_DIM, 12, "center", 6);
  }

  // The one level main.js re-asserts onto the player every tick — see the
  // header, and applyTestOptions() there.
  function invulnerable() {
    return invuln;
  }

  // ...and the same level set from OUTSIDE the keyboard, for main.js's scripted
  // handle (its `window.cybercruise`). Deliberately writing the panel's own
  // field rather than the player's: one piece of state behind both the row and
  // the script, so a run driven from the console still shows ON when F1 is
  // pressed, and applyTestOptions() has one thing to read.
  function setInvulnerable(on) {
    invuln = on === true;
  }

  return { open, update, render, invulnerable, setInvulnerable };
}
