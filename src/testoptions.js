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

// MILESTONE OVERRIDES: pull a one-shot encounter (game/eventtypes.js's `at`)
// forward so it can be reached in seconds instead of driven to. Keyed by event
// id; anything not listed fires at its catalogue figure.
//
// WHY IT LIVES HERE AND NOT IN THE CATALOGUE. Editing `at` directly would work
// exactly once and then be a number nobody remembers to put back — and worse,
// test/events.test.js reads the catalogue to check that an encounter never
// stages a car the road has not unlocked yet, so a boss temporarily moved to
// DIST 150 would either fail the suite or teach somebody to weaken the
// invariant. The catalogue therefore always states what SHIPS, the suite always
// checks what ships, and the override is applied by the director at the one
// place it decides a milestone is due (game/events.js's dueMilestone).
//
// SHIPPING A BUILD: empty this object. It is guarded by SHOW_TEST_OPTIONS above
// like everything else in this file, so switching the master flag off already
// restores every catalogue figure — but an empty object is what the file is
// supposed to look like at rest.
//
//   export const EVENT_AT_OVERRIDES = {};

// GATE OVERRIDES: the same idea for a ROLLED encounter, whose trigger is not a
// milestone but game/eventtypes.js's `minDistance`. Keyed by event id; anything
// not listed is eligible at its catalogue figure.
//
// WHY A SECOND MAP AND NOT ONE. They override different fields on different
// kinds of entry, and they are read in different places — `at` by the director
// when it decides a milestone is due, `minDistance` by eventAvailable() when it
// decides what may be DRAWN. Folding them into one object would mean one key
// that means "fires at" for a set-piece and "unlocks at" for a rolled entry,
// which is two meanings wearing one name.
//
// EVERYTHING THE MAP ABOVE SAYS APPLIES HERE. The catalogue always states what
// SHIPS, the suite always checks what ships (test/events.test.js clears both
// maps before it runs a single test), and this file is where a number gets
// pulled forward to be looked at by hand.
//
// A ROLLED ENTRY BROUGHT FORWARD MAY STAGE A TYPE THE ROAD HAS NOT UNLOCKED —
// the slalom below is tetras, gated at 1200 in obstacletypes.js — and that is
// the point of the override rather than a hole in the invariant: the invariant
// is about what the CATALOGUE says, and the catalogue still says 1500.
//
//   export const EVENT_GATE_OVERRIDES = {};   // ship it like this
//
// EMPTY, which is how this ships. Every rolled encounter unlocks at the
// distance its catalogue entry names. Put an id in here to reach a new one
// quickly by hand:
//
//   export const EVENT_GATE_OVERRIDES = { slalom: 150 };  // the weave at once
export const EVENT_GATE_OVERRIDES = {};   // ship it like this
//
// EMPTY, which is how this ships. Every encounter fires at the distance its
// catalogue entry names. Put an id in here to reach one quickly by hand:
//
//   export const EVENT_AT_OVERRIDES = { siege: 150 };  // the boss in seconds
export const EVENT_AT_OVERRIDES = {};
