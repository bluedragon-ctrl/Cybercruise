// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// THE SPECIALS SHELF: the four one-off upgrades (game/upgrades.js's SPECIALS)
// and the four systems that act on them.
//
// These are the shop's most cross-file entries by some distance. A special is a
// FLAG in upgrades.js, carried on the car by player.js, and read somewhere else
// entirely — weapons.js at the muzzle, projectiles.js in the air, traffic.js at
// the moment of damage, shieldstorm.js on its own clock. Nothing type-checks
// the string that joins them: a row whose `special` is "twincannon" would sell
// perfectly, cost the player 300 CR, and do absolutely nothing forever.
//
// So what is pinned here is the WIRING rather than the tuning — every flag is
// claimed by something, every claim names a flag that exists, and the effect
// each row's caption promises is the effect the code actually applies.
//
// Everything imported is DOM-free at module scope, so the real modules load
// under plain Node.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CONSUMABLES,
  SPECIALS,
  STATS,
  TIER_PRICES,
  Garage,
  priceOf,
  purchase,
  tierPrice,
} from "../src/game/upgrades.js";
import {
  WEAPON_TYPES,
  FLIGHT_SEEKING,
  MARK_DAMAGE_MULT,
  Loadout,
  muzzleOffsets,
  shotMark,
} from "../src/game/weapons.js";
import { Player } from "../src/game/player.js";
import { Wallet } from "../src/game/wallet.js";
import { Projectiles } from "../src/game/projectiles.js";
import { Traffic } from "../src/game/traffic.js";
import { CAR_TYPES, ENEMY_FACTION } from "../src/game/cartypes.js";
import {
  ShieldStorm,
  STORM_RADIUS,
  STORM_DAMAGE,
  STORM_INTERVAL,
} from "../src/game/shieldstorm.js";

const weaponById = (id) => WEAPON_TYPES.find((w) => w.id === id);
const specialById = (id) => SPECIALS.find((s) => s.id === id);

// A shopper with money to burn, same fixture shape shop.test.js uses.
function shopper(credits = 100000) {
  const wallet = new Wallet(null);
  wallet.award(credits);
  return { wallet, player: new Player(0, 0), loadout: new Loadout(), garage: new Garage() };
}

// A car with everything projectiles.js and shieldstorm.js read off a target,
// and nothing else. Stands in for a TrafficCar wherever the real spawner's
// randomness would only get in the way.
function target(worldY, offset, health = 1000, extra = {}) {
  return {
    alive: true,
    seekable: true,
    worldY,
    offset,
    w: 34,
    h: 62,
    health,
    markTime: 0,
    damage(hp) {
      this.health -= hp;
      if (this.health <= 0) this.alive = false;
    },
    markTag(seconds) {
      this.markTime = Math.max(this.markTime, seconds);
    },
    ...extra,
  };
}

// --- The shelf ---------------------------------------------------------------

test("every special is a unique flag with a price, a caption and a line under the cursor", () => {
  const flags = new Set();
  for (const item of SPECIALS) {
    assert.ok(item.special, `${item.id} names no flag, so nothing can ever read it`);
    assert.ok(!flags.has(item.special), `${item.id} reuses the flag ${item.special}`);
    flags.add(item.special);
    assert.ok(item.price > 0, `${item.id} is free`);
    assert.ok(item.detail, `${item.id} has no detail column to draw`);
    assert.ok(item.note, `${item.id} has no line to show under the cursor`);
    assert.ok(item.color, `${item.id} has no accent, so its row cannot be told apart`);
    // A special is NOT a stat and NOT a consumable, and priceOf tells the three
    // apart by exactly these fields. A row carrying two of them would be priced
    // by whichever branch happened to be tested first.
    assert.ok(!item.kind, `${item.id} looks like a consumable to priceOf`);
    assert.ok(item.step === undefined, `${item.id} looks like a stat to priceOf`);
  }
});

