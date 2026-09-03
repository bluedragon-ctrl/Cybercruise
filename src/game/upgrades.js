// THE SHOP'S CATALOGUE — everything the cargo dock sells, and the record of
// what this run has bought.
//
// Same split every other data file in here uses (cartypes.js, pickuptypes.js,
// obstacletypes.js): pure DATA that can be retuned without reading code, and
// the small amount of runtime state that acts on it. game/shop.js draws this
// and moves a cursor over it; it owns none of the numbers.
//
// THREE SHELVES, and they are different KINDS of thing rather than three lists
// that happen to sit side by side:
//
//   CONSUMABLES  ALWAYS buyable, any number of times, fixed price. A purchase
//                lands on the car immediately and is then gone — rounds in a
//                magazine, hull on the bar, seconds of shield. Nothing is
//                remembered about it afterwards.
//   STATS        TIERED. Each has three steps, each step costs more than the
//                last, and once bought a step stays bought FOR THE REST OF THE
//                RUN — the Garage below is that memory. A stat that is maxed
//                simply stops being for sale.
//   SPECIALS     ONE-OFF hardware. Bought once, at one price, owned for the
//                rest of the run — a ladder exactly one rung long, so it goes
//                SOLD rather than MAX. Each one changes a VERB (the cannon
//                fires a pair, the shield bites back) rather than moving a
//                number, which is why it is not a tier. See the shelf itself.
//
// NOTHING SURVIVES A RUN. The Garage is rebuilt by main.js's newGame() beside
// the player and the wallet, so dying costs every tier bought exactly as it
// costs every unspent credit — the same promise main.js's CREDIT_STORE makes
// about the money. When player records arrive and credits persist, this file
// does NOT automatically follow: a run-scoped ladder and a permanent one are
// different games, and that choice should be made then, not inherited.
//
// CONSUMABLES REUSE THE PICKUP CATALOGUE'S EFFECTS. An entry here carries the
// same `kind`/`weaponId`/`amount`/`duration` fields a crate does and is spent
// through pickuptypes.js's applyPickup, so a bought repair and a driven-over FIX
// crate are the same event and "top up a weapon, capped at its magazine" exists
// once in the codebase.

import { AMMO, HEAL, SHIELD, applyPickup } from "./pickuptypes.js";
import { MAX_SPEED, PLAYER_MASS, BASE_MAX_HEALTH } from "./player.js";
import { ROCKET, PLAYER_THRUST, ENEMY, GREEN_BRIGHT, PLAYER } from "../engine/palette.js";

