// Bullets — everything that is in the air between a gun and a car.
//
// COORDINATE MODEL, same as traffic's: a bullet lives at (worldY, offset), and
// screen position is derived from those exactly as a car's is, which is what
// keeps a shot welded to the tarmac it was fired over. Cars are compared against
// with plain arithmetic because everything is in the same two numbers.
//
// THREE WAYS TO FLY, and the difference is entirely in what is held CONSTANT as
// the bullet runs up the road (see weapons.js for which weapon takes which):
//
//   FLIGHT_TRACKING  `offset` is constant. The bullet keeps its distance from
//                    the centre-line, so it follows the road round a bend and
//                    stays in the lane it was fired up. It cannot leave the
//                    road, so it never meets a barrier.
//   FLIGHT_STRAIGHT  `screenX` is constant, and `offset` is RECOMPUTED from it
//                    every tick as screenX - centerXAt(worldY). The bullet holds
//                    the line it was fired along and the road slides out from
//                    under it — which means that into a bend it crosses the
//                    lanes and eventually hits the barrier, where it dies.
//   FLIGHT_SEEKING   NOTHING is held. `offset` is steered, at a capped lateral
//                    rate, toward whatever the round has locked on to — so the
//                    round leaves its own lane and crosses to the target's.
//                    Like tracking it is road-relative and can never meet a
//                    barrier; unlike tracking it does not stay where it was
//                    aimed. See `seek()` below for what it will lock on to.
//
// Deriving offset for the straight case rather than tracking a screen position
// separately is what keeps ONE hit test and ONE render path for all three: by
// the time anything reads `offset`, it is correct for this tick either way.
//
// SPEED IS NOT NECESSARILY CONSTANT. A weapon may name an `accel` (weapons.js's
// ROCKET), in which case the round leaves the rail slowly and builds to its own
// `topSpeed` over the flight. Every consumer below reads `s.speed` per tick
// anyway, so this costs one line in update() and nothing else — but it is what
// makes a launch read as a launch rather than as a slower bullet.
//
// SPEED IS ABSOLUTE. A bullet stores the speed it actually travels at — the
// shooter's speed plus the weapon's muzzle speed — rather than a speed relative
// to anything. Two consequences that both matter: a shot fired at 600 units/sec
// keeps its 600 when the player brakes, so slowing down doesn't drag your own
// bullets back; and firing BACKWARD is then the same maths with the muzzle speed
// subtracted instead (`dir` in spawn), which is what lets a hostile car running
// in front of the player shoot at them at all.
//
// A REARWARD SHOT IS ORDINARILY A NEGATIVE SPEED, and nothing here needs a case
// for it: worldY simply decreases, the swept test takes min/max of the two ends
// so it is direction-agnostic, and retirement already checks both bounds. The
// one thing that does NOT follow automatically is whether such a shot can catch
// what it was aimed at — a car driving faster than its own muzzle speed fires
// rounds that still drift forwards. That is a question about the SHOT BEING
// WORTH TAKING rather than about flight, so it is answered where the trigger is
// pulled (game/armament.js), not here.
//
// SWEPT HITS. A bullet covers ~15 world units per tick and the shortest car is
// 54 long, so a naive point-in-box test would already be marginal, and any
// faster weapon (Phase 5) would shoot straight through a cycle. Every bullet is
// therefore tested along the SEGMENT it travelled this tick, and when that
// segment crosses several cars the NEAREST one is what stops it. Nothing here
// depends on the tick rate.
//
// ONE BULLET, ONE CAR — unless the weapon says otherwise. A hit is ordinarily
// consumed: the bullet dies where it struck. A weapon carrying `pierce`
// (weapons.js's TRACKER) instead punches through anything its round KILLS and
// carries on down the same segment, up to `pierce` extra bodies. Killing is the
// condition on purpose: a round that shrugged off a rig it barely scratched
// would make the heavy types stop reading as heavy.
//
// WHO CAN BE HIT is the CALLER'S choice — update() takes the list of targets.
// This file has no idea what a faction is, which is what lets enemy bullets
// (next step) reuse it by passing the player's body instead of the traffic.
//
// NO ALLOCATION. Bullets are spawned mid-frame, several per second, forever, so
// the pool is built once and reused; a spawn on a full pool overwrites the
// oldest, which is off-screen or nearly so by definition.

import { neonStroke } from "../engine/neon.js";
import { centerXAt, headingAt, ROAD_HALF_WIDTH } from "./road.js";
import { inBlastPlane } from "./collisions.js";
import { FLIGHT_TRACKING, FLIGHT_SEEKING } from "./weapons.js";

