// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// Credits: what a run earns, the link that is the one way a node is taken, and the dish that reports it.
//
// Everything imported here is DOM-free at module scope, so the game's real
// modules load under plain Node.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { CAR_TYPES, ENEMY_FACTION } from "../src/game/cartypes.js";
import { ROAD_HALF_WIDTH, centerXAt } from "../src/game/road.js";
import { visibleNodes } from "../src/game/scenery.js";
import { nodeId, nodeValue, pingingNodes, reset as linksReset } from "../src/game/links.js";
import { Wallet, LINK_RADIUS, CREDITS_KEY, loadBanked } from "../src/game/wallet.js";
import { TIER_COUNT } from "../src/game/upgrades.js";
import { renderNodeHints, renderAwardMarks, renderUplink } from "../src/game/walletrender.js";
import { edgesAt } from "../src/game/road.js";
import { driver, fastest } from "../test-support/fixtures.js";

// --- Phase 11 groundwork: credits (game/wallet.js) --------------------------
//
// The money system's claims are relations between files — the siphon radius
// against the road's own half-width, the `bounty` field against the faction
// that carries it, the fine's floor against the bank underneath it. Every one
// of them is a paragraph in wallet.js that could quietly stop being true when
// someone retunes a number somewhere else, which is what this whole file is
// for.

// A localStorage stand-in: the real one doesn't exist under plain Node, and a
// test that shared one bank with its neighbours would depend on its own
// running order.
function fakeStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

// A synthetic node, positioned in SCREEN space exactly as scenery.js's
// visibleNodes() reports one, plus the plot index everything about it derives
// from. Placed relative to the road's real edges at its own row, so the
// occlusion rule is exercised against real geometry rather than a guessed
// number.
const TEST_W = 600;
const TEST_PLAYER_Y = 500;
function nodeBeside(distance, { offRoadBy = 20, bx = 3, by = 40 } = {}) {
  const sy = TEST_PLAYER_Y; // level with the player: worldY === distance there
  const { left } = edgesAt(distance, TEST_W);
  return { bx, by, cx: left - offRoadBy, sy, variant: 0, progress: 1 };
}

// A clock value at which the given node is actually mid-ping. The ping window
// is a hash-derived phase of a hash-derived period (links.js), so the honest
// way to test "in range while pinging" is to ask links.js itself when that is,
// rather than to hard-code a number a reseed would invalidate.
// A player stand-in level with a node, `away` px to its right. `speed` is
// carried because other parts of the game read it, but nothing in wallet.js
// does any more — how fast the car is going stopped being a rule when the two
// routes became one (see wallet.js's THE LINK).
function atNode(node, away = 0, speed = 600) {
  return { x: node.cx + away, y: node.sy, speed, w: 34 };
}

// Ticks the whole drain at 60Hz for `seconds` and returns what it paid — the
// way main.js drives it. Nothing pays out in a single frame now: the fastest
// a node can be taken is LINK_NEAR_TIME, so a test that wants a payout has to
// spend the time for it.
function siphon(w, nodes, player, distance, seconds, clock = 0, W = TEST_W) {
  let paid = 0;
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    paid += w.harvest(dt, clock + t, nodes, player, distance, W, () => {}, () => false);
  }
  return paid;
}

function clockWhileQuiet(node) {
  for (let t = 0; t < 60; t += 0.05) {
    if (pingingNodes([node], t).length === 0) return t;
  }
  throw new Error("node never idles in 60s — links.js's duty cycle has changed");
}

function clockWhilePinging(node) {
  for (let t = 0; t < 60; t += 0.05) {
    if (pingingNodes([node], t).length > 0) return t;
  }
  throw new Error("no ping window found in 60s — links.js's duty cycle has changed");
}

