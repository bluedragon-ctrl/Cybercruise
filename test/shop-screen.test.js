// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// The shop SCREEN (game/shop.js): its cursor, the action string main.js drives the state machine on, and what it draws.
//
// Separate from shop.test.js, which is about the CATALOGUE. This file is about
// the one contract main.js holds the screen to — "update() and render(), and
// nothing else" — and about the claims shop.js's own header makes: that it owns
// no numbers, that it never touches audio, and that a press made in here can
// never leak out into the gameplay tick on the far side of the interlude.
//
// It runs headless. shop.js reaches the DOM through nothing but the 2D context
// it is handed, and engine/input.js only reads `window` as a DEFAULT ARGUMENT —
// so a stub keyboard target and a recording context are enough to drive the
// whole screen under plain Node.

import test from "node:test";
import assert from "node:assert/strict";
import { createShop } from "../src/game/shop.js";
import { initInput } from "../src/engine/input.js";
import {
  CONSUMABLES,
  SPECIALS,
  STATS,
  TIER_COUNT,
  Garage,
  statById,
  tierPrice,
} from "../src/game/upgrades.js";

import { Player } from "../src/game/player.js";
import { Loadout } from "../src/game/weapons.js";
import { Wallet } from "../src/game/wallet.js";

// --- A keyboard, and a canvas, neither of which exists under Node -------------

// initInput registers keydown/keyup/blur on whatever it is handed. Capturing the
// handlers is all it takes to press a key: the module's own `held`/`fresh` sets
// then behave exactly as they do in the browser, including the auto-repeat
// filter, which is the machinery consumePress's one-shot contract rests on.
const keys = {};
initInput({ addEventListener: (type, fn) => { keys[type] = fn; } });

function press(code) {
  keys.keydown({ code, repeat: false, preventDefault() {} });
  keys.keyup({ code, preventDefault() {} });
}

// Anything still held or still fresh from the previous test would be read by the
// next one — consumePress deliberately holds an edge until somebody takes it.
function clearInput() {
  keys.blur();
}

// A 2D context that records the text it is asked to draw. Enough for shop.js,
// which strokes two rectangles, fills one, draws the tier pips and otherwise
// only ever calls glowText — and the recorded strings are what let a test ask
// "is the price on the screen the price the catalogue says" without a canvas.
function recordingCtx() {
  const texts = [];
  const rects = { fill: 0, stroke: 0 };
  return {
    texts,
    rects,
    save() {}, restore() {},
    fillRect() { rects.fill += 1; },
    strokeRect() { rects.stroke += 1; },
    fillText(text, x, y) { texts.push({ text: String(text), x, y }); },
  };
}

function shop() {
  const wallet = new Wallet(null);
  return {
    screen: createShop(),
    wallet,
    player: new Player(0, 0),
    loadout: new Loadout(),
    garage: new Garage(),
  };
}

// One update tick, in the argument order main.js uses.
function tick(s) {
  return s.screen.update(s.wallet, s.player, s.loadout, s.garage);
}

function draw(s, visit = 1) {
  const ctx = recordingCtx();
  s.screen.render(ctx, 600, 800, s.wallet, visit, s.garage, s.player, s.loadout);
  return ctx;
}

// --- The action string -------------------------------------------------------

test("a quiet tick reports nothing at all", () => {
  clearInput();
  const s = shop();
  assert.equal(tick(s), null);
});

test("ESC undocks from anywhere on the shelf", () => {
  // The one action that changes main.js's state. It has to work from any row,
  // because a player who has finished shopping should never have to scroll to
  // a particular line to leave.
  clearInput();
  const s = shop();
  press("ArrowDown");
  press("ArrowDown");
  tick(s);
  clearInput();
  press("Escape");
  assert.equal(tick(s), "undock");
});

test("the last row is the way out, and SPACE on it undocks", () => {
  // shop.js makes UNDOCK a ROW so that the fire key means exactly one thing on
  // this screen. Walking UP from the top wraps straight onto it, which is also
  // the shortest route there.
  clearInput();
  const s = shop();
  press("ArrowUp");
  assert.equal(tick(s), "move");
  clearInput();
  press("Space");
  assert.equal(tick(s), "undock");
});

