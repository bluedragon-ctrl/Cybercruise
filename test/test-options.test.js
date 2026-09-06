// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// THE DEV PANEL (src/game/testpanel.js) and its config file
// (src/testoptions.js): the cheats the game ships switched off, and the claims
// those two files make about them.
//
// Five things are pinned here:
//
//   1. The invulnerability flag really is a no-op on every damage source,
//      because every source funnels through Player.damage() (player.js's own
//      header), and it does not spend a banked shield on hits it swallowed.
//   2. The panel navigates and reports as its header says: a plain keyboard
//      wrap, Left/Right adjusting, FIRE applying, and an `action` shaped the way
//      main.js's applyPanelAction() switches on.
//   3. DISTANCE only goes forward, which is what makes "every system that only
//      counts up with distance is safe" true by construction rather than by
//      inspection.
//   4. EXTRA_CASH_AMOUNT covers the whole shop, or the CREDITS row cannot do the
//      job it exists for.
//   5. events.skipMilestonesTo() actually empties the queue a warp would
//      otherwise arrive under — the one piece of the warp that is not just
//      "assign and rebuild".
//
// It runs headless. testpanel.js reaches the browser only through the 2D
// contexts it is handed, the same arrangement shop-screen.test.js uses for the
// shop, and it takes its `dt` as a parameter rather than reading a clock — so
// the hold-repeat is drivable here without one.

import test from "node:test";
import assert from "node:assert/strict";

import { Player } from "../src/game/player.js";
import { initInput } from "../src/engine/input.js";
import { EXTRA_CASH_AMOUNT, CREDITS_STEP, DISTANCE_STEP } from "../src/testoptions.js";
import { createTestPanel, PANEL_ROWS } from "../src/game/testpanel.js";

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

// --- 2. Driving the panel ---------------------------------------------------

// initInput registers keydown/keyup/blur on whatever it is handed, exactly as
// shop-screen.test.js drives the shop — capturing the handlers is all it takes
// to press a key under Node.
const keys = {};
initInput({ addEventListener: (type, fn) => { keys[type] = fn; } });

// A tap: down and up inside one tick, so `isDown` is false again by the time
// the panel's hold-repeat looks at it and a tap can never be read as a sweep.
function tap(code) {
  keys.keydown({ code, repeat: false, preventDefault() {} });
  keys.keyup({ code, preventDefault() {} });
}

// One tick with `dt` small enough that HOLD_DELAY is nowhere near reached — the
// tap path only, which is what every test below but the sweep one wants.
function tick(panel, dt = 1 / 60) {
  return panel.update(dt);
}

function tapTick(panel, code) {
  tap(code);
  return tick(panel);
}

// Puts the cursor on the named row from a freshly opened panel, which always
// starts on row 0 (testpanel.js's open()).
function toRow(panel, key) {
  const target = PANEL_ROWS.findIndex((r) => r.key === key);
  for (let i = 0; i < target; i++) tapTick(panel, "ArrowDown");
}

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

// render() takes TWO contexts (Phase 15c: the world canvas and the HUD layer's
// own — see main.js's render() for the split). This suite doesn't care which
// canvas drew a label, only whether it was drawn, so both feed one merged list.
function labels(panel, world = {}) {
  const ctx = recordingCtx();
  const hudCtx = recordingCtx();
  panel.render(ctx, hudCtx, 600, 800, world);
  return [...ctx.texts, ...hudCtx.texts];
}

test("every row draws with its value, so the screen says what is armed", () => {
  keys.blur();
  const panel = createTestPanel();
  panel.open({ dist: 0 });
  const drawn = labels(panel).join("\n");
  for (const row of PANEL_ROWS) {
    assert.ok(drawn.includes(row.label), `row "${row.label}" is in PANEL_ROWS but did not draw`);
  }
  assert.ok(drawn.includes("OFF"), "INVULNERABILITY did not draw its state");
  assert.ok(drawn.includes(String(EXTRA_CASH_AMOUNT)), "CREDITS did not seed at EXTRA_CASH_AMOUNT");
  keys.blur();
});

test("the panel prints the live world it is handed, not a copy it derives", () => {
  const panel = createTestPanel();
  panel.open({ dist: 12 });
  const drawn = labels(panel, { dist: 12, sector: "SEC 04-K", credits: 250, hullPct: 61, speed: 340, entities: 9, points: 7788 }).join("\n");
  for (const shown of ["SEC 04-K", "250", "61%", "340", "9", "7788"]) {
    assert.ok(drawn.includes(shown), `the readout block did not print "${shown}"`);
  }
});

