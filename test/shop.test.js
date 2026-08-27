// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// The upgrade shop: what the dock sells, the tier ladder, and what a purchase moves.
//
// The catalogue in game/upgrades.js is written almost entirely as relations to
// OTHER files. Every stat's `base` is imported from the module that owns the
// stock car, the consumable quantities are the pickup crates' own, and the
// ceilings each tier comment names ("past the fastest cruise", "still under the
// rig", "a third of a mine") are arithmetic across cartypes.js and
// obstacletypes.js. Those are exactly the claims that quietly stop being true
// when somebody retunes a car — which is what this whole suite is for.
//
// Everything imported here is DOM-free at module scope, so the game's real
// modules load under plain Node.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CONSUMABLES,
  STATS,
  TIER_PRICES,
  TIER_COUNT,
  Garage,
  statById,
  statValue,
  tierPrice,
  priceOf,
  purchase,
} from "../src/game/upgrades.js";
import { AMMO, HEAL, SHIELD, PICKUP_TYPES } from "../src/game/pickuptypes.js";
import { WEAPON_TYPES, Loadout } from "../src/game/weapons.js";
import { Player, MAX_SPEED, PLAYER_MASS, BASE_MAX_HEALTH } from "../src/game/player.js";
import { CAR_TYPES } from "../src/game/cartypes.js";
// The fastest cruise on the road, shared with the speed-band assertions in
// road-and-caches.test.js rather than re-derived here — the ENGINE ceiling and
// the traffic band are the same claim seen from two ends.
import { fastest } from "../test-support/fixtures.js";
import { OBSTACLE_TYPES } from "../src/game/obstacletypes.js";
import { Wallet } from "../src/game/wallet.js";

// A player and a full wallet, which is what nearly every purchase test needs.
// The Player constructor's x/y are screen framing and nothing here reads them.
function shopper(credits = 100000) {
  const wallet = new Wallet(null);
  wallet.award(credits);
  return { wallet, player: new Player(0, 0), loadout: new Loadout(), garage: new Garage() };
}

// --- The shelves ------------------------------------------------------------

test("every consumable is one of the three effects a crate can have, with the fields that kind reads", () => {
  // upgrades.js spends a consumable through pickuptypes.js's applyPickup, so a
  // row naming a kind that switch has no branch for — or missing the field the
  // branch reads — would take the player's money and do nothing at all.
  for (const entry of CONSUMABLES) {
    assert.ok([AMMO, HEAL, SHIELD].includes(entry.kind), `${entry.id} has an unknown kind`);
    assert.ok(entry.price > 0, `${entry.id} must cost something`);
    assert.ok(entry.detail, `${entry.id} has no detail column to draw`);
    if (entry.kind === AMMO) {
      assert.ok(entry.amount > 0, `${entry.id} refills nothing`);
      const weapon = WEAPON_TYPES.find((w) => w.id === entry.weaponId);
      assert.ok(weapon, `${entry.id} refills a weapon that isn't in the catalogue`);
      // Selling rounds for a gun that can never run out is selling nothing.
      assert.notEqual(weapon.ammo, Infinity, `${entry.id} refills the infinite gun`);
      assert.ok(entry.amount <= weapon.ammo,
        `${entry.id} sells more rounds than ${weapon.id}'s whole magazine`);
    }
    if (entry.kind === HEAL) assert.ok(entry.amount > 0, `${entry.id} heals nothing`);
    if (entry.kind === SHIELD) assert.ok(entry.duration > 0, `${entry.id} shields for no time`);
  }
});

test("every finite weapon in the player's catalogue can be rearmed at the dock", () => {
  // A gun with a magazine and no shelf row is a gun that runs dry with no way
  // back short of finding a crate — the shop is supposed to be the reliable
  // half of resupply, so this is a coverage check over WEAPON_TYPES rather than
  // over the shelf.
  for (const weapon of WEAPON_TYPES) {
    if (weapon.ammo === Infinity) continue;
    assert.ok(CONSUMABLES.some((e) => e.kind === AMMO && e.weaponId === weapon.id),
      `nothing on the shelf reloads ${weapon.id}`);
  }
});

test("a GUN is topped up by the crate's own quantity", () => {
  // upgrades.js's header claims a gun row sells what the road drops, so a player
  // who knows what a ROCKET+ crate is worth already knows what the row is worth.
  // Two catalogues, one set of numbers — this is what keeps them one set when
  // somebody retunes either.
  for (const entry of CONSUMABLES) {
    if (entry.kind !== AMMO) continue;
    const weapon = WEAPON_TYPES.find((w) => w.id === entry.weaponId);
    if (weapon.payload) continue; // a layer — see the next test
    const crate = PICKUP_TYPES.find((p) => p.kind === AMMO && p.weaponId === entry.weaponId);
    assert.equal(entry.amount, crate.amount,
      `${entry.id} no longer matches the ${entry.weaponId} crate`);
  }
});

