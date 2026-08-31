// Ramming physics — the one place cars are allowed to push each other around.
//
// THE BODY INTERFACE. This file knows nothing about players or traffic; it
// resolves a flat list of BODIES, each of which must expose:
//
//   worldY, offset   position along / across the road (see road.js, traffic.js)
//   prevOffset       offset at the previous tick, so lateral speed is MEASURED
//                    rather than assumed (the player steers positionally, so it
//                    has no lateral velocity of its own to read)
//   w, h             collision box
//   speed            forward speed, world units/sec
//   vLateral         the SHOVE channel: sideways velocity owned by this file and
//                    integrated (and damped) by whoever owns the body
//   mass             relative, arbitrary units — only ratios matter
//   alive            skipped when false
//   damage(hp)       take a hit
//
// OPTIONAL, and read off the body doing the hitting rather than the one taking
// it — see impactCost and sideSwipe for why:
//
//   attackFloor      closing speed under which THIS body's hits do no harm to
//                    whatever they land on. Undefined defaults to DAMAGE_FLOOR.
//   shovePower       multiplies the lateral velocity THIS body hands to
//                    whatever it hits in a side-swipe. Undefined defaults to 1.
//   speedFloor       speed that LEANING on this body from behind may not push it
//                    under — see rearEnd. Read off the body being SLOWED, unlike
//                    the two above, because it describes what that body's own
//                    engine is holding rather than how hard it hits.
//
// TrafficCar implements it directly; the player gets the adapter at the bottom.
// Adding a body type later (a barrel, a boss) means implementing those fields,
// not editing the solver.
//
// HOW A COLLISION IS RESOLVED. Boxes are axis-aligned, so an overlap is undone
// along whichever axis is penetrated LEAST — a rear-end pushes along the road, a
// side-swipe pushes across it. Both bodies move, split by inverse mass, so a
// truck barely notices a roadster and a roadster is flung by a truck. The same
// split then exchanges velocity along that axis (a partly elastic impact) and
// decides who takes the damage.
//
// CHAINS come out of running that pair sweep several times per tick: separating
// A from B may push B into C, which the next pass resolves, which may push C
// into D. So shunting a car into the car beside it carries the hit onward, with
// each link costing momentum, exactly as the player would expect.

// Sideways velocity handed to a body per px of penetration, per second. This is
// what turns steady pressure — the player leaning on a car it is overlapping —
// into a slide that keeps going after contact ends, and what carries an impact
// down a chain. Positional separation alone would only ever nudge.
const PUSH_GAIN = 7;

// Bounce. Deliberately low: cars crumple, they don't ping.
const RESTITUTION = 0.25;

// Damage is linear in closing speed above a floor, so parking against a car
// costs nothing and a full-speed ram is lethal. At equal mass, a 300 unit/sec
// rear-end costs each car (300-40) * 0.15 = 39 hull.
const DAMAGE_FLOOR = 40; // closing speed that does no harm at all
const IMPACT_DAMAGE = 0.15; // hull per unit of closing speed above the floor
// Side-swipes hurt this much of a head-on for the same speed. Exported because
// behaviours.js prices a lane change as a side-swipe — see impactCost.
export const SIDE_DAMAGE = 0.35;

// Sweeps per tick. Four is enough for the chains a 4-lane road can produce
// (7 cars + the player), and the loop exits early once a sweep finds nothing.
const PASSES = 4;

// Lateral speed per body, measured once at the top of the tick. Reused between
// ticks so the solver allocates nothing. See resolveCollisions.
const lateralV = [];

// WHICH PAIRS WERE TOUCHING LAST TICK — the solver's one piece of memory, and
// the thing that lets rearEnd tell an IMPACT from a LEAN (see its header).
// Flat [a, b, a, b, ...] rather than a Set of pair objects because a 4-lane road
// carries eight bodies at most: a linear scan over the handful of live contacts
// is cheaper than the allocation a keyed structure would need every tick, and
// the two arrays are swapped rather than rebuilt, so this allocates nothing
// either. Body IDENTITY is what is compared, which holds because Traffic keeps
// one TrafficCar per car and one PlayerBody for the whole run (traffic.js).
let prevContacts = [];
let contacts = [];