test("driving the middle of the road can never earn a credit, however long you sit there", () => {
  // wallet.js's oldest design claim, and the one the merge had to carry over.
  // It used to be arithmetic (the grab radius was strictly under
  // ROAD_HALF_WIDTH); with one reach of LINK_RADIUS that guarantee moved into
  // the shoulder rule, so it is asserted here the only way that still means
  // anything: drive the centre-line next to a node and take nothing.
  const distance = 4000;
  const node = nodeBeside(distance);
  const w = new Wallet(null);
  const centre = { x: centerXAt(distance, TEST_W), y: node.sy, speed: 150, w: 34 };

  assert.ok(
    Math.hypot(node.cx - centre.x, node.sy - centre.y) < LINK_RADIUS,
    "this test is not testing what it thinks it is — the node is out of reach anyway"
  );
  assert.equal(siphon(w, [node], centre, distance, 20), 0, "the centre-line paid out");
  assert.equal(w.link, null, "the centre-line opened a link it should never have");
});

test("every car type's bounty agrees in sign with its score value", () => {
  // The two are separate fields precisely so they CAN diverge in size — but a
  // car worth points and costing credits (or the reverse) would be telling the
  // player two opposite things about the same kill.
  for (const t of CAR_TYPES) {
    assert.equal(typeof t.bounty, "number", `${t.id} has no bounty`);
    assert.ok(Number.isInteger(t.bounty), `${t.id}'s bounty is not an integer`);
    assert.equal(
      Math.sign(t.bounty), Math.sign(t.value),
      `${t.id} pays ${t.bounty} credits but scores ${t.value}`
    );
  }
});

test("the civilian fine is gentler in credits than in points, relative to the reward", () => {
  // wallet.js's header: the score is where carelessness is punished hard, the
  // wallet is where it is punished honestly (a fine can empty a run, and the
  // bank is out of its reach entirely).
  const enemy = CAR_TYPES.find((t) => t.faction === ENEMY_FACTION);
  const civilian = CAR_TYPES.find((t) => t.faction !== ENEMY_FACTION);
  assert.ok(Math.abs(civilian.bounty) / enemy.bounty < Math.abs(civilian.value) / enemy.value);
});

test("nodeValue is a stable function of the plot index, inside its stated range", () => {
  for (let bx = 0; bx < 8; bx++) {
    for (let by = 0; by < 40; by++) {
      const v = nodeValue(bx, by);
      assert.ok(Number.isInteger(v), `node ${bx},${by} pays a non-integer ${v}`);
      assert.ok(v >= 4 && v <= 17, `node ${bx},${by} pays ${v}, outside 4..17`);
      assert.equal(v, nodeValue(bx, by), "nodeValue is not deterministic");
    }
  }
});

test("a bounty is banked, and a car with no bounty field pays nothing at all", () => {
  const w = new Wallet(fakeStore());
  w.destroyed({ bounty: 25 });
  assert.equal(w.credits, 25);
  // The Phase 10 seam: no `bounty` key at all.
  const before = w.lastAward;
  w.destroyed({ value: 100 });
  assert.equal(w.credits, 25, "a type with no bounty moved the wallet");
  assert.equal(w.lastAward, before, "a type with no bounty flashed an award");
});

test("a fine can empty the run but never overdraws it, and never touches the bank", () => {
  const store = fakeStore();
  const first = new Wallet(store);
  first.destroyed({ bounty: 25 });
  first.destroyed({ bounty: 25 });
  first.bank();
  assert.equal(first.banked, 50);

  const second = new Wallet(store);
  assert.equal(second.banked, 50, "the bank did not survive into the next run");
  second.destroyed({ bounty: 25 });                  // run earnings: 25
  const applied = second.destroyed({ bounty: -40 }); // a fine bigger than the run
  assert.equal(applied, -25, "the HUD would have flashed more than was taken");
  assert.equal(second.earned, 0);
  assert.equal(second.banked, 50, "a fine reached credits banked by an earlier run");
  assert.equal(second.credits, 50);
});

test("bank() commits once and is idempotent, and quotes what the run was worth", () => {
  const store = fakeStore();
  const w = new Wallet(store);
  w.destroyed({ bounty: 25 });
  w.bank();
  w.bank();
  assert.equal(w.banked, 25);
  assert.equal(w.lastRunEarnings, 25);
  assert.equal(loadBanked(store), 25);
});

test("a wallet with no storage at all still runs the whole economy", () => {
  // Private mode, disabled storage, or the test suite itself: only persistence
  // is lost, never the run.
  const w = new Wallet(null);
  w.destroyed({ bounty: 25 });
  w.bank();
  assert.equal(w.banked, 25);
  assert.equal(w.credits, 25);
});

