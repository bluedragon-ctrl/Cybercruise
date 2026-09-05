// Enemy armament — what a hostile car is carrying, and when it uses it.
//
// THE SPLIT is the same one cartypes.js and behaviours.js already use, for the
// same reason: data that can be retuned without reading code, separated from the
// code that acts on it.
//
//   ARMAMENTS   pure DATA. One entry is a hostile loadout: which gun, which mine
//               layer. Arming a new kind of enemy differently is adding an
//               entry, not editing a function.
//   Armament    the RUNTIME state of one car's kit — its cooldowns and what is
//               left in its magazines. Every armed car gets its own; the profile
//               behind it is shared.
//   useArms     the default TACTIC: given a car, its kit and the world, decide
//               whether to take a shot or lay a mine this tick.
//
// UNIFORM WAS THE STARTING POINT: every enemy type shared one profile and one
// tactic, so the road could DO these things before it was worth arguing about
// which car does which. Two seams carry every divergence since, with no change
// to this file's structure —
//
//   * `armamentFor` picks a profile, and a type naming `arms: "..."` overrides
//     the faction default. Per-type kit is a catalogue edit.
//   * behaviours.js calls `useArms` from each HOSTILE TACTIC separately, not
//     from the shared cruise/overtake path. Per-behaviour tactics are then just
//     what each function asks for — `raid` lining up one mine where `pursue`
//     shoots.
//
// The consequence of that second seam: being ARMED follows from the faction,
// USING the arms follows from the behaviour. An enemy type given a civilian
// behaviour carries a gun it never fires — the right way round, since tactics
// are what decide whether a car is fighting, but worth knowing before wondering
// why a new type sits there quietly.
//
// WHAT THIS FILE NEVER DOES: touch the world. It decides, then calls one of two
// hooks the world hands it (`world.fireShot`, `world.dropMine`, wired in
// main.js), which is what keeps traffic.js and behaviours.js free of any import
// of projectiles.js or obstacles.js. Both are OPTIONAL: a caller with no
// projectile pool (the tests, the gallery) leaves them off and armed cars go
// through the motions without firing.

import { Weapon, enemyWeaponById, muzzleOffsets } from "./weapons.js";
import { ENEMY_FACTION } from "./cartypes.js";
import { obstacleTypeById } from "./obstacletypes.js";

// The hostile guns this file hands out, resolved BY NAME rather than by position
// in weapons.js's ENEMY_WEAPON_TYPES — see enemyWeaponById there for what the
// index was costing. Resolved once here rather than at each kit below, so the
// profiles read as a table of loadouts and not a table of lookups.
const ENEMY_GUN = enemyWeaponById("blaster");
const ENEMY_SMG = enemyWeaponById("smg");
const ENEMY_MISSILE = enemyWeaponById("missile");
const ENEMY_TWIN_MISSILE = enemyWeaponById("twinMissile");
const ENEMY_TURRET_SMG = enemyWeaponById("turretSmg");
const ENEMY_TWIN_SMG = enemyWeaponById("twinSmg");

// The mine layer, expressed as a WEAPON — because from the carrier's point of
// view that is exactly what it is: a rate of fire and a magazine. `Weapon`
// (weapons.js) already models both and reads nothing else off its type, so the
// layer reuses it instead of growing a second cooldown-and-ammo class beside it.
// `payload` is the one field weapons.js would not recognise, and it names an
// OBSTACLE_TYPES entry rather than describing a bullet.
const MINE_LAYER = {
  id: "minelayer",
  label: "MINES",
  // SIX SECONDS AND THREE OF THEM, for the car's whole life. A mine is the
  // hardest single hit anything on the road can deal (150 hull — obstacletypes.js)
  // and, unlike a bullet, it stays there: laying them freely would carpet the
  // road behind every enemy and turn the mine from an event into weather. The
  // magazine is what makes a drop worth noticing, and it is also why the gun
  // above is deliberately infinite — the two are rationed differently on
  // purpose.
  interval: 6,
  ammo: 3,
  payload: "caltrop",
};