const MAX_SHOTS = 32;  // in flight at once. The cannon fires ~6/sec and a shot
                       // lives well under a second, so this is roomy
const MAX_SPARKS = 12; // impact flashes alive at once

// --- Seeking (FLIGHT_SEEKING, see the header) ---------------------------------
//
// How far up the road a seeking round will look for something to lock on to,
// and how far off its own line that something may be. The range is generous —
// a rocket fired at nothing in particular should still find the car that
// appears ahead of it.
//
// The CONE is the full width of the road, DERIVED rather than picked, so
// anything actually on the tarmac can be locked on to from anywhere else on
// it. What rations a lock is the weapon's own `turnRate` (weapons.js), not
// this: a rocket may lock on to a car three lanes over and still fail to reach
// it before both are past each other, and that is the interesting outcome. A
// tighter cone here would instead refuse the lock outright, which reads to the
// player as the rocket simply not working.
const SEEK_RANGE = 1100; // world units ahead of the round
const SEEK_CONE = ROAD_HALF_WIDTH * 2; // lateral units either side of its own offset

const SPARK_DURATION = 0.12; // seconds
const SPARK_SIZE = 9;        // px the impact flash reaches at its widest

// --- The "dart" render mode (weapons.js's ROCKET) -----------------------------
//
// Every weapon before the rocket draws as a TRACER: one line stretched between
// where the round is now and where it was `length` ago, which reads fine for
// something fired several times a second but is wrong for a rocket — several
// can be in the air at once (see weapons.js), and a tracer per rocket would
// mean a stretched line for each one rather than a small thing that flew past.
//
// So a dart is a fixed small BODY drawn at the round's own position every
// frame instead: a pointed nose, tapered shoulders, and flared tail fins with
// a notch between them, plus a couple of short flicker ticks for the burner.
// It costs the same per-shot as a tracer line (a handful of moveTo/lineTo
// pairs) and batches the same way — see render() below, three neonStroke
// passes total no matter how many rockets are in flight.
//
// Points are in a fixed LOCAL unit space (x: -4..4, y: -9..9, nose at -9,
// pointing "up" exactly as a straight tracer does) and get scaled by the
// shot's own width/length before being rotated into place.
const DART_BODY = [
  [0, -9], [1.3, -2.5], [4, 8], [1, 5], [0, 7], [-1, 5], [-4, 8], [-1.3, -2.5],
];
// Each entry is [from, to] in the same local space, starting just behind the
// tail notch. `to` is the tick's full length; render() shortens it toward
// `from` for the flicker.
const DART_BURNER = [
  [[-2.2, 8.5], [-3.6, 14]],
  [[2.2, 8.5], [3.6, 14]],
  [[0, 7], [0, 13.5]],
];

// Scale a local dart-space point by the shot's own size and rotate it by `a`
// (the same heading angle a tracking tracer uses — 0 for a straight shot).
function dartPoint([ux, uy], cx, cy, a, sxScale, syScale) {
  const x = ux * sxScale;
  const y = uy * syScale;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [cx + x * cos - y * sin, cy + x * sin + y * cos];
}

// Draw one dart in isolation — the asset gallery's entry point (tools/gallery/gallery.html);
// the live game never calls this, since Projectiles.render() batches every
// rocket on screen into three shared passes instead of one call per rocket.
// `angle` is in radians, 0 = nose up. `flicker` (0..1) shortens the burner
// ticks toward their base, same as render()'s per-shot flicker below.
export function drawDart(ctx, cx, cy, angle, opts = {}) {
  const { color = "#ffe08a", glow = "#ff8a3b", length = 16, width = 6, flicker = 1 } = opts;
  const sxScale = width / 8;
  const syScale = length / 18;

  neonStroke(ctx, (c) => {
    for (let i = 0; i < DART_BODY.length; i++) {
      const [x1, y1] = dartPoint(DART_BODY[i], cx, cy, angle, sxScale, syScale);
      const [x2, y2] = dartPoint(DART_BODY[(i + 1) % DART_BODY.length], cx, cy, angle, sxScale, syScale);
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
    }
  }, color, 1.6, 4.5, 0.15, 1);

  neonStroke(ctx, (c) => {
    for (const [from, to] of DART_BURNER) {
      const [x1, y1] = dartPoint(from, cx, cy, angle, sxScale, syScale);
      const tip = [from[0] + (to[0] - from[0]) * flicker, from[1] + (to[1] - from[1]) * flicker];
      const [x2, y2] = dartPoint(tip, cx, cy, angle, sxScale, syScale);
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
    }
  }, glow, 1.3, 4, 0.14, 1);

  const [nx, ny] = dartPoint([0, -9], cx, cy, angle, sxScale, syScale);
  neonStroke(ctx, (c) => {
    const r = Math.max(1, sxScale * 1.1);
    c.moveTo(nx + r, ny);
    c.arc(nx, ny, r, 0, Math.PI * 2);
  }, "#ffffff", 1.2, 4, 0.15, 1);
}

