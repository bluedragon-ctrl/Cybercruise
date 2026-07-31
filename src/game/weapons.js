// The weapon catalogue — what the player (and later the enemy) shoots with.
//
// Two things live here, and they are deliberately separate:
//
//   WEAPON_TYPES  pure DATA, exactly like cartypes.js: how hard a shot hits, how
//                 often it can be taken, how fast it flies, what it looks like.
//                 Adding a weapon is adding an entry.
//   Weapon        the RUNTIME state of one weapon in one car's hands: its
//                 cooldown and its remaining ammunition. Two cars carrying the
//                 same type each get their own Weapon, and the type is shared.
//
// AMMUNITION. The default gun carries `Infinity` rounds — the player is never
// left with no way to shoot at all, which is what makes the special weapons
// (Phase 5) a choice rather than a lifeline. Every other weapon will be finite,
// so the ammo bookkeeping is built in HERE from the start rather than bolted on:
// `tryFire` already spends a round, and an Infinity counter simply never runs
// down (Infinity - 1 === Infinity, so the arithmetic needs no special case —
// only the HUD does, which is why `ammoText` exists).
//
// WHAT THIS FILE DOES NOT DO: it never touches the world. `tryFire` answers one
// question — "may a shot be taken this instant?" — and the caller is what turns
// a yes into a bullet (see projectiles.js, main.js). That split is what lets the
// enemy reuse the same class in the next step without inheriting the player's
// input handling.

import { PLAYER, PLAYER_THRUST } from "../engine/palette.js";

// HOW A BULLET FLIES. The road curves, so "straight ahead" and "up the lane" are
// two genuinely different shots, and which one a weapon takes is its defining
// trait rather than an engine detail:
//
//   STRAIGHT  the round holds the SCREEN LINE it was fired along and ignores the
//             road entirely. On a straight it is the obvious weapon; into a bend
//             it drifts across the lanes and eventually buries itself in the
//             barrier. What you point at is what you hit — including the wall.
//   TRACKING  the round holds its LATERAL OFFSET from the centre-line, so it
//             follows every curve the road takes and stays in the lane it was
//             fired up. It can shoot round a bend, which no straight shot can,
//             and it can never hit a barrier.
//
// projectiles.js implements both; this constant is the whole difference between
// them at the catalogue level.
export const FLIGHT_STRAIGHT = "straight";
export const FLIGHT_TRACKING = "tracking";

// Fields:
//   id          stable key (save data, pickup tables, debugging)
//   label       HUD caption
//   damage      hull removed by one hit. For scale, the catalogue in cartypes.js
//               runs from the cycle's 25 hull to the rig's 220, and the player
//               has 100
//   interval    seconds between shots — the reciprocal of the fire rate
//   muzzleSpeed how fast the shot leaves the car, world units/sec RELATIVE TO
//               THE SHOOTER. A bullet's absolute speed is the shooter's speed
//               plus this, so firing while flat out doesn't leave your own
//               rounds hanging in front of you
//   flight      FLIGHT_STRAIGHT | FLIGHT_TRACKING — see above
//   ammo        rounds carried. Infinity for the default gun
//   color/glow  bullet body and its trail
//   length/width  the bullet's drawn size AND its hit box, world units
export const WEAPON_TYPES = [
  {
    id: "cannon",
    label: "CANNON",
    // Three hits kills the standard hostile (interceptor, 70 hull), one kills a
    // cycle, seven are needed for a rig. Deliberately NOT a one-shot weapon
    // against anything that matters: the default gun is supposed to make the
    // heavier enemy types feel heavy, which is what leaves Phase 5's specials
    // something to be better at.
    damage: 34,
    interval: 0.16, // ~6 shots/sec — fast enough to feel automatic
    muzzleSpeed: 900,
    // The default gun shoots where the car is POINTED, which on a bend is not
    // where the road goes. That limitation is the reason the tracker below is
    // worth carrying, so it must never be softened here.
    flight: FLIGHT_STRAIGHT,
    ammo: Infinity,
    color: PLAYER,
    glow: PLAYER_THRUST,
    length: 14,
    width: 4,
  },
  {
    id: "tracker",
    label: "TRACKER",
    // Hits harder and slower than the cannon, and every round follows the road
    // round the bend. Its value is entirely SITUATIONAL: on a straight it is a
    // worse cannon, and through a long curve it is the only thing that can
    // reach the car ahead at all.
    damage: 45,
    interval: 0.24, // ~4 shots/sec
    muzzleSpeed: 820,
    flight: FLIGHT_TRACKING,
    // FINITE, and there is nowhere to refill it until the Phase 5 pickups land:
    // 60 rounds is roughly fifteen seconds of held trigger. Running dry and
    // dropping back to the cannon is the intended arc for now, not a bug.
    ammo: 60,
    color: PLAYER_THRUST,
    glow: PLAYER,
    length: 16,
    width: 4.5,
  },
];

export function weaponTypeById(id) {
  return WEAPON_TYPES.find((w) => w.id === id) ?? null;
}

// The default loadout: what the player starts every run holding.
export const DEFAULT_WEAPON = WEAPON_TYPES[0];

// One weapon, as carried by one car.
export class Weapon {
  constructor(type = DEFAULT_WEAPON) {
    this.type = type;
    this.cooldown = 0;   // seconds until the next shot is allowed
    this.ammo = type.ammo;
  }

  get empty() {
    return this.ammo <= 0;
  }

  // Ready to fire RIGHT NOW — the trigger being held is the caller's business.
  get ready() {
    return this.cooldown <= 0 && !this.empty;
  }

  update(dt) {
    if (this.cooldown > 0) this.cooldown -= dt;
  }

  // Spend a shot if one is available. Returns whether it was: the caller fires a
  // bullet on true and does nothing on false, so a held trigger against an empty
  // or cooling weapon costs nothing and makes no noise.
  tryFire() {
    if (!this.ready) return false;
    this.cooldown = this.type.interval;
    this.ammo -= 1; // Infinity stays Infinity
    return true;
  }

  // HUD caption. The infinite gun reads as a symbol rather than as a number,
  // because "999" invites the player to watch it.
  get ammoText() {
    return this.ammo === Infinity ? "∞" : `${Math.max(0, Math.floor(this.ammo))}`;
  }
}

// Everything a car is carrying, and which of it is in hand.
//
// SWAPPING NEVER FAILS, including onto an empty weapon. The alternative — skip
// what has no ammo — means the same key does different things depending on
// state, and the player has no way to see what they are about to get. An empty
// weapon selects, shows "0", and refuses to fire; TAB again moves on.
//
// Cooldowns run for the WHOLE loadout, not just the weapon in hand (see
// update), so swapping cannot be used to dodge a slow weapon's fire rate by
// flicking away and back.
export class Loadout {
  constructor(types = WEAPON_TYPES) {
    this.weapons = types.map((t) => new Weapon(t));
    this.index = 0;
  }

  get current() {
    return this.weapons[this.index];
  }

  next() {
    this.index = (this.index + 1) % this.weapons.length;
    return this.current;
  }

  update(dt) {
    for (const w of this.weapons) w.update(dt);
  }
}