// THE OTHER THING A LAYER CAN CARRY. Same class, same two fields that matter,
// one different `payload`: obstacletypes.js's spike strip instead of its mine.
// Nothing in this file or in obstacles.js needed a line for that — a payload is
// an OBSTACLE_TYPES id and always was — which is the whole reason the layer was
// modelled as a weapon rather than as a mine dispenser.
//
// What the two payloads MEAN could hardly differ more, though, and the numbers
// here are sized off that difference rather than copied from the mine's:
//
//   ONE STRIP, FOR THE CAR'S WHOLE LIFE. The sower's tactic (behaviours.js's
//   `strew`) is a single errand — get ahead, lay it, leave — and a magazine of
//   one is what makes that literal rather than a comment. A second strip would
//   also be a second reason to hang around in front of a player who is by then
//   hunting it.
//   THE INTERVAL IS ALMOST DECORATION at ammo 1, since nothing survives to use
//   the second round. It is stated anyway, at the mine layer's own six seconds,
//   so the magazine is what rations the drop and not a cooldown nobody reaches.
const SPIKE_LAYER = {
  id: "spikelayer",
  label: "SPIKES",
  interval: 6,
  ammo: 1,
  payload: "spikes",
};

// THE BUNKER TRAILER'S OWN LAYER — same two fields as MINE_LAYER, tuned for a
// car that spends the WHOLE FIGHT parked ahead of the player instead of
// snatching one drop on the way past.
//
// TWICE THE CYCLE'S RATE. MINE_LAYER's interval of 6 is sized for a car that
// gets one or two windows before it is past and gone; this car never leaves,
// so half that — 3 — is what keeps the road it is threatening actually
// filling in over the course of the fight rather than reading as the same
// occasional drop stretched across a much longer encounter.
//
// INFINITE, for the reason BATTERY's own magazine is (see below): a boss
// whose mines ran out would be a boss the player could simply wait out from a
// clean lane, which is the one thing a second boss fight must not reward any
// more than the first one did.
//
// SPREAD, unlike the cycle's own single drop — see layMine's own BRACKET
// note for the mechanism. ONE LANE PITCH EITHER SIDE (2 * LANE_WIDTH, 71.5 —
// road.js): a mine dead centre in the neighbouring lane rather than
// somewhere in it, so committing to that lane to dodge the SMG is a real
// gamble, not a corridor with a mine floating loosely inside it. A tighter
// spread would still sit inside the same lane as the burst — indistinguishable
// from one mine, dodged by the same swerve — and a wider one would land past
// the FAR lane a two-lane road puts within reach, missing the lane the player
// was actually going to pick.
const BUNKER_MINE_LAYER = {
  id: "bunkerminelayer",
  label: "MINES",
  interval: 3,
  ammo: Infinity,
  payload: "caltrop",
  spread: 143,
};

// The one hostile profile. See UNIFORM FOR NOW above. Still the rival's own
// kit today, since it names no `arms` override — see cartypes.js.
const HOSTILE = { gun: ENEMY_GUN, layer: MINE_LAYER };

// No gun at all — a car that fights entirely by what it lays in the road.
// `gun: null` rather than a gun with `ammo: 0`, so this is a car type that
// carries nothing to shoot with rather than one that has already fired: the
// two would behave identically here, but the first is what it actually is,
// and it's one field cheaper than a stub weapon type nobody fires.
const RAIDER = { gun: null, layer: MINE_LAYER };

// THE MINE LAYER IS NOT UNIFORM EITHER, and for the same reason the gun
// isn't: only two tactics ever get far enough AHEAD of the player to use one
// at all — `raid` (the cycle) and, once it's filled in, the rival's own. A
// tactic that only ever trails or holds station behind the player (`trail`,
// `pursue`) never satisfies layMine's own lead window, so a mine layer on
// those types is not merely unused flavour, it is dead weight: a magazine
// that never empties and a payload nobody ever resolves. `layer: null` says
// so plainly, the same way `gun: null` already does above — checked
// everywhere a Weapon would be (see the Armament class below).

// The stocker's kit: the SMG (weapons.js) rather than the standard blaster —
// a burst-fire spray instead of one well-aimed round. Gun only: `trail`
// (behaviours.js) camps behind the player for its whole engagement, so it is
// never in a position to lay one.
const GUNNER = { gun: ENEMY_SMG, layer: null };

// The interceptor's kit: a rocket (weapons.js's `missile`) instead of the
// standard blaster — one heavy, slow-reloading hit rather than a steady drip,
// so `pursue` (behaviours.js) never giving up on the player reads as a threat
// that keeps building rather than chip damage. Gun only, for the same reason
// as the stocker's: `pursue` holds station behind the player too.
const ROCKETEER = { gun: ENEMY_MISSILE, layer: null };

