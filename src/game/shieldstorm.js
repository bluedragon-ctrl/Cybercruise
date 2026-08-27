// SHIELD STORM — the shop upgrade that makes the player's shield bite back.
//
// The shield is otherwise the one buff in the game that does nothing but
// SURVIVE: it eats hits (player.js's damage) and that is the whole of it, which
// makes a shielded stretch of road a stretch the player waits out. This turns
// those seconds into the most aggressive the car ever gets — drive INTO the
// pack rather than through it — without touching what a shield already is, and
// without the player having to press anything.
//
// IT IS A PULSE, NOT AN AURA, and that is the difference between a weapon and a
// bulldozer. A continuous field would delete anything that came near, at sixty
// applications a second, with no skill in it at all. A discharge every
// STORM_INTERVAL means a car that brushes past takes one hit and a car the
// player deliberately sits alongside takes several — proximity AND time, which
// is the same thing the mine's blast falloff asks of the player, seen from the
// other side.
//
// WHAT IT IS NOT: a way to farm the road. Every arc is real damage into
// traffic.js's own damage(), so a kill scores exactly as a kill always has
// (score.js pays out however a car died) — but STORM_DAMAGE is deliberately
// under a single cannon round, so a full 30s shop shield spent parked in
// traffic still earns less than the same 30s spent shooting.
//
// IT DOES NOT CHECK WHOSE SIDE A CAR IS ON, and that is a decision rather than
// an omission. Every other area effect in the game is indiscriminate — a mine
// bites whatever crosses it, a detonating car blasts its neighbours and the
// player alike (traffic.js's blast) — and a field of electricity that politely
// declined to touch civilians would be the one physical effect on the road that
// reads minds.
//
// IT HAS A PRICE, THEREFORE. Civilians are worth NEGATIVE points (cartypes.js's
// `value`, -50 to -300) and score.js pays out however a car died, so a storm
// driven through commuter traffic fines the player for every one it kills. That
// is the upgrade's real cost and the skill in it: a shield used to be a licence
// to stop steering, and this makes those same seconds the ones where the line
// you pick matters most. The arcs are drawn as they land, so nobody is fined by
// something they could not see happening.
//
// If that ever needs revisiting, the honest lever is the CAR CATALOGUE's own
// faction (cartypes.js's ENEMY_FACTION) applied here — not a quiet exception
// for one effect.
//
// WHY A MODULE RATHER THAN A METHOD ON PLAYER. player.js knows nothing about
// traffic and must not learn: it is handed a road width and its own input, and
// that is the whole of its world. This needs the car list, the explosion pool
// and the player's position in ROAD coordinates, which is main.js's knowledge,
// not the car's. Same reasoning game/obstacles.js's update(dt, world) follows.
//
// DISTANCE IS MEASURED BETWEEN BOX EDGES, exactly as traffic.js's blast() does
// it and for the same reason: a rig is 124 units long, and a centre-to-centre
// reach would spare the trailer sitting alongside while biting a cycle two
// lengths back.

import { PLAYER, SHIELD_FLICKER } from "../engine/palette.js";

// How far past the car's own skin the shield reaches. Sized against the road
// rather than against the shield's drawn halo (player.js's SHIELD_ORB_R, which
// is a glow and not a hitbox): a lane is roughly 100 units, so this is "the car
// beside me and the one riding my bumper", and never the far lane. The player
// has to actually go and be near something.
export const STORM_RADIUS = 96;

// Per discharge, at contact. UNDER A CANNON ROUND (41, weapons.js) on purpose —
// see the header. Two arcs kill a cycle, five kill an interceptor, and a rig
// (220) simply cannot be stormed down inside one crate's shield.
export const STORM_DAMAGE = 34;

// Seconds between discharges. Slow enough to read as a series of separate
// snaps and to keep the effect pool breathing (effects.js's ARC_DURATION is
// 0.18, so there is a clear gap between one bolt dying and the next), fast
// enough that holding station beside a car is visibly worth doing.
export const STORM_INTERVAL = 0.5;

// FALLOFF, like every other area effect in the game: full damage at contact,
// nothing at the rim. It is what makes "vicinity" a thing the player steers
// rather than a binary they are either inside or outside of.
function stormDamageAt(dist) {
  return STORM_DAMAGE * (1 - dist / STORM_RADIUS);
}

// How many cars ONE discharge may arc to. A cap rather than "everything in
// range", so a storm driven into a dense pack cannot empty the effect pool in
// one tick (effects.js holds 8 slots for the whole road) or delete a whole
// cluster on a single pulse. The nearest are chosen, which is also the pair
// the player is most obviously asking to hit.
const MAX_ARCS = 3;

export class ShieldStorm {
  constructor() {
    this.timer = 0; // seconds until the next discharge is allowed
    // Scratch for the per-pulse "nearest few" shortlist. The ARRAY is reused
    // and truncated rather than rebuilt, the way main.js's own shotTargets is;
    // this is not the frame-by-frame hot path projectiles.js's pool guards
    // against, since a discharge happens twice a second at most.
    this.candidates = [];
  }

  // Between runs, alongside every other per-run reset in main.js's newGame().
  reset() {
    this.timer = 0;
    this.candidates.length = 0;
  }

  // One tick. `worldY`/`offset` are the player in ROAD coordinates — the same
  // pair main.js already computes for the muzzle, rather than a PlayerBody, so
  // this can run BEFORE traffic.update() alongside the player's own gunfire
  // (see main.js: a car killed this tick must detonate and score in this tick).
  //
  // Returns how many cars were struck, which is main.js's cue for a tone — the
  // same "the game module never touches audio" split game/shop.js follows.
  update(dt, player, worldY, offset, cars, explosions) {
    // NOT OWNED, OR NOT RUNNING. The timer is cleared rather than left to run
    // down, so a shield that comes up finds a storm ready to fire on its first
    // tick: the player who drives into a pack the instant a crate lands should
    // get the discharge they went in for, not half a second of nothing.
    if (!player.specials.shieldStorm || player.shieldTime <= 0) {
      this.timer = 0;
      return 0;
    }

    this.timer -= dt;
    if (this.timer > 0) return 0;
    this.timer = STORM_INTERVAL;

    this.candidates.length = 0;
    for (const car of cars) {
      if (!car.alive) continue;
      const dx = Math.max(0, Math.abs(car.offset - offset) - (car.w + player.w) / 2);
      const dy = Math.max(0, Math.abs(car.worldY - worldY) - (car.h + player.h) / 2);
      const dist = Math.hypot(dx, dy);
      if (dist >= STORM_RADIUS) continue;
      this.candidates.push({ car, dist });
    }

    // Nearest first, then the cap — see MAX_ARCS.
    this.candidates.sort((a, b) => a.dist - b.dist);
    const struck = Math.min(this.candidates.length, MAX_ARCS);
    for (let i = 0; i < struck; i++) {
      const { car, dist } = this.candidates[i];
      car.damage(stormDamageAt(dist));
      // The bolt is drawn from the shield to the car it bit, both ends captured
      // where they are RIGHT NOW — see effects.js's ARC slot on why an arc is
      // welded to the tarmac rather than following either end afterwards.
      if (explosions) explosions.spawnShieldArc(car.worldY, car.offset, worldY, offset);
    }
    return struck;
  }
}

// The colours the storm is drawn in, re-exported from one place so the arc, any
// future HUD readout and the shop row cannot drift apart. The shield's own
// player-cyan, flickering white — this is the shield doing the work, and it
// should never read as a second weapon system with a palette of its own.
export const STORM_COLOR = PLAYER;
export const STORM_GLOW = SHIELD_FLICKER;
