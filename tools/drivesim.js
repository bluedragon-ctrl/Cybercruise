// Driving-profile measurement — a headless road, run for a few simulated
// minutes, reporting what each profile actually did.
//
// WHY THIS EXISTS. "Does the roadster feel different from the sedan" is not a
// question a canvas can answer honestly: the two are on screen for a few seconds
// each, at different speeds, in different traffic, and the eye will find a
// difference whether or not the code produces one. The profile table
// (game/driving.js) is a set of claims — this driver is impatient, that one is
// disciplined, this one will take a bump — and each claim is a number that can
// be counted.
//
// So this runs the REAL modules: the real Traffic, the real Obstacles, the real
// behaviours, on a road with no renderer attached. Nothing here is a model of
// the game; it is the game with the drawing removed.
//
// Run with:  npm run sim        (or: node tools/drivesim.js [seconds] [runs])
//
// READING THE OUTPUT. Every row is one car TYPE, grouped under the profile it
// drives, and every figure is per car-minute so that types which live on screen
// longer don't dominate. The columns:
//
//   lane dev   mean px between the car and the nearest lane centre. The direct
//              readout of `laneDiscipline`: a commuter should sit near zero, a
//              hustler visibly off it.
//   pass/min   overtakes COMMITTED per car-minute — `patience` and
//              `passSpeedMargin` together.
//   done%      how many of those finished rather than timing out. A low figure
//              means the profile is committing to passes it cannot make, which
//              is what `passTimeout` and `passEffort` are for.
//   slow%      share of time asking for less than half its cruising speed —
//              time spent stuck behind something.
//   stop%      share of time asking for ZERO. This is brake-to-stop in front of
//              a hazard it will not go round (behaviours.js hazardStop), and it
//              is the figure to watch: a careful driver should register some,
//              and a road full of parked sedans means the tolerance rules are
//              too strict.
//   bump/min   fresh contacts with another car per car-minute — `contact`.
//   hazard     hazards struck per car-minute — `nerve`.

import { Traffic } from "../src/game/traffic.js";
import { Obstacles } from "../src/game/obstacles.js";
import { Explosions } from "../src/game/effects.js";
import { Player } from "../src/game/player.js";
import { CAR_TYPES } from "../src/game/cartypes.js";
import { DRIVING_PROFILES, drivingFor } from "../src/game/driving.js";
import { laneAt, laneOffset, centerXAt } from "../src/game/road.js";

// HOW MUCH ROAD YOU ACTUALLY NEED, which is a great deal more than the defaults.
//
// Every rate below is per CAR-MINUTE, and the rarer types earn car-minutes
// slowly: at weight 0.4 the hypercar collects about 50 of them in 60 runs of
// 300s, and the rig about 100. Batches of that size still disagree with each
// other by roughly 40% on `bump/min` and `hazard` for those types — measured,
// by running the same unchanged code twice.
//
// So the defaults are for a quick look at the COMMON types and nothing else. A
// tuning decision on a rig, a hypercar or any of the rarer hostiles needs
//
//     node tools/drivesim.js 300 60
//
// run once per side of the comparison, and even then treat a difference under
// about a third as no difference at all. A 20-run batch talked this project into
// exactly the wrong `contact` setting for the rig once already — see driving.js's
// `juggernaut`.
const SECONDS = Number(process.argv[2] ?? 180);
const RUNS = Number(process.argv[3] ?? 5);
const DT = 1 / 60;
const W = 600;
const H = 800;

// The player is driven at a FIXED speed rather than through the input layer:
// there is no keyboard here, and a player parked at the minimum would sit in the
// slowest corner of the speed band and never provoke an overtake. Mid-band is
// the condition most of the road is tuned against.
const PLAYER_SPEED = 380;

// Per-type running totals. Keyed by type id; the profile grouping is applied at
// print time, since a profile's numbers are just its types' added together.
function blankTally() {
  const t = {};
  for (const type of CAR_TYPES) {
    t[type.id] = {
      type,
      seconds: 0,
      laneDev: 0,      // px-seconds, divided out at the end
      passStarts: 0,
      passDone: 0,
      passTimedOut: 0,
      slow: 0,         // seconds
      stopped: 0,      // seconds
      bumps: 0,
      hazards: 0,
    };
  }
  return t;
}

// What a car looked like last tick, so edge-triggered events (a pass beginning,
// a contact starting) can be told from continuing ones. A WeakMap because cars
// are retired and dropped constantly and nothing here should keep one alive.
const previous = new WeakMap();

// Do two bodies' boxes overlap? The same axis-aligned test collisions.js uses.
function overlapping(a, b) {
  return (
    Math.abs(a.worldY - b.worldY) < (a.h + b.h) / 2 &&
    Math.abs(a.offset - b.offset) < (a.w + b.w) / 2
  );
}