test("a LAYER is rearmed as a whole set, whatever was left in it", () => {
  // A layer's magazine is three or five rounds (weapons.js), and at that size a
  // "+1" row is not a purchase — it is a rounding error on a decision the player
  // walked down a menu to make. So the mine and the strip sell the WHOLE
  // magazine, which Weapon.refill's own cap turns into "top it right up" however
  // much was left. Told apart by `payload`, exactly as weapons.js tells a layer
  // from a gun everywhere else.
  const layers = WEAPON_TYPES.filter((w) => w.payload);
  assert.ok(layers.length > 0, "the catalogue has no layers to check");
  for (const weapon of layers) {
    const row = CONSUMABLES.find((e) => e.kind === AMMO && e.weaponId === weapon.id);
    assert.ok(row, `nothing on the shelf rearms ${weapon.id}`);
    assert.equal(row.amount, weapon.ammo,
      `${row.id} is not a whole set of ${weapon.id}`);
  }
});

test("rearming a layer costs more per round than topping up a gun", () => {
  // A set bought in one press is a much bigger favour than a crate's worth of
  // rounds — the strip's three-round magazine is the entire reason a belted road
  // is not permanent (weapons.js) — so the layers stay the dearest rounds on the
  // shelf. Per ROUND rather than per row, since the rows sell wildly different
  // counts.
  const perRound = (id) => {
    const row = CONSUMABLES.find((e) => e.id === id);
    return row.price / row.amount;
  };
  const dearestGun = Math.max(perRound("buy_rocket_ammo"), perRound("buy_tracer_ammo"));
  assert.ok(perRound("buy_mine_ammo") > dearestGun, "mines are cheaper per round than a gun");
  // ...and the strip is dearer still, being the stingiest magazine in the game.
  assert.ok(perRound("buy_spikes_ammo") > perRound("buy_mine_ammo"),
    "spike strips must stay the dearest round on the shelf");
});

test("the repair and the shield say on the shelf exactly what they hand over", () => {
  // These two rows were once the crates' own figures verbatim, and that is no
  // longer the relation: the dock's repair is deliberately SMALLER than the FIX
  // crate's and its shield deliberately LONGER than the crate's, because one is
  // bought on demand and the other is what the road happened to drop. The tuning
  // editor is allowed to move both independently — see
  // validateUpgradeConsumableChanges, which accepts amount/duration on a shop row
  // without touching pickuptypes.js.
  //
  // What must NOT drift is the row against its own caption. `detail` is written
  // out by hand rather than formatted (upgrades.js says why: three rows, three
  // different units), so nothing but this assertion stops a retune from leaving
  // the shelf advertising a figure the purchase no longer pays out. That is the
  // one bug a storefront must not have, and it is exactly the bug a tuning pass
  // caused here once already.
  const heal = CONSUMABLES.find((e) => e.kind === HEAL);
  const shield = CONSUMABLES.find((e) => e.kind === SHIELD);
  assert.equal(heal.detail, `+${heal.amount} HULL`);
  assert.equal(shield.detail, `${shield.duration} SEC`);
  // Both still have to be worth walking down a menu for, so neither may fall
  // under the crate that grants the same thing for free.
  assert.ok(heal.amount > 0 && shield.duration > 0, "the dock sells nothing");
  assert.ok(shield.duration >= PICKUP_TYPES.find((p) => p.kind === SHIELD).duration,
    "a bought shield is shorter than the one the road gives away");
});

test("every AMMO row's caption is its own count", () => {
  // Same rule as the repair and the shield above, for the rows that spell their
  // count out as rounds. The set rows ("SET OF 8") name the count too, so they
  // are held to it the same way.
  for (const row of CONSUMABLES.filter((e) => e.kind === AMMO)) {
    const stated = Number(row.detail.match(/\d+/)?.[0]);
    assert.equal(stated, row.amount, `${row.id} advertises ${row.detail} but hands over ${row.amount}`);
  }
});