// --- Consumables -------------------------------------------------------------
//
// PRICED AGAINST A KILL, which is the only scale in the game that means
// anything: an enemy pays 25 CR (cartypes.js's `bounty`), so the numbers below
// read as "three to five enemies" rather than as abstract figures.
//
// GUNS ARE TOPPED UP, THE LAYER IS REARMED, and that split is by what the weapon
// IS rather than by taste. A gun's magazine runs to dozens of rounds, so the
// dock sells the matching crate's own quantity (pickuptypes.js) — the road drops
// it, this sells it, and a player who knows what a ROCKET+ crate is worth
// already knows what the row is worth. The MINE crate hands over two against a
// magazine of sixteen (weapons.js), and at that size a menu walk per pair is not
// a purchase, it is a rounding error. So the mine is sold as a WHOLE SET: one
// press leaves the dock rearmed.
//
// Weapon.refill caps at the weapon's own starting magazine, so selling the whole
// magazine is exactly "top it right up" whatever was left in it — there is no
// separate refill-to-full path, and no way to overfill by buying two.
//
// A ROW WITH NOTHING TO GIVE ISN'T FOR SALE. A crate on the road is free, so
// driving over one at full ammo costing nothing but the drive-over is a
// shrug; a shop row costs actual credits, and priceOf/purchase below refuse an
// AMMO or HEAL purchase that would have no effect (a full magazine, a full
// hull) rather than take the money for it — see consumableWasted. SHIELD is
// the one kind this never applies to (see its own `oncePerVisit` note above)
// because a banked shield has no ceiling to be "full" against.
//
// Fields:
//   id/label      stable key / the caption on the shelf
//   detail        what one purchase actually does, in the player's own units.
//                 Written out rather than derived, because "+18 RDS" and
//                 "+70 HULL" and "5 SEC" are three different units and a
//                 formatter covering all three would be longer than the three
//                 strings
//   price         credits, FLAT. Consumables never get more expensive: the
//                 tier curve is the STATS shelf's idea, and applying it here
//                 would mean a run that goes long slowly loses the ability to
//                 rearm
//   kind          plus whichever fields that kind reads — see pickuptypes.js
//   oncePerVisit  OPTIONAL. See buy_shield's own note — the one row capped by
//                 the visit rather than by whether it would do anything
//   color         the row's accent, matching the crate that grants the same
//                 thing
export const CONSUMABLES = [
  {
    id: "buy_repair",
    label: "HULL REPAIR",
    detail: "+100 HULL",
    price: 50,
    kind: HEAL,
    // HALF A STOCK HULL IN ONE PRESS, and comfortably more than the FIX crate's
    // own 70 (pickuptypes.js): the crate is whatever the road happened to drop,
    // this is the repair the player walked down a menu and paid for. `detail`
    // is the same figure written out in the player's units, and shop.test.js
    // pins the two together — the number and the caption under it are one
    // edit, never two (the tuning editor makes it one: see patchUpgradeEntry).
    amount: 100,
    color: GREEN_BRIGHT,
  },
  {
    id: "buy_shield",
    label: "SHIELD",
    detail: "30 SEC",
    price: 50,
    kind: SHIELD,
    // BANKED, NOT STARTED — same as the crate, since both are spent through
    // applyPickup (pickuptypes.js) and Player.chargeShield is what that now
    // calls. The window opens on the first hit taken after the car lands, so a
    // shield bought here cannot be burned by the shop screen, by the lowering
    // sequence, or by a quiet stretch of road afterwards. That is the only
    // reading of "buy a shield in a shop" that isn't a swindle.
    //
    // SIX TIMES the crate's five seconds (pickuptypes.js): the crate is a
    // reprieve the road handed over mid-fight, this is a stretch of cover the
    // player paid for and gets to spend where they choose.
    duration: 30,
    // ONE PER STOP. A shield has no ceiling of its own — chargeShield banks
    // whatever it is handed, unlike a magazine or a hull bar — so nothing
    // about buying a second one this visit would be WASTED the way a repair at
    // full hull is. It is rationed anyway, because unlimited banked seconds
    // bought in one stand at the counter is a player converting a stop's whole
    // wallet into a run nothing on the road can end, which is a bigger hole
    // than "one purchase did nothing" is on the other two rows below.
    // Garage.boughtThisVisit is the counter, cleared by endVisit() when the
    // player undocks (game/shop.js), so the cap is per STOP, not per run.
    oncePerVisit: true,
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
    detail: "SET OF 16",
    // The whole magazine (weapons.js's `mine`) — twice the eight the player is
    // issued with (weapons.js's `startAmmo`), so this is a real top-up from the
    // first stop rather than a row with nothing left to sell until the player
    // has burned through the run's own supply. Priced as a set, not as eight
    // separate two-mine crates carried out one at a time.
    price: 50,
    kind: AMMO,
    weaponId: "mine",
    amount: 16,
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
    // (700) and the cycle's 730, but only just. NOT past the outrider's 800
    // (cartypes.js), deliberately: that type is built to outrun a maxed
    // player by design (low health, low damage, sweeps past rather than
    // chasing — see its own entry), so it is the one type this ceiling isn't
    // sized against. The traffic band is pinned to the CONSTANT MAX_SPEED
    // rather than to this, so buying speed moves the player through the
    // field instead of dragging the field along with them.
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
    // Three tiers of `step` on top of PLAYER_MASS have to clear the bruiser
    // — the car built to ram — while staying under the rig (cartypes.js),
    // which has to stay what its own catalogue entry calls it: "immovable in
    // practice: ram it and you lose, not the rig". A ladder that climbed past
    // the rig would delete the one thing on the road the player is meant to
    // drive around. shop.test.js's "a fully upgraded ram plate never
    // out-masses the rig" asserts both ends against the live catalogue
    // values rather than numbers restated here, since car-editor can retune
    // any of PLAYER_MASS, `step`, or either car's mass independently.
    //
    // MASS ALONE STAYS TIMID, because the rig ceiling above caps how far it
    // can go — a ladder that only moved mass would always leave the top tier
    // reading as "somewhat sturdier" rather than "a weapon". So the LAST tier
    // also flips `ramMaxed` on `stats` (below), which collisions.js's
    // PlayerBody turns into two bonuses mass by itself can't buy without
    // breaking the rig invariant: it takes less speed for the player's hits to
    // start hurting something, and a sideways shove throws its target harder
    // into whatever's next to it. See PlayerBody's own comment for the values.
    step: 0.8,
    price: 100,
    unit: "",
    decimals: 1,
  },
  {
    id: "siphon",
    label: "SIPHON RIG",
    note: "PULLS MORE FROM EVERY NODE — AND REACHES FURTHER",
    // A PERCENTAGE OF NOTHING BUT ITSELF, unlike every stat above it — there
    // is no `base` figure to import because there is no stock component this
    // upgrades; 100 is "exactly what the floor already pays" and every tier
    // is a straight multiplier on top. See game/wallet.js's SIPHON_TIERS for
    // why yield is the ONE number sold here: reach and drain time both ride
    // along on the same tier (330px/3s, 360px/2s, 390px/1s) but neither is
    // printed on the shelf, because tools/econsim.js showed both stop paying
    // for themselves within a tier or two of the stock car — a row that
    // promised more of either alone would be lying by tier 2.
    //
    // 100 -> 120 -> 140 -> 160: MUST match SIPHON_TIERS' own `yield` column
    // exactly (1.00/1.20/1.40/1.60) — retuning one without the other leaves
    // the shelf quoting a number the wallet doesn't pay.
    base: 100,
    step: 20,
    price: 100,
    unit: "%",
    decimals: 0,
  },
];