function wasTouching(list, a, b) {
  for (let i = 0; i < list.length; i += 2) {
    if ((list[i] === a && list[i + 1] === b) || (list[i] === b && list[i + 1] === a)) return true;
  }
  return false;
}

// AABB overlap between two boxes exposing {worldY, offset, w, h}.
//
// The STATIC test, and deliberately only that: it answers "may these two
// occupy the same patch of road?" and nothing more. Obstacles and pickups
// never move under a rammed shove the way TrafficCar does, so their spawners
// (obstacles.js, pickups.js — which each kept an identical private copy of
// this before it lived here) need no separation pass on either side. Cars go
// through resolveCollisions below instead.
export function overlaps(a, b) {
  return (
    Math.abs(a.worldY - b.worldY) < (a.h + b.h) / 2 &&
    Math.abs(a.offset - b.offset) < (a.w + b.w) / 2
  );
}

// Whether a blast that goes off AT ROAD LEVEL reaches this body.
//
// THE ONE PLACE THIS IS ARGUED, and it is argued here because three separate
// sweeps ask it — Traffic.blast (a dying car), Obstacles.blast (a mine, a
// roadblock) and Projectiles.detonate (a rocket's splash). All three measure
// falloff in the same two ROAD coordinates, between box edges, and all three
// were written when everything in the game was on the tarmac.
//
// An `airborne` body (cartypes.js) is not. Its worldY and offset say where it is
// over the ground, not where it IS — the altitude is in the drawing (carshapes.js's
// `hover`) and in one rule in projectiles.js's firstHit, which is that only a
// SEEKING round climbs to it. A blast on the road that reached it anyway would
// undo that rule quietly and from three directions at once: the player would
// find they could kill a gunship by detonating a rig underneath it, which is
// precisely the shot the whole design says is impossible.
//
// SYMMETRICAL, and cheaply so: an airborne type gives no blast either, because
// its catalogue row states blastRadius 0 rather than because anything here
// checks. One rule, stated once, with nothing to keep in step.
//
// Bodies that are not cars (the player, an obstacle) carry no `airborne` field
// at all and are always in the plane, which is the correct answer for them.
export function inBlastPlane(body) {
  return !body.airborne;
}

// Resolve every overlap in `bodies`. Mutates positions, speeds and health.
export function resolveCollisions(bodies, dt) {
  // Lateral speed has to be MEASURED (the player steers positionally, so it has
  // no velocity to read) — and measured ONCE, before anything is separated.
  // Re-measuring per pass would read the previous pass's positional correction
  // back as real motion, inventing hundreds of px/sec of impact out of a shove
  // the solver itself applied.
  lateralV.length = bodies.length;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    lateralV[i] = (b.offset - b.prevOffset) / dt;
  }

  // This tick's contacts are recorded into the array last tick's were read from,
  // so the two swap places and neither is ever rebuilt.
  const spent = prevContacts;
  prevContacts = contacts;
  contacts = spent;
  contacts.length = 0;

  for (let pass = 0; pass < PASSES; pass++) {
    let touched = false;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        if (!b.alive) continue;
        if (collide(a, b, lateralV[i], lateralV[j], pass === 0)) touched = true;
      }
    }
    if (!touched) return; // road is clear — the usual case
  }
}