test("spend() refuses to overdraw and persists what is left", () => {
  const store = fakeStore();
  const w = new Wallet(store);
  w.destroyed({ bounty: 25 });
  w.bank();
  assert.equal(w.spend(30), false, "spent more than the wallet held");
  assert.equal(w.spend(10), true);
  assert.equal(w.credits, 15);
  assert.equal(loadBanked(store), 15);
});

test("a node held alongside pays its full price, exactly once per run", () => {
  const distance = 4000;
  const node = nodeBeside(distance);
  const w = new Wallet(null);

  const paid = siphon(w, [node], atNode(node), distance, 0.5, clockWhilePinging(node));
  assert.equal(paid, nodeValue(node.bx, node.by), "a node paid something other than its price");
  assert.equal(w.nodes, 1);

  // The same node, alongside for another second: nothing more.
  assert.equal(siphon(w, [node], atNode(node), distance, 1), 0, "the same node paid twice in one run");
  assert.equal(w.nodes, 1);
});

test("the ping decides nothing about money — a dormant node pays the same as a lit one", () => {
  // The coin-flip half of the old confusion: whether a node paid instantly or
  // made you hold used to come down to whether it happened to be lit when you
  // arrived, which the player cannot predict. Now it is the same act either
  // way, at the same price.
  const distance = 4000;
  const node = nodeBeside(distance);

  const lit = new Wallet(null);
  const dark = new Wallet(null);
  const paidLit = siphon(lit, [node], atNode(node), distance, 0.5, clockWhilePinging(node));
  const paidDark = siphon(dark, [node], atNode(node), distance, 0.5, clockWhileQuiet(node));

  assert.equal(paidLit, nodeValue(node.bx, node.by));
  assert.equal(paidDark, paidLit, "a dormant node paid differently from a lit one");
});

test("a node out of range, or under the road, pays nothing however long it pings", () => {
  const distance = 4000;
  const node = nodeBeside(distance);
  const clock = clockWhilePinging(node);

  const far = new Wallet(null);
  // Beyond the reach the floor advertises: out of the mechanic entirely.
  siphon(far, [node], atNode(node, LINK_RADIUS + 40), distance, 10);
  assert.equal(far.credits, 0, "a node beyond the siphon radius paid out");

  // A node the road is currently covering: invisible, and so worth nothing —
  // even with the player sitting directly on top of it.
  const under = new Wallet(null);
  const buried = { ...node, cx: edgesAt(distance, TEST_W).center };
  siphon(under, [buried], atNode(buried), distance, 10, clock);
  assert.equal(under.credits, 0, "a node hidden under the road paid out");
});

test("the harvested-node set is pruned by the row watermark rather than growing all run", () => {
  const w = new Wallet(null);
  // Rows the road has long since left behind...
  for (let by = 0; by < 200; by++) w.harvested.add(nodeId(1, by));
  // ...and a screen sitting far ahead of every one of them.
  w.prune([{ bx: 1, by: 500 }]);
  assert.equal(w.harvested.size, 0);

  // A row still on screen is never forgotten — that is what stops a node
  // paying twice while it is still beside the player.
  w.harvested.add(nodeId(1, 500));
  w.prune([{ bx: 1, by: 500 }]);
  assert.equal(w.harvested.size, 1);
});

test("CREDITS_KEY shares the settings namespace and does not collide with them", () => {
  assert.ok(CREDITS_KEY.startsWith("cybercruise."));
  assert.notEqual(CREDITS_KEY, "cybercruise.sound");
  assert.notEqual(CREDITS_KEY, "cybercruise.music");
});