test("moving the cursor is reported, so main.js can play the menu's own move tone", () => {
  // shop.js never touches audio (its header, and menu.js's rule): it names what
  // happened and main.js picks the sound. A move that went unreported would be
  // a silent cursor.
  clearInput();
  const s = shop();
  press("ArrowDown");
  assert.equal(tick(s), "move");
});

test("an unaffordable row refuses, and the refusal costs nothing", () => {
  clearInput();
  const s = shop();
  assert.equal(s.wallet.credits, 0);
  press("Space"); // cursor starts on the first consumable
  assert.equal(tick(s), "deny");
  assert.equal(s.wallet.credits, 0);
  assert.equal(s.player.health, s.player.maxHealth, "a refusal healed the car");
});

test("a purchase on the shelf moves the wallet and the car together", () => {
  clearInput();
  const s = shop();
  const repair = CONSUMABLES[0];
  assert.equal(repair.kind, "heal", "this test assumes the first row is the repair");
  s.wallet.award(repair.price);
  s.player.damage(150);
  const hurt = s.player.health;

  press("Space");
  assert.equal(tick(s), "buy");
  assert.equal(s.wallet.credits, 0, "the purchase did not charge");
  assert.equal(s.player.health, hurt + repair.amount);
});

test("a press is consumed whatever it does, so it cannot leak into the drive home", () => {
  // jackin.js and disconnect.js each drain their own inputs for exactly this
  // reason: input.js holds an edge until somebody takes it, so a SPACE pressed
  // in the shop that nothing consumed would fire the gun on the first gameplay
  // tick after the car is set back down.
  clearInput();
  const s = shop();
  press("Space");
  assert.equal(tick(s), "deny"); // broke, so the press bought nothing...
  assert.equal(tick(s), null);   // ...and was still taken off the queue
});

test("ESC beats SPACE on a tick carrying both", () => {
  // The order in update() is the answer to "which did they mean": a player
  // walking out is walking out, not buying one last thing on the way.
  clearInput();
  const s = shop();
  const repair = CONSUMABLES[0];
  s.wallet.award(repair.price);
  keys.keydown({ code: "Space", repeat: false, preventDefault() {} });
  keys.keydown({ code: "Escape", repeat: false, preventDefault() {} });
  assert.equal(tick(s), "undock");
  assert.equal(s.wallet.credits, repair.price, "it bought something on the way out");
});

test("the cursor wraps in both directions and reaches every row", () => {
  // Every catalogue row plus the way out, and nothing else — a heading the
  // cursor could land on would be a line the player has to press past.
  clearInput();
  const s = shop();
  const rows = CONSUMABLES.length + STATS.length + SPECIALS.length + 1;
  for (let i = 0; i < rows; i++) {
    press("ArrowDown");
    assert.equal(tick(s), "move");
  }
  // A full lap is back at the start: the first row is the first consumable, and
  // buying it is what proves the cursor came home rather than stopping short.
  // Damaged first, or the repair would be refused as a full-hull no-op
  // (upgrades.js's consumableWasted) rather than bought.
  s.player.damage(50);
  s.wallet.award(CONSUMABLES[0].price);
  clearInput();
  press("Space");
  assert.equal(tick(s), "buy");
});

test("reset puts the cursor back for a fresh run", () => {
  // The cursor is KEPT between visits on purpose (a player topping up the same
  // row every stop should find it where they left it), which is exactly why a
  // new run has to be told to forget it.
  clearInput();
  const s = shop();
  press("ArrowUp"); // onto UNDOCK
  tick(s);
  s.screen.reset();
  // Damaged first — a full-hull repair is refused as a no-op purchase
  // (upgrades.js's consumableWasted), and this test only cares about the
  // cursor, not that particular rule.
  s.player.damage(50);
  s.wallet.award(CONSUMABLES[0].price);
  clearInput();
  press("Space");
  assert.equal(tick(s), "buy", "reset left the cursor on the way out");
});

// --- What it draws -----------------------------------------------------------