// One pair. Returns true if they were overlapping. `first` marks the tick's
// opening pass — see sideSwipe for why the impact only counts there.
function collide(a, b, latA, latB, first) {
  const dy = b.worldY - a.worldY;
  const overlapY = (a.h + b.h) / 2 - Math.abs(dy);
  if (overlapY <= 0) return false;
  const dx = b.offset - a.offset;
  const overlapX = (a.w + b.w) / 2 - Math.abs(dx);
  if (overlapX <= 0) return false;

  // Inverse-mass split: shareA is how much of the correction A absorbs, and
  // equals mB/(mA+mB) — the lighter body moves further and takes more damage.
  const invA = 1 / a.mass;
  const invB = 1 / b.mass;
  const shareA = invA / (invA + invB);
  const shareB = 1 - shareA;

  // Whether this pair arrived at each other THIS tick, decided before the pair
  // is recorded — a pair still touching from last tick is a lean, not a hit.
  // Recorded once per tick however many passes reach it, so `contacts` cannot
  // grow with PASSES.
  const fresh = !wasTouching(prevContacts, a, b);
  if (!wasTouching(contacts, a, b)) contacts.push(a, b);

  if (overlapY < overlapX) {
    rearEnd(a, b, dy >= 0 ? 1 : -1, overlapY, shareA, shareB, fresh, first);
  } else {
    sideSwipe(a, b, dx >= 0 ? 1 : -1, overlapX, shareA, shareB, latA - latB, first);
  }
  return true;
}

// Along the road. `sign` is +1 when b is the car in front. `fresh` is false once
// the pair has been touching since last tick, `first` marks the tick's opening
// pass — together they separate the two things contact along the road can be.
//
// AN IMPACT IS AN ARRIVAL; PRESSURE IS NOT AN IMPACT. This is the distinction
// sideSwipe has always drawn across the road ("standing pressure becomes a
// slide"), applied along it. Without it, a body held against the one in front
// is billed a fresh partly-elastic impact sixty times a second, and the bill is
// proportional to closing speed: the harder its engine pushes back, the harder
// the next tick takes it away. That is a speed SINK, and it is strong enough to
// beat anything the pushing body can do about it — an overdriven player pinned
// behind a mass-2-or-heavier car settled on the CAR'S speed and stayed there,
// 140 units under a floor the pickup had promised (player.js, BAND_RECOVER),
// because a heavy car's own ACCEL ramp (traffic.js) undoes the share of the
// shove it receives faster than the shove arrives. Contact was an anchor.
//
// So a lean exchanges momentum WITHOUT the bounce, and without being able to
// push the rear body under its own `speedFloor`: what the floor refuses is
// handed to the car in front instead, which is what turns a boosted player
// leaning on a rig into a car that shoves the rig along rather than one the rig
// silently switches the boost off for. The ARRIVAL is untouched — full impulse,
// full damage — so a hit still costs the speed it always did and the band
// ramps it back at BAND_RECOVER, visibly, over about half a second.
function rearEnd(a, b, sign, overlap, shareA, shareB, fresh, first) {
  a.worldY -= sign * overlap * shareA;
  b.worldY += sign * overlap * shareB;

  const front = sign > 0 ? b : a;
  const rear = sign > 0 ? a : b;
  const frontShare = sign > 0 ? shareB : shareA;
  const rearShare = 1 - frontShare;

  // Only an approach is an impact. Two cars already separating (the pass that
  // pulled them apart runs before this one can see it) must not be hit twice.
  const closing = rear.speed - front.speed;
  if (closing <= 0) return;

  if (fresh) {
    const impulse = closing * (1 + RESTITUTION);
    rear.speed = Math.max(0, rear.speed - impulse * rearShare);
    front.speed += impulse * frontShare;
    applyDamage(a, b, closing, 1);
    return;
  }

  // A lean, and only on the opening pass: unlike the impact above it does not
  // always leave the pair separating (a floored body keeps its speed), so a
  // later pass finding them still in contact would charge for the same push
  // twice. Damage is not re-billed for the same reason — the arrival was
  // charged for, and DAMAGE_FLOOR would swallow a lean's closing speed anyway.
  if (!first) return;
  const want = closing * rearShare;
  const take = Math.max(0, Math.min(want, rear.speed - (rear.speedFloor ?? 0)));
  rear.speed -= take;
  front.speed += closing * frontShare + (want - take);
}