test("a node in reach wears its price dormant, and brightens when it goes live", () => {
  // The affordance. TWO states rather than one, but the difference between
  // them is now about ATTENTION, not money: a lit node is one the floor is
  // pointing at, and it is worth exactly what the dormant one beside it is
  // worth.
  const distance = 4000;
  const node = nodeBeside(distance);
  const clock = clockWhilePinging(node);
  const w = new Wallet(null);

  const dormant = w.hints(clockWhileQuiet(node), [node], atNode(node), distance, TEST_W);
  assert.equal(dormant.length, 1);
  assert.equal(dormant[0].live, false);

  const lit = w.hints(clock, [node], atNode(node), distance, TEST_W);
  assert.equal(lit[0].live, true);

  // ONE PRICE, and the label quotes it whatever the ping is doing. The old
  // half-price quote is exactly what this merge removed.
  assert.equal(lit[0].value, nodeValue(node.bx, node.by));
  assert.equal(dormant[0].value, lit[0].value, "the same node was advertised at two prices");

  // Further out on the approach: still advertised, but quieter.
  const far = w.hints(clock, [node], atNode(node, 200), distance, TEST_W);
  assert.equal(far.length, 1);
  assert.ok(far[0].alpha < lit[0].alpha, "a distant node shouts as loudly as one alongside");
});

test("nothing is advertised that could not actually be collected", () => {
  // A marker over a node that pays nothing would be the HUD lying, which is
  // the one thing wallet.js's hint layer is not allowed to do. Same three
  // filters harvest() itself applies.
  const distance = 4000;
  const node = nodeBeside(distance);
  const clock = clockWhilePinging(node);
  const w = new Wallet(null);

  // Already taken this run.
  siphon(w, [node], atNode(node), distance, 0.5, clock);
  assert.equal(w.hints(clock, [node], atNode(node), distance, TEST_W).length, 0);

  // Hidden under the road.
  const buried = { ...node, bx: node.bx + 1, cx: edgesAt(distance, TEST_W).center };
  assert.equal(new Wallet(null).hints(clock, [buried], atNode(buried), distance, TEST_W).length, 0);

  // Too far away to be worth mentioning.
  const fresh = new Wallet(null);
  assert.equal(fresh.hints(clock, [node], atNode(node, 1000), distance, TEST_W).length, 0);
});

test("the siphon hint is pushed once per run, and only once it lands", () => {
  const lines = [];
  const push = (text) => lines.push(text);
  const w = new Wallet(null);

  // Nothing in range: nothing to say.
  w.hint(0, false, push, () => false);
  assert.equal(lines.length, 0);

  // Throttled away (a busy log) leaves the run still un-hinted, so the advice
  // isn't silently lost for the whole drive.
  w.hint(0, true, push, () => true);
  assert.equal(lines.length, 0);
  assert.equal(w.hinted, false);

  // Free log: it lands, once, and never again this run.
  linksReset();
  assert.equal(w.hint(100, true, push, () => false), true);
  w.hint(200, true, push, () => false);
  assert.equal(lines.length, 1);
});

test("every payout leaves a marker on the spot it came from, which ages out on its own", () => {
  const distance = 4000;
  const node = nodeBeside(distance);
  const clock = clockWhilePinging(node);
  const w = new Wallet(null);

  // A siphoned node: anchored on the CITY FLOOR, at the screen position it was
  // taken at.
  siphon(w, [node], atNode(node), distance, 0.5, clock);
  assert.equal(w.marks.length, 1);
  assert.equal(w.marks[0].kind, "floor");
  assert.equal(w.marks[0].x, node.cx);
  assert.equal(w.marks[0].value, nodeValue(node.bx, node.by));

  // A destroyed car: anchored on the ROAD, in world coordinates, because that
  // plane scrolls and bends underneath the marker.
  w.destroyed({ bounty: 25 }, 4200, -40);
  const wreck = w.marks[w.marks.length - 1];
  assert.equal(wreck.kind, "road");
  assert.equal(wreck.worldY, 4200);
  assert.equal(wreck.offset, -40);
  assert.equal(wreck.value, 25);

  // A fine marks what was actually taken, in the negative.
  w.destroyed({ bounty: -15 }, 4300, 0);
  assert.equal(w.marks[w.marks.length - 1].value, -15);

  // ...and a caller with no position to point at simply leaves no marker.
  const before = w.marks.length;
  w.destroyed({ bounty: 25 });
  assert.equal(w.marks.length, before);

  w.update(0.5);
  assert.ok(w.marks.length > 0, "markers vanished before their own lifetime was up");
  w.update(1);
  assert.equal(w.marks.length, 0, "a marker outlived its own lifetime");
});