test("nothing on either shelf is free, and no two rows share an id", () => {
  // The ids are what save data, tests and debugging address a row by — the same
  // stable-key rule every other catalogue in the game states.
  const ids = [...CONSUMABLES, ...STATS].map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate catalogue id");
  for (const stat of STATS) {
    assert.ok(stat.price > 0, `${stat.id} is free`);
    assert.ok(stat.step > 0, `${stat.id} buys nothing`);
    assert.ok(stat.note, `${stat.id} has no line to show under the cursor`);
  }
});

// --- The ladder -------------------------------------------------------------

test("every stat's base is the stock car's own figure, not a restated copy", () => {
  // The whole reason STATS imports MAX_SPEED/BASE_MAX_HEALTH/PLAYER_MASS is that
  // retuning the car should retune the ladder hanging off it. A base that had
  // drifted would put the shop's readout and the car's actual behaviour out of
  // step, which is the one bug a storefront must not have.
  assert.equal(statById("engine").base, MAX_SPEED);
  assert.equal(statById("chassis").base, BASE_MAX_HEALTH);
  assert.equal(statById("ram").base, PLAYER_MASS);
  // The deflector is a BONUS on whatever a shield source offered, so its base is
  // zero by definition — a stock car adds nothing (player.js's activateShield).
  assert.equal(statById("deflector").base, 0);
});

test("the tier ladder rises, and the top tier costs four times the first", () => {
  assert.equal(TIER_PRICES[0], 1, "tier 1 must be the stat's own price");
  for (let i = 1; i < TIER_PRICES.length; i++) {
    assert.ok(TIER_PRICES[i] > TIER_PRICES[i - 1],
      `tier ${i + 1} must cost more than tier ${i}`);
  }
  assert.equal(TIER_PRICES.at(-1), 4, "upgrades.js's header claims a 4x top tier");
  for (const stat of STATS) {
    for (let level = 0; level < TIER_COUNT; level++) {
      assert.equal(tierPrice(stat, level), stat.price * TIER_PRICES[level]);
    }
    // NULL past the last tier — not Infinity, not 0. "No longer for sale" is a
    // different thing from "expensive", and shop.js draws it as MAX rather than
    // as a price nobody can meet.
    assert.equal(tierPrice(stat, TIER_COUNT), null, `${stat.id} is still for sale when maxed`);
  }
});

test("a fully upgraded engine passes the fastest thing on the road, but only just", () => {
  // ENGINE's own comment claims 740 clears the cycle's 730. The claim that
  // matters is the RELATION: a ladder stopping short of the fastest cruise would
  // never let the player escape anything, and one clearing it by a wide margin
  // would delete the road behind them.
  const engine = statById("engine");
  const top = statValue(engine, TIER_COUNT);
  assert.ok(top > fastest,
    `a maxed engine (${top}) must out-run the fastest cruise (${fastest})`);
  assert.ok(top < fastest * 1.1,
    `a maxed engine (${top}) clears the fastest cruise (${fastest}) by too much`);
});

test("a fully upgraded ram plate never out-masses the rig", () => {
  // cartypes.js calls the rig "immovable in practice — ram it and you lose, not
  // the rig", and RAM PLATE's own comment promises not to delete that. Mass is
  // the whole mechanic (collisions.js splits both damage and separation by
  // inverse mass), so this is the ceiling keeping one car on the road unrammable.
  const top = statValue(statById("ram"), TIER_COUNT);
  const rig = CAR_TYPES.find((t) => t.id === "rig");
  assert.ok(top < rig.mass, `a maxed ram plate (${top}) out-masses the rig (${rig.mass})`);
  // ...and it does beat the car built to ram, or the tiers buy nothing.
  const bruiser = CAR_TYPES.find((t) => t.id === "bruiser");
  assert.ok(top > bruiser.mass,
    `a maxed ram plate (${top}) must beat the bruiser (${bruiser.mass})`);
});

test("three chassis tiers are worth about one mine", () => {
  // CHASSIS is sized against what actually removes hull rather than as a round
  // fraction of the bar — obstacletypes.js calls the mine "the single hardest
  // hit anything on the road can deal", so the step is measured against it.
  const mine = OBSTACLE_TYPES.find((o) => o.id === "caltrop");
  const gained = statById("chassis").step * TIER_COUNT;
  assert.ok(gained >= mine.blastDamage * 0.9 && gained <= mine.blastDamage * 1.1,
    `a maxed chassis (+${gained}) should be about one mine (${mine.blastDamage})`);
});

// --- What a purchase moves ---------------------------------------------------