// The delta's kit: the SAME missile, fired in a pair every reload — see
// weapons.js's `twinMissile` for why this is a distinct weapon type rather
// than a flag on the interceptor's own `ENEMY_MISSILE` (that object is shared
// by reference with ROCKETEER above, and mutating it would pair the
// interceptor and the gunship too). Gun only, for the same reason as
// ROCKETEER: `pursue` holds station behind the player for the whole
// engagement.
const TWIN_ROCKETEER = { gun: ENEMY_TWIN_MISSILE, layer: null };

// The outrunner's kit (cartypes.js), and the first profile chosen for what a
// gun can do BACKWARDS. Its tactic (behaviours.js's `outrun`) holds station
// AHEAD of the player and shoots back down the road, so the SMG is exactly the
// wrong weapon here however well it suits the outrider: `forwardOnly` (see
// weapons.js) refuses a rearward shot outright, and this car would carry a gun
// it could never fire once it was where it means to be. The plain blaster
// takes the shot in either direction, which is what makes it the pick.
//
// No layer, for the usual reason and an extra one: this car spends its life
// exactly where a mine layer's window wants it, and a hostile that could both
// pin the player from in front AND carpet the road between them is two
// encounters at once.
const REARGUARD = { gun: ENEMY_GUN, layer: null };

// THE BUNKER TRAILER'S KIT — the escalation REARGUARD's own note names and
// then declines: "a hostile that could both pin the player from in front AND
// carpet the road between them is two encounters at once." The outrunner is
// deliberately not that. The second boss is: it carries ENEMY_TURRET_SMG
// (weapons.js) — the same burst spray as the stocker's, but firing backward
// down the road at a player it holds ahead of, which is what that entry's own
// header explains — AND a mine layer that BRACKETS the lane it is shooting
// down (BUNKER_MINE_LAYER's own `spread`) rather than mining the exact lane
// the burst is already covering: the two threats now cost the player two
// different answers instead of one swerve solving both.
const BUNKER_KIT = { gun: ENEMY_TURRET_SMG, layer: BUNKER_MINE_LAYER };

// THE SKIRTED BARGE'S KIT — the third boss, and no layer at all: this car's
// extra threat is not a second weapon system the way the bunker's mines are,
// it is that ENEMY_TWIN_SMG (weapons.js) — TURRET SMG fired as a pair — never
// lines up on anything but the player's own exact lane, because `outrun`
// (behaviours.js) reads this car's `roadMargin` (cartypes.js) and holds
// station there wherever that lane is, barrier or no barrier. A mine layer on
// top of that would be the same "two encounters at once" REARGUARD's own note
// declines for the outrunner — this boss already spends its one escalation on
// the hold, not on the gun.
const BARGE_KIT = { gun: ENEMY_TWIN_SMG, layer: null };

// The sower's kit: a spike strip and nothing else. The RAIDER shape — no gun at
// all, one thing laid in the road — pointed at the other payload, which is the
// clearest reading of what its errand is. See SPIKE_LAYER above.
const SPIKER = { gun: null, layer: SPIKE_LAYER };

// THE BATTERY — the siege mortar's indirect fire, and the third slot a kit can
// carry. See game/shells.js for what a shell IS; this is only the rate of fire
// and the size of the hole.
//
// IT IS A `Weapon` FOR THE SAME REASON THE MINE LAYER IS: from the carrier's
// point of view a battery is a cooldown and a magazine, and Weapon already
// models both. The magazine is INFINITE, unlike the layer's three, and that is
// the fight's whole clock — a boss that ran out of shells would be a boss the
// player could simply wait out from a safe lane, which is the one thing this
// encounter must not reward.
//
// `interval` here is only the OPENING one. The real rate comes from BARRAGE
// below, which overrides the cooldown per salvo — see fireBarrage.
const BATTERY = {
  id: "battery",
  label: "SHELLS",
  interval: 3.4,
  ammo: Infinity,
  // SECONDS OF WARNING ON THE ROAD. The player steers at 260px/sec and a lane
  // is 65px wide, so 1.25s is roughly four lane-changes' worth of time to
  // vacate a 72px circle: unmissable if you are watching, fatal if you are not.
  // This is the single most important number in the fight and the first one to
  // reach for if the barrage feels cheap (too low) or ignorable (too high).
  fuse: 1.25,
  // Wider than a mine's 66 and softer than its 150. A shell is area denial, not
  // a one-hit kill: the player has 100 hull, so a dead-centre hit costs over
  // half of it and a clipped rim costs almost nothing. Standing still is what
  // kills, not any single round.
  blastRadius: 72,
  blastDamage: 55,
  // How far apart the shells of a STRADDLE land, laterally. Just under a lane,
  // so a three-shell pattern brackets the player's lane and both neighbours —
  // the dodge stops being "change lane" and becomes "change SPEED", which is
  // the escalation the last phase is for.
  spread: 52,
};