export class Projectiles {
  // `explosions` is the shared Explosions pool (effects.js), optional so this
  // class still works stand-alone (see test/hazards.test.js). A weapon whose
  // `impact` is "fireball" routes through it instead of the ordinary spark —
  // see `detonate()` below.
  constructor(explosions = null) {
    this.explosions = explosions;
    this.shots = Array.from({ length: MAX_SHOTS }, () => ({
      alive: false,
      worldY: 0,
      prevWorldY: 0, // where it was last tick — the near end of the swept test
      offset: 0,     // lateral px from the centre-line. AUTHORITATIVE for hits
                     // and drawing; derived per tick when the flight is straight
      tracking: false, // road-relative flight (TRACKING or SEEKING) — hold
                       // `offset` rather than `screenX`
      seeking: false,  // FLIGHT_SEEKING — steer `offset` toward `target`
      target: null,    // what a seeking round has locked on to, or null
      turnRate: 0,     // lateral units/sec a seeking round may steer
      screenX: 0,    // the fired line, for a straight shot. Unused when tracking
      speed: 0,      // absolute, world units/sec — CHANGES over the flight when
                     // `accel` is set, so nothing may cache it
      dir: 1,        // +1 fired up the road, -1 back down it. Only `accel` reads
                     // it; the speed itself already carries its own sign
      accel: 0,      // world units/sec², along `dir`. 0 = a constant-speed round
      speedCap: 0,   // absolute speed `accel` builds to. Unused when accel is 0
      pierce: 0,     // extra bodies this round may punch through after a KILL
      damage: 0,
      length: 14,
      width: 4,
      color: "#ffffff",
      glow: "#ffffff",
      render: "tracer", // "tracer" (batched line) | "dart" (weapons.js's ROCKET)
      impact: "spark",  // "spark" | "fireball" — see detonate() below
      blastRadius: 0,   // splash — see detonate() below. 0 = direct hit only
      blastDamage: 0,
      lead: 0,          // CEILING on lateral units/sec for a locked round, and
                        // the whole of the lead steer below. 0 = steer at the
                        // flat `turnRate` instead, which is what a rocket does
      locked: false,    // this round is chasing a car the PLAYER designated,
                        // not one it found for itself. It steers exactly as a
                        // seeker does and differs in one way only: it never
                        // re-acquires — see update()
    }));
    this.sparks = Array.from({ length: MAX_SPARKS }, () => ({
      alive: false,
      elapsed: 0,
      worldY: 0,
      offset: 0,
      color: "#ffffff",
    }));
    this.next = 0;      // round-robin cursor for a full pool
    this.nextSpark = 0;
    this.batchColors = []; // scratch for render's per-colour batching, reused
  }