test("a Garage starts stock, and its stats block is what a fresh Player already reads", () => {
  // main.js builds the player and the garage side by side and applies nothing
  // until the first purchase, so an empty garage that disagreed with a stock car
  // would silently retune the car the first time anything WAS bought.
  const { player, garage } = shopper();
  const stats = garage.stats;
  assert.equal(stats.maxSpeed, player.maxSpeed);
  assert.equal(stats.maxHealth, player.maxHealth);
  assert.equal(stats.shieldBonus, player.shieldBonus);
  assert.equal(stats.mass, player.mass);
  assert.equal(stats.siphonLevel, player.siphonLevel);
});

test("applyUpgrades is absolute, so applying one purchase twice cannot double it", () => {
  // purchase() re-derives the whole block from the tier counters rather than
  // nudging the car, which is what lets main.js re-apply freely — and what makes
  // it safe for the shop to be entered and left any number of times a run.
  const { player, garage } = shopper();
  const engine = statById("engine");
  garage.addTier(engine);
  player.applyUpgrades(garage.stats);
  const once = player.maxSpeed;
  player.applyUpgrades(garage.stats);
  assert.equal(player.maxSpeed, once, "a second apply moved the car again");
  assert.equal(once, MAX_SPEED + engine.step);
});

test("a chassis tier fills the room it just made, rather than diluting the bar", () => {
  // player.js's applyUpgrades heals by exactly the capacity gained — a bar that
  // got LESS full the moment the player paid for more hull is the opposite of
  // what the row promises.
  const { player, garage } = shopper();
  player.damage(80);
  const before = player.health;
  garage.addTier(statById("chassis"));
  player.applyUpgrades(garage.stats);
  const step = statById("chassis").step;
  assert.equal(player.maxHealth, BASE_MAX_HEALTH + step);
  assert.equal(player.health, before + step);
});

test("the deflector lengthens every shield the car is ever handed, from any source", () => {
  // The bonus lives in Player.activateShield rather than in the pickup
  // catalogue, so ONE upgrade covers the crate, the dock's own SHIELD row and
  // anything that grants a shield later, without any of them knowing it exists.
  const { player, garage } = shopper();
  const crate = PICKUP_TYPES.find((p) => p.kind === SHIELD);
  player.activateShield(crate.duration);
  assert.equal(player.shieldTime, crate.duration);

  const deflector = statById("deflector");
  garage.addTier(deflector);
  player.applyUpgrades(garage.stats);
  player.shieldTime = 0;
  player.activateShield(crate.duration);
  assert.equal(player.shieldTime, crate.duration + deflector.step);
});

test("a bought shield is BANKED, not started — same as the crate", () => {
  // A consumable is spent through the crate's own code (upgrades.js's
  // purchase -> pickuptypes.js's applyPickup), so the dock's SHIELD row gets
  // the charge behaviour for free: nothing ticks while the car is still on the
  // lift, and the window opens on the first hit that would have hurt. A shield
  // the player PAID for must not be able to expire over empty road.
  const { wallet, player, loadout, garage } = shopper();
  const row = CONSUMABLES.find((e) => e.kind === SHIELD);

  assert.equal(purchase(row, wallet, player, loadout, garage), true);
  assert.equal(player.shieldCharge, row.duration, "the purchase banks its full duration");
  assert.equal(player.shieldTime, 0, "...and starts no clock");

  player.damage(9999);
  assert.equal(player.health, player.maxHealth, "the hit that trips it is deflected too");
  assert.equal(player.shieldTime, row.duration);
  assert.equal(player.shieldCharge, 0);
});

test("a refused purchase costs nothing at all", () => {
  // purchase() settles availability AND affordability before Wallet.spend is
  // called, so there is no path on which a player pays for a refusal — and none
  // on which a car gets an upgrade the wallet did not pay for.
  const { wallet, player, loadout, garage } = shopper(10); // nowhere near tier 1
  const engine = statById("engine");
  assert.equal(purchase(engine, wallet, player, loadout, garage), false);
  assert.equal(wallet.credits, 10, "a refusal took money");
  assert.equal(garage.levelOf(engine), 0, "a refusal booked a tier");
  assert.equal(player.maxSpeed, MAX_SPEED, "a refusal moved the car");
});

test("a maxed stat stops being for sale, however much money is on the table", () => {
  const { wallet, player, loadout, garage } = shopper();
  const engine = statById("engine");
  for (let i = 0; i < TIER_COUNT; i++) {
    assert.equal(purchase(engine, wallet, player, loadout, garage), true, `tier ${i + 1} refused`);
  }
  assert.equal(garage.levelOf(engine), TIER_COUNT);
  assert.equal(priceOf(engine, garage), null, "a maxed stat still quotes a price");
  const held = wallet.credits;
  assert.equal(purchase(engine, wallet, player, loadout, garage), false, "sold a fourth tier");
  assert.equal(wallet.credits, held, "charged for a tier that doesn't exist");
  assert.equal(player.maxSpeed, statValue(engine, TIER_COUNT));
});