test("the shelf quotes the catalogue's own prices, and nothing else's", () => {
  // shop.js's header claims it owns no numbers. This is that claim: every price
  // on the screen has to be one priceOf() produced, which means retuning the
  // catalogue retunes the screen with nothing here to update.
  clearInput();
  const s = shop();
  // A stock car is at full hull, and a full-hull repair is refused rather than
  // priced (upgrades.js's consumableWasted) — so the repair row would draw
  // "MAX" instead of a price unless something has actually hurt the car first.
  s.player.damage(50);
  const drawn = draw(s).texts.map((t) => t.text);
  for (const entry of CONSUMABLES) {
    assert.ok(drawn.includes(entry.label), `${entry.id} is missing from the shelf`);
    assert.ok(drawn.includes(`${entry.price} CR`), `${entry.id}'s price is missing`);
  }
  for (const stat of STATS) {
    assert.ok(drawn.includes(stat.label), `${stat.id} is missing from the shelf`);
    assert.ok(drawn.includes(`${tierPrice(stat, 0)} CR`), `${stat.id}'s tier 1 price is missing`);
  }
  for (const item of SPECIALS) {
    assert.ok(drawn.includes(item.label), `${item.id} is missing from the shelf`);
    assert.ok(drawn.includes(`${item.price} CR`), `${item.id}'s price is missing`);
    assert.ok(drawn.includes(item.detail), `${item.id}'s detail column is missing`);
  }
  assert.ok(drawn.includes("UNDOCK"), "no way out is drawn");
});

test("a special reads NOT FITTED until it is bought, then SOLD and FITTED", () => {
  // A one-off purchase has one fact a consumable does not — whether it is
  // already on the car — and the shelf has to answer it in both columns at
  // once. "MAX" would be wrong here: that is a ladder topped out, not a thing
  // you own, and shop.js tells the two apart deliberately.
  clearInput();
  const s = shop();
  const item = SPECIALS[0];

  let drawn = draw(s).texts.map((t) => t.text);
  assert.ok(drawn.includes("NOT FITTED"), "an unbought special does not say so");
  assert.ok(!drawn.includes("SOLD"), "a special is sold out before it is bought");

  s.garage.addSpecial(item);
  drawn = draw(s).texts.map((t) => t.text);
  assert.ok(drawn.includes("FITTED"), "a bought special does not say it is fitted");
  assert.ok(drawn.includes("SOLD"), "a bought special is still priced");
  assert.ok(!drawn.includes(`${item.price} CR`), `${item.id} still quotes a price once owned`);
});

test("the shelf quotes what this run has to spend, and says it will not keep it", () => {
  // `credits`, not `banked` — a storefront is where a player decides whether
  // saving up is worth it, so it is the one screen that must not imply a
  // balance the game does not keep (main.js's CREDIT_STORE).
  clearInput();
  const s = shop();
  s.wallet.award(437);
  const drawn = draw(s).texts.map((t) => t.text);
  assert.ok(drawn.includes("437 CR"), "the run's credits are not on the screen");
  assert.ok(drawn.some((t) => t.includes("NOT CARRIED OVER")),
    "the screen no longer warns that credits die with the run");
});

test("a row you cannot afford says so in words, with the shortfall", () => {
  // A red price is far too quiet a way to answer "why did that press do
  // nothing" — especially on a stat mid-ladder, where the row already carries a
  // BOUGHT receipt from the tier before and the player is reasonably reading
  // that as the reason. The note line says which it is, and how short.
  clearInput();
  const s = shop();
  const engine = statById("engine");
  const price = tierPrice(engine, 0);
  s.wallet.award(price - 40);

  // Walk down onto the engine row — the first of the CAR SYSTEMS shelf.
  for (let i = 0; i < CONSUMABLES.length; i++) { press("ArrowDown"); tick(s); }
  const drawn = draw(s).texts.map((t) => t.text);
  assert.ok(drawn.includes("NOT ENOUGH CREDITS — 40 CR SHORT"),
    `no shortfall on the note line; got ${JSON.stringify(drawn.slice(-3))}`);
  assert.ok(!drawn.includes(engine.note),
    "the row's description outranked the reason the press did nothing");

  // ...and once the money is there, the description comes back.
  s.wallet.award(40);
  assert.ok(draw(s).texts.some((t) => t.text === engine.note),
    "an affordable row lost its description");
});

