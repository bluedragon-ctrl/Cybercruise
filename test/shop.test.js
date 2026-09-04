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
  SPECIALS,
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
import { OBSTACLE_TYPES } from "../src/game/obstacletypes.js";
import { Wallet, SIPHON_YIELDS } from "../src/game/wallet.js";
import { PlayerBody } from "../src/game/collisions.js";

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

test("every GUN sells the same fixed pack of rounds", () => {
  // upgrades.js's header claims guns sell a flat pack size rather than the
  // road's own crate quantity, so every gun row has to actually agree on that
  // number — otherwise "a flat pack" is just prose.
  const guns = CONSUMABLES.filter((e) => {
    if (e.kind !== AMMO) return false;
    const weapon = WEAPON_TYPES.find((w) => w.id === e.weaponId);
    return weapon && !weapon.payload;
  });
  assert.ok(guns.length > 1, "not enough gun rows to compare");
  const [first, ...rest] = guns;
  for (const row of rest) {
    assert.equal(row.amount, first.amount,
      `${row.id} sells ${row.amount} rounds a pack, ${first.id} sells ${first.amount}`);
  }
});

test("the LAYER's pack beats the road's own crate without emptying the magazine", () => {
  // The mine's magazine is sixteen rounds (weapons.js) and the road's own
  // MINE+ crate hands over two (pickuptypes.js) — the shop row has to sit
  // strictly between the two: more than a lucky pickup, or there is no reason
  // to walk down a menu for it, and less than the whole magazine, or the row
  // is back to being a single all-or-nothing purchase. Told apart by
  // `payload`, exactly as weapons.js tells a layer from a gun everywhere else.
  const layers = WEAPON_TYPES.filter((w) => w.payload);
  assert.ok(layers.length > 0, "the catalogue has no layers to check");
  for (const weapon of layers) {
    const row = CONSUMABLES.find((e) => e.kind === AMMO && e.weaponId === weapon.id);
    assert.ok(row, `nothing on the shelf rearms ${weapon.id}`);
    const crate = PICKUP_TYPES.find((p) => p.kind === AMMO && p.weaponId === weapon.id);
    assert.ok(row.amount > crate.amount,
      `${row.id} (${row.amount}) is no better than the ${weapon.id} crate (${crate.amount})`);
    assert.ok(row.amount < weapon.ammo,
      `${row.id} (${row.amount}) is the whole ${weapon.id} magazine (${weapon.ammo}) again`);
  }
});