// THE PHASES. What the battery throws, by how much of the boss's hull is left.
//
// ESCALATION IS THE FIGHT'S STRUCTURE, and it is keyed to DAMAGE rather than to
// elapsed time on purpose: the player's own progress is what makes the fight
// harder, so pushing the attack is a decision with a visible price rather than
// a stat check. It is also why the hull meter under the boss carries notches at
// these fractions (game/effects.js) — the player can see the next phase coming
// and choose whether to cross into it now or back off and heal.
//
// EXPORTED so the meter reads these thresholds rather than restating them. Two
// copies of 0.66 that could drift apart would make the notch a lie, and a lying
// instrument is worse than none.
//
// Ordered high to low; barragePhase walks it and takes the first match, so the
// last entry's `above: 0` is the catch-all and needs no special case.
export const BARRAGE = [
  // RANGING. One shell, slowly. This phase is the tutorial: the player gets to
  // watch a single mark land with nothing else demanding their attention, and
  // learns what the ring means before it matters.
  { above: 0.66, shells: 1, interval: 3.4, mines: false },
  // FIRING FOR EFFECT. Two, closer together — the first phase where a lane
  // change alone is not always enough.
  { above: 0.33, shells: 2, interval: 2.6, mines: false },
  // THE STRADDLE, plus mines. Three shells bracketing the lane, and the battery
  // starts laying what is left of its magazine behind itself as it tries to
  // open the gap. A cornered boss fights dirty; see fireBarrage for the drop.
  { above: 0, shells: 3, interval: 2.0, mines: true },
];

// Which phase a car with `frac` of its hull left is in. Total rather than
// per-car state, so nothing has to be reset, remembered or kept in step — the
// hull IS the phase, and a boss healed by anything later would step back down
// on its own.
export function barragePhase(frac) {
  return BARRAGE.find((p) => frac > p.above) ?? BARRAGE[BARRAGE.length - 1];
}

// The boss's kit. No gun AT ALL, and that is the design rather than an omission:
// carshapes.js's SIEGE MORTAR pitch is "no barrel aimed at you", and a mortar
// that also plinked at the player with a blaster would quietly turn the fight
// back into every other pursuit in the game. The mine layer is the standard
// three-round one and is only ever used in the last phase (see BARRAGE above).
const BATTERY_KIT = { gun: null, layer: MINE_LAYER, battery: BATTERY };

// THE CATAMARAN GUNSHIP'S KIT — the fourth boss, and BATTERY's own numbers
// on a SEPARATE object rather than the mortar's by reference, for the reason
// TWIN MISSILE's own note gives: retuning one boss's fight must never quietly
// retune another's. `layer: null`, unlike the mortar's — this boss reuses the
// EXACT SAME BARRAGE table (below), phase, mines and all, and its last
// phase's `mines: true` still fires straight into `layMine`, which no-ops on
// a null layer (see that function's own first line). So the escalation reads
// exactly as it does for the mortar — one shell, then two, then a straddle —
// minus a mine drop this boss was never given the magazine for. No new code,
// which is the point: the fourth boss is the siege battery's own fight,
// carried by a hull that can also hold it off the tarmac (`roadMargin` below).
const CATAMARAN_BATTERY = {
  id: "catbattery",
  label: "BOMBS",
  interval: 3.4,
  ammo: Infinity,
  fuse: 1.25,
  blastRadius: 72,
  blastDamage: 55,
  spread: 52,
};
const CATAMARAN_KIT = { gun: null, layer: null, battery: CATAMARAN_BATTERY };

// THE ROAD TRAIN'S KIT — not a boss, and the last hostile the catalogue adds.
// ENEMY_TWIN_SMG (weapons.js) IS THE SKIRTED BARGE'S OWN GUN, named again
// rather than duplicated: nothing about firing a pair of SMG rounds instead
// of one is specific to `outrun`'s hold, and reusing the type by reference
// costs nothing here since neither car's cartypes.js entry ever retunes a
// weapon's own numbers, only which kit carries it. NO forwardOnly ON IT,
// UNLIKE THE OUTRUNNER'S OWN REARGUARD — this car's tactic (`outrun`) is
// armed through its whole approach, not only once it holds ahead, so a shot
// taken while it's still behind the player fighting past traffic needs to be
// able to fire backward, which REARGUARD's plain blaster already could too;
// this is only carried over onto the twin round.
//
// AND THE STANDARD MINE_LAYER, unlike the barge's own `layer: null` or the
// bunker's bracketing one: three rounds, ordinary aim, dropped opportunistically
// by `useArms` every tick this car is armed — see `layMine`'s own gate, which
// fires only ahead of a trailing player regardless of which tactic asked. With
// `outrun` holding the car in that window for as long as the fight lasts, the
// drop reads as "in front of the player, repeatedly," rather than as the
// rival's own one deliberate round on the way past.
const ROAD_TRAIN_KIT = { gun: ENEMY_TWIN_SMG, layer: MINE_LAYER };