// Across the road. `sign` is +1 when b sits to a's right; `relative` is a's
// lateral speed minus b's, from the snapshot taken at the top of the tick.
function sideSwipe(a, b, sign, overlap, shareA, shareB, relative, first) {
  const closing = relative * sign;

  a.offset -= sign * overlap * shareA;
  b.offset += sign * overlap * shareB;

  // Standing pressure becomes a slide. Applied whether or not they're closing,
  // so a car pinned between the player and its neighbour keeps being squeezed
  // out rather than sitting inside them. Each side's push is scaled by the
  // OTHER body's shovePower (undefined defaults to 1, via impactCost's own
  // pattern) — a maxed RAM PLATE (PlayerBody, below) throws harder without
  // getting thrown any softer itself.
  const push = overlap * PUSH_GAIN;
  a.vLateral -= sign * push * shareA * (b.shovePower ?? 1);
  b.vLateral += sign * push * shareB * (a.shovePower ?? 1);

  // The impact itself counts ONCE. Unlike a rear-end — where the impulse lands
  // on `speed`, so a later pass sees the pair already parting — a sideways
  // impulse goes into vLateral, which the snapshot above doesn't track. Left
  // ungated, a pair still touching after four passes would be hit four times.
  // Chains still carry: the shove becomes measured motion on the next tick, and
  // hits the neighbour then — which a bigger shovePower makes more likely to
  // reach a second car instead of just clearing the first one's overlap.
  if (!first || closing <= 0) return;
  const impulse = closing * (1 + RESTITUTION);
  a.vLateral -= sign * impulse * shareA * (b.shovePower ?? 1);
  b.vLateral += sign * impulse * shareB * (a.shovePower ?? 1);

  applyDamage(a, b, closing, SIDE_DAMAGE);
}

// Hull `a` takes from hitting `b` at `closing`, with `scale` picking the axis
// (1 for a rear-end, SIDE_DAMAGE for a side-swipe). The x2 is so that an
// equal-mass pair — half the correction each — takes the full figure between
// them.
//
// A PURE FUNCTION, and exported, because the number is wanted in two places.
// The solver below uses it to apply damage that has already happened;
// behaviours.js uses it to PRICE a contact that has not happened yet, when a
// driver is deciding whether a lane with a car in it is a lane it will take
// (see driving.js's `contact`). Both must read the same formula or a car would
// be making its decisions against physics the game does not run.
//
// `mass` defaults to 1 for a body that has none: the world's real bodies all
// carry one, but the aim is that a fixture can be priced without inventing a
// weight for it.
//
// `floor` defaults to the shared DAMAGE_FLOOR but is `b`'s to set: it is `b`
// doing the hitting from `a`'s side of this call, so a lower floor on `b`
// (its optional `attackFloor` — a maxed RAM PLATE, see PlayerBody) means `a`
// starts taking damage at a gentler contact than the shared default asks for.
export function impactCost(a, b, closing, scale = 1, floor = DAMAGE_FLOOR) {
  if (closing <= floor) return 0;
  const invA = 1 / (a.mass ?? 1);
  const invB = 1 / (b.mass ?? 1);
  const shareA = invA / (invA + invB);
  return (closing - floor) * IMPACT_DAMAGE * scale * 2 * shareA;
}

function applyDamage(a, b, closing, scale) {
  a.damage(impactCost(a, b, closing, scale, b.attackFloor));
  b.damage(impactCost(b, a, closing, scale, a.attackFloor));
}

// The speed a body keeps after ramming something that never moves — a static
// obstacle, not another body in the solver above. Same physics as rearEnd's
// impulse (closing speed split by inverse mass, damped by RESTITUTION), with
// the blocker's own speed fixed at zero, so a trestle and a rig cost a car
// exactly what the same mass would cost it as a parked car: `blockerMass /
// (moverMass + blockerMass)` of the mover's own closing speed. A light hazard
// (low blockerMass) is barely felt; a heavy one costs most of it.
//
// Exported so obstacles.js prices a ram with the identical formula rather
// than inventing a second one — see impactCost's header for why that
// single-source-of-truth matters here too.
export function ramSpeed(speed, moverMass, blockerMass) {
  if (speed <= 0) return speed;
  const invMover = 1 / moverMass;
  const invBlocker = 1 / blockerMass;
  const share = invMover / (invMover + invBlocker);
  const impulse = speed * (1 + RESTITUTION);
  return Math.max(0, speed - impulse * share);
}