test("every flag on the shelf is claimed by a system, and every claim names a flag on the shelf", () => {
  // The join that nothing else can check. A weapon naming a `twin` the shop
  // does not sell is a dead upgrade path; a shelf row whose flag no system
  // reads is 300 CR of nothing.
  const sold = new Set(SPECIALS.map((s) => s.special));

  const claimed = new Set();
  for (const type of WEAPON_TYPES) {
    if (type.twin) claimed.add(type.twin);
    if (type.mark) claimed.add(type.mark);
  }
  // game/shieldstorm.js reads its own flag straight off the player rather than
  // through a catalogue field, so it is named here — the one claim that cannot
  // be discovered by walking a list.
  claimed.add("shieldStorm");

  for (const flag of sold) {
    assert.ok(claimed.has(flag), `${flag} is sold but nothing reads it`);
  }
  for (const flag of claimed) {
    assert.ok(sold.has(flag), `${flag} is read but nothing sells it`);
  }
});

test("a special costs more than the first rung of a system and less than finishing one", () => {
  // upgrades.js's own pricing claim, and the reason it matters at both ends: a
  // special that undercut the opening tier would be bought before anything else
  // every run, and one that cost more than a whole system would never be bought
  // at a stop paying a few hundred credits.
  const dearestFirstRung = Math.max(...STATS.map((s) => tierPrice(s, 0)));
  const fullLadder = Math.max(
    ...STATS.map((s) => TIER_PRICES.reduce((sum, m) => sum + s.price * m, 0)),
  );
  for (const item of SPECIALS) {
    assert.ok(item.price > dearestFirstRung, `${item.id} is cheaper than a first tier`);
    assert.ok(item.price < fullLadder, `${item.id} costs more than a whole system`);
  }
});

test("a special is bought once, lands on the car, and then stops being for sale", () => {
  const s = shopper();
  for (const item of SPECIALS) {
    assert.equal(priceOf(item, s.garage), item.price, `${item.id} is not on sale`);
    assert.equal(s.player.specials[item.special] ?? false, false,
      `${item.id} is fitted to a stock car`);

    const before = s.wallet.credits;
    assert.equal(purchase(item, s.wallet, s.player, s.loadout, s.garage), true);
    assert.equal(s.wallet.credits, before - item.price, `${item.id} was not paid for`);
    // THE FLAG IS ON THE CAR, not just in the garage — applyUpgrades is the
    // only thing that puts it there, and a purchase path that forgot to call it
    // would leave a row reading SOLD and a weapon behaving as stock.
    assert.equal(s.player.specials[item.special], true, `${item.id} never reached the car`);

    // ...and a one-rung ladder is finished. Null, not a price nobody can meet,
    // so shop.js draws SOLD through the machinery that draws MAX.
    assert.equal(priceOf(item, s.garage), null, `${item.id} is still for sale`);
    assert.equal(purchase(item, s.wallet, s.player, s.loadout, s.garage), false,
      `${item.id} sold twice`);
  }
});

test("a fresh garage carries no specials, so dying costs every one of them", () => {
  // Same promise upgrades.js's header makes about the tier ladder, and the
  // reason the Garage is REBUILT by newGame() rather than reset in place.
  const garage = new Garage();
  for (const item of SPECIALS) {
    assert.equal(garage.owns(item), false, `${item.id} survived into a fresh run`);
    assert.equal(garage.stats.specials[item.special], false);
  }
});

// --- TWIN CANNON / TWIN RACK -------------------------------------------------

test("a paired weapon fires two rounds, symmetric about the muzzle it always used", () => {
  for (const type of WEAPON_TYPES) {
    if (!type.twin) continue;
    // Stock: exactly the single centred round every weapon fired before the
    // shelf existed. This is the case that must not move.
    assert.deepEqual(muzzleOffsets(type, {}), [0], `${type.id} is paired unbought`);
    assert.deepEqual(muzzleOffsets(type, null), [0], `${type.id} needs a specials block`);

    const pair = muzzleOffsets(type, { [type.twin]: true });
    assert.equal(pair.length, 2, `${type.id} did not pair`);
    // SYMMETRIC about zero, so a paired weapon still shoots where the car is
    // pointed — a pair that sat off-centre would quietly re-aim the gun.
    assert.equal(pair[0] + pair[1], 0, `${type.id}'s pair is off-centre`);
    assert.equal(pair[1] - pair[0], type.twinSpread, `${type.id} ignores its own spread`);
  }
});