// Keyed BY NAME, exactly like behaviours.js's BEHAVIOURS table, so a car type
// can name its kit in the catalogue the same way it already names its tactics.
const ARMAMENTS = {
  hostile: HOSTILE,
  raider: RAIDER,
  gunner: GUNNER,
  rocketeer: ROCKETEER,
  twinRocketeer: TWIN_ROCKETEER,
  rearguard: REARGUARD,
  bunker: BUNKER_KIT,
  barge: BARGE_KIT,
  spiker: SPIKER,
  battery: BATTERY_KIT,
  catamaran: CATAMARAN_KIT,
  roadtrain: ROAD_TRAIN_KIT,
};

// The profile a car type carries, or null if it carries nothing.
export function armamentFor(type) {
  // A named profile always wins, so the catalogue is the authority the moment
  // there is more than one profile to choose between.
  if (type.arms) return ARMAMENTS[type.arms] ?? null;
  // Until then: every hostile is armed, and nothing else is. Faction is the
  // right default rather than a per-type flag, because "an enemy car that cannot
  // fight" is not a thing the game has a use for — a new hostile type is armed
  // by existing rather than by remembering to say so.
  return type.faction === ENEMY_FACTION ? HOSTILE : null;
}

// One car's kit. Constructed once per car, at spawn.
export class Armament {
  constructor(profile) {
    // BOTH null-able now, symmetrically — a profile may carry no gun at all
    // (RAIDER) or no mine layer at all (GUNNER, ROCKETEER), and each is
    // checked everywhere else a Weapon would be, rather than handed a stub
    // that exists only to sit there unused.
    this.gun = profile.gun ? new Weapon(profile.gun) : null;
    this.layer = profile.layer ? new Weapon(profile.layer) : null;
    // Resolved ONCE, here, rather than looked up per drop: the payload is a
    // catalogue entry that never changes, and doing it at construction is what
    // makes a typo in `payload` show up when the car spawns rather than six
    // seconds later when it tries to use it. Null along with the layer itself
    // when there is no layer to resolve one for.
    this.payload = profile.layer ? obstacleTypeById(profile.layer.payload) : null;
    // The third slot, and null for everything that is not the boss — checked
    // exactly as the other two are rather than given a stub, so "does this car
    // have artillery" is one truthiness test wherever it is asked.
    this.battery = profile.battery ? new Weapon(profile.battery) : null;
  }

  // Cooldowns run whether or not the car is in a position to use anything, for
  // the same reason the player's whole Loadout cools down together (weapons.js):
  // a weapon that only recovered while it had a target would fire instantly
  // every time one appeared.
  update(dt) {
    if (this.gun) this.gun.update(dt);
    if (this.layer) this.layer.update(dt);
    if (this.battery) this.battery.update(dt);
  }
}

// The kit for a car type, ready to be handed to one car. Null for anything
// unarmed, which is what traffic.js stores and what behaviours.js tests.
export function armFor(type) {
  const profile = armamentFor(type);
  return profile ? new Armament(profile) : null;
}

// --- The default tactic ------------------------------------------------------