test("a chain reaction can't stack more than a readable number of markers", () => {
  const w = new Wallet(null);
  for (let i = 0; i < 20; i++) w.destroyed({ bounty: 25 }, 1000 + i, 0);
  assert.ok(w.marks.length <= 5, `${w.marks.length} markers in the air at once`);
  // The oldest go, not the newest: what stays on screen is what just happened.
  assert.equal(w.marks[w.marks.length - 1].worldY, 1019);
});

test("a fine with nothing left to take leaves no marker at all", () => {
  // "-0CR" over a wreck would be noise, and worse, a lie about a penalty that
  // did not land.
  const w = new Wallet(null);
  w.destroyed({ bounty: -15 }, 1000, 0);
  assert.equal(w.earned, 0);
  assert.equal(w.marks.length, 0);
});

// --- The link: the one way a node is ever taken -----------------------------

// A player stand-in out past the shoulder on the same side as `node` — the
// position the link demands, and the only position it demands.
function beside(node, distance, speed = 350) {
  const center = centerXAt(distance, TEST_W);
  const side = Math.sign(node.cx - center) || -1;
  // `w` because the link's dish is measured off the car's flank
  // (wallet.js's linkGeometry); everything else here only needs a point.
  return { x: center + side * (ROAD_HALF_WIDTH - 17), y: node.sy, speed, w: 34 };
}

// Runs `seconds` of ticks against one node, at 60Hz, exactly as main.js does.
function hold(w, node, player, distance, seconds, clock = 0) {
  let paid = 0;
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    paid += w.holdLink(dt, clock + t, [node], player, distance, TEST_W, () => {}, () => false);
  }
  return paid;
}

test("a car on the node's side eventually takes a node it could never touch", () => {
  // The whole reason the reach is wide: nodes sit on a fixed column grid while
  // the road wanders across it, so some are simply too far out to be brushed
  // past. Reaching them is what the time is for.
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const player = beside(node, distance, 150);

  // Long enough for a node this far out: the drain slows with range, and 200px
  // past the barrier is most of the way to the edge of reach.
  const paid = hold(w, node, player, distance, 6);
  assert.ok(paid > 0, "a held link never completed");
  assert.equal(w.nodes, 1);
  // AT FULL PRICE. The old uplink paid half for exactly this node; one route
  // means one number, and it is the one the floor advertised.
  assert.equal(paid, nodeValue(node.bx, node.by));
});

test("distance sets the pace: the same node takes longer from further out", () => {
  // The merge itself, stated as a test. There is no threshold anywhere in
  // here — near is quick, far is slow, and the two are the same act.
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 40 });

  const near = new Wallet(null);
  const far = new Wallet(null);
  const alongside = beside(node, distance);
  const back = { ...alongside, y: node.sy + 200 };

  // The rate curve itself: strictly faster the closer the car is, with no
  // step anywhere in it.
  assert.ok(near.linkRate(0) > near.linkRate(150), "the curve is flat up close");
  assert.ok(near.linkRate(150) > near.linkRate(LINK_RADIUS), "the curve is flat further out");
  assert.ok(1 / near.linkRate(0) < 0.4, "point blank does not read as instant");

  // Alongside: taken in well under two seconds.
  assert.ok(hold(near, node, alongside, distance, 1.5) > 0, "a node alongside never completed");
  // The same time from 200px back is not enough...
  assert.equal(hold(far, node, back, distance, 1.5), 0, "a distant node paid at close-range speed");
  assert.ok(far.link.charge > 0, "a distant node was not charging at all");
  // ...but it gets there, given the time.
  assert.ok(hold(far, node, back, distance, 6) > 0, "a distant node never completed");
});

test("nothing reads the throttle — speed costs time in range, not permission", () => {
  // Speed used to be a rule with a number attached (a 200 u/s ceiling). Now it
  // is geometry: the same hold at 620 pays exactly as it does at 120, because
  // wallet.js never asks. What speed decides is how long the car is there for,
  // which is main.js's business, not this module's.
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });

  const crawling = new Wallet(null);
  const flying = new Wallet(null);
  const paidSlow = hold(crawling, node, beside(node, distance, 120), distance, 6);
  const paidFast = hold(flying, node, beside(node, distance, 620), distance, 6);
  assert.ok(paidSlow > 0);
  assert.equal(paidFast, paidSlow, "the throttle changed what a held node paid");
});

