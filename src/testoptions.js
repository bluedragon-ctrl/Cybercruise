// TEST OPTIONS — the dev panel's knobs, and the switch that decides whether the
// panel exists at all.
//
// These exist to make the game TESTABLE by hand: a run that cannot be killed is
// how you inspect a sector twenty minutes deep, a wallet you can set to any
// figure is how you look at the shop's top tier without grinding to it, and a
// distance you can set is how you look at the late road without driving to it.
// They are not a difficulty setting and they are not meant to ship switched on.
//
// SHIPPING A BUILD: set SHOW_TEST_OPTIONS to false. That alone removes the
// panel — main.js stops answering F1 and stops importing anything the panel
// applies, and game/events.js/eventtypes.js go back to reading the catalogue
// whatever the override maps below still contain. One flag, no half-wiring;
// test/test-options.test.js is what pins that.
//
// ONE SCREEN OF ITS OWN, NOT ROWS ON THE MENU. The cheats used to live at the
// foot of game/menu.js's start/pause screen, hidden until F1 and armed by mouse
// click only — two guards that existed solely because they shared a screen with
// SOUND and MUSIC, where a stray Down could otherwise arm one. On a screen where
// EVERY row is a cheat there is nothing to protect: F1 opens it from the menu,
// from play or from pause, it is ordinary keyboard-navigable, and menu.js is
// just the options menu again. See game/testpanel.js.
//
// Everything here is a knob, exactly like game/tuning.js: no behaviour of its
// own lives in this file, only the numbers and the flags its consumers
// (game/testpanel.js for the rows, main.js for applying them, game/events.js
// and game/eventtypes.js for the override maps) read.

// The master switch. False removes the whole panel and every override below.
export const SHOW_TEST_OPTIONS = true;

// GL PRESENT: whether present() (src/engine/present.js) runs the bloom chain —
// bright-pass, blur, composite — over the uploaded frame, or skips straight to
// a plain blit of it with none of that.
//
// NOT A CHEAT, AND IT SHIPS ON. It is here because Phase 15's whole premise is
// that bloom can be A/B'd, and this file is the place a switch is reachable
// without hunting through the engine. It is deliberately NOT gated by
// SHOW_TEST_OPTIONS above and has no panel row: SHOW_TEST_OPTIONS false is
// "ship it", and shipping must not silently take the renderer with it.
//
// WHAT "OFF" MEANS CHANGED IN PHASE 15D-I, AND IT IS WORTH KNOWING WHY. Before
// 15d-i, off was the whole game exactly as it shipped through Phase 14: no
// WebGL2 canvas at all, the 2D canvas shown directly — the honest zero-bloom
// comparison, because there was nothing else the GPU path was doing yet. THAT
// MACHINE NO LONGER EXISTS: WebGL2 is required to run the game at all now (see
// src/engine/gl/context.js's header for why, and what a machine without it
// sees instead), so "off" can no longer mean "skip the GPU pass" — it means
// "take the GPU pass, skip bloom". The frame is still uploaded and still
// blitted through WebGL2 either way (present.js's own PRESENT_FS, the same
// 15a no-op blit); only the bright-pass/blur/composite passes are what this
// flag removes. Still useful for exactly what it always was — comparing the
// look with bloom against without it — just no longer a comparison against a
// renderer that does not require a GPU at all.
//
// WHAT "OFF" DOES *NOT* REMOVE, AS OF PHASE 15E-I, and this is the third time
// this comment has had to be rewritten. The present chain now carries GAME
// VISUALS as well as bloom: the jack-in and the disconnect are a fragment pass
// in it (src/engine/gl/shaders.js's GLITCH_FS), not Canvas2D any more. That
// pass runs whatever this flag says, because the flag's whole job is to A/B a
// HALO — and a switch that also deleted the boot and the death would be useless
// during exactly the two moments it was flipped to look at. So "off" is still
// precisely "skip bright-pass/blur/composite"; everything else the chain does
// is unaffected.
//
// A context lost mid-run, or no WebGL2 at boot, are not states this flag ever
// controlled and still are not: present.js answers both on its own now,
// with a message rather than a fallback — see its header.
export const GL_PRESENT = true;

// --- The panel's own numbers -------------------------------------------------

// EXTRA CASH: what the CREDITS row is pre-loaded with EVERY time the panel
// opens, so the common case — "give me everything" — is F1, Down, FIRE. It does
// not seed from the live balance, because the live balance is printed in the
// readouts a few lines under the row anyway. Asserted by
// test/test-options.test.js to cover every upgrade in the shop at every tier,
// because walking the shop end to end is the entire point of the row.
export const EXTRA_CASH_AMOUNT = 999999;

// How far one tap of Left/Right moves each number row. HELD, the step is
// multiplied by HOLD_MULTIPLIER after HOLD_ACCEL_AT seconds (game/testpanel.js's
// own repeat code) — a tap is for the exact figure, a hold is for the order of
// magnitude, and between them neither row ever needs a text field on a canvas.
//
// The DISTANCE step is in DIST units (road.js's DIST_UNITS), the same figure the
// HUD's own DIST readout prints, so what the row says and what the HUD says
// after a warp are the same number rather than two scales to convert between.
export const CREDITS_STEP = 1000;
export const DISTANCE_STEP = 10;

// --- The encounter overrides -------------------------------------------------
//
// MILESTONE OVERRIDES: pull a one-shot encounter (game/eventtypes.js's `at`)
// forward so it fires at a distance you can reach in seconds. Keyed by event id;
// anything not listed fires at its catalogue figure.
//
// STILL WORTH HAVING NOW THE PANEL CAN WARP. A warp reaches the DISTANCE an
// encounter fires at; this reaches the ENCOUNTER without moving the world's
// clock, which is what you want when the thing under test is the fight rather
// than the road it happens on — a boss at DIST 0 is fought in a stock car on a
// road with the right traffic for DIST 0, and that is a different test from the
// same boss found by warping to DIST 900. The panel's PASSED EVENTS row (see
// game/testpanel.js) is the third case: warp there and let everything below fire
// on the way past.
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
// SHIPPING A BUILD: empty both maps. They are guarded by SHOW_TEST_OPTIONS above
// like everything else here, so switching the master flag off already restores
// every catalogue figure — but empty is what the file is supposed to look like
// at rest.
//
// EMPTY, which is how this ships. Put an id in here to reach one in seconds:
//
//   export const EVENT_AT_OVERRIDES = { siege: 150 };  // the boss at once
export const EVENT_AT_OVERRIDES = {};

// GATE OVERRIDES: the same idea for a ROLLED encounter, whose trigger is not a
// milestone but game/eventtypes.js's `minDistance`. Keyed by event id; anything
// not listed is eligible at its catalogue figure.
//
// A SECOND MAP, because the two override different fields read in different
// places: `at` by the director deciding a milestone is due, `minDistance` by
// eventAvailable() deciding what may be DRAWN. One key meaning "fires at" for a
// set-piece and "unlocks at" for a rolled entry is two meanings wearing one name.
//
// Everything the map above says applies here, including that the suite clears
// both before it runs a single test. An entry brought forward may stage a type
// the ambient road has not unlocked, which is the point of the override — the
// invariant is about what the catalogue says, and the catalogue is unchanged.
//
//   export const EVENT_GATE_OVERRIDES = { slalom: 150 };  // the weave at once
export const EVENT_GATE_OVERRIDES = {};
