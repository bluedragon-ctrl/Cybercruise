// TEST OPTIONS — the cheat rows on the start/pause menu, and the switch that
// decides whether they are there at all.
//
// These exist to make the game TESTABLE by hand: a run that cannot be killed
// is how you inspect a sector twenty minutes deep, and a wallet that starts
// full is how you look at the shop's top tier without grinding to it. They are
// not a difficulty setting and they are not meant to ship switched on.
//
// SHIPPING A BUILD: set SHOW_TEST_OPTIONS to false. That alone removes both
// rows from game/menu.js — the menu builds its row list from these flags, so
// nothing else has to be edited and nothing is left half-wired. main.js still
// asks the menu whether each cheat is armed, and with the rows gone the answer
// is always false, whatever a previous session happened to leave in
// localStorage.
//
// Everything here is a knob, exactly like game/tuning.js: no behaviour of its
// own lives in this file, only the numbers and the flags the two consumers
// (game/menu.js for the rows, main.js for applying them) read.

// The master switch. False removes EVERY test row from the menu regardless of
// the two per-option flags below.
export const SHOW_TEST_OPTIONS = true;

// INVULNERABILITY: the car takes no hull damage at all — every source funnels
// through Player.damage(), so the flag is honoured there once and covers
// bullets, blasts, ramming and wall-scrape alike. Speed is still scrubbed by a
// scrape, because a car that cannot be slowed cannot be driven badly and the
// point is to test the road, not to fly over it.
export const SHOW_INVULNERABILITY_OPTION = true;

// EXTRA CASH: credits granted the moment the option is armed, so the shop can
// be walked end to end. Granted ONCE per run per arming — switching the row off
// and back on pays again, which is the behaviour you want when a test spends
// the lot and needs another float.
export const SHOW_EXTRA_CASH_OPTION = true;
export const EXTRA_CASH_AMOUNT = 999999;