  // Fire one round. `type` is a weapon-catalogue entry (weapons.js); `worldY`
  // and `offset` are the muzzle, `shooterSpeed` is what the bullet inherits, and
  // `W` is the canvas width the centre-line is measured against. `dir` is +1 up
  // the road and -1 back down it — see SPEED IS ABSOLUTE above. It defaults to
  // forward, so every existing caller reads unchanged.
  //
  // Both flight modes are spawned from the same (worldY, offset) muzzle — the
  // straight shot simply converts it, ONCE, into the screen line it will hold.
  // `opts` carries the things a round's own catalogue entry cannot decide,
  // because they depend on what the player has BOUGHT and on what is already
  // designated — the caller's knowledge, not the weapon's:
  //
  //   target   a car the player designated at the trigger, for this round to
  //            chase (game/targeting.js)
  //   lead     the CEILING on how fast it may cross the road to do so
  //
  // It defaults to null, so every existing caller — and every hostile round,
  // forever — reads exactly as it did before the parameter existed. The object
  // is READ AND COPIED here and never held, so callers are free to hand the
  // same scratch object over on every shot (main.js does).
  spawn(worldY, offset, shooterSpeed, type, W, dir = 1, opts = null) {
    let s = this.shots.find((b) => !b.alive);
    if (!s) {
      s = this.shots[this.next];
      this.next = (this.next + 1) % this.shots.length;
    }
    s.alive = true;
    s.worldY = worldY;
    s.prevWorldY = worldY;
    s.offset = offset;
    // A SEEKING round is road-relative exactly as a tracking one is — it holds
    // an offset rather than a screen line, and steers that offset. Everything
    // downstream (the hit test, the barrier check, the drawn heading) reads
    // `tracking`, so seeking gets all of it for free and only adds the steer.
    s.tracking = type.flight === FLIGHT_TRACKING || type.flight === FLIGHT_SEEKING;
    s.seeking = type.flight === FLIGHT_SEEKING;
    s.target = null; // acquired on the first update tick, where the targets are
    s.turnRate = type.turnRate ?? 0;
    s.screenX = centerXAt(worldY, W) + offset;
    s.speed = shooterSpeed + dir * type.muzzleSpeed;
    s.dir = dir;
    s.accel = type.accel ?? 0;
    s.speedCap = shooterSpeed + dir * (type.topSpeed ?? type.muzzleSpeed);
    s.pierce = type.pierce ?? 0;
    s.damage = type.damage;
    s.length = type.length;
    s.width = type.width;
    s.color = type.color;
    s.glow = type.glow;
    s.render = type.render ?? "tracer";
    s.impact = type.impact ?? "spark";
    s.blastRadius = type.blastRadius ?? 0;
    s.blastDamage = type.blastDamage ?? 0;

    // --- What the shop bought (see `opts` above) ---------------------------
    // A ROUND HANDED A TARGET CHASES IT. This is the whole of AUTOLOCK at the
    // muzzle: the round borrows the seeking STEER (it is road-relative already,
    // so `tracking` is untouched) and nothing else about being a rocket. Its
    // own much slower turnRate overrides the type's, and `locked` is what tells
    // update() never to go looking for a replacement.
    s.lead = 0;
    s.locked = !!opts?.target;
    if (s.locked) {
      s.target = opts.target;
      s.seeking = true;
      // The lead REPLACES the flight mode's own rate rather than adding to it —
      // the two are different quantities and a round steers by exactly one of
      // them (see the steer in update()).
      s.turnRate = 0;
      s.lead = opts.lead ?? 0;
    }
    return s;
  }

