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

const SOUND_KEY = "cybercruise.sound";
const MUSIC_KEY = "cybercruise.music";

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

// Row 0 is the only one that ever ends update() with `true`; rows 1-2 are
// volume sliders that adjust in place and leave the menu up. Row 0's label is
// the only thing that differs between the three modes — see the header.
const ROW0_LABEL = { start: "START GAME", pause: "CONTINUE", gameover: "RESTART" };
const ROW_COUNT = 3; // row 0 (see above), SOUND, MUSIC
const SOUND_ROW = 1;
const MUSIC_ROW = 2;
const VOLUME_STEP = 0.1;

// SOUND/MUSIC rows' volume bar geometry, shared between render() (drawing)
// and update() (mouse hit-testing) so the clickable area can never drift from
// what's actually drawn.
const MENU_START_Y = 420;
const MENU_ROW_SPACING = 52;
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

  // Called every time main.js switches the screen TO this menu. Resets the
  // cursor to row 0 so the player always lands on START GAME / CONTINUE,
  // never mid-way through the options from a previous visit.
  function open(newMode) {
    mode = newMode;
    selected = 0;
    draggingRow = null;
  }

  // Returns { confirmed, moved, soundAdjusted } — main.js reads all three
  // to decide which Phase 8 step 5 menu SFX (audio/menusfx.js's MENU_SOUND)
  // to play; this module still never touches audio itself (see the header).
  // `confirmed` is true on the ONE tick row 0 (START GAME/CONTINUE/RESTART)
  // is confirmed — the same signal main.js's state machine has always read,
  // just no longer the return value's ENTIRE shape. `moved` is true the tick
  // the keyboard cursor actually stepped (up/down); `soundAdjusted` is true
  // the tick the SOUND row specifically changed (keyboard step or an active
  // mouse drag) — MUSIC-row changes are deliberately NOT reported here, since
  // the music itself is that slider's own preview (see the design brief) and
  // menu_adjust doubling it would be redundant. consumePress, not isDown, for
  // both nav and confirm — a held key must move the cursor (or confirm) once,
  // not every frame it's down.
  //
  // `W` is only needed to hit-test the mouse against the SOUND/MUSIC rows'
  // volume bars (barRect) — everything else here is keyboard-only and
  // doesn't care about screen size.
  function update(W) {
    let moved = false;
    let soundAdjusted = false;

    if (consumePress("up")) { selected = (selected + ROW_COUNT - 1) % ROW_COUNT; moved = true; }
    if (consumePress("down")) { selected = (selected + 1) % ROW_COUNT; moved = true; }

    if (consumePress("fire") && selected === 0) return { confirmed: true, moved, soundAdjusted };

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

    return { confirmed: false, moved, soundAdjusted };
  }

  function render(ctx, W, H) {
    glowText(ctx, "CYBERCRUISE", W / 2, 210, GREEN_BRIGHT, 46, "center", 18);
    // Pause and gameover both reuse the exact same screen, so the subtitle is
    // the one thing that tells all three modes apart at a glance.
    const subtitle = mode === "pause" ? "PAUSED" : mode === "gameover" ? "CONNECTION LOST" : "NEON HIGHWAY COMBAT";
    glowText(ctx, subtitle, W / 2, 268, GREEN_PALE, 14, "center", 8);
    glowLine(ctx, W / 2 - 120, 302, W / 2 + 120, 302, GREEN_DIM, 1, 6);

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

    glowText(ctx, "MORE OPTIONS COMING SOON", W / 2, H - 40, GREEN_DIM, 12, "center", 6);
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

  return { open, update, render, musicVolume, soundVolume };
}
