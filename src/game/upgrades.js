// THE SHOP'S CATALOGUE — everything the cargo dock sells, and the record of
// what this run has bought.
//
// Same split every other data file in here uses (cartypes.js, pickuptypes.js,
// obstacletypes.js): pure DATA that can be retuned without reading code, and
// the small amount of runtime state that acts on it. game/shop.js draws this
// and moves a cursor over it; it owns none of the numbers.
//
// TWO SHELVES, and they are different KINDS of thing rather than two lists that
// happen to sit side by side:
//
//   CONSUMABLES  ALWAYS buyable, any number of times, fixed price. A purchase
//                lands on the car immediately and is then gone — rounds in a
//                magazine, hull on the bar, seconds of shield. Nothing is
//                remembered about it afterwards.
//   STATS        TIERED. Each has three steps, each step costs more than the
//                last, and once bought a step stays bought FOR THE REST OF THE
//                RUN — the Garage below is that memory. A stat that is maxed
//                simply stops being for sale.
//
// NOTHING SURVIVES A RUN. Both shelves are scoped to one drive: the Garage is
// rebuilt by main.js's newGame() alongside the player and the wallet, so dying
// costs the player every tier they bought exactly as it costs them every credit
// they had not spent. That is deliberate and it is the same promise main.js's
// CREDIT_STORE makes about the money itself — see its header for why a bank
// that lives in one browser is not progress anyone owns. When player records
// arrive and credits start persisting, this file does NOT automatically follow:
// a run-scoped upgrade ladder and a permanent one are different games, and the
// choice between them should be made then rather than inherited by accident.
//
// CONSUMABLES REUSE THE PICKUP CATALOGUE'S OWN EFFECTS. An entry here carries
// the same `kind`/`weaponId`/`amount`/`duration` fields a crate does and is
// spent through pickuptypes.js's applyPickup — a bought repair and a driven-over
// FIX crate are the same event, and there is no second copy of "top up a weapon,
// capped at its own magazine" anywhere in the codebase.

import { AMMO, HEAL, SHIELD, applyPickup } from "./pickuptypes.js";
import { MAX_SPEED, PLAYER_MASS, BASE_MAX_HEALTH } from "./player.js";
import { ROCKET, PLAYER_THRUST, ENEMY, GREEN_BRIGHT, PLAYER } from "../engine/palette.js";

