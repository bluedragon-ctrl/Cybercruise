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
  Loadout,
  muzzleOffsets,
  shotLock,
  lockTurnRate,
} from "../src/game/weapons.js";
import { Player } from "../src/game/player.js";
import { Lock } from "../src/game/targeting.js";
import { Wallet } from "../src/game/wallet.js";
import { Projectiles } from "../src/game/projectiles.js";
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
    damage(hp) {
      this.health -= hp;
      if (this.health <= 0) this.alive = false;
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
    if (type.lock) claimed.add(type.lock);
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

// --- AUTOLOCK ----------------------------------------------------------------

test("only the tracker designates, and only once the upgrade is bought", () => {
  const tracker = weaponById("tracker");
  assert.equal(shotLock(tracker, {}), 0, "a stock tracker designates");
  assert.equal(shotLock(tracker, null), 0);
  assert.equal(shotLock(tracker, { autolock: true }), tracker.lockTime);
  assert.equal(lockTurnRate(tracker, { autolock: true }), tracker.lockTurnRate);
  assert.equal(lockTurnRate(tracker, {}), 0, "a stock tracker steers");
  for (const type of WEAPON_TYPES) {
    if (type.id === "tracker") continue;
    assert.equal(shotLock(type, { autolock: true }), 0,
      `${type.id} designates, and AUTOLOCK is the tracker's upgrade`);
  }
});

test("a locked round steers slower than the weapon built to seek", () => {
  // The upgrade's entire balance, and the one relation that must never invert:
  // the rocket has to stay the best seeker in the game or its own reason to
  // exist goes with it. This is also what makes the lock "will try, not
  // necessarily succeed" rather than "cannot miss".
  const tracker = weaponById("tracker");
  const rocket = weaponById("rocket");
  assert.ok(tracker.lockTurnRate > 0, "the tracker cannot steer at all");
  assert.ok(tracker.lockTurnRate < rocket.turnRate,
    "a tracer round out-turns a rocket, which makes the rocket pointless");
  // ...and a designation has to outlive the burst that made it, or the player
  // re-designates every burst and the upgrade is invisible.
  const cycle = tracker.interval + tracker.burstCount * tracker.burstInterval;
  assert.ok(tracker.lockTime > cycle,
    "a lock expires inside its own burst-and-rest cycle");
});

test("a hit designates the car it hit, for the weapon's own duration", () => {
  // The lock is EARNED BY A HIT rather than by aiming — you cannot designate
  // something you have not touched, which is what gives round one of a burst
  // its job.
  const shots = new Projectiles();
  const tracker = weaponById("tracker");
  const car = target(120, 0);
  const seen = [];
  shots.onLock = (c, seconds) => seen.push([c, seconds]);

  const s = shots.spawn(0, 0, 0, tracker, 600, 1, { lockOn: tracker.lockTime });
  assert.equal(s.lockOn, tracker.lockTime);
  assert.equal(s.locked, false, "a round fired with nothing designated should not chase");
  shots.update(0.3, [car], { distance: 0, playerY: 400, W: 600, H: 800 });

  assert.deepEqual(seen, [[car, tracker.lockTime]], "the hit did not designate the car");
  assert.equal(car.health, 1000 - tracker.damage, "designating changed the round's own damage");
});

test("a round designates only cars, never road furniture", () => {
  // `seekable` is the same opt-in flag a rocket's own lock respects, so a
  // trestle can never become the thing eight rounds chase.
  const shots = new Projectiles();
  const tracker = weaponById("tracker");
  const trestle = target(120, 0, 1000, { seekable: false });
  let fired = false;
  shots.onLock = () => { fired = true; };

  shots.spawn(0, 0, 0, tracker, 600, 1, { lockOn: tracker.lockTime });
  shots.update(0.3, [trestle], { distance: 0, playerY: 400, W: 600, H: 800 });
  assert.ok(trestle.health < 1000, "the round did not hit the obstacle at all");
  assert.equal(fired, false, "a roadblock was designated");
});

test("a round fired at a designated car chases it out of its lane", () => {
  // The upgrade itself. The round is spawned down the middle and the target
  // sits well off to one side, so a stock tracking round would hold offset 0
  // for its whole flight.
  const shots = new Projectiles();
  const tracker = weaponById("tracker");
  const car = target(900, 150);

  const s = shots.spawn(0, 0, 0, tracker, 600, 1, {
    target: car, turnRate: tracker.lockTurnRate,
  });
  assert.equal(s.locked, true);
  assert.equal(s.seeking, true, "a locked round has to borrow the seeking steer");
  assert.equal(s.turnRate, tracker.lockTurnRate, "it took the rocket's turn rate");

  shots.update(0.1, [car], { distance: 0, playerY: 400, W: 600, H: 800 });
  assert.ok(s.offset > 0, "the round did not steer toward the car at all");
  // ...but only at its own capped rate. Never a teleport onto the target.
  assert.ok(s.offset <= tracker.lockTurnRate * 0.1 + 1e-9,
    "the round steered further in one tick than its turn rate allows");
});

test("the lane rake survives: a round locked to a car dead ahead does not deviate", () => {
  // The reason AUTOLOCK costs the tracker nothing it already had. A locked car
  // in your own lane leaves target.offset - s.offset at zero, so the round
  // flies the same tracking line it always did — and `pierce` still punches
  // down the row of cars in the way, which is the weapon's whole identity.
  const shots = new Projectiles();
  const tracker = weaponById("tracker");
  const first = target(200, 0, 10);  // dies to one round...
  const second = target(400, 0, 10); // ...so the round carries on to this
  const locked = target(900, 0);

  const s = shots.spawn(0, 0, 0, tracker, 600, 1, {
    target: locked, turnRate: tracker.lockTurnRate,
  });
  shots.update(0.5, [first, second, locked], { distance: 0, playerY: 400, W: 600, H: 800 });

  assert.equal(s.offset, 0, "a round locked straight ahead drifted out of its lane");
  assert.equal(first.alive, false, "the round did not hit the car in its way");
  assert.equal(second.alive, false, "pierce stopped working once the round was locked");
});

test("when the locked car dies mid-burst the rest of the burst does NOT re-lock", () => {
  // The rule that stops one trigger pull from clearing a lane by itself. A
  // burst that re-locked would not be eight rounds following a car, it would
  // be eight rounds that cannot be spent wrongly.
  const shots = new Projectiles();
  const tracker = weaponById("tracker");
  const car = target(900, 150);
  const bystander = target(700, -150);

  const s = shots.spawn(0, 0, 0, tracker, 600, 1, {
    target: car, turnRate: tracker.lockTurnRate,
  });
  car.alive = false; // killed by something else before the round got there

  shots.update(0.1, [car, bystander], { distance: 0, playerY: 400, W: 600, H: 800 });
  assert.equal(s.target, null, "the round went looking for a replacement target");
  assert.equal(s.seeking, false, "the round is still steering at nothing");
  assert.ok(s.alive, "the round should fly on, not vanish");
});

test("the lock drops a dead car, expires on its own, and can be moved", () => {
  const lock = new Lock();
  const first = target(400, 0);
  const second = target(500, 60);

  assert.equal(lock.car, null, "a fresh lock designates something");
  assert.equal(lock.acquire(first, 3), true);
  assert.equal(lock.car, first);

  // MOVED, not refused — the newest car the player actually shot is the one
  // they mean, and a lock that could not move would leave them hosing a car
  // they had stopped caring about.
  lock.acquire(second, 3);
  assert.equal(lock.car, second);

  // A car destroyed by ANYTHING — another weapon, a mine, a ram — stops being
  // the target with no tick needed: `car` re-checks on every read.
  second.alive = false;
  assert.equal(lock.car, null, "a wreck is still being chased");
  lock.update(0.016);
  assert.equal(lock.target, null, "the dead target was not cleared");

  // ...and a live one still runs out on its own clock.
  lock.acquire(first, 0.5);
  lock.update(0.6);
  assert.equal(lock.car, null, "the designation never expires");
  assert.equal(lock.acquire(second, 3), false, "a dead car can be designated");
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