// --- Specials ----------------------------------------------------------------
//
// THE THIRD SHELF, and a third KIND of thing again. A consumable lands on the
// car and is gone; a stat is a ladder you climb a rung at a time. A SPECIAL is
// a piece of hardware: you own it or you do not, it costs one price, and once
// bought it is on the car for the rest of the run and the row goes SOLD.
//
// WHY NOT TIERS. Every one of these changes a VERB — the cannon fires two
// rounds, the shield bites back, a tracer hit paints a target, a mine leaves
// teeth. There is no half of "fires two rounds", and a tier ladder would have
// to invent one
// (fires 1.5 rounds? paints for two seconds?) purely to fit the shelf it was
// sold on. Where a special does carry a number (the storm's damage, the mark's
// multiplier) that number lives with the system that owns it — game/
// shieldstorm.js, weapons.js — for exactly the reason the stats above import
// their `base` rather than restating it.
//
// THEY ARE FLAGS AND ONLY FLAGS HERE. `special` is the key that shows up in
// Garage.stats's `specials` block and, through Player.applyUpgrades, on the
// car itself. Nothing in this file knows what any of them DO; the systems that
// read the flags do, and each says so in its own header.
//
// PRICED BETWEEN A FIRST RUNG AND A FULL LADDER. A whole stat is 700 CR
// (100+200+400) and its rungs are 100, 200 and 400. These sit at 300-400 — so
// the cheapest special costs what a system's SECOND rung and a bit does, and
// the dearest costs exactly what a third rung does.
//
// Both ends of that band are load-bearing. Below a first rung and a special
// would simply be the first thing bought every run, before the player has any
// idea what the road is going to ask of them. Above a full ladder and it would
// never be bought at all at a stop paying a few hundred. In between, one
// special IS the stop — which is the decision worth putting on a shelf.
//
// EVERYTHING IS ON SALE FOR NOW. When these become sector- or stop-gated (some
// subset available at any one dock), the gate belongs on the SHELF that draws
// them — game/shop.js filtering SPECIALS — not on the entries here, exactly as
// nothing in this file knows which stop the player is at today.
//
// Fields: id/label/detail/price/note/color as the shelves above, plus
//   special   the flag key. MUST be unique, and MUST be the same string the
//             system that acts on it reads (weapons.js's `twin`/`mark`, and
//             player.specials.shieldStorm)
export const SPECIALS = [
  {
    id: "twin_cannon",
    label: "TWIN CANNON",
    detail: "2 BARRELS",
    note: "THE CANNON FIRES A PAIR, RUNNING PARALLEL",
    // THE CHEAPEST OF THE FOUR, and it has to be: the cannon is the one gun
    // with infinite ammunition (weapons.js), so this is the special every run
    // can always use — the first one a player should be able to reach, and the
    // one whose ceiling is lowest because the rounds it doubles are the
    // weakest thing the player carries.
    price: 300,
    special: "twinCannon",
    color: PLAYER,
  },
  {
    id: "twin_rack",
    label: "TWIN RACK",
    detail: "2 SEEKERS",
    note: "TWO ROCKETS A PRESS, EACH HUNTING ITS OWN CAR",
    // THE DEAREST, for the mirror of the cannon's reasoning: it doubles the
    // heaviest round in the game, and the pair split across two cars rather
    // than stacking on one (projectiles.js's seek), so a full rack answers a
    // pack the way nothing else the player owns can. It is also rationed by a
    // magazine the road has to supply, which is the other half of the price.
    price: 400,
    special: "twinRocket",
    color: ROCKET,
  },
  {
    id: "shield_storm",
    label: "SHIELD STORM",
    detail: "ARCS OUT",
    note: "YOUR SHIELD ARCS INTO ANYTHING THAT DRIVES CLOSE",
    // TURNS A DEFENCE INTO A WEAPON, which is the most it could be asked to
    // cost. Priced under the rack because it does nothing at all until the
    // player has a shield running — this is the one special whose value is
    // entirely in what ELSE the run bought (crates, the SHIELD row above, the
    // DEFLECTOR tiers), and a run with no shield in it has wasted the money.
    price: 350,
    special: "shieldStorm",
    color: PLAYER,
  },
  {
    id: "spike_mines",
    label: "SPIKE MINES",
    detail: "LAYS A BELT",
    note: "EVERY MINE COMES WITH A SPIKE BELT ACROSS THE ROAD",
    // THE ONE SPECIAL THAT ANSWERS WHAT THE PLAYER CANNOT OUT-SHOOT. Every
    // other row on this shelf is more damage or better-aimed damage; this is
    // the only piece of hardware that takes an enemy's SPEED, and a car crawling
    // at 150 for five seconds (obstacletypes.js's strip) has dropped out of the
    // fight whether or not it is dead.
    //
    // WHAT IT BUYS IS THE GEOMETRY. A mine is 26px of a 286px road: drive round
    // it and it cost the player a round for nothing, which is what the plain
    // mine asks of every hostile with the room to swerve. The strip laid across
    // it spans 171.6 — so the middle of the road is a kill and the way around it
    // is a crawl, and there is no longer a cheap answer to a mine.
    //
    // It changes a verb like the rest of the shelf: the deploy key lays the same
    // mine, from the same magazine, on the same press — see weapons.js's
    // `upgradeLays`, which main.js resolves at the drop. Nothing about the
    // controls or the ammunition moves, which is the entire reason this is an
    // upgrade to the mine rather than the second deployable it used to be.
    //
    // DELIBERATELY THE STRONGEST THING ON THIS SHELF, and bought late. A belt
    // the player can put across the road behind them is a road nothing can chase
    // them down, which was the argument for keeping the strip scarce when it was
    // a weapon of its own (five rounds, none at the start, the dearest ammunition
    // in the game). What rations it now is the price and the LAID BUDGET rather
    // than a magazine: a pair spends two of obstacles.js's MAX_LAID_PLAYER, so
    // two pairs is all the road will hold at once and a third press waits for
    // the first to fall behind. That is the ceiling to retune if a belted road
    // turns out to be as oppressive as it was feared to be — not the strip's
    // own numbers, which the sower shares.
    //
    // PRICED AT THE STORM'S 350, and against it deliberately: both are worth
    // exactly what the run around them is worth. The storm is dead money in a
    // run with no shield; this is dead money in a run that never lays a mine,
    // and repays a run being chased by things it cannot out-shoot.
    price: 350,
    special: "spikeMines",
    // ENEMY red, alone on this shelf among four player-coloured rows, and it
    // earns it: every other special dresses something the player FIRES, this
    // one dresses a hazard left in the road. It is the colour the mine crate
    // and the strip already carry (pickuptypes.js, obstacleshapes.js) — a
    // hazard is red here whoever laid it.
    color: ENEMY,
  },
  {
    id: "autolock",
    label: "AUTOLOCK",
    detail: "ROUNDS CHASE",
    note: "THE TRACER PICKS A HOSTILE — THE WHOLE BURST FOLLOWS IT",
    // Same price as the storm and for a related reason: it is a multiplier on
    // shots the player still has to take, not damage of its own. It adds no
    // damage at all — every round still hits for 22 — it only stops them
    // MISSING, and a player who never carries the tracker gets nothing from
    // it, which is exactly the kind of purchase a shelf of specials wants.
    price: 350,
    special: "autolock",
    color: PLAYER_THRUST,
  },
  {
    id: "siphon_medic",
    label: "SIPHON MEDIC",
    detail: "HULL = CREDITS",
    note: "A SIPHONED NODE HEALS AS MUCH HULL AS IT PAYS OUT",
    // ONE FOR ONE WITH THE CREDIT, not a number of its own — game/wallet.js's
    // collect() hands this the SAME `value` that lands in the wallet, so the
    // effect scales with everything that already scales that figure: a richer
    // node heals more, and a SIPHON RIG tier bought off the STATS shelf above
    // (SIPHON_YIELDS) makes every node pay AND heal more at once. This is the
    // reason it carries no `amount` field here the way buy_repair does — there
    // is nothing to restate, because it is never a figure of its own.
    //
    // SIZED SMALL ON PURPOSE. A node pays 4-17 CR at stock (links.js's
    // NODE_VALUE_MIN/MAX), a sliver of the CHASSIS tier's 50 HULL — this is a
    // trickle earned by doing what a run was already doing (steering at nodes
    // for money), not a repair kit. What it buys is a FLOOR under a run that
    // keeps siphoning, which nothing else in the game turns credits into.
    price: 350,
    special: "siphonMedic",
    color: GREEN_BRIGHT,
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
    // The specials, keyed by their FLAG (`special`) rather than by their row
    // id, so this object is already the block the car wants — see `stats`
    // below, which hands it straight over. Every key is present and false from
    // the start: a `specials` block whose shape changes as things are bought
    // would make every reader write `?.` or `??` for no reason.
    this.specials = {};
    for (const item of SPECIALS) this.specials[item.special] = false;
    // Consumable ids bought at the CURRENT stop, for the `oncePerVisit` rows
    // (buy_shield, so far). Cleared by endVisit() rather than carried for the
    // whole run — this is the one piece of state on Garage that is scoped to a
    // STOP rather than to the run, which is why it isn't a `levels`-style
    // counter: there is nothing to remember once the player undocks.
    this.visitPurchases = new Set();
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

  // Does the car already carry this special? The shelf's "SOLD" state and
  // priceOf's "not for sale" both hang off this, the way maxed() does for a
  // finished stat — a special is simply a ladder one rung long.
  owns(item) {
    return this.specials[item.special] === true;
  }

  // Books one special. Same contract as addTier: the caller has already taken
  // the money, and purchase() below is the only thing that should call it.
  addSpecial(item) {
    if (this.owns(item)) return false;
    this.specials[item.special] = true;
    return true;
  }

  // Has `entry` already been bought at this stop? Only `oncePerVisit` rows
  // are ever checked against this — see priceOf.
  boughtThisVisit(entry) {
    return this.visitPurchases.has(entry.id);
  }

  // Books one `oncePerVisit` purchase for the stop. Same contract as addTier
  // and addSpecial: purchase() below is the only caller, and only after the
  // money has moved.
  recordVisit(entry) {
    this.visitPurchases.add(entry.id);
  }

  // The stop is over — game/shop.js calls this on undock, right alongside its
  // own boughtHere.clear() (the shelf's "BOUGHT" marks), so the two per-visit
  // records reset together even though one lives here and one lives there.
  endVisit() {
    this.visitPurchases.clear();
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
      // WHETHER, not how much — collisions.js's PlayerBody reads this flag
      // rather than comparing `mass` against a threshold, so a car-editor
      // retune of PLAYER_MASS, `step`, or the rig's own mass can't silently
      // flip it. It gates two bonuses raw mass alone can't buy without
      // outmassing the rig (see `ram`'s own comment): a lower closing-speed
      // floor on what the player hits, and a stronger sideways shove.
      ramMaxed: this.maxed(statById("ram")),
      // THE RAW TIER, not a computed value like the four above — game/
      // wallet.js's SIPHON_TIERS is indexed by level directly (it drives
      // three different numbers off one tier, not one), so what Player wants
      // here is "which row of that table", not a figure of its own.
      siphonLevel: this.levelOf(statById("siphon")),
      // THE FLAGS THEMSELVES, by reference. Safe for the same reason the four
      // figures above are recomputed: applyUpgrades is an absolute assignment,
      // so the car simply points at the record of what has been bought and
      // reads it live. Nothing outside addSpecial() writes to it.
      specials: this.specials,
    };
  }
}