// THE GUN.
//
// An enemy shoots at the player and at nothing else (see main.js for the other
// half of that: hostile rounds are resolved against the player alone). Two rules
// shape when the trigger is pulled, and both are about the player rather than
// about the enemy:
//
//   IT MUST BE SEEN COMING. A car firing from beyond the edge of the screen is
//   an unattributable hit — the hull bar drops and there is nothing to blame. So
//   the range is capped by what is actually ON SCREEN, which the world already
//   knows: screen y is playerY - (worldY - distance), one world unit per pixel,
//   so `player.y` is exactly the road visible ahead of the player and
//   `H - player.y` the road visible behind them (see visibleRoad). The constant
//   below is a further ceiling, and with the player framed at 62% down the
//   screen it is not usually the binding one.
//
//   IT MUST BE ABLE TO CONNECT. A rearward shot leaves the muzzle at the
//   shooter's speed MINUS the muzzle speed, so a fast car firing behind it puts
//   out rounds that barely move; and a forward shot at a player who is quicker
//   than the bullet never lands either. Rather than tune those cases away, the
//   shot is simply not taken unless it closes on the target at a useful rate.
//   That reads correctly too — a car pulling away stops shooting behind it.
// EXPORTED, both of them, for the same reason MINE_RANGE below is: a tactic
// that parks itself at a chosen distance from the player has to choose one this
// file will actually take a shot from. behaviours.js's `outrun` holds station
// AHEAD of the player at its profile's `leadHold`, and test/hazards.test.js
// pins that figure between these two rather than against a copy of them.
export const GUN_RANGE = 520;      // world units, before visibility cuts it down
export const GUN_MIN_RANGE = 70;   // roughly a car length: contact range is for ramming
const GUN_CLOSING = 200;    // world units/sec a round must gain on its target
// How far off the target's line a shot is still worth taking. Sized from the
// BULLET's own hit test (projectiles.js: |offset difference| < (target.w +
// bullet.width) / 2) plus slack, so the aim window is roughly the window in
// which a hit is possible — a little wider, since the player may steer into it,
// but not so wide that half the rounds are fired at empty tarmac.
//
// THE DEFAULT, not a fixed ceiling — a gun type may name its own `aimSlack`
// (weapons.js) to be more reckless than this, or more precise. Read via
// aimSlackFor below rather than inline, so "which figure won" is one place.
const GUN_AIM_SLACK = 8;

// The aim tolerance a given gun actually fires within — its own `aimSlack`
// if it names one, GUN_AIM_SLACK otherwise.
function aimSlackFor(type) {
  return type.aimSlack ?? GUN_AIM_SLACK;
}

// THE MINE LAYER.
//
// Mines go BEHIND, at the player, and only when the player is the thing actually
// following. The second half of that is not politeness — it is the scoring rule
// cartypes.js's NERVE section already had to design around: score.js pays out
// however a car died, so a civilian killed by a mine the player never laid would
// fine them for a kill they had no part in. Traffic is kept clear of mines by
// nobody having the nerve to drive onto one; laid mines need the matching rule
// at the other end, which is that a car does not lay one with somebody else's
// traffic between it and its target.
// EXPORTED, because behaviours.js's `raid` tactic needs the same window: a
// car that lines itself up to lay a mine has to aim for a lead distance this
// function will actually accept, not a copy of the two numbers that might
// drift out of step with them.
//
// 460 REACHES INTO THE TOP OF THE VISIBLE ROAD, not just "far enough to react
// to". World units are screen pixels along the road (road.js) and the player
// sits at 62% down an 800px canvas, so 460 ahead lands a shade under 10% from
// the top edge — inside the last fifth of what the player can see coming, with
// room before it would scroll off entirely. Mid-screen (~300) reads as a
// near-miss rather than a real dodge.
export const MINE_RANGE = 460;     // world units back the target may be...
export const MINE_MIN_LEAD = 150;  // ...and no nearer, or it appears in their face
                            // with no road left to steer around it. The player
                            // steers at 260px/sec and needs ~30px to clear a
                            // mine, so this is several times the reaction it
                            // demands
export const MINE_AIM = 45; // how nearly in line the target must be — about two
                            // thirds of a lane, so a mine is laid in the player's
                            // path rather than somewhere off to one side

// Use whatever this car is carrying, if anything, at whatever it is worth using
// on. Called by each hostile behaviour (behaviours.js) once its driving is
// decided — arms never change where a car is going.
export function useArms(car, world) {
  const arms = car.arms;
  if (!arms) return; // civilians, and any type whose profile is unknown
  // The player in road coordinates, which is the only target either weapon has.
  // Traffic syncs it before any behaviour runs, so it is always current here;
  // absent means a caller with no player at all (the gallery, a test fixture).
  const target = world.playerBody;
  if (!target) return;

  shoot(car, arms, target, world);

  // THE BATTERY OWNS ITS OWN MINE DROP, so it returns instead of falling
  // through to the shared rule: a mortar lays only in its last phase (see
  // BARRAGE), and that is a decision about the boss fight rather than about
  // mine-laying in general. Everything else in the catalogue is unaffected —
  // `arms.battery` is null for all of them.
  if (arms.battery) {
    fireBarrage(car, arms, target, world);
    return;
  }

  layMine(car, arms, target, world);
}