  // Move every bullet, then resolve what it hit.
  //
  // `targets` is any array of bodies exposing { worldY, offset, w, h, alive,
  // damage(hp) } — traffic cars satisfy it directly, and so does the player's
  // collision body, which is what enemy fire will pass. `world` supplies the
  // bounds a bullet is retired at.
  update(dt, targets, { distance, playerY, W, H }) {
    const ahead = distance + playerY + H;       // a long way past the top edge
    const behind = distance - (H - playerY) - H;

    for (const s of this.shots) {
      if (!s.alive) continue;

      // The burn, BEFORE the step it pays for — a round that names an `accel`
      // builds toward its own top speed along the direction it was fired. The
      // cap is signed with `dir`, so a rearward round accelerates DOWN the
      // number line to its cap rather than up to it.
      if (s.accel) {
        s.speed += s.dir * s.accel * dt;
        s.speed = s.dir > 0 ? Math.min(s.speed, s.speedCap) : Math.max(s.speed, s.speedCap);
      }

      s.prevWorldY = s.worldY;
      s.worldY += s.speed * dt;

      // The steer, AFTER the step — so a seeking round corrects against where
      // it now is rather than where it was, and the hit test below sees the
      // offset it actually flew to this tick.
      if (s.seeking) {
        if (!s.target || !s.target.alive || (s.target.worldY - s.worldY) * s.dir <= 0) {
          // A LOCKED ROUND DOES NOT LOOK FOR A NEW TARGET — it flies out the
          // rest of its life on the tracking line it is on now.
          //
          // That is the difference between a lock and a seeker, and it is the
          // rule that stops one trigger pull from clearing a lane by itself: a
          // burst whose designated car dies to round three wastes rounds four
          // through eight unless the player re-designates. A burst that
          // re-locked would not be eight rounds following a car, it would be
          // eight rounds that cannot be spent wrongly.
          if (s.locked) {
            s.seeking = false;
            s.target = null;
          } else {
            s.target = this.seek(s, targets);
          }
        }
        if (s.target) {
          const want = s.target.offset - s.offset;
          // TWO STEERS, and which one a round uses is set at the muzzle.
          //
          // A SEEKER turns at a FLAT rate: it acquired this car in flight and
          // is chasing it, so how hard it may turn is a property of the round
          // and of nothing else. That is the rocket.
          //
          // A LOCKED ROUND FLIES A LEAD: it was aimed at a car the player had
          // already designated, so it takes the lateral speed that actually
          // ARRIVES — the gap left to cross divided by the time left to cross
          // it — capped at what the weapon allows. This is the difference
          // between the two, and the reason a flat rate was wrong here: time to
          // impact shrinks as the round closes, so a flat rate is weakest at
          // point-blank range, which is the shot that should never miss. See
          // weapons.js's `lockLead` for the measured table.
          //
          // ETA falls out of the two speeds along the road. A round that is not
          // gaining on its target has no arrival to lead (`closing <= 0`), and
          // one arriving THIS TICK has no time left to spend: both mean "take
          // the cap", which the Infinity does without a second branch.
          let step = s.turnRate * dt;
          if (s.lead > 0) {
            const closing = s.dir * (s.speed - (s.target.speed ?? 0));
            const eta = closing > 0 ? ((s.target.worldY - s.worldY) * s.dir) / closing : 0;
            step = Math.min(s.lead, eta > 0 ? Math.abs(want) / eta : Infinity) * dt;
          }
          s.offset += Math.max(-step, Math.min(step, want));
        }
      }

      // A straight shot holds its screen line, so its offset has to be re-derived
      // against the road that has just curved under it. Done BEFORE the hit test,
      // so what the bullet is tested against is where it actually is now.
      if (!s.tracking) {
        s.offset = s.screenX - centerXAt(s.worldY, W);
        // ...and a line that has run off the tarmac has run into the barrier.
        // This is the whole cost of a straight weapon through a bend, and it is
        // why the tracker is worth carrying.
        if (Math.abs(s.offset) > ROAD_HALF_WIDTH - s.width / 2) {
          this.detonate(s.worldY, Math.sign(s.offset) * (ROAD_HALF_WIDTH - s.width / 2), s, targets, null);
          s.alive = false;
          continue;
        }
      }

      // A PIERCING round resolves every body on its segment in turn, not just
      // the first — it only stops at one it failed to kill. An ordinary round
      // has pierce 0 and leaves this loop on its first hit, exactly as before
      // the field existed.
      // `s.pierce` is SPENT DOWN, not read against a per-tick counter: the
      // budget is for the round's whole LIFE, not for one tick of it. A tick
      // is an implementation detail of the simulation and the two cars a round
      // punches through may well fall either side of one, so a per-tick
      // allowance would quietly make pierce unbounded.
      while (s.alive) {
        const hit = this.firstHit(s, targets);
        if (!hit) break;
        hit.damage(s.damage);
        if (s.pierce > 0 && !hit.alive) {
          // Through it and onward. The flash sits on the body it passed
          // through rather than at the round's own position, so a burst that
          // punches a line of cars marks each one.
          s.pierce -= 1;
          this.spark(hit.worldY, s.offset, s.glow);
          continue;
        }
        // The flash goes where the BULLET stopped, not at the car's centre, so
        // a long rig shows hits along its flank rather than one spot amidships.
        // `hit` is passed through so a splash weapon (below) doesn't double-hit
        // the thing it struck directly — that already took the full s.damage.
        this.detonate(s.worldY, s.offset, s, targets, hit);
        s.alive = false;
      }
      if (!s.alive) continue;

      if (s.worldY > ahead || s.worldY < behind) s.alive = false;
    }

    for (const p of this.sparks) {
      if (!p.alive) continue;
      p.elapsed += dt;
      if (p.elapsed >= SPARK_DURATION) p.alive = false;
    }
  }