test("INVULNERABILITY is a level the panel holds, flipped by Left, Right or FIRE", () => {
  keys.blur();
  for (const code of ["ArrowRight", "ArrowLeft", "Space"]) {
    const panel = createTestPanel();
    panel.open({ dist: 0 });
    assert.equal(panel.invulnerable(), false, "a fresh panel must start clean");
    const result = tapTick(panel, code);
    assert.equal(panel.invulnerable(), true, `${code} did not flip INVULNERABILITY`);
    // No `action`: the level is read by main.js every tick (applyTestOptions),
    // never handed over as an event.
    assert.equal(result.action, null);
    assert.equal(result.adjusted, true, "a flipped row must report `adjusted` — main.js plays menu_adjust on it");
    tapTick(panel, code);
    assert.equal(panel.invulnerable(), false, "the row is a toggle, not a one-way arm");
  }
  keys.blur();
});

test("CREDITS steps with Left/Right and hands main.js a figure only on FIRE", () => {
  keys.blur();
  const panel = createTestPanel();
  panel.open({ dist: 0 });
  toRow(panel, "credits");

  assert.equal(tapTick(panel, "ArrowRight").action, null, "an adjustment must not commit on its own");
  assert.equal(tapTick(panel, "ArrowLeft").action, null);

  const fired = tapTick(panel, "Space");
  assert.deepEqual(fired.action, { kind: "credits", value: EXTRA_CASH_AMOUNT },
    "one step up and one step down must leave the seeded figure where it started");

  // ...and it can go to zero, which is what tests the shop's cannot-afford path.
  for (let i = 0; i < EXTRA_CASH_AMOUNT / CREDITS_STEP + 2; i++) tapTick(panel, "ArrowLeft");
  assert.deepEqual(tapTick(panel, "Space").action, { kind: "credits", value: 0 },
    "CREDITS must floor at 0 rather than going negative");
  keys.blur();
});

test("a held key sweeps, and sweeps faster the longer it is held", () => {
  keys.blur();
  const panel = createTestPanel();
  panel.open({ dist: 0 });
  toRow(panel, "credits");

  // Held, not tapped: keydown with no keyup, so `isDown` stays true across the
  // ticks below the way a finger on the key does.
  keys.keydown({ code: "ArrowRight", repeat: false, preventDefault() {} });
  // Two seconds at 1/60 — comfortably past both HOLD_DELAY and HOLD_ACCEL_AT.
  for (let i = 0; i < 120; i++) tick(panel);
  keys.keyup({ code: "ArrowRight", preventDefault() {} });

  const swept = tapTick(panel, "Space").action.value;
  assert.ok(
    swept > EXTRA_CASH_AMOUNT + 40 * CREDITS_STEP,
    `two seconds of holding moved CREDITS by only ${swept - EXTRA_CASH_AMOUNT} — `
      + "the hold-repeat's acceleration is what makes a text field unnecessary (testpanel.js's header)",
  );
  keys.blur();
});

// --- 3. Distance only goes forward ------------------------------------------

test("DISTANCE seeds where the car is and cannot be taken backwards", () => {
  keys.blur();
  const panel = createTestPanel();
  panel.open({ dist: 400 });
  toRow(panel, "distance");

  // Twenty steps down from a floor of 400 — every one of them clamped.
  for (let i = 0; i < 20; i++) tapTick(panel, "ArrowLeft");
  assert.equal(tapTick(panel, "Space").action, null,
    "a warp to where the car already is must not rebuild the road for nothing");

  const forward = tapTick(panel, "ArrowRight") && tapTick(panel, "Space");
  assert.deepEqual(forward.action, { kind: "warp", dist: 400 + DISTANCE_STEP, skipPassed: true });
  keys.blur();
});

test("PASSED EVENTS defaults to SKIP and rides along with the warp", () => {
  keys.blur();
  const panel = createTestPanel();
  panel.open({ dist: 0 });

  toRow(panel, "passed");
  tapTick(panel, "Space"); // SKIP -> FIRE

  // Back up to DISTANCE and warp — the row's state must reach main.js on the
  // action, since that is the only thing that carries it there.
  tapTick(panel, "ArrowUp");
  tapTick(panel, "ArrowRight");
  assert.equal(tapTick(panel, "Space").action.skipPassed, false);
  keys.blur();
});

