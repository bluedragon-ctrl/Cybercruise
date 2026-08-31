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
import {
  SHOW_TEST_OPTIONS,
  SHOW_INVULNERABILITY_OPTION,
  SHOW_EXTRA_CASH_OPTION,
  EXTRA_CASH_AMOUNT,
} from "../src/testoptions.js";

const { createMenu } = await import("../src/game/menu.js");

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

function labels(menu) {
  const ctx = recordingCtx();
  menu.render(ctx, 600, 800);
  return ctx.texts;
}

test("every option switched on in testoptions.js draws a row, and every one switched off draws none", () => {
  const drawn = labels(createMenu()).join("\n");
  const shown = { invulnerable: "INVULNERABILITY", extraCash: "EXTRA CASH" };

  for (const [key, label] of Object.entries(shown)) {
    assert.equal(
      drawn.includes(label),
      compiledIn.includes(key),
      `row "${label}" is ${compiledIn.includes(key) ? "enabled" : "disabled"} in testoptions.js `
        + `but ${drawn.includes(label) ? "is" : "is not"} on the screen`,
    );
  }
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
  const drawn = labels(createMenu());
  for (const line of drawn) {
    if (line.includes("INVULNERABILITY") || line.includes("EXTRA CASH")) {
      assert.ok(/: (ON|OFF)$/.test(line), `test row "${line}" does not show its state`);
    }
  }
});

// --- 3. Driving the rows ----------------------------------------------------

// initInput registers keydown/keyup/blur on whatever it is handed, exactly as
// shop-screen.test.js drives the shop — capturing the handlers is all it takes
// to press a key under Node.
const keys = {};
initInput({ addEventListener: (type, fn) => { keys[type] = fn; } });

function press(code) {
  keys.keydown({ code, repeat: false, preventDefault() {} });
  keys.keyup({ code, preventDefault() {} });
}

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

test("arrowing down to a test row and pressing right flips it, and says so for the menu's own SFX", (t) => {
  if (!compiledIn.length) return t.skip("no test rows compiled in");
  keys.blur(); // nothing held or fresh from a previous test — see shop-screen.test.js
  const menu = createMenu();
  menu.open("start");

  // Past row 0, SOUND and MUSIC, onto the first test row.
  step(menu, "ArrowDown", 3);
  const before = menu[compiledIn[0]]();
  const result = step(menu, "ArrowRight");

  assert.equal(menu[compiledIn[0]](), !before, "the row did not flip");
  assert.equal(result.toggled, true, "a flipped row must report `toggled` — main.js plays menu_adjust on it");
  assert.equal(result.confirmed, false, "flipping a row must never start the game");

  // And back, so the row is a toggle rather than a one-way arm.
  assert.equal(step(menu, "ArrowRight").confirmed, false);
  assert.equal(menu[compiledIn[0]](), before);
  keys.blur();
});

test("the cursor wraps around the test rows rather than past them", (t) => {
  if (!compiledIn.length) return t.skip("no test rows compiled in");
  keys.blur();
  const menu = createMenu();
  menu.open("start");

  // Up from row 0 lands on the LAST row, which is now a test row — and
  // confirming there must toggle, not start the game, or a build with the
  // rows in it would be startable from a row that isn't START GAME.
  step(menu, "ArrowUp");
  const last = compiledIn[compiledIn.length - 1];
  const before = menu[last]();
  const result = step(menu, "Space");
  assert.equal(result.confirmed, false);
  assert.equal(menu[last](), !before);
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