test("buying one weapon's pair does not pair another", () => {
  // The flag is matched against the weapon's OWN `twin`, which is the whole
  // reason each weapon names one rather than the shop naming a weapon id.
  const cannon = weaponById("cannon");
  const rocket = weaponById("rocket");
  assert.equal(muzzleOffsets(cannon, { twinCannon: true }).length, 2);
  assert.equal(muzzleOffsets(rocket, { twinCannon: true }).length, 1);
  assert.equal(muzzleOffsets(rocket, { twinRocket: true }).length, 2);
  assert.equal(muzzleOffsets(cannon, { twinRocket: true }).length, 1);
});

test("a pair is two separate rounds, and an aimed pair still both land", () => {
  // Both halves of the twinSpread comment in weapons.js. Too narrow and the
  // pair is one round with a seam down it; too wide and the upgrade quietly
  // halves the player's accuracy.
  //
  // HOW WIDE IS "TOO WIDE" DEPENDS ON THE FLIGHT MODE, which is why this is
  // two ceilings and not one. A round that cannot steer has to fit inside the
  // NARROWEST car on the road or the player misses with half of every burst.
  // A SEEKER may sit wider — it is aimed by projectiles.js's seek() rather than
  // by the muzzle, and being far enough apart to pick different cars is the
  // upgrade — but it still has to be inside the widest car, so a pair that does
  // lock the same target both land on it.
  const narrowest = Math.min(...CAR_TYPES.map((c) => c.w));
  const widest = Math.max(...CAR_TYPES.map((c) => c.w));
  for (const type of WEAPON_TYPES) {
    if (!type.twin) continue;
    assert.ok(type.twinSpread > type.width * 2,
      `${type.id}'s pair overlaps into one round`);
    const ceiling = type.flight === FLIGHT_SEEKING ? widest : narrowest;
    assert.ok(type.twinSpread < ceiling,
      `${type.id}'s pair is too wide to both hit one car`);
  }
});

test("two rockets in the air hunt different cars when there are two to hunt", () => {
  // TWIN RACK's actual claim — "each hunting its own car" — and the reason
  // projectiles.js's seek() ranks a locked target below an unlocked one.
  const shots = new Projectiles();
  const rocket = weaponById("rocket");
  const near = target(600, -60);
  const far = target(700, 60);
  const targets = [near, far];

  const pair = muzzleOffsets(rocket, { twinRocket: true });
  for (const dx of pair) shots.spawn(0, dx, 0, rocket, 600);

  // One tick is enough: both rounds acquire on their first update.
  shots.update(0.016, targets, { distance: 0, playerY: 400, W: 600, H: 800 });
  const live = shots.shots.filter((s) => s.alive && s.seeking);
  assert.equal(live.length, 2, "both rockets should still be in the air");
  assert.notEqual(live[0].target, live[1].target,
    "both rockets locked the same car — the rack is one rocket drawn twice");
  assert.ok(live.every((s) => targets.includes(s.target)), "a rocket locked nothing");
});

test("a lone car is still hunted by both — the split is a preference, not a rule", () => {
  // The other half of the same ranking. A rocket that refused an already-locked
  // target would fly up an empty lane rather than hit the only thing there is.
  const shots = new Projectiles();
  const rocket = weaponById("rocket");
  const only = target(600, 0);

  for (const dx of muzzleOffsets(rocket, { twinRocket: true })) shots.spawn(0, dx, 0, rocket, 600);
  shots.update(0.016, [only], { distance: 0, playerY: 400, W: 600, H: 800 });

  const live = shots.shots.filter((s) => s.alive && s.seeking);
  assert.equal(live.length, 2);
  assert.ok(live.every((s) => s.target === only), "a rocket gave up on the only car on the road");
});

// --- MARKER ROUNDS -----------------------------------------------------------

