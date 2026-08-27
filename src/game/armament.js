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
// UNIFORM WAS THE STARTING POINT, ON PURPOSE. Every enemy-faction type got the
// same profile and the same tactic at first, so an interceptor and a bruiser
// shot alike — the road had to be ABLE to do these things before it was worth
// arguing about which car does which, how often. The two seams that step cut
// are what the first divergence (the cycle's `raider` profile, gun-less) used
// without touching this file's structure —
//
//   * `armamentFor` picks a profile, and a car type naming `arms: "..."`
//     overrides the faction default. Per-type kit is then a catalogue edit.
//   * behaviours.js calls `useArms` from each HOSTILE TACTIC separately rather
//     than from the shared cruise/overtake path. Per-behaviour tactics are then
//     a matter of what each of those functions asks for — `raid` lining up a
//     single mine drop where `pursue` shoots, and so on.
//
// Note the consequence of that second seam: being ARMED follows from the
// faction, but USING the arms follows from the behaviour. An enemy type given a
// civilian behaviour would carry a gun it never fires. That is the right way
// round — a car's tactics are what decide whether it is fighting — but it is
// worth knowing before wondering why a new type sits there quietly.
//
// WHAT THIS FILE NEVER DOES: touch the world. It decides, and then calls one of
// two hooks the world hands it (`world.fireShot`, `world.dropMine`, wired up in
// main.js). That is what keeps traffic.js and behaviours.js free of any import
// of projectiles.js or obstacles.js — the same trick Traffic's `onDestroyed`
// callback uses to keep it from ever knowing what a point is. Both hooks are
// OPTIONAL: a caller with no projectile pool (the tests, the gallery) simply
// leaves them off and armed cars go through the motions without firing.

import { Weapon, ENEMY_WEAPON_TYPES } from "./weapons.js";
import { ENEMY_FACTION } from "./cartypes.js";
import { obstacleTypeById } from "./obstacletypes.js";

const ENEMY_GUN = ENEMY_WEAPON_TYPES[0];
const ENEMY_SMG = ENEMY_WEAPON_TYPES[1];
const ENEMY_MISSILE = ENEMY_WEAPON_TYPES[2];

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

// The sower's kit: a spike strip and nothing else. The RAIDER shape — no gun at
// all, one thing laid in the road — pointed at the other payload, which is the
// clearest reading of what its errand is. See SPIKE_LAYER above.
const SPIKER = { gun: null, layer: SPIKE_LAYER };

// Keyed BY NAME, exactly like behaviours.js's BEHAVIOURS table, so a car type
// can name its kit in the catalogue the same way it already names its tactics.
const ARMAMENTS = {
  hostile: HOSTILE,
  raider: RAIDER,
  gunner: GUNNER,
  rocketeer: ROCKETEER,
  rearguard: REARGUARD,
  spiker: SPIKER,
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
  }

  // Cooldowns run whether or not the car is in a position to use anything, for
  // the same reason the player's whole Loadout cools down together (weapons.js):
  // a weapon that only recovered while it had a target would fire instantly
  // every time one appeared.
  update(dt) {
    if (this.gun) this.gun.update(dt);
    if (this.layer) this.layer.update(dt);
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
  layMine(car, arms, target, world);
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
  world.fireShot(car, type, dir);
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