test("each tier costs what the ladder says, taken out of the wallet in order", () => {
  const { wallet, player, loadout, garage } = shopper();
  const chassis = statById("chassis");
  for (let level = 0; level < TIER_COUNT; level++) {
    const before = wallet.credits;
    assert.equal(priceOf(chassis, garage), tierPrice(chassis, level));
    purchase(chassis, wallet, player, loadout, garage);
    assert.equal(before - wallet.credits, tierPrice(chassis, level),
      `tier ${level + 1} charged the wrong price`);
  }
});

test("a consumable is spent through the crate's own effect, capped where the crate is capped", () => {
  // A bought repair IS a FIX crate (upgrades.js's header), so it inherits
  // Player.heal's cap and Weapon.refill's: a purchase over a full magazine costs
  // the player their money exactly as driving over a crate at full ammo would.
  const { wallet, player, loadout, garage } = shopper();

  const rocketRow = CONSUMABLES.find((e) => e.weaponId === "rocket");
  const rocket = loadout.get("rocket");
  rocket.ammo = 0;
  assert.equal(purchase(rocketRow, wallet, player, loadout, garage), true);
  assert.equal(rocket.ammo, rocketRow.amount);
  rocket.ammo = rocket.type.ammo;
  purchase(rocketRow, wallet, player, loadout, garage);
  assert.equal(rocket.ammo, rocket.type.ammo, "a refill overflowed the magazine");

  const repair = CONSUMABLES.find((e) => e.kind === HEAL);
  player.damage(500); // more than the hull holds; floors at 0
  purchase(repair, wallet, player, loadout, garage);
  assert.equal(player.health, repair.amount);
});

test("one press rearms a layer from any state, and never past its magazine", () => {
  // The point of selling a whole set: the player presses once and leaves with a
  // full magazine, whether they had one round left or none. Weapon.refill's cap
  // is what makes "sell the whole magazine" and "top it right up" the same act.
  const { wallet, player, loadout, garage } = shopper();
  for (const weapon of WEAPON_TYPES.filter((w) => w.payload)) {
    const row = CONSUMABLES.find((e) => e.kind === AMMO && e.weaponId === weapon.id);
    const carried = loadout.get(weapon.id);
    for (const left of [0, 1, weapon.ammo]) {
      carried.ammo = left;
      assert.equal(purchase(row, wallet, player, loadout, garage), true);
      assert.equal(carried.ammo, weapon.ammo,
        `${weapon.id} was not a full set after one press (had ${left})`);
    }
  }
});

test("a consumable can be bought over and over — only the stats are rationed", () => {
  // The two shelves are different KINDS of thing (upgrades.js's header), and this
  // is the difference: a flat price that never rises and no counter behind it.
  const { wallet, player, loadout, garage } = shopper();
  const shield = CONSUMABLES.find((e) => e.kind === SHIELD);
  for (let i = 0; i < 5; i++) {
    const before = wallet.credits;
    assert.equal(purchase(shield, wallet, player, loadout, garage), true, `refused sale ${i + 1}`);
    assert.equal(before - wallet.credits, shield.price, "a consumable's price moved");
  }
});

test("the mass the shop sells is the mass the collision solver reads", () => {
  // RAM PLATE is one shelf row because mass is one number that buys three
  // things. That only holds while the physics reads the CAR's mass rather than
  // the module constant — collisions.js's PlayerBody proxies it for exactly this
  // reason, and obstacles.js's ram was switched to it alongside.
  const { wallet, player, loadout, garage } = shopper();
  const ram = statById("ram");
  purchase(ram, wallet, player, loadout, garage);
  assert.equal(player.mass, PLAYER_MASS + ram.step);
  assert.notEqual(player.mass, PLAYER_MASS, "the upgrade left the car at stock mass");
});

test("an upgraded car can actually reach the speed it paid for", () => {
  // The clamp in Player.update reads the instance's own ceiling, not the module
  // constant — an ENGINE tier that raised a number nothing enforced would be the
  // most expensive no-op in the game.
  const { wallet, player, loadout, garage } = shopper();
  const engine = statById("engine");
  purchase(engine, wallet, player, loadout, garage);
  player.speed = 100000; // far past any ceiling
  player.update(1 / 60, { left: -10000, right: 10000 });
  assert.equal(player.speed, MAX_SPEED + engine.step);
});