test("only the tracker paints, and only once the upgrade is bought", () => {
  const tracker = weaponById("tracker");
  assert.equal(shotMark(tracker, {}), 0, "a stock tracker paints");
  assert.equal(shotMark(tracker, null), 0);
  assert.equal(shotMark(tracker, { markerRounds: true }), tracker.markTime);
  for (const type of WEAPON_TYPES) {
    if (type.id === "tracker") continue;
    assert.equal(shotMark(type, { markerRounds: true }), 0,
      `${type.id} paints, and MARKER ROUNDS is the tracker's upgrade`);
  }
});

test("a tracer hit paints what it hits, and the round that painted it gets no bonus", () => {
  // The order projectiles.js commits to: damage first, paint after. A marker
  // round that amplified itself would be a damage upgrade wearing a reticle.
  const shots = new Projectiles();
  const tracker = weaponById("tracker");
  const car = target(120, 0);

  const s = shots.spawn(0, 0, 0, tracker, 600, 1, tracker.markTime);
  assert.equal(s.mark, tracker.markTime);
  shots.update(0.3, [car], { distance: 0, playerY: 400, W: 600, H: 800 });

  assert.equal(car.markTime, tracker.markTime, "the hit did not paint the car");
  assert.equal(car.health, 1000 - tracker.damage, "the painting round amplified itself");
});

test("a marked car takes more from EVERYTHING, and stops when the paint dries", () => {
  // traffic.js applies the multiplier inside damage() — the one door every
  // damage source in the game already comes through — which is the only way
  // "everything hurts it more" can be true of a ram and a mine as well as a gun.
  const traffic = new Traffic();
  traffic.spawn({ distance: 0, player: { y: 400 }, W: 600, H: 800 });
  const car = traffic.cars[0];
  assert.ok(car, "no car was spawned to shoot at");

  const full = car.maxHealth;
  car.damage(10);
  const plain = full - car.health;

  car.markTag(4);
  assert.equal(car.marked, true);
  car.damage(10);
  const painted = full - car.health - plain;
  assert.ok(Math.abs(painted - 10 * MARK_DAMAGE_MULT) < 1e-9,
    `a marked car took ${painted} from a 10-point hit`);

  // The paint dries on the car's own clock, counted down in update().
  car.markTime = 0.05;
  car.update(0.1, { player: { y: 400, x: 300, speed: 0 }, distance: 0, W: 600, H: 800, cars: traffic.cars, obstacles: [] });
  assert.equal(car.marked, false, "the paint never dries");
});

test("a rocket prefers a painted car to a nearer unpainted one", () => {
  // The pay-off for owning both upgrades, and the reason seek() ranks marks
  // above distance: painting a car with the tracker is how the player TELLS
  // the rockets where to go.
  const shots = new Projectiles();
  const rocket = weaponById("rocket");
  const near = target(500, -40);
  const painted = target(800, 40, 1000, { markTime: 3 });

  const s = shots.spawn(0, 0, 0, rocket, 600);
  shots.update(0.016, [near, painted], { distance: 0, playerY: 400, W: 600, H: 800 });
  assert.equal(s.target, painted, "the rocket ignored the car the tracker designated");
});

// --- SHIELD STORM ------------------------------------------------------------

// A player standing at road offset 0 with a shield running, or not.
function stormPlayer({ owned = true, shield = 10 } = {}) {
  const player = new Player(0, 0);
  player.specials = { shieldStorm: owned };
  player.shieldTime = shield;
  return player;
}

const stormTick = (storm, player, cars, dt = STORM_INTERVAL) =>
  storm.update(dt, player, 0, 0, cars, null);

test("the storm does nothing without the upgrade, and nothing without a shield", () => {
  const storm = new ShieldStorm();
  const beside = () => target(0, 60);

  let car = beside();
  assert.equal(stormTick(storm, stormPlayer({ owned: false }), [car]), 0);
  assert.equal(car.health, 1000, "an unbought storm still bit");

  car = beside();
  assert.equal(stormTick(storm, stormPlayer({ shield: 0 }), [car]), 0);
  assert.equal(car.health, 1000, "the storm fired with no shield up");
});