// --- Consumables -------------------------------------------------------------
//
// PRICED AGAINST A KILL, which is the only scale in the game that means
// anything: an enemy pays 25 CR (cartypes.js's `bounty`), so the numbers below
// read as "three to five enemies" rather than as abstract figures.
//
// GUNS ARE TOPPED UP, LAYERS ARE REARMED, and that split is by what the weapon
// IS rather than by taste. A gun's magazine runs to dozens of rounds, so the
// dock sells the matching crate's own quantity (pickuptypes.js) — the road drops
// it, this sells it, and a player who knows what a ROCKET+ crate is worth
// already knows what the row is worth. A LAYER's magazine is three or five
// (weapons.js), and at that size "+1" is not a purchase, it is a rounding error
// on a decision the player has to walk down a menu to make. So the mine and the
// spike strip are sold as a WHOLE SET: one press leaves the dock rearmed.
//
// Weapon.refill caps at the weapon's own starting magazine, so selling the whole
// magazine is exactly "top it right up" whatever was left in it — there is no
// separate refill-to-full path, and no way to overfill by buying two.
//
// Fields:
//   id/label   stable key / the caption on the shelf
//   detail     what one purchase actually does, in the player's own units.
//              Written out rather than derived, because "+18 RDS" and "+70 HULL"
//              and "5 SEC" are three different units and a formatter covering
//              all three would be longer than the three strings
//   price      credits, FLAT. Consumables never get more expensive: the tier
//              curve is the STATS shelf's idea, and applying it here would mean
//              a run that goes long slowly loses the ability to rearm
//   kind       plus whichever fields that kind reads — see pickuptypes.js
//   color      the row's accent, matching the crate that grants the same thing
export const CONSUMABLES = [
  {
    id: "buy_repair",
    label: "HULL REPAIR",
    detail: "+50 HULL",
    price: 50,
    kind: HEAL,
    // TUNED BELOW THE FIX CRATE'S OWN 70 (pickuptypes.js) and priced to match:
    // a repair the player can walk up and buy on demand is worth less per point
    // than one the road decided to drop. `detail` is the same figure written out
    // in the player's units, and shop.test.js pins the two together — the number
    // and the caption under it are one edit, never two.
    amount: 100,
    color: GREEN_BRIGHT,
  },
  {
    id: "buy_shield",
    label: "SHIELD",
    detail: "15 SEC",
    price: 50,
    kind: SHIELD,
    // RUNS FROM THE MOMENT THE WHEELS ARE BACK DOWN, and it costs nothing to
    // make that true: main.js only advances the player during "playing", so
    // shieldTime does not tick through the shop screen or through the lowering
    // sequence either side of it (see updateShopping/updateLowering there). A
    // shield bought here is therefore still whole when the car lands, which is
    // the only reading of "buy a shield in a shop" that isn't a swindle.
    //
    // THREE TIMES the crate's five seconds (pickuptypes.js): the crate is a
    // reprieve the road handed over mid-fight, this is a stretch of cover the
    // player paid for and gets to spend where they choose.
    duration: 30,
    color: PLAYER,
  },
  {
    id: "buy_rocket_ammo",
    label: "ROCKET AMMO",
    detail: "+18 RDS",
    price: 50,
    kind: AMMO,
    weaponId: "rocket",
    amount: 18,
    color: ROCKET,
  },
  {
    id: "buy_tracer_ammo",
    label: "TRACER AMMO",
    detail: "+48 RDS",
    price: 35,
    kind: AMMO,
    weaponId: "tracker",
    amount: 48,
    color: PLAYER_THRUST,
  },
  {
    id: "buy_mine_ammo",
    label: "MINES",
    detail: "SET OF 8",
    // The whole magazine (weapons.js's `mine`), at well under four times what
    // the road's own two-mine crate is worth — a set bought in one press is
    // priced as a set, not as four separate crates carried out one at a time.
    price: 50,
    kind: AMMO,
    weaponId: "mine",
    amount: 8,
    color: ENEMY,
  },
  {
    id: "buy_spikes_ammo",
    label: "SPIKE STRIPS",
    detail: "SET OF 5",
    // THE DEAREST ROUNDS ON THE SHELF, and they have to stay that way. The strip
    // is the one weapon the player owns NOTHING of at the start (weapons.js's
    // `startAmmo: 0`) and whose whole balance is how few there are — a road the
    // player can keep permanently belted is a road nothing can chase them down.
    // The dock is therefore the main way anyone gets one at all, which makes the
    // price the thing standing between "a weapon you go and buy" and "a weapon
    // you simply have". Fewer rounds than the mine row for a lower total but a
    // HIGHER price each, which is the relation that matters and the one
    // test/shop.test.js pins.
    price: 75,
    kind: AMMO,
    weaponId: "spikes",
    amount: 5,
    color: ENEMY,
  },
];

// --- Car stats ---------------------------------------------------------------

// THREE TIERS, AND THE THIRD COSTS FOUR TIMES THE FIRST. Multipliers on each
// stat's own `price`, so "how steep is the ladder" and "how expensive is this
// particular system" stay two separate knobs.
//
// The shape is the point: tier 1 is affordable at the first stop or two, which
// is what makes docking worth doing early; tier 3 is a run's worth of saving,
// which is what stops a good run from owning everything by the middle of it.
// Maxing all four systems costs 3,780 CR against a stop that pays a few
// hundred — a ladder you climb some of, never all of.
export const TIER_PRICES = [1, 2, 4];
export const TIER_COUNT = TIER_PRICES.length;

