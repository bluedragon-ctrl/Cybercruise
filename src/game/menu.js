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
// its music volume respectively. Both are 0..1 sliders, persisted the same
// way, regardless of which is read where.
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
import {
  SHOW_TEST_OPTIONS,
  SHOW_INVULNERABILITY_OPTION,
  SHOW_EXTRA_CASH_OPTION,
} from "../testoptions.js";

const SOUND_KEY = "cybercruise.sound";
const MUSIC_KEY = "cybercruise.music";
const INVULNERABLE_KEY = "cybercruise.test.invulnerable";
const EXTRA_CASH_KEY = "cybercruise.test.extracash";

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// Volume is stored as a "0".."1" string under the same keys the old SOUND
// on/off flag and MUSIC level used — both previously saved "1"/"0", which
// parse back as 1/0 here, so a value saved before either was a slider just
// loads as 100%/0% with no migration needed.
function loadVolume(key) {
  const v = localStorage.getItem(key);
  if (v === null) return 1;
  const n = parseFloat(v);
  return Number.isFinite(n) ? clamp01(n) : 1;
}

function saveVolume(key, value) {
  localStorage.setItem(key, String(value));
}

// The test rows' on/off state, persisted under their own keys so a testing
// session survives a reload. Stored as "1"/"0" rather than the volume rows'
// "0".."1" string, because these are flags and reading one back as a level
// would be a category error waiting to happen.
function loadFlag(key) {
  return localStorage.getItem(key) === "1";
}

function saveFlag(key, value) {
  localStorage.setItem(key, value ? "1" : "0");
}

// Row geometry, shared by everything that draws a row or hit-tests a click
// against one — the volume bars (barRect) and the test rows (testRowRect)
// below both hang off it, so what's drawn can never drift from what's
// clickable.
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
      SHOW_INVULNERABILITY_OPTION && { key: "invulnerable", label: "INVULNERABILITY", storeKey: INVULNERABLE_KEY },
      SHOW_EXTRA_CASH_OPTION && { key: "extraCash", label: "EXTRA CASH", storeKey: EXTRA_CASH_KEY },
    ].filter(Boolean);

// row 0 (see above), SOUND, MUSIC, then whichever test rows are compiled in.
const FIRST_TEST_ROW = 3;
const ROW_COUNT = FIRST_TEST_ROW + TEST_ROWS.length;

// The clickable box around a test row's label — deliberately generous, since
// unlike the volume bars there is nothing drawn to aim at but the text itself.
const TEST_ROW_W = 320;
const TEST_ROW_H = 34;
function testRowRect(W, row) {
  const rowY = MENU_START_Y + row * MENU_ROW_SPACING;
  return { x: W / 2 - TEST_ROW_W / 2, y: rowY - TEST_ROW_H + 8, w: TEST_ROW_W, h: TEST_ROW_H };
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
  let soundLevel = loadVolume(SOUND_KEY);
  let volume = loadVolume(MUSIC_KEY);
  // One entry per COMPILED-IN test row, keyed by its `key`. A row that is not
  // compiled in has no entry, and its accessor below reports false — see the
  // TEST_ROWS comment on why a stale localStorage value must not leak into a
  // build that dropped the row.
  const flags = {};
  for (const row of TEST_ROWS) flags[row.key] = loadFlag(row.storeKey);
  // Which row's bar (if any) a drag that STARTED on it is currently
  // controlling — a click that lands elsewhere and drags onto a bar must not
  // suddenly grab it, same reasoning a native slider only tracks drags it
  // originated. Null when no drag is in progress.
  let draggingRow = null;

  function setSoundVolume(v) {
    soundLevel = clamp01(v);
    saveVolume(SOUND_KEY, soundLevel);
  }

  function setMusicVolume(v) {
    volume = clamp01(v);
    saveVolume(MUSIC_KEY, volume);
  }

  function toggleTestRow(row) {
    flags[row.key] = !flags[row.key];
    saveFlag(row.storeKey, flags[row.key]);
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
  // TEST ROW (testoptions.js) flipped, by key or by click — main.js plays the
  // same menu_adjust for it, since a toggle IS an adjustment as far as the
  // menu's own vocabulary of sounds goes, and it is reported separately only
  // so a build with the rows switched off cannot be told apart by its audio.
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

    if (consumePress("up")) { selected = (selected + ROW_COUNT - 1) % ROW_COUNT; moved = true; }
    if (consumePress("down")) { selected = (selected + 1) % ROW_COUNT; moved = true; }

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

    // Test rows: an on/off row, so all three keys that mean "act on this row"
    // do the same single thing. Fire is included because row 0 is the only
    // place it means "confirm and leave" (handled above and already returned
    // from), which leaves it free to mean "flip this" everywhere else.
    const selectedTestRow = TEST_ROWS[selected - FIRST_TEST_ROW];
    if (selectedTestRow) {
      // Left and right consumed unconditionally rather than short-circuited: a
      // press left sitting in the buffer would fire again on whatever row the
      // cursor moved to next. `fire` was already taken at the top of update().
      const left = consumePress("left");
      const right = consumePress("right");
      if (left || right || fire) {
        toggleTestRow(selectedTestRow);
        toggled = true;
      }
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
    // track, so one click on the label flips it (and moves the cursor there,
    // the same way clicking a volume bar does).
    if (clicked) {
      for (let i = 0; i < TEST_ROWS.length; i++) {
        const row = FIRST_TEST_ROW + i;
        const box = testRowRect(W, row);
        if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
          selected = row;
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
    glowLine(ctx, W / 2 - 120, 302, W / 2 + 120, 302, GREEN_DIM, 1, 6);

    const rows = [ROW0_LABEL[mode], "SOUND", "MUSIC", ...TEST_ROWS.map((r) => r.label)];
    for (let i = 0; i < rows.length; i++) {
      const isSelected = i === selected;
      let label = rows[i];
      if (i === SOUND_ROW) label += `: ${Math.round(soundLevel * 100)}%`;
      if (i === MUSIC_ROW) label += `: ${Math.round(volume * 100)}%`;
      const testRow = TEST_ROWS[i - FIRST_TEST_ROW];
      if (testRow) label += flags[testRow.key] ? ": ON" : ": OFF";
      glowText(
        ctx,
        (isSelected ? "> " : "  ") + label,
        W / 2,
        MENU_START_Y + i * MENU_ROW_SPACING,
        // An ARMED test row draws in the same pale green the subtitle uses
        // rather than the row colour, so a screen with a cheat switched on
        // never reads as an ordinary one at a glance.
        isSelected ? PLAYER : testRow && flags[testRow.key] ? GREEN_PALE : GREEN,
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
  // exist; a build that dropped a row cannot be cheated by a leftover
  // localStorage value.
  function invulnerable() {
    return flags.invulnerable === true;
  }

  function extraCash() {
    return flags.extraCash === true;
  }

  return { open, update, render, musicVolume, soundVolume, invulnerable, extraCash };
}