test("the storm bites what is close and spares what is not, with falloff between", () => {
  const player = stormPlayer();
  // Just inside the rim, edge to edge — the same box-edge measurement
  // traffic.js's blast() uses, so this is what STORM_RADIUS actually means.
  const edgeGap = (34 + player.w) / 2;
  const near = target(0, edgeGap + 4);
  const far = target(0, edgeGap + STORM_RADIUS + 4);

  const struck = stormTick(new ShieldStorm(), player, [near, far]);
  assert.equal(struck, 1, "the storm reached the wrong number of cars");
  assert.ok(near.health < 1000, "the car alongside was not bitten");
  assert.equal(far.health, 1000, "the storm reached a car outside its radius");
  // Falloff: a hit at the rim is worth nearly nothing, never the full figure.
  assert.ok(1000 - near.health < STORM_DAMAGE, "the storm ignored its own falloff");
});

test("the storm is a pulse, not an aura — one discharge per interval", () => {
  // The header's own distinction, and the whole of what stops the upgrade from
  // being a bulldozer that deletes anything near it sixty times a second.
  const storm = new ShieldStorm();
  const player = stormPlayer();
  const car = target(0, (34 + player.w) / 2 + 4);

  assert.equal(storm.update(STORM_INTERVAL, player, 0, 0, [car], null), 1);
  const afterFirst = car.health;
  // Several frames' worth of ticks, still inside one interval.
  for (let i = 0; i < 10; i++) {
    assert.equal(storm.update(0.016, player, 0, 0, [car], null), 0, "the storm fired early");
  }
  assert.equal(car.health, afterFirst, "the storm damaged between discharges");
  // ...and it comes round again.
  assert.equal(storm.update(STORM_INTERVAL, player, 0, 0, [car], null), 1);
  assert.ok(car.health < afterFirst, "the storm never fired again");
});

test("a shield that has just come up discharges at once", () => {
  // The timer is CLEARED while the storm is idle rather than left running, so
  // the player who drives into a pack the instant a crate lands gets the
  // discharge they went in for.
  const storm = new ShieldStorm();
  const car = target(0, 60);
  // A long stretch with no shield up...
  for (let i = 0; i < 60; i++) storm.update(0.016, stormPlayer({ shield: 0 }), 0, 0, [car], null);
  // ...then one up, on the very next frame.
  assert.equal(storm.update(0.016, stormPlayer(), 0, 0, [car], null), 1,
    "a fresh shield had to wait out a stale timer");
});

test("the storm bites civilians too, and civilians cost points", () => {
  // Both halves of shieldstorm.js's own note, pinned together because the cost
  // is the whole reason the indiscriminate behaviour is a design decision and
  // not an oversight. A future retune that spares civilians should have to come
  // through here and say so.
  const player = stormPlayer();
  const civilian = target(0, (34 + player.w) / 2 + 4);
  assert.equal(stormTick(new ShieldStorm(), player, [civilian]), 1);
  assert.ok(civilian.health < 1000, "the storm read the car's faction");

  assert.ok(CAR_TYPES.some((t) => t.faction !== ENEMY_FACTION && t.value < 0),
    "civilians no longer cost points, so the storm has no cost at all");
});

test("the storm is worth less than shooting, which is what stops it farming the road", () => {
  // shieldstorm.js's own claim. A discharge has to be under one cannon round,
  // or parking in traffic under a bought shield out-earns driving and gunning.
  const cannon = weaponById("cannon");
  assert.ok(STORM_DAMAGE < cannon.damage,
    "a shield discharge hits harder than the default gun");
  // And the shelf has to be telling the truth about needing a shield at all:
  // the storm's own row does not grant one, so a run buying it and nothing else
  // gets nothing. Left as an assertion because it is the row's whole risk.
  assert.ok(CONSUMABLES.some((c) => c.id === "buy_shield"),
    "nothing on the shelf sells the shield SHIELD STORM depends on");
  assert.ok(specialById("shield_storm").price > 0);
});
