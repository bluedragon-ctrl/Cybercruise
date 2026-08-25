// The pickup GAMEPLAY catalogue — what each buff crate DOES. Same split as
// obstacletypes.js: pickupshapes.js says what a crate LOOKS like, this file
// says what happens when the player drives over it. Adding a new buff means an
// entry here (keyed to a shape BY NAME, exactly as obstacletypes.js is keyed
// to obstacleshapes.js) and, if it is a new KIND of effect, one more branch in
// applyPickup below.
//
// THREE KINDS, deliberately kept this small rather than growing a field per
// possible effect:
//
//   AMMO    tops up a weapon already in the player's Loadout (weapons.js).
//           `weaponId` names the catalogue entry — not an index, so the crate
//           survives WEAPON_TYPES being reordered — and `amount` is spent
//           through Weapon.refill, which already caps at the weapon's own
//           starting ammo. There is no separate "max ammo" concept to keep in
//           sync here.
//   HEAL    restores hull via Player.heal, capped at maxHealth there.
//   SHIELD  grants `duration` seconds of invulnerability via
//           Player.activateShield.
//
// WEIGHTS ARE UNIFORM FOR NOW. The Standard Loadout proposal this catalogue
// implements called for gating the stronger buffs (MINE, SHIELD) behind a
// minDistance and spawning the set at a measured cadence — deliberately not
// done yet. The user's own instruction for this pass was "let them just
// randomly spawn on the road": every type is available from distance 0 at
// equal weight, so pickPickupType below is a plain uniform draw. minDistance
// and weight are still read (mirroring obstacletypes.js's own
// obstacleAvailable/pickObstacleType exactly) so tightening the spawn later is
// a catalogue edit, not new machinery.
import { pickupShapeIndex } from "./pickupshapes.js";
import { pickWeighted } from "./weightedpick.js";
import { ROCKET, PLAYER_THRUST, ENEMY, GREEN_BRIGHT, PLAYER } from "../engine/palette.js";

export const AMMO = "ammo";
export const HEAL = "heal";
export const SHIELD = "shield";

export const PICKUP_TYPES = [
  {
    id: "rocket_ammo",
    label: "ROCKET+",
    shape: pickupShapeIndex("ROCKET_AMMO"),
    kind: AMMO,
    weaponId: "rocket",
    // 36% of the rocket's own 50-round magazine (weapons.js) — meaningful
    // without refilling it outright, the same "use it, don't lean on it"
    // scarcity the weapon's own catalogue entry already asks for.
    amount: 18,
    weight: 1,
    minDistance: 0,
    color: ROCKET, // the rocket weapon's own bullet colour (weapons.js)
  },
  {
    id: "tracer_ammo",
    label: "TRACER+",
    shape: pickupShapeIndex("TRACER_AMMO"),
    kind: AMMO,
    weaponId: "tracker",
    amount: 48, // 40% of the tracker's 120-round magazine — six of its
                // eight-round bursts (weapons.js)
    weight: 1,
    minDistance: 0,
    color: PLAYER_THRUST, // the tracker weapon's own bullet colour
  },
  {
    id: "mine_ammo",
    label: "MINE+",
    shape: pickupShapeIndex("MINE_AMMO"),
    kind: AMMO,
    weaponId: "mine",
    // TWO MINES, against the layer's eight-round magazine (weapons.js) — 25%,
    // where the two gun crates above are 36-40% of theirs. The layer crates are
    // deliberately the stingier half of this catalogue now that the magazines
    // have grown: a mine is the hardest single hit on the road, the player is
    // ISSUED a full eight at the start of every run, and the dock will sell a
    // whole set (game/upgrades.js). A crate is a top-up between those, not a
    // resupply.
    amount: 2,
    weight: 1,
    minDistance: 0,
    // ENEMY, not the mine weapon's own HUD colour (weapons.js sets that to
    // PLAYER_THRUST purely for hull-bar-row legibility). This one matches
    // what the crate's own glyph is drawn in instead — the mine hazard's
    // established red (obstacleshapes.js) — so the burst echoes what the
    // player just saw on the crate, not the HUD text they didn't look at.
    color: ENEMY,
  },
  {
    id: "spikes_ammo",
    label: "SPIKES+",
    shape: pickupShapeIndex("SPIKES_AMMO"),
    kind: AMMO,
    weaponId: "spikes",
    // ONE STRIP, against the mine crate's two, and the stingiest thing in this
    // catalogue by some way: 20% of the strip's five-round magazine (weapons.js)
    // against the gun crates' 36-40% of theirs. Two reasons, and they compound.
    // A road the player can keep permanently belted is a road nothing can chase
    // them down, so the refill must never be proportional to the magazine. And
    // the player starts a run with NO strips at all (weapons.js's `startAmmo`),
    // which makes finding one on the road a real event rather than a top-up —
    // exactly what a single strip should be.
    amount: 1,
    weight: 1,
    minDistance: 0,
    // ENEMY, matching the crate's own glyph and the hazard's red on the road,
    // for exactly the reason the mine crate below gives.
    color: ENEMY,
  },
  {
    id: "fix",
    label: "FIX",
    shape: pickupShapeIndex("FIX"),
    kind: HEAL,
    amount: 70, // 35% of the player's 200 maxHealth (player.js)
    weight: 1,
    minDistance: 0,
    color: GREEN_BRIGHT,
  },
  {
    id: "shield",
    label: "SHIELD",
    shape: pickupShapeIndex("SHIELD"),
    kind: SHIELD,
    duration: 5,
    weight: 1,
    minDistance: 0,
    color: PLAYER, // the player's own cyan, matching the shield ring it grants
  },
];

// Whether `type` may appear yet, given the RAW world odometer. Mirrors
// obstacletypes.js's obstacleAvailable exactly — kept even though every entry
// is gated at 0 today, so tightening a gate later needs no new machinery.
export function pickupAvailable(type, distance) {
  return distance >= (type.minDistance ?? 0);
}

// A random pickup type the player has driven far enough to meet, honouring
// `weight`. The draw itself is weightedpick.js's, shared with pickObstacleType
// and pickCarType; only the gate above is this catalogue's own.
export function pickPickupType(distance = Infinity) {
  return pickWeighted(PICKUP_TYPES, (type) => pickupAvailable(type, distance));
}

// One named pickup type. Mirrors obstacletypes.js's obstacleTypeById.
export function pickupTypeById(id) {
  return PICKUP_TYPES.find((t) => t.id === id) ?? null;
}

// Apply `type`'s effect. `player` and `loadout` are the two things a buff can
// ever touch — see the header for why there is nothing more general than
// that. A crate is always spent on contact, even over an already-full
// magazine or hull — Weapon.refill and Player.heal already no-op gracefully
// at their own cap, so this never needs to ask "was there room" first; it
// just costs the player a wasted pickup, same as driving over an ammo crate
// at full ammo would in any other game of this shape.
export function applyPickup(type, player, loadout) {
  switch (type.kind) {
    case AMMO: {
      const weapon = loadout.get(type.weaponId);
      if (weapon) weapon.refill(type.amount);
      break;
    }
    case HEAL:
      player.heal(type.amount);
      break;
    case SHIELD:
      player.activateShield(type.duration);
      break;
  }
}