// Fields:
//   id/label   stable key / the caption on the shelf
//   note       the one-line "what this actually does for me", shown under the
//              cursor rather than on every row — the shelf would be a wall of
//              text otherwise
//   base       the figure a stock car starts at, IMPORTED from the module that
//              owns it rather than restated, so retuning the car retunes the
//              ladder hanging off it
//   step       what ONE tier adds. Every tier adds the same amount; the PRICE
//              is what escalates, not diminishing returns. A flat step against
//              a rising price is already a curve, and it is the one a player
//              can do arithmetic on mid-run
//   price      credits for tier 1; tiers 2 and 3 are this times TIER_PRICES
//   unit       suffix for the readout ("" for a bare number)
//   prefix     OPTIONAL leading character for the readout. Only the deflector
//              uses one: its value is a BONUS on somebody else's number, and a
//              row reading "0S → 2S" invites the player to think a stock car
//              grants a nil-length shield. "+0S → +2S" says what it is
//   decimals   how the value prints — mass is the only fractional one
export const STATS = [
  {
    id: "engine",
    label: "ENGINE",
    note: "RAISES THE CAR'S TOP SPEED",
    base: MAX_SPEED,
    // +40 a tier, so a fully upgraded car tops out at 740 — past the roadster
    // (700) and past the cycle's 730, the fastest thing on the road
    // (cartypes.js), but only just. The traffic band is pinned to the CONSTANT
    // MAX_SPEED rather than to this, so buying speed moves the player through
    // the field instead of dragging the field along with them.
    step: 40,
    price: 100,
    unit: "",
    decimals: 0,
  },
  {
    id: "chassis",
    label: "CHASSIS",
    note: "RAISES MAX HULL — AND REPAIRS BY THE SAME",
    base: BASE_MAX_HEALTH,
    // +50 a tier: 200 to 350 fully upgraded. Sized against what actually
    // removes hull rather than as a round fraction — a mine is the hardest
    // single hit on the road at 150 (obstacletypes.js), so each tier buys a
    // third of one, and a maxed chassis is the difference between two mines
    // ending a run and three.
    step: 50,
    price: 100,
    unit: "",
    decimals: 0,
  },
  {
    id: "deflector",
    label: "DEFLECTOR",
    note: "EVERY SHIELD YOU GET LASTS LONGER",
    // The BONUS, not a duration of its own — a stock car adds nothing to the
    // shields it is handed. See player.js's activateShield: this is why one
    // upgrade covers the crate, the dock's own SHIELD row, and anything that
    // grants a shield later, without any of them knowing it exists.
    base: 0,
    // +12s A TIER, against a 5s crate (pickuptypes.js) — so one tier already
    // more than triples every shield the player picks up (5s -> 17s), and a
    // maxed deflector runs 41s.
    //
    // THAT IS DELIBERATELY A BIG NUMBER, and the reason is that the shield is
    // the one buff the player does not control the timing of. Ammunition and
    // hull are spent when you choose; a shield starts the moment you drive over
    // the crate, so a couple of extra seconds is a couple of extra seconds of
    // whatever happened to be on the road right then — usually nothing. The
    // step has to be long enough to change what the player DOES with a shield
    // (drive through the pack rather than round it) or the tier is invisible.
    //
    // The cost of getting this wrong is the highest on the shelf, since a
    // shield is total invulnerability while it runs: a full deflector plus a
    // crate is over half a minute in which nothing on the road can touch the
    // car. Retune HERE if that reads as too long, and retune it against real
    // road time rather than against the crate's own 5s.
    step: 12,
    price: 100,
    unit: "S",
    prefix: "+",
    decimals: 0,
  },
  {
    id: "ram",
    label: "RAM PLATE",
    note: "HIT HARDER, GET SHOVED LESS",
    base: PLAYER_MASS,
    // MASS, and that is the whole mechanic — collisions.js splits both damage
    // and separation by inverse mass, so this one number buys a harder ram, a
    // lighter hit taken and a car that gets pushed around less. Physically
    // honest, which is why it is one shelf entry rather than three.
    //
    // +0.4 a tier walks 1.4 up to 2.6: past the bruiser (2.2), just under the
    // bus (2.8) and well under the rig's 4 (cartypes.js), which has to stay
    // what its own catalogue entry calls it — "immovable in practice: ram it
    // and you lose, not the rig". A ladder that climbed past the rig would
    // delete the one thing on the road the player is meant to drive around.
    step: 0.8,
    price: 100,
    unit: "",
    decimals: 1,
  },
];