test("with no run yet, the two world rows are inert and say so", () => {
  keys.blur();
  const panel = createTestPanel();
  panel.open({ dist: 0, live: false });

  const drawn = labels(panel).join("\n");
  assert.ok(drawn.includes("NO RUN YET") === false, "the reason only shows under the cursor, not always");
  assert.ok(!drawn.includes(String(EXTRA_CASH_AMOUNT)),
    "CREDITS drew a figure it cannot apply — newGame() would throw it away (testpanel.js's header)");

  toRow(panel, "credits");
  assert.ok(labels(panel).join("\n").includes("NO RUN YET"), "the dead row does not say why");
  tapTick(panel, "ArrowRight");
  assert.equal(tapTick(panel, "Space").action, null, "FIRE on a dead CREDITS row still asked main.js for something");

  toRow(panel, "distance");
  assert.equal(tapTick(panel, "Space").action, null, "FIRE on a dead DISTANCE row still asked for a warp");

  // The two LEVELS are unaffected — holding them across a newGame() is the whole
  // reason F1 opens from the start menu. Reopened rather than navigated back:
  // open() puts the cursor on row 0, and that it does so is worth asserting too.
  panel.open({ dist: 0, live: false });
  assert.equal(panel.invulnerable(), false);
  tapTick(panel, "Space");
  assert.equal(panel.invulnerable(), true, "INVULNERABILITY must still arm before the first run");
  keys.blur();
});

test("F1 and ESC both close the panel, and neither leaves a press behind", () => {
  keys.blur();
  for (const code of ["F1", "Escape"]) {
    const panel = createTestPanel();
    panel.open({ dist: 0 });
    const result = tapTick(panel, code);
    assert.equal(result.closed, true, `${code} did not close the panel`);
    assert.equal(result.action, null);
  }
  keys.blur();
});

test("the cursor wraps plainly over every row, in both directions", () => {
  keys.blur();
  const panel = createTestPanel();
  panel.open({ dist: 0 });

  // A full lap of Downs lands back on row 0 — INVULNERABILITY, the one row
  // whose state is readable from outside, is how the test can tell.
  for (let i = 0; i < PANEL_ROWS.length; i++) tapTick(panel, "ArrowDown");
  tapTick(panel, "Space");
  assert.equal(panel.invulnerable(), true, "a full lap of Downs did not return to row 0");

  // ...and Up from row 0 goes to the LAST row rather than off the end.
  tapTick(panel, "ArrowUp");
  tapTick(panel, "ArrowDown");
  tapTick(panel, "Space");
  assert.equal(panel.invulnerable(), false, "Up then Down did not come back to row 0");
  keys.blur();
});

// --- 4. The payout ----------------------------------------------------------

test("EXTRA_CASH_AMOUNT is worth more than the whole shop, or it cannot do its job", async () => {
  const { STATS, TIER_COUNT, tierPrice } = await import("../src/game/upgrades.js");
  let everything = 0;
  for (const stat of STATS) {
    for (let tier = 1; tier <= TIER_COUNT; tier++) everything += tierPrice(stat, tier);
  }
  assert.ok(
    EXTRA_CASH_AMOUNT >= everything,
    `EXTRA_CASH_AMOUNT (${EXTRA_CASH_AMOUNT}) must cover every upgrade in the shop (${everything}) `
      + "— testing the top tier is the entire point of the row",
  );
});

// --- 5. The warp's one non-obvious half -------------------------------------

test("skipMilestonesTo empties the queue a warp would otherwise arrive under", async () => {
  const events = await import("../src/game/events.js");
  const { EVENT_TYPES } = await import("../src/game/eventtypes.js");

  const oneShots = EVENT_TYPES.filter((t) => t.at !== undefined);
  const repeats = EVENT_TYPES.filter((t) => t.every !== undefined);
  const far = Math.max(0, ...oneShots.map((t) => t.at), ...repeats.map((t) => t.every)) + 100;

  events.reset();
  events.skipMilestonesTo(far);

  for (const type of oneShots) {
    assert.equal(events.milestoneCount(type.id), 1,
      `"${type.id}" fires at DIST ${type.at} and a warp past it left the milestone unspent — `
        + "it would fire on arrival, which is exactly what the SKIP row promises it will not");
  }
  // A REPEATING entry takes the COUNT the distance implies, not a flag: the shop
  // prints it as "STOP N" (shop.js), so a warp that set it to 1 would put the
  // player back at their first dock twenty minutes into the run.
  for (const type of repeats) {
    assert.equal(events.milestoneCount(type.id), Math.floor(far / type.every));
  }

  // And it leaves the rest of the director alone — reset() is what clears a run,
  // not this.
  events.reset();
  for (const type of EVENT_TYPES) assert.equal(events.milestoneCount(type.id), 0);
});
