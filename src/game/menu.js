// Start screen, pause screen AND game-over screen — the same menu, reused for
// all three.
//
// This module owns UI state ONLY — it never touches the world in game/*.js
// and knows nothing about "playing" a game. main.js just asks update() "did
// the player confirm row 0 this tick?" and switches its own top-level state
// (to "playing" whether that came from START GAME or CONTINUE) the moment it
// says yes; everything else (player, traffic, score...) is main.js's
// business, not this module's.
//
// `open(mode)` picks which of the three contexts row 0 reads as — "start"
// labels it START GAME, "pause" CONTINUE, "gameover" RESTART — and resets the
// cursor to it, so re-entering any of the three always lands back on the row
// that acts on it rather than wherever the cursor was left last time.
//
// SOUND and MUSIC both drive playback now, via soundVolume()/musicVolume()
// below — main.js reads them to scale src/audio/synth.js's one-shot SFX and
// its music volume respectively. Both are 0..1 sliders that start from a
// coded default and live only for the session — see SOUND_DEFAULT/
// MUSIC_DEFAULT below for why neither is read back from local storage.
//
// "gameover" is a THIRD context for this same screen, alongside "start" and
// "pause" — main.js opens it once game/disconnect.js's sequence finishes, and
// confirming row 0 (RESTART) is main.js's cue to reset the game, the same way
// confirming START GAME or CONTINUE is its cue to unpause. This module still
// never touches the world: it doesn't know the run ended in death, only that
// it was told to show a third label.

import { consumePress } from "../engine/input.js";
import { mousePos, isMouseDown, consumeMouseClick } from "../engine/mouse.js";
import { glowText, glowLine } from "../engine/neon.js";
import { GREEN, GREEN_DIM, GREEN_PALE, GREEN_BRIGHT, PLAYER } from "../engine/palette.js";
import { LOGICAL_H } from "../engine/viewport.js";
import {
  SHOW_TEST_OPTIONS,
  SHOW_INVULNERABILITY_OPTION,
  SHOW_EXTRA_CASH_OPTION,
} from "../testoptions.js";

// NOT PERSISTED — neither these two nor the test rows below. The game runs
// served from a shared server rather than as a per-user desktop install, so
// there is no local file that is reliably this player's — reading one back
// would as easily hand a stranger's leftover setting to the next visitor as
// it would remember this one's. Every load starts from these two coded
// defaults instead; the slider still moves them for the rest of the session,
// in memory, the same as before.
const SOUND_DEFAULT = 0.5;
const MUSIC_DEFAULT = 0.2;

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// Row geometry for the three real rows and their volume bars (barRect below)
// — shared between render() and update()'s hit-testing so what's drawn can
// never drift from what's clickable. The test checkboxes live at the foot of
// the screen instead (CHECK_Y below) and don't use this.
const MENU_START_Y = 420;
const MENU_ROW_SPACING = 52;

// Row 0 is the only one that ever ends update() with `confirmed`; every row
// below it adjusts or toggles in place and leaves the menu up. Row 0's label is
// the only thing that differs between the three modes — see the header.
const ROW0_LABEL = { start: "START GAME", pause: "CONTINUE", gameover: "RESTART" };
const SOUND_ROW = 1;
const MUSIC_ROW = 2;
const VOLUME_STEP = 0.1;

// THE TEST ROWS (testoptions.js) are the only part of this menu that is not
// always there: each one exists only while its flag in that file says so, and
// the master switch drops all of them at once. Built here as a list rather
// than as two more hard-coded row indices so that everything below — the row
// count the cursor wraps against, what render() draws, what a click hit-tests
// against — follows from the same array, and a build with the rows switched
// off has no gaps in it to fall through.
//
// `key` is the name the flag is stored under in `flags` below AND the name of
// the accessor createMenu() exposes for it, so main.js and this file cannot
// disagree about which row it is reading.
const TEST_ROWS = !SHOW_TEST_OPTIONS
  ? []
  : [
      SHOW_INVULNERABILITY_OPTION && { key: "invulnerable", label: "INVULNERABILITY" },
      SHOW_EXTRA_CASH_OPTION && { key: "extraCash", label: "EXTRA CASH" },
    ].filter(Boolean);