  // What a SEEKING round (see the header) will lock on to: the nearest body
  // ahead of it, inside SEEK_RANGE and SEEK_CONE, that is worth chasing.
  //
  // ONLY CARS, never road furniture. `seekable` is set by traffic.js's Car and
  // by nothing else, so a rocket cannot be talked into turning across two lanes
  // to chase a trestle — which would be both useless and, since the player
  // aimed at a car, a betrayal of the shot they took. The flag is opt-IN rather
  // than a list of exclusions here, so anything added to the target list later
  // (drones, the helicopter) has to say for itself whether it can be locked on.
  // ONE THING OUTRANKS DISTANCE, and it exists so that a rack of rockets
  // (weapons.js's TWIN RACK) reads as several rounds hunting rather than one
  // round fired twice: A CAR ANOTHER LIVE SEEKER HAS ALREADY CLAIMED IS
  // AVOIDED. Two rockets launched in the same tick would otherwise pick the
  // same nearest car every time and the second warhead would land on a wreck.
  //
  // `rank` is compared before `ahead`, so the nearest acceptable car still
  // wins inside a rank. And it is a PREFERENCE, not a rule: an already-claimed
  // car is still returned when it is all there is, so a lone target never
  // leaves a rocket flying blind up an empty lane.
  seek(s, targets) {
    let best = null;
    let bestRank = Infinity;
    let bestDist = Infinity;
    for (const t of targets) {
      if (!t.alive || !t.seekable) continue;
      const ahead = (t.worldY - s.worldY) * s.dir;
      if (ahead <= 0 || ahead > SEEK_RANGE) continue;
      if (Math.abs(t.offset - s.offset) > SEEK_CONE) continue;
      const rank = this.claimedBy(t, s) ? 1 : 0;
      if (rank > bestRank) continue;
      if (rank < bestRank || ahead < bestDist) {
        bestRank = rank;
        bestDist = ahead;
        best = t;
      }
    }
    return best;
  }

  // Is some OTHER live seeking round already chasing `t`? Linear over a pool of
  // 32, run only when a round has to acquire (which is once per lock, not once
  // per tick), so it stays far cheaper than the per-target bookkeeping the
  // alternative would need — and it self-heals: a dead rocket's claim vanishes
  // with it, because `alive` is the only record there is.
  //
  // A ROUND THE PLAYER AIMED COUNTS AS A CLAIM TOO (`locked` rounds are
  // `seeking`), which is the behaviour worth having: a rocket should route
  // around the car a burst of tracer fire is already committed to rather than
  // pile onto it.
  claimedBy(t, self) {
    for (const o of this.shots) {
      if (o !== self && o.alive && o.seeking && o.target === t) return true;
    }
    return false;
  }

  // The nearest target the bullet's path crossed this tick, or null. "Nearest"
  // is measured from where the bullet CAME FROM, so a shot that would reach two
  // cars in one tick stops at the first one.
  //
  // SAFE TO CALL REPEATEDLY for the same shot in the same tick, which is what a
  // piercing round does (see update): a round only pierces something it KILLED,
  // and a dead body fails the `alive` test on the next call — so the "already
  // punched through" list that would otherwise be needed here doesn't exist.
  firstHit(s, targets) {
    let best = null;
    let bestEntry = Infinity;
    const from = Math.min(s.prevWorldY, s.worldY);
    const to = Math.max(s.prevWorldY, s.worldY);

    for (const t of targets) {
      if (!t.alive) continue;
      // ALTITUDE, and it is the one thing in this file that is not decided by
      // the two road coordinates. An `airborne` body (cartypes.js) is flying
      // well above the tarmac, and every round here except a seeking one flies
      // ALONG the road — a straight round buries itself in a barrier at road
      // level (see the barrier check in update), and a tracking round holds the
      // lane it was fired up. Neither leaves the road plane, so neither can
      // touch something that is not in it. A seeking round climbs to what it
      // has locked on to, which is why the rocket is the answer to the air and
      // the only weapon that is — exactly the case ROCKET's own comment in
      // weapons.js said these types would opt into for themselves.
      //
      // NOT A LATERAL RULE. It would be tempting to let the gunship be shot at
      // whenever it happens to be over the tarmac, and that is wrong for the
      // reason the artwork already states: a round low enough to hit a barrier
      // cannot hit something in the air above it, wherever it is standing.
      if (t.airborne && !s.seeking) continue;
      if (Math.abs(t.offset - s.offset) >= (t.w + s.width) / 2) continue;
      // The car's box, inflated by the bullet's own length so a shot that has
      // only just touched it counts.
      const near = t.worldY - (t.h + s.length) / 2;
      const far = t.worldY + (t.h + s.length) / 2;
      if (far < from || near > to) continue;
      if (near < bestEntry) {
        bestEntry = near;
        best = t;
      }
    }
    return best;
  }