test("the link is bought with position — the wrong side of the road earns nothing", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const center = centerXAt(distance, TEST_W);
  const side = Math.sign(node.cx - center) || -1;
  // Out on the OPPOSITE shoulder.
  const wrongSide = { x: center - side * (ROAD_HALF_WIDTH - 17), y: node.sy, speed: 150, w: 34 };
  assert.equal(hold(w, node, wrongSide, distance, 5), 0);
});

test("a broken hold bleeds away rather than being wiped, and never completes on its own", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const center = centerXAt(distance, TEST_W);
  // Swerving back into the middle is what breaks a hold now.
  const middle = { x: center, y: node.sy, speed: 350, w: 34 };

  hold(w, node, beside(node, distance), distance, 1);
  const banked = w.link.charge;
  assert.ok(banked > 0);

  // One tick back off the shoulder: progress drops, but the attempt survives.
  w.holdLink(1 / 60, 0, [node], middle, distance, TEST_W, () => {}, () => false);
  assert.ok(w.link.charge < banked, "a broken hold kept its progress");
  assert.ok(w.link.charge > 0, "a single tick wiped the whole attempt");

  // Sustained: it lapses entirely, and nothing is ever paid for it.
  for (let i = 0; i < 600; i++) {
    w.holdLink(1 / 60, 0, [node], middle, distance, TEST_W, () => {}, () => false);
  }
  assert.equal(w.link, null);
  assert.equal(w.credits, 0);
});

test("only one link runs at a time, and switching nodes starts over", () => {
  const distance = 4000;
  const near = nodeBeside(distance, { offRoadBy: 200, bx: 3, by: 40 });
  const far = { ...near, bx: 4, by: 41, cx: near.cx - 60 };
  const w = new Wallet(null);
  const player = beside(near, distance, 150);

  hold(w, near, player, distance, 0.3);
  const id = w.link.id;
  const progress = w.link.charge;

  // The same tick sequence against the OTHER node: a new hold, from zero.
  w.holdLink(1 / 60, 0, [far], player, distance, TEST_W, () => {}, () => false);
  assert.notEqual(w.link.id, id);
  assert.ok(w.link.charge < progress);
});

test("a node out of position still advertises its price — that is the whole affordance", () => {
  // There is no text prompt any more: the beam, the bar and the number do the
  // teaching. Which puts the entire job of telling a centre-line driver that
  // there is money out here on the PRICE LABEL, so the one thing that must
  // never happen is a node going quiet just because the car is not yet in a
  // position to drain it.
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 40 });
  const w = new Wallet(null);
  const quiet = clockWhileQuiet(node);
  const center = centerXAt(distance, TEST_W);

  const central = w.hints(quiet, [node], { x: center, y: node.sy, speed: 350, w: 34 }, distance, TEST_W);
  assert.equal(central.length, 1, "a node in reach went unadvertised to a centre-line car");
  assert.equal(central[0].value, nodeValue(node.bx, node.by), "the price quoted was not the price");

  // And it is the same number once the car is out there earning it — the label
  // never changes its mind about what a node is worth.
  const out = w.hints(quiet, [node], beside(node, distance), distance, TEST_W);
  assert.equal(out[0].value, central[0].value);

  // Closing on it makes it louder, which is the only signal that changes.
  assert.ok(out[0].alpha > central[0].alpha, "drawing level with a node did not brighten it");
});

test("a drain in progress shows its own meter", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const player = beside(node, distance, 150);
  const quiet = clockWhileQuiet(node);

  assert.equal(w.hints(quiet, [node], player, distance, TEST_W)[0].charge, 0);
  hold(w, node, player, distance, 0.5);
  const mid = w.hints(quiet, [node], player, distance, TEST_W)[0].charge;
  assert.ok(mid > 0 && mid < 1, `meter reads ${mid}`);
});