// row 0 (see above), SOUND, MUSIC, then whichever test rows are compiled in —
// but the keyboard's up/down wrap (update() below) never steps onto the test
// rows at all, in either direction, F1 or no F1. They are reached ONLY by a
// mouse click landing on the checkbox directly (testRowRect below) — a stray
// Down at the wrong moment must not be able to arm a cheat, which a shared
// wrap with SOUND/MUSIC would allow.
const FIRST_TEST_ROW = 3;

// DRAWN SMALL, AT THE FOOT OF THE SCREEN, deliberately unlike the three real
// rows above — a dev cheat sitting in the same size and place as START GAME
// reads as part of the game's own option set instead of what it is. A row of
// tiny checkboxes beside the "TEST BUILD" footer they already share a reason
// for existing with does the opposite: unmissable if you're looking for it,
// easy to never notice if you're not.
//
// HIDDEN UNTIL F1, and toggled by MOUSE ONLY once revealed — see
// `testOptionsVisible` and the click handling in update() below. Small and at
// the foot was "easy to never notice"; this is "invisible unless you already
// know the key", for the same footer that still names the file where F1 and
// the flags themselves are documented.
const CHECK_Y = LOGICAL_H - 68; // a clear gap above the footer text (H - 40)
const CHECK_FONT = 12;
const CHECK_BOX = 10; // the little square glyph itself
const CHECK_GAP = 6; // between the square and its label
const CHECK_ITEM_W = 170; // reserved per checkbox, box+label+padding, for centering and the click target

// The clickable box around one checkbox + its label — generous past the glyph
// itself for the same reason the old full-width test row was: a dev flag
// should be easy to hit, not a precision target. `CHECK_Y` is the text's own
// TOP (glowText draws from a "top" baseline — engine/neon.js), so the rect
// pads a few px above it for the box glyph and enough below for the label's
// full height.
// Exported so test-options.test.js can click a checkbox at its actual
// geometry instead of duplicating CHECK_Y/CHECK_ITEM_W as a second copy that
// could silently drift from this one.
export function testRowRect(W, i) {
  const totalW = TEST_ROWS.length * CHECK_ITEM_W;
  const x = W / 2 - totalW / 2 + i * CHECK_ITEM_W;
  return { x, y: CHECK_Y - 6, w: CHECK_ITEM_W, h: CHECK_FONT + 12 };
}

// SOUND/MUSIC rows' volume bar geometry, shared between render() (drawing)
// and update() (mouse hit-testing) so the clickable area can never drift from
// what's actually drawn.
const BAR_W = 200;
const BAR_H = 12;
function barRect(W, row) {
  const rowY = MENU_START_Y + row * MENU_ROW_SPACING;
  return { x: W / 2 - BAR_W / 2, y: rowY + 30, w: BAR_W, h: BAR_H };
}