  // Everything that happens where a shot stops: the visual effect, and — for a
  // weapon whose blast reaches past what it directly struck — the splash.
  //
  // VISUAL. Every weapon before the rocket gets the small spark cross; a
  // weapon can instead name a bigger effect through the shared Explosions pool
  // via its `impact` field (weapons.js) — the rocket names "fireball". Falls
  // back to a spark if no pool was handed to the constructor, so Projectiles
  // keeps working stand-alone.
  //
  // SPLASH. `s.blastRadius`/`s.blastDamage` (weapons.js) is the EXACT falloff
  // formula Traffic.blast() and Obstacles.blast() already use for a dying car
  // or a mine — peak at the target's box edge, nothing at the radius — so a
  // rocket's splash is that same curve at a third setting, not a fourth
  // mechanic to keep in sync. The one difference: the source here is a POINT
  // (where the round stopped), not another box, so only the TARGET's own
  // half-extent is subtracted, not a sum of two.
  //
  // `exclude` is whatever the round struck directly (or null, off the
  // barrier) — it already took the full `s.damage` in the caller, and this
  // sweep must not hit it a second time.
  detonate(worldY, offset, s, targets, exclude) {
    if (s.impact === "fireball" && this.explosions) {
      this.explosions.spawnFireball(worldY, offset);
    } else {
      this.spark(worldY, offset, s.glow);
    }

    if (!s.blastRadius || !s.blastDamage) return;
    for (const t of targets) {
      if (t === exclude || !t.alive) continue;
      // Nothing at road level reaches the air — see collisions.js's inBlastPlane.
      // The round that struck the gunship directly is already `exclude`, so this
      // costs a rocket nothing on the target it actually hit.
      if (!inBlastPlane(t)) continue;
      const dx = Math.max(0, Math.abs(t.offset - offset) - t.w / 2);
      const dy = Math.max(0, Math.abs(t.worldY - worldY) - t.h / 2);
      const dist = Math.hypot(dx, dy);
      if (dist >= s.blastRadius) continue;
      t.damage(s.blastDamage * (1 - dist / s.blastRadius));
    }
  }

  spark(worldY, offset, color) {
    let p = this.sparks.find((q) => !q.alive);
    if (!p) {
      p = this.sparks[this.nextSpark];
      this.nextSpark = (this.nextSpark + 1) % this.sparks.length;
    }
    p.alive = true;
    p.elapsed = 0;
    p.worldY = worldY;
    p.offset = offset;
    p.color = color;
  }