test("a wreck's receipt draws without taking the frame down with it", () => {
  const distance = 4000;
  const w = new Wallet(null);
  w.award(100); // something for the bounty to land on top of
  w.destroyed({ bounty: 25 }, distance + 40, 30);
  assert.equal(w.marks.length, 1, "the wreck left no marker to draw");

  // Records every call rather than asserting on the pixels: what is under test
  // is that the function completes, and that the receipt was actually emitted
  // (an early return would pass a "did not throw" check trivially).
  const drawn = [];
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === "measureText" ? () => ({ width: 10 }) : (...args) => drawn.push([k, ...args])),
    set: () => true,
  });

  renderAwardMarks(ctx, w.marks, { x: 0, y: 400, speed: 150 }, distance, TEST_W);
  assert.ok(drawn.some(([k]) => k === "fillText"), "the receipt never reached the canvas");
});

// walletrender.js's other two entry points, on the same terms as the receipt
// test above: what is under test is that each one completes AND actually emits
// ink, since an early return would sail through a bare "did not throw".
//
// Worth having because these moved out of Wallet in the first place. The rule
// deciding what belongs on screen (hints, linkGeometry) is asserted in detail
// elsewhere in this file under plain Node; these two only check that the ink
// path downstream of those rules is still wired up.
function recordingCtx(drawn) {
  return new Proxy({}, {
    get: (_t, k) => (k === "measureText" ? () => ({ width: 10 }) : (...args) => drawn.push([k, ...args])),
    set: () => true,
  });
}

test("a node's price marker reaches the canvas", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const player = beside(node, distance, 150);
  const marks = w.hints(clockWhilePinging(node), [node], player, distance, TEST_W);
  assert.ok(marks.length > 0, "the node offered no marker to draw");

  const drawn = [];
  renderNodeHints(recordingCtx(drawn), marks);
  assert.ok(drawn.some(([k]) => k === "fillText"), "the price never reached the canvas");
});

test("the uplink draws while a hold is running, and nothing at all when none is", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const player = beside(node, distance, 150);

  const idle = [];
  renderUplink(recordingCtx(idle), 0, w.linkGeometry([node], player, player.x));
  assert.equal(idle.length, 0, "a car with no hold still drew a dish");

  hold(w, node, player, distance, 0.5);
  const live = [];
  renderUplink(recordingCtx(live), 0, w.linkGeometry([node], player, player.x));
  assert.ok(live.some(([k]) => k === "stroke"), "the dish never reached the canvas");
});

// --- The dish: the same fact, drawn on the car -------------------------------

test("no hold, no dish — the car only wears one while it is actually taking something", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const player = beside(node, distance, 150);
  assert.equal(w.linkGeometry([node], player, player.x), null);
});

test("the dish rides the flank the node is on, clear of the car's own body", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const player = beside(node, distance, 150);
  hold(w, node, player, distance, 1);

  const link = w.linkGeometry([node], player, player.x);
  assert.ok(link, "a running hold drew no dish");
  // The whole point of the marker: it says WHICH WAY the money is.
  assert.equal(Math.sign(link.ax - player.x), Math.sign(node.cx - player.x));
  // Off the edge of the body, never on top of the wireframe.
  assert.ok(Math.abs(link.ax - player.x) >= player.w / 2);
  assert.ok(Math.abs(link.dx - player.x) > Math.abs(link.ax - player.x));
  // And it is aimed at the node it is draining, not at the road ahead.
  assert.ok(Math.sign(link.ux) === Math.sign(node.cx - player.x));
});

test("the dish brightens with the drain it is reporting, and lands on the node", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const player = beside(node, distance, 150);

  hold(w, node, player, distance, 0.2);
  const early = w.linkGeometry([node], player, player.x);
  hold(w, node, player, distance, 0.3);
  const later = w.linkGeometry([node], player, player.x);
  assert.ok(later.progress > early.progress, "progress went backwards");
  assert.ok(later.progress < 1, "the meter filled before the hold did");
  // The far end is the node itself — the link is between two real things.
  assert.equal(later.nx, node.cx);
  assert.equal(later.ny, node.sy);
});