test("buying one tier does not make the next look bought — the price stays live", () => {
  // The reported bug: after a tier lands, the row carries a BOUGHT receipt, and
  // if that receipt sits where the price goes the player reads a row with tiers
  // left as finished. The receipt and the price are different facts and both are
  // drawn, with the note line saying why the next tier is out of reach.
  clearInput();
  const s = shop();
  const engine = statById("engine");
  // A stock car is at full hull, so the untouched repair row would draw "MAX"
  // too (upgrades.js's consumableWasted) — irrelevant to this test, but it
  // would false-positive the "no MAX anywhere" check below if left in.
  s.player.damage(50);
  s.wallet.award(tierPrice(engine, 0)); // exactly one tier's worth
  for (let i = 0; i < CONSUMABLES.length; i++) { press("ArrowDown"); tick(s); }
  clearInput();
  press("Space");
  assert.equal(tick(s), "buy");

  const drawn = draw(s).texts.map((t) => t.text);
  assert.ok(drawn.includes("BOUGHT"), "no receipt for the tier just bought");
  assert.ok(drawn.includes(`${tierPrice(engine, 1)} CR`),
    "the next tier's price is not on the row");
  assert.ok(!drawn.includes("MAX"), "a stat with tiers left reads as finished");
  assert.ok(drawn.some((t) => t.startsWith("NOT ENOUGH CREDITS")),
    "nothing says the blocker is money");
});

test("a maxed stat reads MAX instead of a price", () => {
  clearInput();
  const s = shop();
  const engine = statById("engine");
  for (let i = 0; i < TIER_COUNT; i++) s.garage.addTier(engine);
  assert.ok(draw(s).texts.some((t) => t.text === "MAX"), "a maxed stat still quotes a price");

  // The note line belongs to whatever the cursor is ON, so walk down onto the
  // engine row — the first of the STATS shelf — to read it.
  for (let i = 0; i < CONSUMABLES.length; i++) { press("ArrowDown"); tick(s); }
  assert.ok(draw(s).texts.some((t) => t.text === "FULLY UPGRADED"),
    "the note line does not say why the row is out of stock");
});

test("a stat row shows where the next tier takes the reading", () => {
  // The whole reason a stat row carries a value column: "620 → 660" is what
  // makes a price mean something. A row that only showed the price would be
  // asking the player to trust it.
  clearInput();
  const s = shop();
  const drawn = draw(s).texts.map((t) => t.text);
  const engine = statById("engine");
  assert.ok(drawn.includes(`${engine.base.toFixed(0)} → ${(engine.base + engine.step).toFixed(0)}`),
    "the engine row does not show what the next tier buys");
  // The fractional one prints as a fraction, or a ram plate reads as "1 → 2".
  const ram = statById("ram");
  assert.ok(drawn.includes(`${ram.base.toFixed(1)} → ${(ram.base + ram.step).toFixed(1)}`),
    "the ram plate row rounded its mass away");
});

test("a purchase leaves a receipt on the row until the player undocks", () => {
  // The mark is feedback about the visit in progress — a shelf of receipts is a
  // summary of what this stop was spent on. Cleared by undocking, not by time.
  clearInput();
  const s = shop();
  // Damaged well short of the repair's own +100, so the row still quotes a
  // price after one purchase instead of reading as a wasted, refused one
  // (upgrades.js's consumableWasted) — the point below is that the price
  // survives the BOUGHT mark, not that a second purchase would succeed.
  s.player.damage(150);
  s.wallet.award(CONSUMABLES[0].price * 2);
  press("Space");
  tick(s);
  assert.ok(draw(s).texts.some((t) => t.text === "BOUGHT"), "no receipt after a purchase");
  // ...AND the price is still on the row. A consumable can be bought again
  // immediately, so a receipt that covered its price would leave the player
  // buying a second one unable to see what it costs.
  assert.ok(draw(s).texts.some((t) => t.text === `${CONSUMABLES[0].price} CR`),
    "the receipt hid the price of a row that can be bought again");
  clearInput();
  press("Escape");
  assert.equal(tick(s), "undock");
  assert.ok(!draw(s).texts.some((t) => t.text === "BOUGHT"), "the receipt survived undocking");
});

test("the screen covers the world completely", () => {
  // main.js returns before any world layer while this state is live, so the
  // backdrop fill IS the background. A screen that did not paint one would show
  // the frozen road through the price list.
  clearInput();
  const s = shop();
  assert.ok(draw(s).rects.fill >= 1, "nothing painted the backdrop");
});
