// The high-score initials screen — three letters, arcade-cabinet style,
// shown between "dying" and "gameover" only when leaderboard.qualifies()
// said this run's score belongs on the shared board (main.js wires the
// branch). Shaped exactly like menu.js's own module — open()/update()/
// render(ctx, hudCtx, W, H), UI state only, never the world or the network —
// but it is not a fourth menu.js mode: a row-cycling menu and a
// letter-cycling widget are different enough interactions that folding them
// into one module would have bent menu.js's row abstraction (rowY/barRect)
// around a case it was never for. See menu.js's header for the convention
// this mirrors.
//
// WHY THREE LETTERS, NOT A NAME FIELD. The game has zero raw-text input
// today — engine/input.js only ever exposes semantic actions (an
// allow-listed key set), never a keystroke's actual character — so a free-text
// name would mean overlaying a real HTML <input> on the canvas. Three
// cycled initials reuse the same four actions play and the menu already
// read (left/right/up/down/fire) and are the form this exact screen has
// taken since the arcades this game already imitates (README, menu.js's
// CONNECT/RECONNECT fiction). Nothing new to wire, nothing out of period.
//
// FIRE BOTH ADVANCES AND CONFIRMS — mashing it walks the cursor across all
// three slots and submits on the last, the same "one button does the whole
// job" feel as the machines this is modelled on. Left/Right can still jump
// the cursor directly; nothing requires stepping through in order.
//
// GLOWTEXT, NOT VECTORTEXT. Every other title screen string
// (menu.js's TITLE/ROW0_LABEL/SUBTITLE) is the game's vector display type,
// and vectorfont.test.js asserts coverage of that alphabet against exactly
// that list. This screen is secondary — up a few seconds, seen rarely — so
// it draws with glowText's canvas font (as the HUD, the checkboxes and the
// footer already do) rather than adding a second string list for the
// vector-coverage test to track.

import { consumePress, isDown } from "../engine/input.js";
import { glowText } from "../engine/neon.js";
import { GREEN, GREEN_PALE, GREEN_DIM, PLAYER } from "../engine/palette.js";
import { drawHorizon } from "./menu.js";

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SLOT_COUNT = 3;

// Holding UP/DOWN auto-repeats cycle() instead of needing a repress per
// letter — 36 glyphs in CHARSET makes single-step-per-tap the slow path.
// DELAY is longer than RATE so a tap-tap-tap player never free-rides into an
// unwanted repeat between presses.
const REPEAT_DELAY = 0.4; // s held before auto-repeat kicks in
const REPEAT_RATE = 0.08; // s between repeats once it has

const TITLE_Y = 260;
const SLOTS_Y = 340;
const SLOT_CAP = 40; // glowText font size for the big letters
const SLOT_SPACING = 64;
const HINT_Y = 430;

export function createNameEntry() {
  let letters = Array(SLOT_COUNT).fill("A");
  let cursor = 0;
  let repeatTimer = 0; // seconds until the next auto-repeat cycle(), while up/down is held

  // Called by main.js the tick it enters "highscore" — resets to AAA/cursor 0
  // so a previous entry (or a stale one from a build with no persistence,
  // see menu.js's own NOT PERSISTED note) never leaks into the next prompt.
  function open() {
    letters = Array(SLOT_COUNT).fill("A");
    cursor = 0;
    repeatTimer = 0;
  }

  function cycle(dir) {
    const i = CHARSET.indexOf(letters[cursor]);
    letters[cursor] = CHARSET[(i + dir + CHARSET.length) % CHARSET.length];
  }

  // Returns { confirmed, name } — main.js reads `confirmed` the one tick the
  // last slot is fired, the same edge-triggered shape menu.js's update()
  // returns `confirmed` on. `name` is only meaningful that tick.
  function update(dt) {
    if (consumePress("left")) cursor = Math.max(0, cursor - 1);
    if (consumePress("right")) cursor = Math.min(SLOT_COUNT - 1, cursor + 1);
    if (consumePress("up")) {
      cycle(1);
      repeatTimer = REPEAT_DELAY;
    }
    if (consumePress("down")) {
      cycle(-1);
      repeatTimer = REPEAT_DELAY;
    }
    // isDown, not consumePress: the press above already fired the first
    // cycle(), this only keeps firing it for as long as the key stays down.
    const heldDir = isDown("up") ? 1 : isDown("down") ? -1 : 0;
    if (heldDir === 0) {
      repeatTimer = 0;
    } else {
      repeatTimer -= dt;
      if (repeatTimer <= 0) {
        cycle(heldDir);
        repeatTimer += REPEAT_RATE;
      }
    }
    if (consumePress("fire")) {
      if (cursor === SLOT_COUNT - 1) return { confirmed: true, name: letters.join("") };
      cursor++;
    }
    return { confirmed: false, name: "" };
  }

  function render(ctx, hudCtx, W, H) {
    drawHorizon(ctx, W, H);

    glowText(hudCtx, "NEW HIGH SCORE", W / 2, TITLE_Y, GREEN_PALE, 22, "center", 10, true);

    const totalW = (SLOT_COUNT - 1) * SLOT_SPACING;
    const startX = W / 2 - totalW / 2;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const x = startX + i * SLOT_SPACING;
      const selected = i === cursor;
      const color = selected ? PLAYER : GREEN;
      glowText(hudCtx, letters[i], x, SLOTS_Y, color, SLOT_CAP, "center", selected ? 14 : 6, true);
      // A short underline instead of menu.js's bracket pair — brackets read
      // right around a whole label, but here the label IS a single glyph and
      // brackets that tight would sit closer to a box than a cursor.
      if (selected) {
        hudCtx.save();
        hudCtx.strokeStyle = color;
        hudCtx.lineWidth = 3;
        hudCtx.beginPath();
        hudCtx.moveTo(x - SLOT_CAP * 0.3, SLOTS_Y + SLOT_CAP + 8);
        hudCtx.lineTo(x + SLOT_CAP * 0.3, SLOTS_Y + SLOT_CAP + 8);
        hudCtx.stroke();
        hudCtx.restore();
      }
    }

    glowText(hudCtx, "UP/DOWN CHANGE LETTER", W / 2, HINT_Y, GREEN_DIM, 12, "center", 4);
    glowText(hudCtx, "LEFT/RIGHT MOVE, FIRE TO CONFIRM", W / 2, HINT_Y + 20, GREEN_DIM, 12, "center", 4);
  }

  return { open, update, render };
}