  // No interpolation, for the same reason traffic's y isn't interpolated: screen
  // y comes from the raw worldY against the raw distance, so a bullet tracks the
  // road rather than sliding against it.
  render(ctx, distance, playerY, W, H) {
    // Every bullet is one straight line, so a volley goes into ONE batched path
    // and pays for neonStroke's three passes once (see neon.js). A path can only
    // carry one colour, so the batch is PER WEAPON COLOUR — swapping weapons
    // leaves rounds of both kinds in the air, and that is two strokes, not one
    // stroke per bullet.
    const colors = this.batchColors;
    colors.length = 0;
    for (const s of this.shots) {
      if (s.alive && s.render !== "dart" && !colors.includes(s.color)) colors.push(s.color);
    }

    for (const color of colors) {
      const sample = this.shots.find((s) => s.alive && s.render !== "dart" && s.color === color);
      neonStroke(
        ctx,
        (c) => {
          for (const s of this.shots) {
            if (!s.alive || s.render === "dart" || s.color !== color) continue;
            const sy = playerY - (s.worldY - distance);
            if (sy < -s.length || sy > H + s.length) continue;
            const sx = centerXAt(s.worldY, W) + s.offset;

            // A tracer is drawn along the line it is actually travelling, which
            // is where the two flight modes visibly part company now that the
            // world leans into its bends. A TRACKING round holds its distance
            // from the centre-line, so it curves with the road and is drawn on
            // the road's heading. A STRAIGHT round holds the screen line it was
            // fired along and stays vertical — so into a bend you can watch it
            // drift off the tarmac towards the barrier it is going to die on,
            // which is exactly the trade the player is making by carrying it.
            if (s.tracking) {
              const a = headingAt(s.worldY);
              const hx = (Math.sin(a) * s.length) / 2;
              const hy = (-Math.cos(a) * s.length) / 2;
              c.moveTo(sx - hx, sy - hy);
              c.lineTo(sx + hx, sy + hy);
            } else {
              c.moveTo(sx, sy + s.length / 2);
              c.lineTo(sx, sy - s.length / 2);
            }
          }
        },
        color,
        sample.width,
        3.5,
        0.16,
        1,
      );
    }

    // Rockets (weapons.js's ROCKET, DART_BODY above): small discrete bodies,
    // not tracer lines, so they get their own batching — one pass per body
    // colour, one per burner colour, and one shared pass for every nose
    // highlight. Three neonStroke calls total, same as the tracer loop above,
    // no matter how many rockets are in flight at once.
    const dartColors = [];
    const dartGlows = [];
    for (const s of this.shots) {
      if (!s.alive || s.render !== "dart") continue;
      if (!dartColors.includes(s.color)) dartColors.push(s.color);
      if (!dartGlows.includes(s.glow)) dartGlows.push(s.glow);
    }

    // All three passes walk the same rockets, cull them against the same screen
    // band and project them with the same four values — only the per-rocket
    // FILTER and the geometry they emit differ. That preamble was written out
    // three times before this helper; keeping it in one place is what stops the
    // culling margin in one pass from drifting away from the other two, which
    // would show as rockets whose bodies and burners pop in at different rows.
    //
    // `emit` receives the shot plus its projected frame, and issues moveTo/
    // lineTo into the caller's already-open path (see neonStroke).
    const eachDart = (filter, emit) => (c) => {
      for (const s of this.shots) {
        if (!s.alive || s.render !== "dart" || !filter(s)) continue;
        const sy = playerY - (s.worldY - distance);
        if (sy < -s.length * 2 || sy > H + s.length * 2) continue;
        const sx = centerXAt(s.worldY, W) + s.offset;
        const a = s.tracking ? headingAt(s.worldY) : 0;
        emit(c, s, sx, sy, a, s.width / 8, s.length / 18);
      }
    };

    for (const color of dartColors) {
      neonStroke(
        ctx,
        eachDart(
          (s) => s.color === color,
          (c, s, sx, sy, a, sxScale, syScale) => {
            for (let i = 0; i < DART_BODY.length; i++) {
              const [x1, y1] = dartPoint(DART_BODY[i], sx, sy, a, sxScale, syScale);
              const [x2, y2] = dartPoint(DART_BODY[(i + 1) % DART_BODY.length], sx, sy, a, sxScale, syScale);
              c.moveTo(x1, y1);
              c.lineTo(x2, y2);
            }
          },
        ),
        color,
        1.6,
        4.5,
        0.15,
        1,
      );
    }

    for (const glow of dartGlows) {
      neonStroke(
        ctx,
        eachDart(
          (s) => s.glow === glow,
          (c, s, sx, sy, a, sxScale, syScale) => {
            // A cheap flicker with no clock of its own: driven by worldY, which
            // changes every tick as the rocket flies, so the burner crawls
            // instead of sitting as a static glyph.
            const flick = 0.75 + 0.25 * Math.sin(s.worldY * 0.35);
            for (const [from, to] of DART_BURNER) {
              const [x1, y1] = dartPoint(from, sx, sy, a, sxScale, syScale);
              const tip = [from[0] + (to[0] - from[0]) * flick, from[1] + (to[1] - from[1]) * flick];
              const [x2, y2] = dartPoint(tip, sx, sy, a, sxScale, syScale);
              c.moveTo(x1, y1);
              c.lineTo(x2, y2);
            }
          },
        ),
        glow,
        1.3,
        4,
        0.14,
        1,
      );
    }

    if (dartColors.length) {
      neonStroke(
        ctx,
        eachDart(
          () => true,
          (c, s, sx, sy, a, sxScale, syScale) => {
            const [nx, ny] = dartPoint([0, -9], sx, sy, a, sxScale, syScale);
            const r = Math.max(1, sxScale * 1.1);
            c.moveTo(nx + r, ny);
            c.arc(nx, ny, r, 0, Math.PI * 2);
          },
        ),
        "#ffffff",
        1.2,
        4,
        0.15,
        1,
      );
    }

    // Impacts: a small cross that opens and fades. Each is its own stroke, since
    // they differ in alpha — but there are at most MAX_SPARKS of them and they
    // last an eighth of a second.
    for (const p of this.sparks) {
      if (!p.alive) continue;
      const t = p.elapsed / SPARK_DURATION;
      const sy = playerY - (p.worldY - distance);
      if (sy < -SPARK_SIZE || sy > H + SPARK_SIZE) continue;
      const sx = centerXAt(p.worldY, W) + p.offset;
      const r = SPARK_SIZE * (0.4 + t * 0.6);
      neonStroke(
        ctx,
        (c) => {
          c.moveTo(sx - r, sy);
          c.lineTo(sx + r, sy);
          c.moveTo(sx, sy - r);
          c.lineTo(sx, sy + r);
          c.moveTo(sx - r * 0.6, sy - r * 0.6);
          c.lineTo(sx + r * 0.6, sy + r * 0.6);
          c.moveTo(sx + r * 0.6, sy - r * 0.6);
          c.lineTo(sx - r * 0.6, sy + r * 0.6);
        },
        p.color,
        2,
        4,
        0.15,
        1 - t,
      );
    }
  }
}