// Sample every live car once, after the world has stepped.
function sample(tally, cars, obstacles, dt) {
  for (const car of cars) {
    if (!car.alive) continue;
    const row = tally[car.type.id];
    row.seconds += dt;
    row.laneDev += Math.abs(car.offset - laneOffset(laneAt(car.offset))) * dt;

    if (car.targetSpeed <= 0) row.stopped += dt;
    else if (car.targetSpeed < car.cruiseSpeed * 0.5) row.slow += dt;

    const was = previous.get(car) ?? { passing: false, passTime: 0, touching: false, onHazard: false };

    // Passes. A manoeuvre that ended having run past its profile's timeout is
    // one the car gave up on; anything shorter finished.
    const passing = Boolean(car.passTarget);
    if (passing && !was.passing) row.passStarts++;
    if (!passing && was.passing) {
      if (was.passTime > car.drive.passTimeout) row.passTimedOut++;
      else row.passDone++;
    }

    // Contacts, counted on the tick they BEGIN: a car leaning on another for a
    // second is one bump, not sixty.
    let touching = false;
    for (const other of cars) {
      if (other !== car && other.alive && overlapping(car, other)) {
        touching = true;
        break;
      }
    }
    if (touching && !was.touching) row.bumps++;

    let onHazard = false;
    for (const o of obstacles) {
      if (o.alive && overlapping(car, o)) {
        onHazard = true;
        break;
      }
    }
    if (onHazard && !was.onHazard) row.hazards++;

    previous.set(car, { passing, passTime: car.passTime ?? 0, touching, onHazard });
  }
}

// One run of the real game loop, minus the drawing.
function run(tally, seconds) {
  const explosions = new Explosions();
  const traffic = new Traffic(null, explosions);
  const obstacles = new Obstacles(explosions);
  const player = new Player(W / 2, H * 0.62);
  player.speed = PLAYER_SPEED;
  let distance = 0;

  for (let step = 0; step < seconds / DT; step++) {
    distance += player.speed * DT;
    // The player holds a lane rather than steering: this measures how TRAFFIC
    // drives, and a player weaving about would be a second uncontrolled variable
    // in every figure below. Pinned to the centre-line's lane 2, in screen x, as
    // player.x is what PlayerBody re-bases into an offset.
    player.prevX = player.x;
    player.x = centerXAt(distance, W) + laneOffset(2);
    player.speed = PLAYER_SPEED; // undo any shove the collision pass applied
    player.health = player.maxHealth; // and keep it alive for the whole run

    const world = { player, distance, W, H, cars: traffic.cars, obstacles: obstacles.list };
    obstacles.update(DT, world);
    world.obstacles = obstacles.list; // retire() replaces the array — see main.js
    traffic.update(DT, world);

    sample(tally, traffic.cars, obstacles.list, DT);
  }
}

// --- Reporting ------------------------------------------------------------------

function fmt(n, width, digits = 1) {
  return (Number.isFinite(n) ? n.toFixed(digits) : "-").padStart(width);
}

function report(tally) {
  const byProfile = new Map();
  for (const type of CAR_TYPES) {
    const name = Object.keys(DRIVING_PROFILES).find(
      (k) => DRIVING_PROFILES[k] === drivingFor(type),
    );
    if (!byProfile.has(name)) byProfile.set(name, []);
    byProfile.get(name).push(tally[type.id]);
  }

  console.log(
    `\n${SECONDS}s x ${RUNS} runs, player holding lane 2 at ${PLAYER_SPEED} units/sec\n`,
  );
  console.log(
    "profile / type        car-min  lane dev  pass/min  done%  slow%  stop%  bump/min  hazard",
  );
  console.log("-".repeat(88));

  for (const [name, rows] of byProfile) {
    const live = rows.filter((r) => r.seconds > 0);
    if (live.length === 0) continue;
    console.log(`${name}`);
    for (const r of live) print(`  ${r.type.id}`, r);
    if (live.length > 1) print("  = all", merge(live));
  }
}

function merge(rows) {
  const sum = { seconds: 0, laneDev: 0, passStarts: 0, passDone: 0, passTimedOut: 0,
                slow: 0, stopped: 0, bumps: 0, hazards: 0 };
  for (const r of rows) for (const k of Object.keys(sum)) sum[k] += r[k];
  return sum;
}

function print(label, r) {
  const minutes = r.seconds / 60;
  const ended = r.passDone + r.passTimedOut;
  console.log(
    label.padEnd(22) +
      fmt(minutes, 7) +
      fmt(r.laneDev / r.seconds, 10) +
      fmt(r.passStarts / minutes, 10) +
      fmt(ended ? (100 * r.passDone) / ended : NaN, 7, 0) +
      fmt((100 * r.slow) / r.seconds, 7, 0) +
      fmt((100 * r.stopped) / r.seconds, 7, 0) +
      fmt(r.bumps / minutes, 10) +
      fmt(r.hazards / minutes, 8, 2),
  );
}

const tally = blankTally();
for (let i = 0; i < RUNS; i++) run(tally, SECONDS);
report(tally);
