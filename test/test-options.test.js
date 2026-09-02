// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// THE TEST OPTIONS (src/testoptions.js): the two cheat rows on the menu, and
// the claim that file's header makes — that switching a flag off there is the
// WHOLE removal, with nothing left half-wired behind it.
//
// Three things are pinned here:
//
//   1. The invulnerability flag really is a no-op on every damage source,
//      because every source funnels through Player.damage() (player.js's own
//      header), and it does not spend a banked shield on hits it swallowed.
//   2. menu.js builds its rows from testoptions.js, so a row that is compiled
//      in has an accessor that can flip, and the row count the cursor wraps
//      against grows with it.
//   3. The accessors report a plain boolean, since main.js assigns
//      menu.invulnerable() straight onto the player.
//
// It runs headless. menu.js reaches the browser only through the 2D context it
// is handed, so a recording context is enough — the same arrangement
// shop-screen.test.js uses for the shop. Neither the volume sliders nor the
// test rows touch localStorage any more (menu.js's own NOT PERSISTED note),
// so no stub store is needed here.

import test from "node:test";
import assert from "node:assert/strict";

import { Player } from "../src/game/player.js";
import { initInput } from "../src/engine/input.js";
import { initMouse } from "../src/engine/mouse.js";
import {
  SHOW_TEST_OPTIONS,
  SHOW_INVULNERABILITY_OPTION,
  SHOW_EXTRA_CASH_OPTION,
  EXTRA_CASH_AMOUNT,
} from "../src/testoptions.js";

const { createMenu, testRowRect } = await import("../src/game/menu.js");

// --- 1. Invulnerability -----------------------------------------------------

test("an invulnerable car loses no hull to any damage source", () => {
  const player = new Player(0, 0);
  player.invulnerable = true;
  const full = player.health;

  // Every caller in the game ends up at damage() — collisions.js's PlayerBody,
  // obstacles.js's playerBox, and player.update()'s own wall-scrape — so one
  // call per magnitude is the whole surface.
  player.damage(1);
  player.damage(player.maxHealth * 2);

  assert.equal(player.health, full);
});

test("a swallowed hit does not spend the banked shield, and does not report as damage", () => {
  let reports = 0;
  const player = new Player(0, 0, () => { reports += 1; });
  player.invulnerable = true;
  player.shieldCharge = 4;

  player.damage(10);

  // The charge is for the hit the player did not see coming (player.js's
  // damage() header) — a run that cannot be hurt must not burn it on nothing.
  assert.equal(player.shieldCharge, 4);
  // No onDamage call at all: main.js turns that into a flash, a shake and a
  // hiss, none of which describes what just happened.
  assert.equal(reports, 0);
});

test("a car is vulnerable unless something switches the flag on", () => {
  const player = new Player(0, 0);
  assert.equal(player.invulnerable, false);
  player.damage(5);
  assert.ok(player.health < player.maxHealth);
});

// --- 2. The rows follow the config file -------------------------------------

// Which rows the config file says exist, and therefore how many rows the menu
// should have beyond its three permanent ones (row 0, SOUND, MUSIC).
const compiledIn = !SHOW_TEST_OPTIONS
  ? []
  : [
      SHOW_INVULNERABILITY_OPTION && "invulnerable",
      SHOW_EXTRA_CASH_OPTION && "extraCash",
    ].filter(Boolean);

// A 2D context that records the text it is asked to draw, exactly as
// shop-screen.test.js's does — the drawn labels are how a test can ask "is the
// row actually on the screen" without a canvas.
function recordingCtx() {
  const texts = [];
  return {
    texts,
    save() {}, restore() {},
    fillRect() {}, strokeRect() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillText(text) { texts.push(String(text)); },
    canvas: { width: 600, height: 800 },
  };
}

// menu.render() now takes TWO contexts (Phase 15c: the world canvas and the
// HUD layer's own — see main.js's render() for the split). The test rows draw
// on the HUD one, but this suite doesn't care which canvas drew a label, only
// whether it was drawn — so both recording contexts feed one merged list.
function labels(menu) {
  const ctx = recordingCtx();
  const hudCtx = recordingCtx();
  menu.render(ctx, hudCtx, 600, 800);
  return [...ctx.texts, ...hudCtx.texts];
}

// initInput registers keydown/keyup/blur on whatever it is handed, exactly as
// shop-screen.test.js drives the shop — capturing the handlers is all it takes
// to press a key under Node. Declared here (moved up from where it used to
// live, in section 3 below) since revealing the rows before render() is now
// also part of the drawing tests.
const keys = {};
initInput({ addEventListener: (type, fn) => { keys[type] = fn; } });

function press(code) {
  keys.keydown({ code, repeat: false, preventDefault() {} });
  keys.keyup({ code, preventDefault() {} });
}

