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
const SIDE_DAMAGE = 0.35; // side-swipes hurt this much of a head-on for the same speed

// Sweeps per tick. Four is enough for the chains a 4-lane road can produce
// (7 cars + the player), and the loop exits early once a sweep finds nothing.
const PASSES = 4;

// Lateral speed per body, measured once at the top of the tick. Reused between
// ticks so the solver allocates nothing. See resolveCollisions.
const lateralV = [];

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

  if (overlapY < overlapX) {
    rearEnd(a, b, dy >= 0 ? 1 : -1, overlapY, shareA, shareB);
  } else {
    sideSwipe(a, b, dx >= 0 ? 1 : -1, overlapX, shareA, shareB, latA - latB, first);
  }
  return true;
}

// Along the road. `sign` is +1 when b is the car in front.
function rearEnd(a, b, sign, overlap, shareA, shareB) {
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

  const impulse = closing * (1 + RESTITUTION);
  rear.speed = Math.max(0, rear.speed - impulse * rearShare);
  front.speed += impulse * frontShare;

  applyDamage(a, b, closing, shareA, shareB, 1);
}

// Across the road. `sign` is +1 when b sits to a's right; `relative` is a's
// lateral speed minus b's, from the snapshot taken at the top of the tick.
function sideSwipe(a, b, sign, overlap, shareA, shareB, relative, first) {
  const closing = relative * sign;

  a.offset -= sign * overlap * shareA;
  b.offset += sign * overlap * shareB;

  // Standing pressure becomes a slide. Applied whether or not they're closing,
  // so a car pinned between the player and its neighbour keeps being squeezed
  // out rather than sitting inside them.
  const push = overlap * PUSH_GAIN;
  a.vLateral -= sign * push * shareA;
  b.vLateral += sign * push * shareB;

  // The impact itself counts ONCE. Unlike a rear-end — where the impulse lands
  // on `speed`, so a later pass sees the pair already parting — a sideways
  // impulse goes into vLateral, which the snapshot above doesn't track. Left
  // ungated, a pair still touching after four passes would be hit four times.
  // Chains still carry: the shove becomes measured motion on the next tick, and
  // hits the neighbour then.
  if (!first || closing <= 0) return;
  const impulse = closing * (1 + RESTITUTION);
  a.vLateral -= sign * impulse * shareA;
  b.vLateral += sign * impulse * shareB;

  applyDamage(a, b, closing, shareA, shareB, SIDE_DAMAGE);
}

function applyDamage(a, b, closing, shareA, shareB, scale) {
  if (closing <= DAMAGE_FLOOR) return;
  // x2 so that an equal-mass pair (share 0.5 each) takes the full figure.
  const hull = (closing - DAMAGE_FLOOR) * IMPACT_DAMAGE * scale * 2;
  a.damage(hull * shareA);
  b.damage(hull * shareB);
}

// --- The player as a body ---------------------------------------------------
// The player lives in screen x and is pinned to the row where worldY ===
// distance; traffic lives in road-relative offsets. This adapter is the
// translation, kept as accessors so the solver's writes land straight on the
// player (its x IS the offset, re-based on the centre-line).
export class PlayerBody {
  constructor(mass, halfRoad) {
    this.mass = mass;
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

  // Never false: running out of hull is Phase 6's problem, and a removed player
  // would simply stop colliding.
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
  get vLateral() { return this.player.vLateral; }
  set vLateral(v) { this.player.vLateral = v; }

  damage(hp) { this.player.damage(hp); }
}