// --- The barrage --------------------------------------------------------------
//
// Lob a salvo at where the target is GOING TO BE. Returns whether one was fired.
//
// THERE IS NO RANGE GATE HERE, and its absence is the single most deliberate
// thing in this file. Every other weapon checks that the shot can be seen coming
// and can connect (see shoot's IT MUST BE SEEN COMING, and layMine's window),
// because every other weapon is a line between two cars. Indirect fire is not.
// The battery drops shells on a map reference, and it does that whether the
// player is alongside it, half a screen ahead, or over the horizon on twelve
// seconds of overdrive — which is exactly why the boss cannot be escaped by
// simply being faster than it. Adding a range check here would hand the player
// a way to switch the fight off by driving, and the fight is the encounter.
//
// The player is not left with nothing to read, though: the MARK is always on
// screen even when the battery is not, because it is drawn where the shell will
// land rather than where it came from (shells.js). A player who has run away is
// still given their 1.25 seconds; what they have lost is the ability to shoot
// back.
function fireBarrage(car, arms, target, world) {
  if (!world.fireShell || !arms.battery.ready) return false;

  const type = arms.battery.type;
  const phase = barragePhase(car.health / car.type.health);

  // THE LEAD, and the reason this weapon asks the player to change SPEED rather
  // than only to change lane: the impact point is where the target will be in
  // `fuse` seconds if they hold what they are doing now. Drive on exactly as you
  // were and you arrive with the shell. Everything else — braking, flooring it,
  // swerving — is a dodge.
  const aimY = target.worldY + target.speed * type.fuse;

  // A straddle is centred on the target's line, so an odd count puts one shell
  // dead on it and the rest either side. `(i - (n-1)/2)` is that centring; with
  // one shell it is zero and the whole thing collapses to a single aimed round.
  for (let i = 0; i < phase.shells; i++) {
    const spread = (i - (phase.shells - 1) / 2) * type.spread;
    world.fireShell(aimY, target.offset + spread, type.fuse, type.blastRadius, type.blastDamage);
  }

  arms.battery.tryFire();
  // THE PHASE SETS THE REAL COOLDOWN, overriding the one tryFire just took from
  // the type. Written this way round rather than by giving Weapon a variable
  // interval because the rate belongs to the FIGHT, not to the gun: BARRAGE is
  // the table a designer retunes, and weapons.js stays a catalogue of fixed
  // things.
  arms.battery.cooldown = phase.interval;

  // THE LAST PHASE ALSO LAYS. Ordinary window, ordinary rules — layMine still
  // refuses a drop with somebody else's traffic in the way, and still needs the
  // player actually behind and roughly in line, so this is a mine in the
  // player's path or nothing at all.
  if (phase.mines) layMine(car, arms, target, world);
  return true;
}

// Take a shot at `target` if this is a shot worth taking. Returns whether one
// was fired.
function shoot(car, arms, target, world) {
  if (!arms.gun || !world.fireShot || !arms.gun.ready) return false;

  const along = target.worldY - car.worldY;
  const dir = along >= 0 ? 1 : -1;
  const type = arms.gun.type;
  // FORWARD-ONLY GUNS, like the player's own, never take the rearward shot
  // at all — there is no dir -1 for them, only "no shot". A car built to
  // hang off the player's tail and fire up the road (the stocker's `trail`)
  // has no business aiming back over its own shoulder, whatever the relative
  // position happens to read as for one tick.
  if (type.forwardOnly && dir < 0) return false;
  const range = Math.abs(along);
  if (range < GUN_MIN_RANGE || range > GUN_RANGE) return false;
  if (range > visibleRoad(world, dir)) return false;

  if (Math.abs(target.offset - car.offset) > (target.w + type.width) / 2 + aimSlackFor(type)) {
    return false;
  }

  // Would the round actually gain on it? See IT MUST BE ABLE TO CONNECT above.
  // The sign trick covers both directions at once: firing forward wants the
  // bullet faster than the target, firing backward wants it slower (or moving
  // the other way entirely), and both are `dir * (bullet - target) > 0`.
  const bulletSpeed = car.speed + dir * type.muzzleSpeed;
  if (dir * (bulletSpeed - target.speed) < GUN_CLOSING) return false;

  if (!arms.gun.tryFire()) return false;
  // ONE tryFire, ONE OR MORE ROUNDS — the same trick main.js's own fire branch
  // uses for the player's TWIN CANNON/TWIN RACK (weapons.js's muzzleOffsets):
  // a stock gun gets back a single [0] and this loop costs one call; the
  // delta's `twinRocketeer` gets a symmetric pair back and both rounds share
  // the one cooldown the tryFire above already spent — that IS the kit, not a
  // second cost on top of it.
  for (const dx of muzzleOffsets(type)) world.fireShot(car, type, dir, dx);
  return true;
}