// The maxed RAM PLATE's bonus, on top of what its mass alone buys (see
// upgrades.js's `ram` entry) — defined here, not as catalogue data, because
// they are collision-solver tuning exactly like DAMAGE_FLOOR and PUSH_GAIN
// above, just gated on a flag instead of always-on.
//
// ATTACK_FLOOR trades DAMAGE_FLOOR's 40 for 20 on the player's OWN hits (see
// impactCost's `floor` param) — half the closing speed needed before contact
// starts to hurt, so ordinary driving contact starts to cost something, not
// just a full-speed charge lined up in advance.
const RAM_MAXED_ATTACK_FLOOR = 20;
// SHOVE_POWER multiplies the lateral velocity the player's OWN hits hand to
// whatever they land on (see sideSwipe). +60%, a starting figure pending a
// drivesim pass: big enough that a side-swipe into a car with a neighbour is
// meant to carry into that neighbour too, not just clear the first overlap.
const RAM_MAXED_SHOVE_POWER = 1.6;

// --- The player as a body ---------------------------------------------------
// The player lives in screen x and is pinned to the row where worldY ===
// distance; traffic lives in road-relative offsets. This adapter is the
// translation, kept as accessors so the solver's writes land straight on the
// player (its x IS the offset, re-based on the centre-line).
export class PlayerBody {
  constructor(mass, halfRoad) {
    this.baseMass = mass;
    this.halfRoad = halfRoad; // lateral limit, so a shove can't post the player
    this.player = null;       // through a barrier for a frame
    this.centerX = 0;
    this.worldY = 0;
  }

  // Re-point at the player for this tick. `centerX` is the road centre-line at
  // the player's row.
  sync(player, distance, centerX) {
    this.player = player;
    this.worldY = distance;
    this.centerX = centerX;
  }

  get w() { return this.player.w; }
  get h() { return this.player.h; }

  // READ OFF THE CAR, not stored here, because the shop's RAM PLATE tiers move
  // it mid-run (game/upgrades.js) and this adapter is REBUILT on every shop
  // visit — Traffic is thrown away and remade by main.js's respawnWorld(), so
  // a copy taken at construction would silently roll every purchase back the
  // moment the player undocked. `baseMass` is the fallback for the tick before
  // sync() has ever run, and for a fixture with no player at all.
  get mass() { return this.player ? this.player.mass : this.baseMass; }

  // Undefined (collisions.js's own defaults apply) until the RAM PLATE is
  // maxed — see the constants above and upgrades.js's `ram` entry for why
  // this rides on the tier flag rather than a mass threshold.
  get attackFloor() { return this.player?.ramMaxed ? RAM_MAXED_ATTACK_FLOOR : undefined; }
  get shovePower() { return this.player?.ramMaxed ? RAM_MAXED_SHOVE_POWER : undefined; }

  // Never false. A hull running out doesn't remove the player from this
  // solver at all — it ends the "playing" state one level up in main.js,
  // which stops calling traffic.update() (and so this solver) entirely for
  // the rest of the run. The one tick where health actually reaches zero has
  // already had its collisions resolved by the time anything checks for it.
  get alive() { return true; }

  get offset() { return this.player.x - this.centerX; }
  set offset(v) {
    const limit = this.halfRoad - this.player.w / 2;
    this.player.x = this.centerX + Math.max(-limit, Math.min(limit, v));
  }

  // Same re-basing for the previous tick. The centre-line moved a little between
  // ticks too, but by well under a pixel at any survivable speed, so using the
  // current one keeps this to the steering the player actually did.
  get prevOffset() { return this.player.prevX - this.centerX; }

  get speed() { return this.player.speed; }
  set speed(v) { this.player.speed = v; }

  // The band's own floor, boost and puncture included — see Player.speedFloor,
  // which owns that argument, and rearEnd for what leaning on it does.
  get speedFloor() { return this.player.speedFloor; }
  get vLateral() { return this.player.vLateral; }
  set vLateral(v) { this.player.vLateral = v; }

  damage(hp) { this.player.damage(hp); }
}