export function createMenu() {
  let selected = 0;
  let mode = "start"; // "start" | "pause" | "gameover"
  let soundLevel = SOUND_DEFAULT;
  let volume = MUSIC_DEFAULT;
  // One entry per COMPILED-IN test row, keyed by its `key`, always starting
  // OFF — see the NOT PERSISTED note near SOUND_DEFAULT above. A row that is
  // not compiled in has no entry at all, and its accessor below reports false.
  const flags = {};
  for (const row of TEST_ROWS) flags[row.key] = false;
  // Which row's bar (if any) a drag that STARTED on it is currently
  // controlling — a click that lands elsewhere and drags onto a bar must not
  // suddenly grab it, same reasoning a native slider only tracks drags it
  // originated. Null when no drag is in progress.
  let draggingRow = null;
  // Starts hidden every load, same as `flags` above — F1 (input.js's
  // "testOptions" action) flips it. Session-only like the rest of this file;
  // nothing here is a reason to remember it past a reload.
  let testOptionsVisible = false;

  function setSoundVolume(v) {
    soundLevel = clamp01(v);
  }

  function setMusicVolume(v) {
    volume = clamp01(v);
  }

  function toggleTestRow(row) {
    flags[row.key] = !flags[row.key];
  }

  // Called every time main.js switches the screen TO this menu. Resets the
  // cursor to row 0 so the player always lands on START GAME / CONTINUE,
  // never mid-way through the options from a previous visit.
  function open(newMode) {
    mode = newMode;
    selected = 0;
    draggingRow = null;
  }

  // Returns { confirmed, moved, soundAdjusted, toggled } — main.js reads all
  // four
  // to decide which Phase 8 step 5 menu SFX (audio/menusfx.js's MENU_SOUND)
  // to play; this module still never touches audio itself (see the header).
  // `confirmed` is true on the ONE tick row 0 (START GAME/CONTINUE/RESTART)
  // is confirmed — the same signal main.js's state machine has always read,
  // just no longer the return value's ENTIRE shape. `moved` is true the tick
  // the keyboard cursor actually stepped (up/down); `soundAdjusted` is true
  // the tick the SOUND row specifically changed (keyboard step or an active
  // mouse drag) — MUSIC-row changes are deliberately NOT reported here, since
  // the music itself is that slider's own preview (see the design brief) and
  // menu_adjust doubling it would be redundant. `toggled` is true the tick a
  // TEST ROW (testoptions.js) flipped — by a mouse click ONLY, once F1 has
  // revealed the rows (testOptionsVisible below); main.js plays the same
  // menu_adjust for it, since a toggle IS an adjustment as far as the menu's
  // own vocabulary of sounds goes, and it is reported separately only so a
  // build with the rows switched off cannot be told apart by its audio.
  // consumePress, not isDown, for
  // both nav and confirm — a held key must move the cursor (or confirm) once,
  // not every frame it's down.
  //
  // `W` is only needed to hit-test the mouse against the SOUND/MUSIC rows'
  // volume bars (barRect) — everything else here is keyboard-only and
  // doesn't care about screen size.
  function update(W) {
    let moved = false;
    let soundAdjusted = false;
    let toggled = false;

    // F1 is a plain toggle, not tied to `selected` — it can flip the rows'
    // visibility from anywhere on the menu, the same way Escape can pause
    // from anywhere in play. Hiding them again snaps the cursor off a row
    // that just stopped existing, the same clamp `open()` already does for a
    // fresh visit.
    if (consumePress("testOptions")) {
      testOptionsVisible = !testOptionsVisible;
      if (!testOptionsVisible && selected >= FIRST_TEST_ROW) selected = 0;
    }

    // The test rows NEVER join the keyboard wrap, visible or not — mouse only,
    // so an accidental Down at the wrong moment can't arm a cheat the way it
    // could if the rows sat in the same up/down cycle as SOUND/MUSIC. A click
    // can still park `selected` on one for the highlight (below); Up/Down from
    // there snap to the nearest real row rather than doing modulo arithmetic
    // against an index the wrap doesn't otherwise know about.
    if (consumePress("up")) {
      selected = selected < FIRST_TEST_ROW ? (selected + FIRST_TEST_ROW - 1) % FIRST_TEST_ROW : FIRST_TEST_ROW - 1;
      moved = true;
    }
    if (consumePress("down")) {
      selected = selected < FIRST_TEST_ROW ? (selected + 1) % FIRST_TEST_ROW : 0;
      moved = true;
    }

    // Taken ONCE, into a local, rather than consumed inside each branch that
    // wants it: consumePress is one-shot, so a `consumePress("fire") &&
    // selected === 0` test would swallow the press on every OTHER row and the
    // test rows below would never see the one aimed at them.
    const fire = consumePress("fire");
    if (fire && selected === 0) return { confirmed: true, moved, soundAdjusted, toggled };

    // SOUND/MUSIC rows: Left/Right step the volume — the same keys steerAxis
    // reads during play (input.js), safe to reuse here since the menu only
    // ever runs while the world itself is frozen (state "menu"/"paused" in
    // main.js).
    if (selected === SOUND_ROW) {
      if (consumePress("left")) { setSoundVolume(soundLevel - VOLUME_STEP); soundAdjusted = true; }
      if (consumePress("right")) { setSoundVolume(soundLevel + VOLUME_STEP); soundAdjusted = true; }
    }
    if (selected === MUSIC_ROW) {
      if (consumePress("left")) setMusicVolume(volume - VOLUME_STEP);
      if (consumePress("right")) setMusicVolume(volume + VOLUME_STEP);
    }

    // Test rows are MOUSE-ONLY (see the click handling below) — the keyboard
    // cursor can still land here for the highlight, but Left/Right do nothing
    // once it has. Still consumed rather than left alone: a press sitting in
    // the buffer would otherwise fire again on whatever row the cursor moves
    // to next (SOUND/MUSIC), same reasoning as the old toggle-by-key code
    // this replaced. `fire` needs no such guard — it was already taken,
    // unconditionally, at the top of update().
    if (TEST_ROWS[selected - FIRST_TEST_ROW]) {
      consumePress("left");
      consumePress("right");
    }

    // Mouse: either bar can be clicked or dragged directly regardless of
    // which row the keyboard cursor is currently on — clicking one also
    // moves the cursor there, same as any other row would.
    const { x, y } = mousePos();
    const clicked = consumeMouseClick();
    for (const [row, setter] of [[SOUND_ROW, setSoundVolume], [MUSIC_ROW, setMusicVolume]]) {
      const bar = barRect(W, row);
      // A few px of vertical slop around the thin bar so it isn't a
      // pixel-perfect target to grab.
      const overBar = x >= bar.x && x <= bar.x + bar.w && y >= bar.y - 6 && y <= bar.y + bar.h + 6;
      if (clicked && overBar) {
        draggingRow = row;
        selected = row;
      }
      if (draggingRow === row) {
        if (!isMouseDown()) {
          draggingRow = null;
        } else {
          // Dragging clamps to the bar's own width rather than requiring the
          // pointer stay inside it — past either edge just pins to 0%/100%,
          // the usual slider behaviour.
          setter((x - bar.x) / bar.w);
          if (row === SOUND_ROW) soundAdjusted = true;
        }
      }
    }

    // Test rows are CLICKED, not dragged — there is no continuous value to
    // track, so one click on the checkbox flips it (and moves the cursor
    // there, the same way clicking a volume bar does). Gated on visibility:
    // hidden rows still occupy testRowRect's geometry (it doesn't know about
    // F1), so without this a click in that dead patch of screen would flip a
    // flag nothing on screen claims exists.
    if (clicked && testOptionsVisible) {
      for (let i = 0; i < TEST_ROWS.length; i++) {
        const box = testRowRect(W, i);
        if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
          selected = FIRST_TEST_ROW + i;
          toggleTestRow(TEST_ROWS[i]);
          toggled = true;
        }
      }
    }

    return { confirmed: false, moved, soundAdjusted, toggled };
  }

  function render(ctx, W, H) {
    glowText(ctx, "CYBERCRUISE", W / 2, 210, GREEN_BRIGHT, 46, "center", 18);
    // Pause and gameover both reuse the exact same screen, so the subtitle is
    // the one thing that tells all three modes apart at a glance.
    const subtitle = mode === "pause" ? "PAUSED" : mode === "gameover" ? "CONNECTION LOST" : "NEON HIGHWAY COMBAT";
    glowText(ctx, subtitle, W / 2, 268, GREEN_PALE, 14, "center", 8);
    glowLine(ctx, W / 2 - 120, 302, W / 2 + 120, 302, GREEN_DIM, 1);

    // The three REAL rows only — the test checkboxes are a different size, in
    // a different place, on purpose (see CHECK_Y above), so they are drawn in
    // their own pass below rather than folded into this one.
    const rows = [ROW0_LABEL[mode], "SOUND", "MUSIC"];
    for (let i = 0; i < rows.length; i++) {
      const isSelected = i === selected;
      let label = rows[i];
      if (i === SOUND_ROW) label += `: ${Math.round(soundLevel * 100)}%`;
      if (i === MUSIC_ROW) label += `: ${Math.round(volume * 100)}%`;
      glowText(
        ctx,
        (isSelected ? "> " : "  ") + label,
        W / 2,
        MENU_START_Y + i * MENU_ROW_SPACING,
        isSelected ? PLAYER : GREEN,
        22,
        "center",
        isSelected ? 16 : 8,
      );
    }

    // SOUND/MUSIC rows' volume bars — empty track plus a filled portion, the
    // same styling main.js's HUD hull bar uses. Exactly the rects update()
    // hit-tests the mouse against (barRect), so what's drawn is always what's
    // clickable.
    for (const [row, level] of [[SOUND_ROW, soundLevel], [MUSIC_ROW, volume]]) {
      const bar = barRect(W, row);
      ctx.save();
      ctx.strokeStyle = "rgba(120,255,180,0.4)";
      ctx.lineWidth = 1;
      ctx.strokeRect(bar.x, bar.y, bar.w, bar.h);
      ctx.restore();
      if (level > 0) {
        ctx.save();
        ctx.fillStyle = GREEN_BRIGHT;
        ctx.shadowColor = GREEN_BRIGHT;
        ctx.shadowBlur = 10;
        ctx.fillRect(bar.x + 1, bar.y + 1, (bar.w - 2) * level, bar.h - 2);
        ctx.restore();
      }
    }

    // The test checkboxes — small on purpose (see CHECK_Y above), and drawn
    // at all only once F1 has set `testOptionsVisible` (see update()). Off
    // draws as an empty outline in the dimmest green the menu uses; armed
    // fills the square and lifts the whole item to the subtitle's pale
    // green, so a screen with a cheat switched on reads as unusual at a
    // glance even this small. `selected` can land here ONLY via a click
    // (FIRST_TEST_ROW.. — see update()'s wrap, which deliberately never
    // steps here), so the PLAYER highlight below is confirmation of the
    // click that just landed, not a keyboard cursor passing through.
    if (testOptionsVisible) {
      for (let i = 0; i < TEST_ROWS.length; i++) {
        const row = TEST_ROWS[i];
        const isSelected = FIRST_TEST_ROW + i === selected;
        const armed = flags[row.key];
        const box = testRowRect(W, i);
        const color = isSelected ? PLAYER : armed ? GREEN_PALE : GREEN_DIM;

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(box.x, CHECK_Y, CHECK_BOX, CHECK_BOX);
        if (armed) {
          ctx.fillStyle = color;
          ctx.shadowColor = color;
          ctx.shadowBlur = 4;
          ctx.fillRect(box.x + 2, CHECK_Y + 2, CHECK_BOX - 4, CHECK_BOX - 4);
        }
        ctx.restore();

        const label = `${row.label}: ${armed ? "ON" : "OFF"}`;
        glowText(ctx, label, box.x + CHECK_BOX + CHECK_GAP, CHECK_Y - 1, color, CHECK_FONT, "left", isSelected ? 6 : 0);
      }
    }

    // The footer doubles as the warning that this build has cheats in it —
    // switching them off in testoptions.js takes the line with them.
    const footer = TEST_ROWS.length
      ? "TEST BUILD — SEE src/testoptions.js"
      : "MORE OPTIONS COMING SOON";
    glowText(ctx, footer, W / 2, H - 40, GREEN_DIM, 12, "center", 6);
  }

  // Read-only peek at the MUSIC volume for main.js to hand to the audio
  // engine (src/audio/synth.js) — this module still never touches audio
  // itself, see the header; it only exposes the level whoever else needs it.
  function musicVolume() {
    return volume;
  }

  // Same read-only peek as musicVolume(), for the SOUND level — main.js uses
  // this to scale src/audio/synth.js's one-shot SFX (playDisconnect).
  function soundVolume() {
    return soundLevel;
  }

  // The test rows' state, read by main.js the same read-only way the two
  // volume levels above are — this module applies nothing itself, it only
  // reports which rows are armed. FALSE whenever the row is not compiled in
  // (testoptions.js), since `flags` only ever holds entries for rows that
  // exist.
  function invulnerable() {
    return flags.invulnerable === true;
  }

  function extraCash() {
    return flags.extraCash === true;
  }

  return { open, update, render, musicVolume, soundVolume, invulnerable, extraCash };
}