// Presses F1 (see input.js's "testOptions" action) and consumes it the same
// tick, mirroring what one call to menu.update() does in the real loop.
function revealTestRows(menu) {
  press("F1");
  menu.update(600);
}

test("test rows draw nothing until F1 reveals them", (t) => {
  if (!compiledIn.length) return t.skip("no test rows compiled in");
  keys.blur();
  const menu = createMenu();
  menu.open("start");

  const hidden = labels(menu).join("\n");
  assert.ok(!hidden.includes("INVULNERABILITY") && !hidden.includes("EXTRA CASH"),
    "a test row drew before F1 was pressed");

  revealTestRows(menu);
  const shown = labels(menu).join("\n");
  for (const key of compiledIn) {
    const label = key === "invulnerable" ? "INVULNERABILITY" : "EXTRA CASH";
    assert.ok(shown.includes(label), `row "${label}" is compiled in but did not draw after F1`);
  }

  // And F1 again hides them, rather than only ever revealing.
  revealTestRows(menu);
  const hiddenAgain = labels(menu).join("\n");
  assert.ok(!hiddenAgain.includes("INVULNERABILITY") && !hiddenAgain.includes("EXTRA CASH"));
  keys.blur();
});

test("every option switched on in testoptions.js draws a row once revealed, and every one switched off draws none", () => {
  const menu = createMenu();
  revealTestRows(menu);
  const drawn = labels(menu).join("\n");
  const shown = { invulnerable: "INVULNERABILITY", extraCash: "EXTRA CASH" };

  for (const [key, label] of Object.entries(shown)) {
    assert.equal(
      drawn.includes(label),
      compiledIn.includes(key),
      `row "${label}" is ${compiledIn.includes(key) ? "enabled" : "disabled"} in testoptions.js `
        + `but ${drawn.includes(label) ? "is" : "is not"} on the screen`,
    );
  }
  keys.blur();
});

test("a compiled-in row reads back as an off/on boolean, which is what main.js assigns to the player", () => {
  const menu = createMenu();
  for (const key of ["invulnerable", "extraCash"]) {
    const value = menu[key]();
    assert.equal(typeof value, "boolean", `menu.${key}() must be a boolean, got ${typeof value}`);
    // A row that is NOT compiled in can never report armed — testoptions.js's
    // header makes exactly this promise about a shipping build.
    if (!compiledIn.includes(key)) assert.equal(value, false);
  }
});

test("the rows are drawn with their state, so the screen says which cheats are armed", () => {
  const menu = createMenu();
  revealTestRows(menu);
  const drawn = labels(menu);
  for (const line of drawn) {
    if (line.includes("INVULNERABILITY") || line.includes("EXTRA CASH")) {
      assert.ok(/: (ON|OFF)$/.test(line), `test row "${line}" does not show its state`);
    }
  }
  keys.blur();
});

// --- 3. Driving the rows ----------------------------------------------------

// One press is consumed per update() (consumePress's one-shot contract), so
// stepping the cursor n rows means n ticks, not n presses in a row.
function step(menu, code, times = 1) {
  let result;
  for (let i = 0; i < times; i++) {
    press(code);
    result = menu.update(600);
  }
  return result;
}

// mouse.js's initMouse listens for "mouseup" on the real global `window`
// (deliberately — see its own comment: a drag must end even if the pointer
// leaves the canvas before releasing), which plain Node does not have. This
// stubs just enough of that global for initMouse() to run headless, the same
// reasoning recordingCtx() above stubs a canvas 2D context.
if (typeof globalThis.window === "undefined") {
  const windowHandlers = {};
  globalThis.window = { addEventListener: (type, fn) => { windowHandlers[type] = fn; }, _handlers: windowHandlers };
}

const mouseHandlers = {};
initMouse({
  addEventListener: (type, fn) => { mouseHandlers[type] = fn; },
  // 600x800 CSS box over the 600x800 logical space (viewport.js's LOGICAL_W/
  // LOGICAL_H) — a 1:1 ratio, so clientX/Y need no scaling to land on the
  // same coordinates testRowRect() itself returns.
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 800 }),
});

// Presses the mouse at (x, y) and immediately releases it — clicking a test
// checkbox is a tap, not a drag, and releasing right away keeps `isMouseDown`
// from leaking true into whichever test runs next.
function click(x, y) {
  mouseHandlers.mousedown({ clientX: x, clientY: y });
  globalThis.window._handlers?.mouseup?.();
}

