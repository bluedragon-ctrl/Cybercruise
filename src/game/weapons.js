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
    ammo: Infinity,
    color: PLAYER,
    glow: PLAYER_THRUST,
    length: 14,
    width: 4,
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
