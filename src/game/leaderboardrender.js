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
// The column (x 445..585, y 360..700) was measured against menu.js's actual
// layout: it clears the title/subtitle/rows entirely, sits below the
// gameover screen's centred FINAL SCORE/CREDITS EARNED lines (~x 157..443),
// and stops well above the test checkboxes/footer (y >= 732). On the RIGHT
// rather than the left — a plain preference, not a layout constraint; the
// mirror-image left column would fit exactly as cleanly.
//
// SMALL, DELIBERATELY — glowText's HUD-font path (as the checkboxes and
// footer already use), not the vector display type: this is a glance, not a
// second headline competing with CONNECT/RECONNECT.

import { glowText } from "../engine/neon.js";
import { GREEN_PALE, GREEN_DIM, GREEN } from "../engine/palette.js";

const PANEL_X = 445; // left edge of the rank/name column
const HEADING_Y = 360;
const ROW_START_Y = 384;
const ROW_PITCH = 20;
const NAME_FONT = 11;
const SCORE_X = 585; // right edge of the score column, mirrors PANEL_X's margin off x=600

// `entries` is leaderboard.js's getCached() result: null before the first
// fetch resolves, [] for a confirmed-empty board, else score-descending
// {name, score} objects. All three are drawn distinctly so a slow network
// doesn't read as "the board really is empty".
export function draw(hudCtx, W, H, entries) {
  glowText(hudCtx, "TOP 10", PANEL_X, HEADING_Y, GREEN_PALE, 13, "left", 6, true);

  if (entries === null) {
    glowText(hudCtx, "LOADING...", PANEL_X, ROW_START_Y, GREEN_DIM, NAME_FONT, "left", 4);
    return;
  }
  if (entries.length === 0) {
    glowText(hudCtx, "NO SCORES YET", PANEL_X, ROW_START_Y, GREEN_DIM, NAME_FONT, "left", 4);
    return;
  }

  for (let i = 0; i < entries.length; i++) {
    const y = ROW_START_Y + i * ROW_PITCH;
    const rank = `${i + 1}`.padStart(2, " ");
    glowText(hudCtx, `${rank} ${entries[i].name}`, PANEL_X, y, GREEN, NAME_FONT, "left", 4);
    glowText(hudCtx, `${entries[i].score}`, SCORE_X, y, GREEN, NAME_FONT, "right", 4);
  }
}
