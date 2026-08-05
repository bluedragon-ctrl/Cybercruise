// Start screen AND pause screen — the same menu, reused for both.
//
// This module owns UI state ONLY — it never touches the world in game/*.js
// and knows nothing about "playing" a game. main.js just asks update() "did
// the player confirm row 0 this tick?" and switches its own top-level state
// (to "playing" whether that came from START GAME or CONTINUE) the moment it
// says yes; everything else (player, traffic, score...) is main.js's
// business, not this module's.
//
// `open(mode)` picks which of the two contexts row 0 reads as — "start"
// labels it START GAME, "pause" labels it CONTINUE — and resets the cursor
// to it, so re-entering the pause screen always lands back on the row that
// resumes play rather than wherever the cursor was left last time.
//
// SOUND doesn't drive anything yet (no SFX engine); MUSIC does, via
// musicOn() below — main.js reads it to gate src/audio/synth.js. Both flags
// are persisted regardless, so a future SFX engine will just read localStorage
// on startup instead of needing its own UI.

import { consumePress } from "../engine/input.js";
import { glowText, glowLine } from "../engine/neon.js";
import { GREEN, GREEN_DIM, GREEN_PALE, GREEN_BRIGHT, PLAYER } from "../engine/palette.js";

const SOUND_KEY = "cybercruise.sound";
const MUSIC_KEY = "cybercruise.music";

function loadFlag(key) {
  // Absent key (first visit) defaults ON; anything else is exactly what was
  // last saved.
  const v = localStorage.getItem(key);
  return v === null ? true : v === "1";
}

function saveFlag(key, value) {
  localStorage.setItem(key, value ? "1" : "0");
}

// Row 0 is the only one that ever ends update() with `true`; rows 1-2 toggle
// a flag in place and the menu stays up. Its label is the only thing that
// differs between the two modes — see the header.
const ROW0_LABEL = { start: "START GAME", pause: "CONTINUE" };
const ROW_COUNT = 3; // row 0 (see above), SOUND, MUSIC

export function createMenu() {
  let selected = 0;
  let mode = "start"; // "start" | "pause"
  let sound = loadFlag(SOUND_KEY);
  let music = loadFlag(MUSIC_KEY);

  // Called every time main.js switches the screen TO this menu. Resets the
  // cursor to row 0 so the player always lands on START GAME / CONTINUE,
  // never mid-way through the options from a previous visit.
  function open(newMode) {
    mode = newMode;
    selected = 0;
  }

  // Returns true on the ONE tick row 0 (START GAME or CONTINUE) is
  // confirmed. consumePress, not isDown, for both nav and confirm — a held
  // key must move the cursor (or confirm) once, not every frame it's down.
  function update() {
    if (consumePress("up")) selected = (selected + ROW_COUNT - 1) % ROW_COUNT;
    if (consumePress("down")) selected = (selected + 1) % ROW_COUNT;

    if (consumePress("fire")) {
      if (selected === 0) return true;
      if (selected === 1) { sound = !sound; saveFlag(SOUND_KEY, sound); }
      if (selected === 2) { music = !music; saveFlag(MUSIC_KEY, music); }
    }
    return false;
  }

  function render(ctx, W, H) {
    glowText(ctx, "CYBERCRUISE", W / 2, 210, GREEN_BRIGHT, 46, "center", 18);
    // Pause reuses the exact same screen, so the subtitle is the one thing
    // that tells the two apart at a glance.
    glowText(ctx, mode === "pause" ? "PAUSED" : "NEON HIGHWAY COMBAT", W / 2, 268, GREEN_PALE, 14, "center", 8);
    glowLine(ctx, W / 2 - 120, 302, W / 2 + 120, 302, GREEN_DIM, 1, 6);

    const rows = [ROW0_LABEL[mode], "SOUND", "MUSIC"];
    const startY = 420;
    const spacing = 52;
    for (let i = 0; i < rows.length; i++) {
      const isSelected = i === selected;
      let label = rows[i];
      if (i === 1) label += `: ${sound ? "ON" : "OFF"}`;
      if (i === 2) label += `: ${music ? "ON" : "OFF"}`;
      glowText(
        ctx,
        (isSelected ? "> " : "  ") + label,
        W / 2,
        startY + i * spacing,
        isSelected ? PLAYER : GREEN,
        22,
        "center",
        isSelected ? 16 : 8,
      );
    }

    glowText(ctx, "MORE OPTIONS COMING SOON", W / 2, H - 40, GREEN_DIM, 12, "center", 6);
  }

  // Read-only peek at the MUSIC flag for main.js to hand to the audio engine
  // (src/audio/synth.js) — this module still never touches audio itself, see
  // the header; it only exposes the flag whoever else needs it.
  function musicOn() {
    return music;
  }

  return { open, update, render, musicOn };
}