test("Left/Right/Fire do nothing on a test row — a click is the only way to select or flip one", (t) => {
  if (!compiledIn.length) return t.skip("no test rows compiled in");
  keys.blur(); // nothing held or fresh from a previous test — see shop-screen.test.js
  const menu = createMenu();
  menu.open("start");
  revealTestRows(menu);

  // The first test row is reached ONLY by clicking its checkbox — there is
  // no keyboard path onto it any more (see the next few tests), so this test
  // has to get there the same way a real player would.
  const before = menu[compiledIn[0]]();
  const box = testRowRect(600, 0);
  click(box.x + box.w / 2, box.y + box.h / 2);
  const clickResult = menu.update(600);
  assert.equal(menu[compiledIn[0]](), !before, "the click did not flip the row");
  assert.equal(clickResult.toggled, true, "a flipped row must report `toggled` — main.js plays menu_adjust on it");
  assert.equal(clickResult.confirmed, false);

  // With the cursor parked there by that click, Left/Right/Fire must still
  // do nothing — mouse-only means mouse-only even once selected.
  const right = step(menu, "ArrowRight");
  assert.equal(menu[compiledIn[0]](), !before, "ArrowRight flipped a test row — it must be mouse-only");
  assert.equal(right.toggled, false);

  const fire = step(menu, "Space");
  assert.equal(menu[compiledIn[0]](), !before, "Space flipped a test row — it must be mouse-only");
  assert.equal(fire.confirmed, false, "Space on a test row must never start the game");
  assert.equal(fire.toggled, false);

  // A second click flips it back, so the row is a toggle rather than a
  // one-way arm.
  click(box.x + box.w / 2, box.y + box.h / 2);
  menu.update(600);
  assert.equal(menu[compiledIn[0]](), before);
  keys.blur();
});

test("Up/Down wrap only among the three real rows, F1 or no F1", (t) => {
  keys.blur();
  const menu = createMenu();
  menu.open("start");

  // Up from row 0 must land on MUSIC (row 2), not a test row, however many
  // are compiled in — the rows aren't on screen, so the keyboard cursor must
  // not be able to find them either. Read back indirectly through
  // musicVolume(), since `selected` itself isn't exposed.
  step(menu, "ArrowUp");
  const before = menu.musicVolume();
  step(menu, "ArrowRight");
  assert.ok(menu.musicVolume() > before, "Up did not wrap onto MUSIC — a hidden test row is still in the cursor's path");

  // F1 must not change this — the wrap is fixed at the three real rows
  // regardless of whether the checkboxes are on screen (see the two tests
  // below for the actual F1/no-F1 distinction, which is drawing, not input).
  // Back to row 0 first (the Up/Right above left the cursor on MUSIC), so
  // three Downs landing on row 0 again actually says something.
  menu.open("start");
  revealTestRows(menu);
  const result = step(menu, "ArrowDown", 3);
  assert.equal(result.moved, true);
  assert.equal(step(menu, "Space").confirmed, true,
    "three Downs from row 0 did not wrap back to row 0 — F1 extended the keyboard wrap onto a test row");
  keys.blur();
});

test("Down from a clicked test row lands on row 0, not past it", (t) => {
  if (!compiledIn.length) return t.skip("no test rows compiled in");
  keys.blur();
  const menu = createMenu();
  menu.open("start");
  revealTestRows(menu);

  const box = testRowRect(600, 0);
  click(box.x + box.w / 2, box.y + box.h / 2);
  menu.update(600); // parks `selected` on the test row (and flips it — a fresh menu, so that's fine)

  step(menu, "ArrowDown");
  assert.equal(step(menu, "Space").confirmed, true, "Down from a test row did not land on row 0");
  keys.blur();
});

test("Up from a clicked test row lands on MUSIC, not past it", (t) => {
  if (!compiledIn.length) return t.skip("no test rows compiled in");
  keys.blur();
  const menu = createMenu();
  menu.open("start");
  revealTestRows(menu);

  const box = testRowRect(600, 0);
  click(box.x + box.w / 2, box.y + box.h / 2);
  menu.update(600);

  const before = menu.musicVolume();
  step(menu, "ArrowUp");
  step(menu, "ArrowRight");
  assert.ok(menu.musicVolume() > before, "Up from a test row did not land on MUSIC");
  keys.blur();
});

// --- 4. The payout ----------------------------------------------------------

test("EXTRA CASH is worth more than the whole shop, or it cannot do its job", async () => {
  const { STATS, TIER_COUNT, tierPrice } = await import("../src/game/upgrades.js");
  let everything = 0;
  for (const stat of STATS) {
    for (let tier = 1; tier <= TIER_COUNT; tier++) everything += tierPrice(stat, tier);
  }
  assert.ok(
    EXTRA_CASH_AMOUNT >= everything,
    `EXTRA_CASH_AMOUNT (${EXTRA_CASH_AMOUNT}) must cover every upgrade in the shop (${everything}) `
      + "— testing the top tier is the entire point of the option",
  );
});
