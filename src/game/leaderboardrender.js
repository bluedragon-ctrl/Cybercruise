// The shared top-10 board's on-screen half: one pure function, paired with
// leaderboard.js the way walletrender.js is paired with wallet.js (that
// file's own header has the fuller argument for the split) — this takes the
// cached list leaderboard.js already fetched and turns it into ink, and
// knows nothing about fetching, caching or the worker behind either.
//
// WHERE IT SITS. main.js calls draw() after menu.js's own render(), on both
// "menu" and "gameover" — the same "world/network state drawn on top of
// menu.js" pattern main.js already uses for the FINAL SCORE line, since
// menu.js documents that it never touches anything outside its own UI state.
// The column is centred on the screen's 3/4 line (PANEL_HALF_W each side of
// it) to balance menu.js's own CONNECT/RECONNECT/SOUND/MUSIC stack, which
// centres on the 1/4 line in those same two modes for the same reason (see
// menu.js's rowCx) — split the screen into quarters and each block sits on
// the line between its own pair. Vertically it clears the title/subtitle/rows entirely,
// sits below the gameover screen's centred FINAL SCORE/CREDITS EARNED lines,
// and stops well above the test checkboxes/footer (y >= 732).
//
// SMALL, DELIBERATELY — glowText's HUD-font path (as the checkboxes and
// footer already use), not the vector display type: this is a glance, not a
// second headline competing with CONNECT/RECONNECT.

import { glowText } from "../engine/neon.js";
import { GREEN_PALE, GREEN_DIM, GREEN } from "../engine/palette.js";

const HEADING_Y = 360;
const ROW_START_Y = 384;
const ROW_PITCH = 20;
const NAME_FONT = 11;
const PANEL_HALF_W = 70; // half the rank/name..score column width, each side of the 3/4 line

// `entries` is leaderboard.js's getCached() result: null before the first
// fetch resolves, [] for a confirmed-empty board, else score-descending
// {name, score} objects. All three are drawn distinctly so a slow network
// doesn't read as "the board really is empty".
export function draw(hudCtx, W, H, entries) {
  const panelX = (3 * W) / 4 - PANEL_HALF_W; // left edge of the rank/name column
  const scoreX = (3 * W) / 4 + PANEL_HALF_W; // right edge of the score column

  glowText(hudCtx, "TOP 10", panelX, HEADING_Y, GREEN_PALE, 13, "left", 6, true);

  if (entries === null) {
    glowText(hudCtx, "LOADING...", panelX, ROW_START_Y, GREEN_DIM, NAME_FONT, "left", 4);
    return;
  }
  if (entries.length === 0) {
    glowText(hudCtx, "NO SCORES YET", panelX, ROW_START_Y, GREEN_DIM, NAME_FONT, "left", 4);
    return;
  }

  for (let i = 0; i < entries.length; i++) {
    const y = ROW_START_Y + i * ROW_PITCH;
    const rank = `${i + 1}`.padStart(2, " ");
    glowText(hudCtx, `${rank} ${entries[i].name}`, panelX, y, GREEN, NAME_FONT, "left", 4);
    glowText(hudCtx, `${entries[i].score}`, scoreX, y, GREEN, NAME_FONT, "right", 4);
  }
}