// One named stat. Mirrors pickupTypeById/obstacleTypeById.
export function statById(id) {
  return STATS.find((s) => s.id === id) ?? null;
}

// What `stat` reads at `level` tiers owned.
export function statValue(stat, level) {
  return stat.base + stat.step * level;
}

// What the NEXT tier of `stat` costs at `level` tiers owned, or null when there
// is no next tier. Null rather than Infinity, because "no longer for sale" is a
// different thing from "expensive" and the shelf draws the two differently.
export function tierPrice(stat, level) {
  if (level >= TIER_COUNT) return null;
  return stat.price * TIER_PRICES[level];
}

// --- What this run has bought ------------------------------------------------

// The tier counters, and the stat block they add up to. One per run, built by
// main.js's newGame() and thrown away with it.
//
// IT HOLDS COUNTERS, NOT EFFECTS. `stats` recomputes the whole block from the
// base figures every time it is read, which is what lets Player.applyUpgrades
// be a plain absolute assignment — nothing here or in player.js has to remember
// which purchases have already been applied to which car, and a shop visit that
// rebuilds half the world (main.js's respawnWorld) cannot lose a tier by
// rebuilding the wrong object.
export class Garage {
  constructor() {
    // Keyed by stat id rather than indexed, so reordering STATS above can never
    // silently reassign somebody's engine tiers to their chassis.
    this.levels = {};
    for (const stat of STATS) this.levels[stat.id] = 0;
  }

  levelOf(stat) {
    return this.levels[stat.id] ?? 0;
  }

  maxed(stat) {
    return this.levelOf(stat) >= TIER_COUNT;
  }

  // Books one tier. The caller is responsible for having taken the money — see
  // purchase() below, which is the only thing that should be calling this.
  addTier(stat) {
    if (this.maxed(stat)) return false;
    this.levels[stat.id] = this.levelOf(stat) + 1;
    return true;
  }

  // Everything the tiers add up to, in the shape Player.applyUpgrades wants.
  // Recomputed on read — see the header.
  get stats() {
    const value = (id) => {
      const stat = statById(id);
      return statValue(stat, this.levelOf(stat));
    };
    return {
      maxSpeed: value("engine"),
      maxHealth: value("chassis"),
      shieldBonus: value("deflector"),
      mass: value("ram"),
    };
  }
}

// --- Buying ------------------------------------------------------------------

// What `entry` costs right now, or null if it is not for sale (a maxed stat).
// One function over both shelves, so the screen never has to branch on which
// kind of row it is pricing.
export function priceOf(entry, garage) {
  // Told apart by whether the row names a `kind`, exactly the way weapons.js
  // tells a layer from a gun by whether it names a `payload` — the field that
  // decides what a thing IS also decides which shelf it came from.
  if (entry.kind) return entry.price;
  return tierPrice(entry, garage.levelOf(entry));
}

// Buy one thing off either shelf. Returns whether anything was actually bought,
// which is the shop screen's cue for a confirm tone rather than a refusal one.
//
// THE MONEY MOVES SECOND-TO-LAST, and the order matters. Availability and
// affordability are both settled BEFORE Wallet.spend is called, so a refused
// purchase costs the player nothing at all — and the effect lands only AFTER
// the spend succeeds, so there is no path on which a car gets an upgrade the
// wallet did not pay for. Wallet.spend refuses to overdraw on its own
// (wallet.js), so the affordability check here is belt and braces rather than
// the only guard.
export function purchase(entry, wallet, player, loadout, garage) {
  const price = priceOf(entry, garage);
  if (price === null || price > wallet.credits) return false;
  if (!wallet.spend(price)) return false;

  if (entry.kind) {
    // A consumable — the crate's own effect, applied by the crate's own code.
    // See the header: a bought repair IS a FIX crate.
    applyPickup(entry, player, loadout);
  } else {
    garage.addTier(entry);
    // Re-derived from the counters rather than nudged, so this stays safe
    // however many times it ends up being called.
    player.applyUpgrades(garage.stats);
  }
  return true;
}