test("rearming the layer costs more per round than topping up a gun", () => {
  // A set bought in one press is a much bigger favour than a crate's worth of
  // rounds, and a mine is the hardest single hit on the road (obstacletypes.js)
  // — so the layer stays the dearest round on the shelf. Per ROUND rather than
  // per row, since the rows sell wildly different counts.
  //
  // WALKED FROM THE CATALOGUE, not from two named ids: the relation is "every
  // layer row is dearer per round than every gun row", and spelling out the
  // rows was what left this test asserting nothing about a row added later.
  const perRound = (row) => row.price / row.amount;
  const rows = CONSUMABLES.filter((e) => e.kind === AMMO);
  const isLayer = (row) => !!WEAPON_TYPES.find((t) => t.id === row.weaponId)?.payload;
  const layers = rows.filter(isLayer);
  const guns = rows.filter((r) => !isLayer(r));
  assert.ok(layers.length > 0 && guns.length > 0, "the shelf has no layer or no gun to compare");

  const dearestGun = Math.max(...guns.map(perRound));
  for (const row of layers) {
    assert.ok(perRound(row) > dearestGun,
      `${row.id} is cheaper per round (${perRound(row)}) than a gun (${dearestGun})`);
  }
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

test("nothing on any shelf is free, and no two rows share an id", () => {
  // The ids are what save data, tests and debugging address a row by — the same
  // stable-key rule every other catalogue in the game states.
  const ids = [...CONSUMABLES, ...STATS, ...SPECIALS].map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate catalogue id");
  for (const stat of STATS) {
    assert.ok(stat.price > 0, `${stat.id} is free`);
    // A `values`-shaped stat (siphon) has no single `step` — it is read off a
    // table instead (upgrades.js's own field-table comment) — so the "buys
    // something" check is that every tier reads higher than the one before,
    // the property `step > 0` was standing in for on the base+step stats.
    if (stat.values) {
      for (let level = 1; level <= TIER_COUNT; level++) {
        assert.ok(statValue(stat, level) > statValue(stat, level - 1),
          `${stat.id} tier ${level} buys nothing over tier ${level - 1}`);
      }
    } else {
      assert.ok(stat.step > 0, `${stat.id} buys nothing`);
    }
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

test("the SIPHON RIG shelf reads the payout table by reference, not a restated ladder", () => {
  // This is the invariant that broke once already: the shelf used to print a
  // hand-set base+step ladder that only a COMMENT kept in step with wallet.js's
  // SIPHON_YIELDS (the table hints()/collect() actually pay from), and a
  // tuning pass moved one without the other. Asserting object IDENTITY — not
  // just equal numbers — is what makes that class of drift impossible to
  // reintroduce silently: statValue reads this array's own elements, so there
  // is no second copy anywhere left to fall out of step.
  assert.equal(statById("siphon").values, SIPHON_YIELDS);
  for (let level = 0; level <= TIER_COUNT; level++) {
    assert.equal(statValue(statById("siphon"), level), SIPHON_YIELDS[level],
      `siphon tier ${level} shelf reading drifted from what a node actually pays`);
  }
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

test("ramMaxed flips only once every ram tier is bought, and reaches the player", () => {
  // collisions.js's PlayerBody gates the attackFloor/shovePower bonus on this
  // flag rather than on a mass threshold, specifically so a car-editor retune
  // of any figure in the mass ladder can't flip it early or late by accident.
  const { player, garage } = shopper();
  const ram = statById("ram");
  for (let level = 0; level < TIER_COUNT; level++) {
    assert.equal(garage.stats.ramMaxed, false, `ramMaxed set early, at ${level} of ${TIER_COUNT} tiers`);
    player.applyUpgrades(garage.stats);
    assert.equal(player.ramMaxed, false);
    garage.addTier(ram);
  }
  assert.equal(garage.stats.ramMaxed, true, "the last tier should have set it");
  player.applyUpgrades(garage.stats);
  assert.equal(player.ramMaxed, true, "applyUpgrades must carry the flag onto the car");
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
  assert.equal(stats.ramMaxed, player.ramMaxed);
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
  // Player.heal's cap and Weapon.refill's. Exercised here on rows still short
  // of the cap — a purchase landing exactly ON the cap is refused outright
  // rather than merely capped; see the dedicated "wasted purchase" test below
  // for that half.
  const { wallet, player, loadout, garage } = shopper();

  const rocketRow = CONSUMABLES.find((e) => e.weaponId === "rocket");
  const rocket = loadout.get("rocket");
  rocket.ammo = 0;
  assert.equal(purchase(rocketRow, wallet, player, loadout, garage), true);
  assert.equal(rocket.ammo, rocketRow.amount);

  const repair = CONSUMABLES.find((e) => e.kind === HEAL);
  player.damage(500); // more than the hull holds; floors at 0
  purchase(repair, wallet, player, loadout, garage);
  assert.equal(player.health, repair.amount);
});

test("a consumable that would do nothing is refused, and the wallet keeps the money", () => {
  // Driving over a crate at full ammo just shrugs — nothing was on offer for
  // free. Paying a shop price for the same nothing is a different act, so
  // priceOf/purchase (upgrades.js) refuse the sale before the wallet ever
  // moves, on every kind that has a ceiling to be full against.
  const { wallet, player, loadout, garage } = shopper();

  const rocketRow = CONSUMABLES.find((e) => e.weaponId === "rocket");
  const rocket = loadout.get("rocket");
  rocket.ammo = rocket.type.ammo; // already full
  let before = wallet.credits;
  assert.equal(priceOf(rocketRow, garage, player, loadout), null,
    "a full magazine still quotes a price");
  assert.equal(purchase(rocketRow, wallet, player, loadout, garage), false,
    "sold a refill nobody needed");
  assert.equal(wallet.credits, before, "charged for a purchase that did nothing");

  const repair = CONSUMABLES.find((e) => e.kind === HEAL);
  before = wallet.credits;
  assert.equal(purchase(repair, wallet, player, loadout, garage), false,
    "sold a repair at full hull");
  assert.equal(wallet.credits, before, "charged for a repair at full hull");
});

test("a layer's pack tops up from any state, capped at its own magazine", () => {
  // The pack is a flat quantity now (upgrades.js's header), not "sell the
  // whole magazine" — so a press from empty adds exactly the pack, and a press
  // near full is capped by Weapon.refill rather than overflowing past the
  // magazine.
  const { wallet, player, loadout, garage } = shopper();
  for (const weapon of WEAPON_TYPES.filter((w) => w.payload)) {
    const row = CONSUMABLES.find((e) => e.kind === AMMO && e.weaponId === weapon.id);
    const carried = loadout.get(weapon.id);

    carried.ammo = 0;
    assert.equal(purchase(row, wallet, player, loadout, garage), true);
    assert.equal(carried.ammo, row.amount,
      `${weapon.id} did not gain a full pack from empty`);

    carried.ammo = weapon.ammo - 1;
    assert.equal(purchase(row, wallet, player, loadout, garage), true);
    assert.equal(carried.ammo, weapon.ammo,
      `${weapon.id} overflowed past its own magazine`);

    // ...and a press once the magazine is already full is refused, exactly
    // like the gun rows above.
    assert.equal(purchase(row, wallet, player, loadout, garage), false,
      `${weapon.id} sold a pack nobody needed`);
  }
});

test("a consumable can be bought over and over — only the stats are rationed", () => {
  // The two shelves are different KINDS of thing (upgrades.js's header), and this
  // is the difference: a flat price that never rises and no PERMANENT counter
  // behind it — a stat stops being for sale forever once maxed, but a consumable
  // is buyable again the moment there's room for it (here: more hull lost).
  const { wallet, player, loadout, garage } = shopper();
  const repair = CONSUMABLES.find((e) => e.kind === HEAL);
  for (let i = 0; i < 5; i++) {
    player.damage(10);
    const before = wallet.credits;
    assert.equal(purchase(repair, wallet, player, loadout, garage), true, `refused sale ${i + 1}`);
    assert.equal(before - wallet.credits, repair.price, "a consumable's price moved");
  }
});

test("the shield is rationed to one purchase a stop, and the cap resets on the next visit", () => {
  // A banked shield has no ceiling of its own (unlike a magazine or a hull
  // bar), so it is the one consumable capped by `oncePerVisit` instead of by
  // wasted effect — see upgrades.js's header on buy_shield. Garage.endVisit()
  // is what game/shop.js calls on undock, so this pins the cap to the STOP
  // rather than to the run.
  const { wallet, player, loadout, garage } = shopper();
  const shield = CONSUMABLES.find((e) => e.kind === SHIELD);

  assert.equal(purchase(shield, wallet, player, loadout, garage), true);
  const before = wallet.credits;
  assert.equal(priceOf(shield, garage, player, loadout), null,
    "a second shield this stop still quotes a price");
  assert.equal(purchase(shield, wallet, player, loadout, garage), false,
    "sold a second shield the same stop");
  assert.equal(wallet.credits, before, "charged for a shield the cap refused");

  garage.endVisit();
  assert.equal(purchase(shield, wallet, player, loadout, garage), true,
    "the cap should have reset for the next stop");
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

test("only a fully maxed ram plate arms PlayerBody's attackFloor/shovePower", () => {
  // Same proxy, same reason: the two ramMaxed bonuses (collisions.js) must
  // read the CAR's live flag, not a snapshot, or a shop visit that buys the
  // last tier would leave the adapter one purchase behind.
  const { wallet, player, loadout, garage } = shopper();
  const ram = statById("ram");
  const adapter = new PlayerBody(PLAYER_MASS, 300);
  adapter.sync(player, 0, 0);
  assert.equal(adapter.attackFloor, undefined, "unmaxed must not arm the floor bonus");
  assert.equal(adapter.shovePower, undefined, "unmaxed must not arm the shove bonus");

  for (let i = 0; i < TIER_COUNT; i++) purchase(ram, wallet, player, loadout, garage);
  assert.equal(player.ramMaxed, true, "the fixture must actually max the tier, or this proves nothing");
  assert.equal(adapter.attackFloor, 20);
  assert.equal(adapter.shovePower, 1.6);
});

test("an upgraded car can actually reach the speed it paid for", () => {
  // The clamp in Player.update reads the instance's own ceiling, not the module
  // constant — an ENGINE tier that raised a number nothing enforced would be the
  // most expensive no-op in the game.
  const { wallet, player, loadout, garage } = shopper();
  const engine = statById("engine");
  purchase(engine, wallet, player, loadout, garage);
  // Just past the ceiling the tier paid for. Player.update walks a car back
  // into its band at BAND_RECOVER rather than snapping it (see that method),
  // so this is a second of ticks and then a check that the walk STOPPED on the
  // upgraded ceiling — not on the stock one, and not below it.
  player.speed = MAX_SPEED + engine.step + 100;
  for (let i = 0; i < 60; i++) player.update(1 / 60, { left: -10000, right: 10000 });
  assert.equal(player.speed, MAX_SPEED + engine.step);
});