test("a node the floor is no longer drawing takes its dish with it", () => {
  // linkGeometry reads the node out of the list actually on screen, so a hold on
  // something that has scrolled away draws nothing rather than a beam into an
  // empty patch of city.
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const player = beside(node, distance, 150);
  hold(w, node, player, distance, 1);
  assert.equal(w.linkGeometry([], player, player.x), null);
});

// --- The SIPHON RIG (game/upgrades.js's `siphon` stat) -----------------------
//
// A player stand-in with a rig tier bolted on — everything else about `beside`
// unchanged, since the rig is read straight off `player.siphonLevel` by
// wallet.js and nothing here needs to know the table it drives.
function rigged(node, distance, level, speed = 150) {
  return { ...beside(node, distance, speed), siphonLevel: level };
}

test("an unrigged player reads the same as one with no siphonLevel at all", () => {
  // player.js defaults siphonLevel to 0, but wallet.js's own test fixtures
  // (this file's `beside`/`atNode`) carry no such field, and that omission has
  // to keep meaning "stock" rather than throwing or reading as tier 0 by luck.
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const bare = beside(node, distance);
  const stock = rigged(node, distance, 0);
  assert.equal(new Wallet(null).linkRate(150, bare), new Wallet(null).linkRate(150, stock));
});

test("the rig reaches further: a node out of a stock car's range is in reach for a maxed one", () => {
  const distance = 4000;
  // Well past LINK_RADIUS (300) but inside the maxed rig's 390.
  const node = nodeBeside(distance, { offRoadBy: 340 });
  const w = new Wallet(null);
  const stock = rigged(node, distance, 0);
  const maxed = rigged(node, distance, 3);
  assert.equal(w.payable(node, stock, distance, TEST_W), false, "a stock car reached a node past LINK_RADIUS");
  assert.equal(w.payable(node, maxed, distance, TEST_W), true, "the maxed rig did not reach a node inside its own range");
});

test("the rig drains faster at every tier, at the same distance", () => {
  const w = new Wallet(null);
  let prev = w.linkRate(150, { siphonLevel: 0 });
  for (let level = 1; level <= 3; level++) {
    const rate = w.linkRate(150, { siphonLevel: level });
    assert.ok(rate > prev, `tier ${level} drained no faster than tier ${level - 1}`);
    prev = rate;
  }
});

test("the rig's yield pays out more per node, and the floor's own price tag agrees with what lands", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 40 }); // well within even a stock car's reach
  const stockValue = nodeValue(node.bx, node.by);

  const stockPaid = hold(new Wallet(null), node, rigged(node, distance, 0), distance, 2);
  assert.equal(stockPaid, stockValue, "a stock car's payout drifted from the catalogue's own price");

  const clock = 0;
  for (let level = 1; level <= 3; level++) {
    const w = new Wallet(null);
    const player = rigged(node, distance, level);
    // THE HINT MUST MATCH THE PAYOUT. hints() is what the player reads on the
    // floor before committing to a node; collect() is what actually lands. A
    // rig that quoted one and paid the other would be exactly the HUD lying
    // this file's own header (see wallet.js) says never happens.
    const quoted = w.hints(clock, [node], player, distance, TEST_W)[0].value;
    const paid = hold(w, node, player, distance, 2, clock);
    assert.equal(paid, quoted, `tier ${level} paid a different figure than it quoted`);
    assert.ok(paid > stockPaid, `tier ${level} paid no more than a stock car`);
  }
});

test("the four SIPHON_TIERS levels the shop can actually sell all clear a stock car's own payout", () => {
  // upgrades.js's TIER_COUNT is 3 (three tiers to BUY, on top of the level-0
  // stock car every stat already starts at) — a fourth entry in wallet.js's
  // own table that the shop could never reach would be dead code.
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 40 });
  const stockPaid = hold(new Wallet(null), node, rigged(node, distance, 0), distance, 2);
  for (let level = 1; level <= TIER_COUNT; level++) {
    const paid = hold(new Wallet(null), node, rigged(node, distance, level), distance, 2);
    assert.ok(paid > stockPaid, `level ${level} (within TIER_COUNT) did not out-earn stock`);
  }
});