// How far a shooter firing in `dir` may be from the player and still be ON
// SCREEN — see IT MUST BE SEEN COMING. Screen and world units are 1:1 along the
// road (screen y = playerY - (worldY - distance)), so this is exact rather than
// an approximation.
//
// MIND WHICH END. `dir` describes where the TARGET is, so it names the opposite
// edge of the screen from the shooter: a car firing forward (dir +1) is one the
// player has left BEHIND them, and the road behind the player is the H - y below
// the car. A car firing backward is ahead, up in the y above it.
function visibleRoad(world, dir) {
  const { player, H } = world;
  if (!player || !H) return GUN_RANGE;
  return dir > 0 ? H - player.y : player.y;
}

// Lay a mine behind this car if the player is the one who will find it. Returns
// whether one was laid.
function layMine(car, arms, target, world) {
  // No layer at all (the stocker's `gunner`, the interceptor's `rocketeer` —
  // see the ARMAMENTS table above) is the common case now, not the exception,
  // so it's checked first rather than assumed.
  if (!arms.layer || !world.dropMine || !arms.layer.ready || !arms.payload) return false;

  const lead = car.worldY - target.worldY; // positive while the target trails us
  if (lead < MINE_MIN_LEAD || lead > MINE_RANGE) return false;
  if (Math.abs(target.offset - car.offset) > MINE_AIM) return false;
  if (trafficBetween(car, world, lead)) return false;

  // THE BRACKET, the bunker trailer's own escalation — see BUNKER_MINE_LAYER's
  // `spread`. A layer that names one gets TWO mines either side of ITS OWN
  // line instead of one dead on it, the same STRADDLE idea the battery's own
  // `spread` already gives shells (see BARRAGE above), turned on the one
  // weapon that used to put its whole threat where the gun's was already
  // aiming: a mine dead centre in the lane the SMG is already shooting down
  // costs the player nothing extra to dodge, since leaving that lane answers
  // both at once. Bracketing it instead prices the ESCAPE — changing lane to
  // clear the burst now risks the mine waiting in the lane taken.
  if (arms.layer.type.spread) {
    const half = arms.layer.type.spread / 2;
    // A PLAIN LITERAL, NOT `{ ...car }`. Obstacles.drop() only ever reads
    // `worldY`/`h`/`offset` off the body it is handed, but `w`/`h` on a real
    // TrafficCar (traffic.js) are GETTERS on the prototype, not the
    // instance's own enumerable properties — so a spread clone silently
    // drops them, `body.h` comes out `undefined`, and drop()'s own
    // `body.h + deepest` arithmetic goes NaN. The mine still gets pushed
    // (drop() never validates worldY), so the layer reads as firing — an
    // invisible mine nobody can see or hit, forever holding a slot in
    // MAX_LAID_HOSTILE. Naming the three fields explicitly reads the
    // getters' VALUES instead of losing them.
    const shooter = { worldY: car.worldY, h: car.h };
    // The drop is still attempted BEFORE the round is spent (see the single-
    // mine branch below for why), and EITHER LANDING is enough to count as
    // the attack: a budget cap or a barrier clamp swallowing one side must
    // not silently refund the whole reload when the other side still landed.
    const left = world.dropMine({ ...shooter, offset: car.offset - half }, arms.payload);
    const right = world.dropMine({ ...shooter, offset: car.offset + half }, arms.payload);
    if (!left && !right) return false;
    arms.layer.tryFire();
    return true;
  }

  // The drop is attempted BEFORE the round is spent, so a mine the road had no
  // room for costs the car nothing: this is the one weapon with a magazine small
  // enough that quietly swallowing a shot would be felt.
  if (!world.dropMine(car, arms.payload)) return false;
  arms.layer.tryFire();
  return true;
}

// Is somebody else's car in the stretch of road this mine would land in? See THE
// MINE LAYER above for why this exists — it is a scoring rule wearing a driving
// rule's clothes.
function trafficBetween(car, world, lead) {
  for (const other of world.cars ?? []) {
    if (other === car || !other.alive) continue;
    const gap = car.worldY - other.worldY;
    if (gap <= 0 || gap > lead) continue;
    if (Math.abs(other.offset - car.offset) > MINE_AIM + other.w / 2) continue;
    return true;
  }
  return false;
}