// --- Buying ------------------------------------------------------------------

// Would buying `entry` right now do NOTHING — a magazine already topped up, a
// hull already full? AMMO and HEAL only; SHIELD has no ceiling of its own
// (Player.chargeShield banks whatever it is handed) and is rationed by
// `oncePerVisit` instead, checked separately in priceOf below. `player`/
// `loadout` are optional and default to "not wasted" when absent, mirroring
// shop.js's own statusFor — priceOf is called from contexts (tests, an
// unlanded car) that have neither.
function consumableWasted(entry, player, loadout) {
  if (!player) return false;
  if (entry.kind === HEAL) return player.health >= player.maxHealth;
  if (entry.kind === AMMO) {
    const weapon = loadout && loadout.get(entry.weaponId);
    return weapon ? weapon.ammo >= weapon.type.ammo : false;
  }
  return false;
}

// What `entry` costs right now, or null if it is not for sale (a maxed stat,
// a full magazine, a shield already bought this stop). One function over
// every shelf, so the screen never has to branch on which kind of row it is
// pricing. `player`/`loadout` are only read for the consumable checks above —
// see priceOf.
export function priceOf(entry, garage, player, loadout) {
  // Told apart by whether the row names a `kind`, exactly the way weapons.js
  // tells a layer from a gun by whether it names a `payload` — the field that
  // decides what a thing IS also decides which shelf it came from.
  if (entry.kind) {
    if (entry.oncePerVisit && garage.boughtThisVisit(entry)) return null;
    if (consumableWasted(entry, player, loadout)) return null;
    return entry.price;
  }
  // A SPECIAL is a one-rung ladder: its own flat price until it is owned, and
  // then not for sale at all — the same null a maxed stat returns, so the
  // shelf draws "SOLD" through the machinery that already draws "MAX".
  if (entry.special) return garage.owns(entry) ? null : entry.price;
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
  const price = priceOf(entry, garage, player, loadout);
  if (price === null || price > wallet.credits) return false;
  if (!wallet.spend(price)) return false;

  if (entry.kind) {
    // A consumable — the crate's own effect, applied by the crate's own code.
    // See the header: a bought repair IS a FIX crate.
    applyPickup(entry, player, loadout);
    if (entry.oncePerVisit) garage.recordVisit(entry);
  } else if (entry.special) {
    // A special — booked, then re-derived onto the car through the SAME
    // absolute assignment a tier uses. The car gets a flag it reads for the
    // rest of the run; what it does with it is the four systems' business,
    // never this file's.
    garage.addSpecial(entry);
    player.applyUpgrades(garage.stats);
  } else {
    garage.addTier(entry);
    // Re-derived from the counters rather than nudged, so this stays safe
    // however many times it ends up being called.
    player.applyUpgrades(garage.stats);
  }
  return true;
}
