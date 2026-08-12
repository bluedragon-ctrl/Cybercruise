// Maps a menu action (a UI gesture on the START/PAUSE/GAMEOVER screen — see
// game/menu.js's own header for why one screen serves all three) to the
// audio/soundtypes.js id it should play. Mirrors audio/weaponsfx.js's shape
// exactly — a small table keyed by a name main.js already has in hand — but
// the "catalogue" it's keyed against is hand-written (MENU_ACTIONS below)
// rather than derived from another file's own list the way WEAPON_TYPES/
// ENEMY_WEAPON_TYPES drive weaponsfx.js's coverage: menu.js's own gestures
// (a cursor step, a confirm, an adjust, a back-out) aren't rows in any
// existing catalogue, so MENU_ACTIONS IS the canonical list here, and
// test/invariants.test.js checks MENU_SOUND covers it exactly (no missing
// action, no orphaned key) the same way it checks PLAYER_FIRE_SOUND against
// WEAPON_TYPES.
//
// menu.js ITSELF never calls this, or anything else in audio/ — see its own
// header ("this module never touches audio itself... main.js just asks
// update()"). main.js reads menu.js's update() result (moved/soundAdjusted/
// confirmed) and main.js's own state machine (the ESC-to-resume "back" case)
// and decides which of these to play — the same wiring pattern sectors.js's
// own crossing uses (main.js, not sectors.js, plays sector_shift and drives
// the filter collapse).
export const MENU_ACTIONS = ["move", "confirm", "back", "adjust"];

export const MENU_SOUND = {
  move: "menu_move",
  confirm: "menu_confirm",
  back: "menu_back",
  adjust: "menu_adjust",
};
