// Cross-file invariants — the relations the source documents in prose.
//
// WHY THIS FILE EXISTS. Cybercruise tunes itself through numbers that live in
// one file but constrain another: the traffic catalogue is pinned to the
// player's speed band, the follower's braking rule is sized against the widest
// closing speed that band can produce, and the sprite-cache budget is a product
// of the catalogue's length and the wheel-frame count. Every one of those is
// carefully explained in a comment — and a comment cannot fail. Retuning one
// number in cartypes.js could quietly invalidate a paragraph in behaviours.js
// and the road would start rear-ending itself with nothing to say so.
//
// So these are deliberately NOT unit tests of behaviour. They are assertions of
// the arithmetic the comments claim, placed so that changing a tuning number
// either keeps the claim true or fails here with the relation spelled out.
//
// Run with: npm test   (node --test, no dependencies)
//
// Everything imported here is DOM-free at module scope — spritecache.js only
// touches `document` inside getSprite, and input.js only reads `window` as a
// default argument — so the game's real modules load under plain Node.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CAR_TYPES, FOCUS, pickCarType, typeAvailable } from "../src/game/cartypes.js";
import { CAR_SHAPES, carShapeExtent } from "../src/game/carshapes.js";
import {
  ACCEL as TRAFFIC_ACCEL,
  RETIRE_MARGIN as TRAFFIC_RETIRE_MARGIN,
  Traffic,
} from "../src/game/traffic.js";
import { driveCar, dodgeDistance } from "../src/game/behaviours.js";
import { DRIVING_PROFILES, drivingFor, typesDriving } from "../src/game/driving.js";
import { MIN_SPEED, MAX_SPEED, ACCEL as PLAYER_ACCEL, Player } from "../src/game/player.js";
import { WHEEL_FRAMES } from "../src/game/sprites.js";
import {
  LANE_COUNT, LANE_WIDTH, ROAD_HALF_WIDTH, laneAt, laneOffset, centerXAt,
  centerOffset, headingAt,
  TILE_STRIDE, DASH_SPAN, blockOf, blockLocalY, blockDestY,
  DIST_UNITS,
} from "../src/game/road.js";
import { gridPhase } from "../src/game/scenery.js";
import { OBSTACLE_SHAPES } from "../src/game/obstacleshapes.js";
import { CELL, plotAt, plotColumns, plotRows, BUILDING, EMPTY } from "../src/game/citygrid.js";
import { resolveCollisions, impactCost } from "../src/game/collisions.js";
import { Score, DISTANCE_POINTS } from "../src/game/score.js";
import { Loadout, Weapon, WEAPON_TYPES, ENEMY_WEAPON_TYPES } from "../src/game/weapons.js";
import {
  OBSTACLE_TYPES, obstacleTypeById, obstacleAvailable, PLACE_LANE, PLACE_SIDE,
} from "../src/game/obstacletypes.js";
import { Obstacles, SPAWN_MARGIN as OBSTACLE_SPAWN_MARGIN } from "../src/game/obstacles.js";
import { Explosions } from "../src/game/effects.js";
import { Projectiles } from "../src/game/projectiles.js";
import { armFor, armamentFor } from "../src/game/armament.js";
import { NEUTRAL_PALE } from "../src/engine/palette.js";

// A fixture car. Traffic cars are built by traffic.js, which hands them the two
// things behaviours.js reads that a plain object literal would not have: the
// driving profile (`drive`) and the tolerances rolled from it. Defaults are the
// commuter's — careful, dead centre in its lane, unwilling to hit anything.
const COMMUTER = DRIVING_PROFILES.commuter;
function driver(over = {}) {
  return {
    drive: COMMUTER, nerve: 0, contact: 0, heldTime: 0, alive: true,
    ...over,
  };
}

const slowest = Math.min(...CAR_TYPES.map((t) => t.speedMin));
const fastest = Math.max(...CAR_TYPES.map((t) => t.speedMax));

// --- The speed band, and the braking rule sized against it -------------------

test("every driving profile can shed the closing speed its own drivers reach", () => {
  // behaviours.js gives a follower `followGap` plus `followReaction` seconds of
  // closing rate to brake in, which only covers the road needed while
  //     dv^2 / (2 * ACCEL)  <=  followGap + dv * followReaction
  // for every closing speed dv its drivers can produce (shedding dv costs
  // dv^2/(2*ACCEL) of road). Break it and traffic starts rear-ending itself.
  //
  // PER PROFILE, NOT PER CATALOGUE, and that is the whole reason `hustler` is
  // allowed to tailgate: dv is the fastest type NAMING THAT PROFILE minus the
  // player's minimum, not the catalogue's 610. A tight following distance is
  // safe exactly as long as nothing quick drives it — so this fails the day
  // somebody points the hypercar at the roadster's profile, which is the
  // failure the per-profile form exists to catch.
  for (const [name, p] of Object.entries(DRIVING_PROFILES)) {
    const users = typesDriving(name, CAR_TYPES);
    if (users.length === 0) continue; // a profile nobody drives constrains nothing
    // Capped at each type's own speedMax, exactly as behaviours.js passSpeed does.
    const top = Math.max(...users.map((t) => Math.min(t.speedMax, t.speedMax * p.passEffort)));
    const dv = top - MIN_SPEED;
    const needed = (dv * dv) / (2 * TRAFFIC_ACCEL);
    const allowed = p.followGap + dv * p.followReaction;
    const fastestUser = users.reduce((a, b) => (a.speedMax > b.speedMax ? a : b));
    assert.ok(
      allowed >= needed,
      `profile "${name}" leaves ${allowed.toFixed(0)} units of road to shed ${dv} ` +
        `units/sec of closing speed, which needs ${needed.toFixed(0)}. Its quickest ` +
        `driver is the ${fastestUser.id} at ${fastestUser.speedMax}. Raise followGap ` +
        `or followReaction, or move that type to another profile.`,
    );
  }
});

test("traffic cannot out-brake the player", () => {
  // traffic.js sizes its ACCEL "just under the player's own", so the player can
  // always change speed harder than the cars around them.
  assert.ok(
    TRAFFIC_ACCEL < PLAYER_ACCEL,
    `traffic ACCEL ${TRAFFIC_ACCEL} must stay under the player's ${PLAYER_ACCEL}`,
  );
});

test("the catalogue is pinned to both ends of the player's speed band", () => {
  // FLOOR: the slowest cruise is half again the player's minimum, so dawdling
  // makes the city stream past rather than making the road go quiet.
  assert.ok(
    slowest >= MIN_SPEED * 1.5,
    `slowest cruise ${slowest} must stay >= 1.5x the player's minimum ${MIN_SPEED}`,
  );
  // CEILING: something is always quicker than the player flat out, or holding
  // the throttle down would be enough to be left alone.
  assert.ok(
    fastest > MAX_SPEED,
    `fastest cruise ${fastest} must exceed the player's maximum ${MAX_SPEED}`,
  );
});

test("every car type has a coherent speed range", () => {
  for (const t of CAR_TYPES) {
    assert.ok(t.speedMin <= t.speedMax, `${t.id}: speedMin > speedMax`);
    assert.ok(t.speedMin > 0, `${t.id}: speedMin must be positive`);
  }
});

// --- The sprite-cache budget -------------------------------------------------

test("sprite-cache budget matches the figure cartypes.js documents", () => {
  // cartypes.js: "11 types * 8 * 2 = 176 sprites at the absolute worst" — one
  // per (type, wheel frame), doubled for the critical-hull blink colour. This is
  // what keeps the cache bounded, so it must not grow silently.
  const worstCase = CAR_TYPES.length * WHEEL_FRAMES * 2;
  assert.equal(
    worstCase,
    176,
    `traffic sprite worst case is now ${worstCase}, not the documented 176 ` +
      `(${CAR_TYPES.length} types x ${WHEEL_FRAMES} wheel frames x 2 colours)`,
  );
});

test("one car type per silhouette", () => {
  // cartypes.js opens with "ONE TYPE PER SILHOUETTE": a type is told apart by
  // its shape, since colour only carries faction and weight class.
  const shapes = CAR_TYPES.map((t) => t.shape);
  assert.equal(new Set(shapes).size, shapes.length, "two car types share a silhouette");
  assert.equal(shapes.length, CAR_SHAPES.length, "catalogue is no longer 1:1 with CAR_SHAPES");
});

test("carShapeExtent bounds every point of every shape", () => {
  // The extent decides the offscreen sprite's size. If it ever under-reports,
  // the artwork is silently clipped at the sprite edge — which looks like a
  // drawing bug, a long way from the shape that caused it.
  for (let i = 0; i < CAR_SHAPES.length; i++) {
    const shape = CAR_SHAPES[i];
    const [w, h] = shape.size;
    const ext = carShapeExtent(i, w, h);
    for (const profile of shape.parts ?? [shape.profile]) {
      for (const [fx, fy] of profile) {
        assert.ok(Math.abs(fx * (w / 2)) <= ext.x, `${shape.name}: x extent clips the profile`);
        assert.ok(-fy * (h / 2) <= ext.up, `${shape.name}: up extent clips the profile`);
        assert.ok(fy * (h / 2) <= ext.down, `${shape.name}: down extent clips the profile`);
      }
    }
  }
});

// --- Road geometry -----------------------------------------------------------

test("laneAt inverts laneOffset, and every lane sits on the tarmac", () => {
  for (let i = 0; i < LANE_COUNT; i++) {
    const offset = laneOffset(i);
    assert.equal(laneAt(offset), i, `lane ${i} does not round-trip`);
    assert.ok(Math.abs(offset) < ROAD_HALF_WIDTH, `lane ${i} centre is off the road`);
  }
});

test("laneAt clamps anything shoved past the barriers", () => {
  // Ramming knocks cars off their lane; laneAt is what the spawner reads to
  // avoid dropping traffic on top of them, so it must never return a bad index.
  assert.equal(laneAt(-ROAD_HALF_WIDTH * 4), 0);
  assert.equal(laneAt(ROAD_HALF_WIDTH * 4), LANE_COUNT - 1);
});

test("headingAt is the true slope of centerOffset", () => {
  // Every car, obstacle and tracking round on screen is rotated by headingAt, so
  // if it ever stops being the derivative of centerOffset the whole world points
  // along a road that isn't there — and it would go wrong SMOOTHLY, which is the
  // hardest kind of wrong to spot by eye. The two are written as separate
  // closed-form expressions over shared constants (road.js), so this compares the
  // analytic answer against a central difference of the curve itself.
  //
  // h is small because the curve is C1 but not C2: at the joins where the road
  // settles into a straight, the curvature steps and a central difference
  // straddling the join carries an O(h) error that is nothing to do with
  // headingAt being wrong. h = 0.001 keeps that a hundredth of the tolerance,
  // still far above the cancellation floor (~1e-11) of differencing a ~90px
  // offset.
  const h = 0.001;
  for (let y = 0; y < 40000; y += 37) {
    const numeric = (centerOffset(y + h) - centerOffset(y - h)) / (2 * h);
    assert.ok(
      Math.abs(Math.tan(headingAt(y)) - numeric) < 1e-6,
      `headingAt disagrees with centerOffset's slope at worldY ${y}`,
    );
  }
});

test("the road never turns sharply enough to rotate a car onto its side", () => {
  // The rotated blit (engine/spritecache.js) is cheap precisely because the lean
  // is small: sprites are rasterised axis-aligned and resampled at an angle, and
  // thin neon strokes soften as that angle grows. road.js documents the range as
  // ±12°; this is what keeps a retuned curve from quietly making the artwork
  // mushy — or from swinging cars far enough to look like a spin rather than a
  // lean.
  //
  // The upper bound is also what keeps the road a HIGHWAY. All three shape knobs
  // in game/tuning.js multiply into this angle, so it is the one number that
  // catches "gentle sweeping curves" drifting back into the wavy forest road the
  // road used to be — you cannot turn often and hard without showing up here.
  let max = 0;
  for (let y = 0; y < 400000; y += 3) max = Math.max(max, Math.abs(headingAt(y)));
  const deg = (max * 180) / Math.PI;
  assert.ok(deg > 7, `the road barely turns (${deg.toFixed(1)}°) — rotation buys nothing`);
  assert.ok(deg < 16, `the road leans cars ${deg.toFixed(1)}° — sweeping curves, not switchbacks`);
});

test("the road spends real stretches dead straight between its turns", () => {
  // The whole point of the soft clip in road.js: a pure sine road is turn after
  // turn with nothing between them, which reads as constant snaking. This pins
  // BOTH ends of the trade — enough straight road to feel like relief, but not so
  // much that the road stops being a road worth steering. Retune with
  // ROAD_STRAIGHTNESS in game/tuning.js.
  let flat = 0;
  let longest = 0;
  let run = 0;
  const samples = 400000 / 3;
  for (let y = 0; y < 400000; y += 3) {
    if (headingAt(y) === 0) {
      flat++;
      run += 3;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  const pct = (100 * flat) / samples;
  assert.ok(pct > 45, `only ${pct.toFixed(0)}% of the road is straight — still snaky`);
  assert.ok(pct < 78, `${pct.toFixed(0)}% of the road is straight — barely a road`);
  // ~260 world units/second at cruising speed. A highway may hold one line for a
  // long while, but "a whole minute without a bend" is a different game.
  assert.ok(longest < 260 * 35, `a straight runs ${(longest / 260).toFixed(0)}s — too long`);
});

// --- The cached scrolling layers ---------------------------------------------
//
// The road and the floor grid are no longer stroked each frame; they are blitted
// from pre-rendered canvases (road.js's strip cache, scenery.js's grid tile).
// Nothing here can look at pixels — these run under plain Node — but the whole
// correctness of both caches is arithmetic about WHERE a blit lands, and that
// can be asserted exactly. A pixel diff of the two against their direct renders
// belongs in the browser; this is the part that can fail silently.

test("a road strip blits exactly where the direct render would have drawn it", () => {
  // This is the cache's entire claim: for any world position, the tile-local row
  // plus the tile's blit offset must come out at the SAME screen row the plain
  // formula gives — the one traffic, obstacles and bullets all use. If it ever
  // drifts, the cars slide against the tarmac they are driving on.
  const playerY = 496;
  for (let distance = 0; distance < 5000; distance += 37) {
    for (let worldY = distance - 800; worldY < distance + 400; worldY += 13) {
      const k = blockOf(worldY);
      const cached = blockDestY(k, distance, playerY) + blockLocalY(k, worldY);
      const direct = playerY - (worldY - distance);
      assert.ok(
        Math.abs(cached - direct) < 1e-9,
        `strip ${k} puts worldY ${worldY} at ${cached}, direct render says ${direct}`,
      );
    }
  }
});

test("the blitted strips cover the whole screen, top and bottom", () => {
  // road.render walks blocks from the screen's bottom world row to its top. A
  // sign slip or an off-by-one in that range would leave an unpainted band at one
  // edge — through which the city floor would show, since the tarmac is what
  // occludes it.
  const H = 800;
  const playerY = 496;
  for (let distance = 0; distance < 4000; distance += 17) {
    const kMin = blockOf(distance + playerY - H);
    const kMax = blockOf(distance + playerY);
    assert.ok(
      blockDestY(kMax, distance, playerY) <= 0,
      `the top strip starts at ${blockDestY(kMax, distance, playerY)}, leaving a gap above it`,
    );
    assert.ok(
      blockDestY(kMin, distance, playerY) + TILE_STRIDE >= H,
      `the bottom strip ends above the screen bottom at distance ${distance}`,
    );
  }
});

test("a strip's overdraw margin is wider than anything drawn across its seam", () => {
  // Seams are handled by painting each tile a full stride past both ends and
  // letting the canvas clip, so a neighbouring tile continues the identical
  // stroke. That only works while the margin is wider than the longest feature
  // that can straddle a boundary — the centre line's dash-plus-gap period. Shrink
  // TILE_STRIDE below that and dashes start winking out at tile joins.
  assert.ok(
    TILE_STRIDE >= DASH_SPAN,
    `a ${TILE_STRIDE}px overdraw cannot cover a ${DASH_SPAN}px dash period`,
  );
});

test("the floor grid's tile phase reproduces the world-anchored horizontals", () => {
  // The grid tile is blitted at gridPhase() - CELL. Every horizontal in the tile
  // sits at a multiple of CELL, so every horizontal ON SCREEN must land in the
  // same residue class as the world-anchored line the direct render would draw.
  // The playerY term in the phase is the load-bearing part and the easy one to
  // drop: without it the grid is misplaced by a mean channel diff of 18.6/255.
  for (const playerY of [0, 496, 500, 803]) {
    for (let fDist = 0; fDist < 3000; fDist += 7) {
      const phase = gridPhase(fDist, playerY);
      assert.ok(phase >= 0 && phase < CELL, `phase ${phase} is outside one cell`);
      // Where the direct render puts the world line at wy = k*CELL.
      for (const k of [-3, 0, 11, 47]) {
        const direct = playerY - (k * CELL - fDist);
        const residue = (((direct - phase) % CELL) + CELL) % CELL;
        assert.ok(
          residue < 1e-9 || CELL - residue < 1e-9,
          `world line ${k * CELL} lands at ${direct}, off the tile's phase ${phase}`,
        );
      }
    }
  }
});

test("one extra cell of tile height is enough to cover the screen at any phase", () => {
  // The tile is H + CELL tall and blitted at a negative offset in [-CELL, 0).
  // That single extra cell is what lets ONE blit cover the screen whatever the
  // phase — the reason this layer needs no position-keyed cache at all.
  const H = 800;
  for (let fDist = 0; fDist < 640; fDist += 0.5) {
    const destY = gridPhase(fDist, 496) - CELL;
    assert.ok(destY <= 0 && destY >= -CELL, `blit offset ${destY} is outside [-CELL, 0]`);
    assert.ok(destY + (H + CELL) >= H, `the tile stops ${-(destY + CELL)}px short of the bottom`);
  }
});

// --- The city floor is a pure function of its plot index ---------------------

test("plotAt is deterministic and total", () => {
  // citygrid.js's whole design rests on this: the city is infinite and identical
  // every time you drive past because nothing is stored. A plot that varied
  // between calls would make buildings flicker in and out as you approached.
  for (let bx = 0; bx < 6; bx++) {
    for (let by = -30; by < 30; by++) {
      const a = plotAt(bx, by);
      const b = plotAt(bx, by);
      assert.deepEqual(a, b, `plot (${bx}, ${by}) is not stable across calls`);
      assert.ok(a.type === BUILDING || a.type === EMPTY, `plot (${bx}, ${by}) has an unknown type`);
      if (a.type === BUILDING) {
        assert.ok(Number.isInteger(a.variant) && a.variant >= 0, "building variant must be an index");
      }
    }
  }
});

test("the visible floor stays a bounded walk", () => {
  // scenery.js walks every plot in view each frame, so this product is per-frame
  // work. It is small today; this pins it so it cannot creep.
  const rows = plotRows(0, 800 + 240);
  const plots = (rows.max - rows.min + 1) * plotColumns(600);
  assert.ok(plots <= 60, `floor walk grew to ${plots} plots per frame`);
});

// --- Ramming physics ---------------------------------------------------------

// A minimal body satisfying the interface collisions.js documents.
function body(over = {}) {
  return {
    worldY: 0, offset: 0, prevOffset: 0, w: 34, h: 60,
    speed: 0, vLateral: 0, mass: 1, alive: true, taken: 0,
    damage(hp) { this.taken += hp; },
    ...over,
  };
}

test("an equal-mass rear-end costs each car the documented hull", () => {
  // collisions.js: "At equal mass, a 300 unit/sec rear-end costs each car
  // (300-40) * 0.15 = 39 hull."
  const rear = body({ worldY: 0, speed: 400 });
  const front = body({ worldY: 50, speed: 100 });
  resolveCollisions([rear, front], 1 / 60);

  assert.equal(+rear.taken.toFixed(6), 39);
  assert.equal(+front.taken.toFixed(6), 39);
  // Momentum goes the right way, and nothing is left overlapping.
  assert.ok(rear.speed < 400, "the rear car should have been slowed");
  assert.ok(front.speed > 100, "the front car should have been shoved along");
  assert.ok(front.worldY - rear.worldY >= 60, "the pair are still inside each other");
});

test("low-speed contact is free", () => {
  // Parking against a car must cost nothing, or traffic would grind itself down
  // just by queueing. DAMAGE_FLOOR is 40.
  const rear = body({ worldY: 0, speed: 130 });
  const front = body({ worldY: 50, speed: 100 });
  resolveCollisions([rear, front], 1 / 60);
  assert.equal(rear.taken, 0);
  assert.equal(front.taken, 0);
});

test("a heavier car shrugs off a lighter one", () => {
  // Damage and movement split by INVERSE mass, so the light car comes off worse.
  const light = body({ worldY: 0, speed: 400, mass: 0.5 });
  const heavy = body({ worldY: 50, speed: 100, mass: 4 });
  resolveCollisions([light, heavy], 1 / 60);
  assert.ok(light.taken > heavy.taken, "the lighter car must take the greater share");
});

// --- Tick ordering: a dead car stops existing immediately --------------------
//
// main.js resolves bullets BEFORE traffic, so that a car killed this tick
// detonates and scores in the same frame rather than a frame later. The cost of
// that ordering is a window in which a car is dead but still in `traffic.cars`,
// because it is not dropped until retire() at the end of the tick. Nothing may
// act on a car inside that window.

test("a car killed by a bullet does not drive on before it explodes", () => {
  const traffic = new Traffic();
  const player = new Player(300, 496);
  const world = { player, distance: 0, W: 600, H: 800 };

  traffic.spawn(world);
  const car = traffic.cars[0];
  assert.ok(car, "expected spawn to put a car on the road");
  const diedAt = car.worldY;
  const diedOffset = car.offset;

  car.damage(car.health); // as a bullet would, in main.js, before traffic.update
  assert.ok(!car.alive);
  assert.ok(car.speed > 0, "the test is meaningless if the car was not moving");

  traffic.update(1 / 60, world);

  const wreck = traffic.explosions.slots.find((s) => s.alive);
  assert.ok(wreck, "the dead car should have detonated this tick");
  assert.equal(wreck.worldY, diedAt, "the wreck drifted from where the car was killed");
  assert.equal(wreck.offset, diedOffset, "the wreck drifted across the road");
  // Note the road may not be empty: retire() runs before spawn(), so a fresh car
  // can take the corpse's place in the same tick. Only this car must be gone.
  assert.ok(!traffic.cars.includes(car), "the corpse should have been retired");
});

test("a destroyed car is scored exactly once", () => {
  let calls = 0;
  const traffic = new Traffic(() => calls++);
  const player = new Player(300, 496);
  const world = { player, distance: 0, W: 600, H: 800 };

  traffic.spawn(world);
  traffic.cars[0].damage(traffic.cars[0].health);
  traffic.update(1 / 60, world);
  assert.equal(calls, 1);

  traffic.update(1 / 60, world); // the corpse is gone; nothing more may be paid
  assert.equal(calls, 1);
});

test("traffic does not brake for a corpse", () => {
  // The other half of the same window: a car killed this tick leaves nothing
  // solid on the road, so following cars must drive straight through the space.
  const follower = () => driver({
    worldY: 0, offset: 0, w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: 0,
    type: { behaviour: "cruise", w: 34, steerSpeed: 90 },
  });
  // Close enough ahead to force a hard brake if it counts as an obstacle.
  const ahead = (alive) => ({ worldY: 100, offset: 0, w: 34, h: 60, speed: 0, alive });

  const braking = follower();
  const live = ahead(true);
  driveCar(braking, 1 / 60, { cars: [braking, live], playerBody: null });
  assert.ok(
    braking.targetSpeed < braking.cruiseSpeed,
    "a LIVE car ahead must still be braked for — otherwise this test proves nothing",
  );

  const clear = follower();
  const corpse = ahead(false);
  driveCar(clear, 1 / 60, { cars: [clear, corpse], playerBody: null });
  assert.equal(clear.targetSpeed, clear.cruiseSpeed, "a dead car ahead must not cause braking");
});

// --- Distance gating ---------------------------------------------------------

test("the testing FOCUS switch is off", () => {
  // FIRST, because a focused catalogue fails most of what follows for a reason
  // that has nothing to do with the gate: cartypes.js's FOCUS narrows the road to
  // the types being worked on, and is meant to be flipped back before anything is
  // committed. Without this the suite reports "van never appeared even past every
  // gate", which sends a reader hunting through weights.
  assert.deepEqual(
    FOCUS,
    [],
    `cartypes.js FOCUS is still set to [${FOCUS.join(", ")}] — the road is narrowed ` +
      `to those types. Set it back to [] before committing.`,
  );
});

test("the opening road is civilian: no hostile type spawns before its gate", () => {
  // cartypes.js's ENEMY_MIN_DISTANCE claim, in the units it is written in. The
  // gate is on the DIST READOUT (road.js's DIST_UNITS), not on raw world units —
  // get that conversion wrong by a factor of 100 and the "quiet start" is over
  // in a third of a second, with nothing else in the game to say so.
  const gate = Math.max(...CAR_TYPES.map((t) => t.minDistance ?? 0));
  assert.ok(gate > 0, "no car type is gated at all — cartypes.js says the enemy should be");

  const justBefore = gate * DIST_UNITS - 1;
  for (let i = 0; i < 2000; i++) {
    const type = pickCarType(justBefore);
    assert.ok(type, "the catalogue must always offer SOMETHING on the opening road");
    assert.ok(
      typeAvailable(type, justBefore),
      `${type.id} was offered at DIST ${(justBefore / DIST_UNITS).toFixed(2)}, ` +
        `but its gate is ${type.minDistance}`,
    );
  }
});

test("every gated type is back in the draw once its distance is passed", () => {
  // The other half: a gate must OPEN, or a type is simply switched off and the
  // sprite-cache budget in cartypes.js's header is paying for artwork nobody
  // ever meets.
  const far = Math.max(...CAR_TYPES.map((t) => t.minDistance ?? 0)) * DIST_UNITS;
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(pickCarType(far).id);
  for (const type of CAR_TYPES) {
    assert.ok(seen.has(type.id), `${type.id} never appeared even past every gate`);
  }
});

test("gating reweights the draw rather than thinning the traffic", () => {
  // pickCarType's own claim: before the enemy is unlocked the civilians share
  // the WHOLE draw, so the opening road is as busy as any other stretch. A
  // rejection-sampling implementation would return null (or nothing at all) for
  // the gated share of the rolls, and the opening would feel empty instead of
  // peaceful.
  for (let i = 0; i < 500; i++) {
    assert.ok(pickCarType(0), "a roll on the opening road must still yield a type");
  }
});

test("obstacle gating uses the same units as the car catalogue", () => {
  // Both catalogues are documented as speaking DIST-readout units, and
  // obstacletypes.js is written as a mirror of cartypes.js. The hazards are all
  // at 0 today, so this asserts the MECHANISM, not the current tuning.
  for (const type of OBSTACLE_TYPES) {
    assert.equal(typeof type.minDistance, "number", `${type.id} has no minDistance`);
    assert.ok(
      obstacleAvailable(type, type.minDistance * DIST_UNITS),
      `${type.id} is still gated at exactly its own minDistance`,
    );
    if (type.minDistance > 0) {
      assert.ok(
        !obstacleAvailable(type, type.minDistance * DIST_UNITS - 1),
        `${type.id} spawns a unit before its gate`,
      );
    }
  }
});

// --- Scoring -----------------------------------------------------------------

test("kills dominate the score, as score.js claims", () => {
  // score.js: "against a car worth +-100, a minute of flat-out driving is worth
  // about a third of one kill". That ratio is the whole shape of the scoring,
  // and it breaks if either DISTANCE_POINTS or `value` moves alone.
  const minuteFlatOut = MAX_SPEED * 60 * DISTANCE_POINTS;
  const killValue = Math.max(...CAR_TYPES.map((t) => Math.abs(t.value)));
  const ratio = minuteFlatOut / killValue;
  assert.ok(
    ratio > 0.2 && ratio < 0.5,
    `a minute of driving is now worth ${ratio.toFixed(2)} of a kill (want ~0.33). ` +
      `Move DISTANCE_POINTS or the catalogue's \`value\`, never both at once.`,
  );
});

test("destroying civilians can put the score in the red", () => {
  // score.js is explicit that the total is NOT clamped at zero — the penalty is
  // supposed to be diggable-out-of, not invisible.
  const score = new Score();
  const civilian = CAR_TYPES.find((t) => t.value < 0);
  score.destroyed(civilian);
  assert.ok(score.points < 0, "a civilian kill on a fresh run must go negative");
  assert.equal(score.civilians, 1);
  assert.equal(score.kills, 0);
});

test("distance accumulates as a float and only floors when read", () => {
  // Sub-unit travel per tick must not be rounded away, or a slow player scores
  // nothing at all.
  const score = new Score();
  for (let i = 0; i < 1000; i++) score.travel(1);
  assert.equal(score.points, Math.floor(1000 * DISTANCE_POINTS));
  assert.equal(score.travelled, 1000);
});

// --- Weapons -----------------------------------------------------------------

test("the default gun never runs out", () => {
  // weapons.js: the player must always have some way to shoot, which is what
  // makes the finite weapons a choice rather than a lifeline.
  const w = new Weapon(WEAPON_TYPES[0]);
  assert.equal(w.ammo, Infinity);
  for (let i = 0; i < 100; i++) {
    w.cooldown = 0;
    assert.ok(w.tryFire());
  }
  assert.equal(w.ammo, Infinity);
  assert.equal(w.ammoText, "∞");
});

test("a weapon respects its own fire rate", () => {
  const type = WEAPON_TYPES[0];
  const w = new Weapon(type);
  assert.ok(w.tryFire(), "the first shot should be free");
  assert.ok(!w.tryFire(), "a second shot in the same instant must be refused");
  w.update(type.interval);
  assert.ok(w.tryFire(), "the weapon should be ready again after its interval");
});

test("an empty weapon selects, shows zero and refuses to fire", () => {
  // weapons.js: "SWAPPING NEVER FAILS, including onto an empty weapon."
  const finite = WEAPON_TYPES.find((t) => t.ammo !== Infinity);
  assert.ok(finite, "expected at least one finite weapon in the catalogue");
  const w = new Weapon(finite);
  for (let i = 0; i < finite.ammo; i++) {
    w.cooldown = 0;
    assert.ok(w.tryFire());
  }
  w.cooldown = 0;
  assert.ok(!w.tryFire(), "an empty weapon must refuse to fire");
  assert.ok(w.empty);
  assert.equal(w.ammoText, "0");
});

test("swapping cannot be used to dodge a cooldown", () => {
  // weapons.js: cooldowns run for the WHOLE loadout, so flicking away and back
  // must not refresh the weapon in hand.
  const loadout = new Loadout();
  const first = loadout.current;
  assert.ok(first.tryFire());
  loadout.next();
  loadout.next(); // all the way back round to `first`
  assert.equal(loadout.current, first);
  assert.ok(!loadout.current.tryFire(), "the cooldown should have survived the swap");
});

test("the loadout cycles through every weapon and returns", () => {
  const loadout = new Loadout();
  const seen = new Set();
  for (let i = 0; i < WEAPON_TYPES.length; i++) {
    seen.add(loadout.current.type.id);
    loadout.next();
  }
  assert.equal(seen.size, WEAPON_TYPES.length, "TAB does not reach every weapon");
  assert.equal(loadout.current.type.id, WEAPON_TYPES[0].id, "the cycle does not return to the start");
});

// --- Road obstacles -----------------------------------------------------------

test("every obstacle type carries coherent, positive gameplay numbers", () => {
  for (const t of OBSTACLE_TYPES) {
    assert.ok(t.health > 0, `${t.id}: health must be positive`);
    assert.ok(t.weight > 0, `${t.id}: weight must be positive`);
    assert.ok(t.blastRadius >= 0, `${t.id}: blastRadius must not be negative`);
    assert.ok(t.blastDamage >= 0, `${t.id}: blastDamage must not be negative`);
  }
});

test("the mine carries the minimum health in the catalogue, as obstacletypes.js claims", () => {
  // obstacletypes.js: "a mine takes exactly ONE hit, gunfire or contact, same
  // as a car at zero hull" — the catalogue backs that up with the number, not
  // just the comment.
  const mine = OBSTACLE_TYPES.find((t) => t.id === "caltrop");
  const minHealth = Math.min(...OBSTACLE_TYPES.map((t) => t.health));
  assert.equal(mine.health, minHealth);
  assert.equal(mine.health, 1);
});

// A minimal world: a stationary player at the origin, no traffic. Obstacles
// only need `player`, `distance`, `W`, `H` and (optionally) `cars`.
function obstacleWorld() {
  const player = new Player(300, 496);
  return { player, distance: 0, W: 600, H: 800, cars: [] };
}

test("a ram destroys an obstacle outright, even at full health", () => {
  // game/obstacles.js: contact ignores `health` entirely — the road only ever
  // gives the player one pass at a static object, so partial damage surviving
  // a hit that cannot be repeated would be a number nobody ever sees move.
  const obstacles = new Obstacles(new Explosions());
  const world = obstacleWorld();
  obstacles.spawn(world);
  const o = obstacles.list[0];
  assert.ok(o, "expected spawn to place an obstacle");
  assert.equal(o.health, o.type.health, "should start at full health");

  // Drive the player exactly onto it.
  world.distance = o.worldY;
  world.player.x = centerXAt(o.worldY, world.W) + o.offset;
  obstacles.update(1 / 60, world);

  assert.ok(!obstacles.list.includes(o), "a full-health obstacle must still be destroyed by contact");
});

test("gunfire spends an obstacle's health instead of destroying it outright", () => {
  const obstacles = new Obstacles(new Explosions());
  const world = obstacleWorld();
  obstacles.spawn(world);
  const o = obstacles.list[0];

  o.damage(o.health / 2);
  assert.ok(o.alive, "half its health should leave the obstacle standing");

  o.damage(o.health); // more than enough to finish it off
  assert.ok(!o.alive, "spending the rest of its health must destroy it");
});

test("destroying an obstacle spawns its destruction effect exactly once", () => {
  const explosions = new Explosions();
  const obstacles = new Obstacles(explosions);
  const world = obstacleWorld();
  obstacles.spawn(world);
  const o = obstacles.list[0];

  o.damage(o.health);
  obstacles.update(1 / 60, world);

  const alive = explosions.slots.filter((s) => s.alive);
  assert.equal(alive.length, 1, "exactly one effect should have been spawned");
  assert.ok(!obstacles.list.includes(o), "the destroyed obstacle should have been retired");
});

test("hazards are placed beyond the traffic field, with room left to dodge", () => {
  // The relation obstacles.js's SPAWN_MARGIN is sized by, spanning three files:
  // a hazard must appear past the furthest live car (traffic.js's RETIRE_MARGIN)
  // AND leave the worst dodger in the catalogue enough road to get clear
  // (behaviours.js's dodgeDistance). Break it and hazards land in the middle of
  // the traffic field, where the cars nearest the spawn point cannot avoid them
  // however well they drive — which measured as the road clearing 88% of its own
  // obstacles before the player ever reached one.
  const worst = Math.max(...CAR_TYPES.map((t) => dodgeDistance(t.speedMax, t.steerSpeed)));
  const needed = TRAFFIC_RETIRE_MARGIN + worst;
  assert.ok(
    OBSTACLE_SPAWN_MARGIN >= needed,
    `obstacle SPAWN_MARGIN is ${OBSTACLE_SPAWN_MARGIN} but needs to be at least ` +
      `${Math.ceil(needed)} (traffic RETIRE_MARGIN ${TRAFFIC_RETIRE_MARGIN} + ` +
      `${Math.ceil(worst)} units for the slowest-steering type to cross two lanes)`,
  );
});

test("no driver has the nerve to run onto a mine", () => {
  // driving.js's NERVE section: no profile's ceiling reaches the tetra's damage,
  // and therefore none reaches the mine's. That keeps mines the PLAYER'S
  // problem rather than something the road sweeps up for them, and it avoids
  // score.js fining the player for a civilian a mine killed unaided.
  const boldest = Math.max(...Object.values(DRIVING_PROFILES).map((p) => p.nerve));
  const mine = OBSTACLE_TYPES.find((t) => t.id === "caltrop");
  const tetra = OBSTACLE_TYPES.find((t) => t.id === "tetra");
  assert.ok(
    boldest < tetra.blastDamage,
    `the boldest nerve (${boldest}) now reaches the tetra's ${tetra.blastDamage} hit`,
  );
  assert.ok(
    boldest < mine.blastDamage,
    `the boldest nerve (${boldest}) now reaches the mine's ${mine.blastDamage} hit — ` +
      `traffic would start clearing mines off the road for the player`,
  );
});

test("the amber civilians always dodge, and at least one hostile gambles", () => {
  // The shape of the dial, not its exact settings. AMBER civilians (palette
  // NEUTRAL / NEUTRAL_DEEP — sedan, van, rig) steering around everything is what
  // makes an amber car swerving mean "something is in that lane". The PALE
  // civilians are a visibly different shade, which is what buys the roadster the
  // room to shoulder through a stack of barrels without muddying that signal —
  // see driving.js's NERVE section.
  const civilians = CAR_TYPES.filter((t) => t.value < 0);
  const amber = civilians.filter((t) => t.color !== NEUTRAL_PALE);
  assert.ok(amber.length > 0, "the signal needs someone to carry it");
  for (const t of amber) {
    assert.equal(drivingFor(t).nerve, 0, `${t.id}: amber civilians must always dodge`);
  }
  const trestle = OBSTACLE_TYPES.find((t) => t.id === "trestle");
  const gamblers = CAR_TYPES.filter((t) => drivingFor(t).nerve > trestle.blastDamage);
  assert.ok(gamblers.length > 0, "no hostile type can ever barge a trestle");
});

test("a nerve setting is either zero or bold enough to do something", () => {
  // The dial is QUANTISED by the obstacle catalogue: nerve is compared against a
  // hazard's blastDamage, so anything between 0 and the cheapest hazard behaves
  // exactly like 0. There is no "slightly bolder", and a profile sitting in that
  // dead band is a tuning attempt that silently did nothing.
  const cheapest = Math.min(...OBSTACLE_TYPES.map((t) => t.blastDamage));
  for (const [name, p] of Object.entries(DRIVING_PROFILES)) {
    assert.ok(
      p.nerve === 0 || p.nerve > cheapest,
      `profile "${name}" has nerve ${p.nerve}, which is under the cheapest hazard ` +
        `(${cheapest} hull) and therefore identical to nerve 0`,
    );
  }
});

// A cruising car in lane 1, and a hazard somewhere ahead of it. `gap` is how
// much road it gets, which is what decides whether steering alone is enough.
function hazardScenario(gap, over = {}) {
  const car = driver({
    worldY: 0, offset: laneOffset(1), w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: laneOffset(1),
    // behaviours.js derives its hazard lookahead from speed and steerSpeed, so
    // a fixture without a steering rate would look ahead an undefined distance.
    type: { behaviour: "cruise", w: 34, steerSpeed: 90 },
    ...over,
  });
  const hazard = {
    worldY: gap, offset: laneOffset(1), w: 60, h: 14, alive: true, threat: 8,
  };
  driveCar(car, 1 / 60, { cars: [car], obstacles: [hazard], playerBody: null });
  return { car, hazard };
}

test("traffic steers around a hazard rather than queueing behind it", () => {
  // behaviours.js keeps obstacles OUT of leadCar on purpose: a hazard never
  // moves, so MATCHING ITS SPEED would mean stopping dead for something that is
  // never going to pull away. Going round is the answer.
  const { car, hazard } = hazardScenario(400);
  assert.notEqual(car.targetOffset, laneOffset(1), "the car should have picked another lane");
  assert.ok(
    Math.abs(car.targetOffset - hazard.offset) >= (car.w + hazard.w) / 2,
    "the lane it picked still overlaps the hazard",
  );
  assert.ok(car.targetSpeed > 0, "it must not stop for something it can drive around");
});

test("a car with road to spare passes a hazard at full speed", () => {
  // Tier 3 is a floor, not a target: braking must not leak into the ordinary
  // case, or the whole road would slow down every time a roadblock appeared.
  const { car } = hazardScenario(2000);
  assert.equal(car.targetSpeed, car.cruiseSpeed);
});

test("a car that cannot fit the swerve in slows down until it can", () => {
  // The tier the user asked for: a hazard is static, so going slower does not
  // let it get away — it just buys the seconds a lane change costs.
  const { car } = hazardScenario(90);
  assert.ok(
    car.targetSpeed < car.cruiseSpeed,
    `expected braking with only 90 units of road, got ${car.targetSpeed}`,
  );
  assert.ok(car.targetSpeed >= 0, "speed must never go negative");
});

test("a boxed-in car still slows, even with no lane to aim at", () => {
  // Every lane hazardous: there is no line to steer to, and the car must not
  // simply give up and drive on at cruise. Stopping in front of a hazard is an
  // acceptable outcome — see behaviours.js's tier 3.
  const car = driver({
    worldY: 0, offset: 0, w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: 0,
    type: { behaviour: "cruise", w: 34, steerSpeed: 90 },
  });
  // One hazard wide enough to cover the whole road, close ahead.
  const wall = { worldY: 80, offset: 0, w: 1000, h: 14, alive: true, threat: 30 };
  driveCar(car, 1 / 60, { cars: [car], obstacles: [wall], playerBody: null });
  assert.ok(
    car.targetSpeed < car.cruiseSpeed,
    `a car with nowhere to go must slow down, got ${car.targetSpeed}`,
  );
});

test("a driver with the nerve for it holds its line through a hazard", () => {
  // A barger neither steers nor brakes: it means to hit the thing.
  const { car } = hazardScenario(150, { nerve: 20 });
  assert.equal(car.targetOffset, laneOffset(1), "nerve 20 should shrug off an 8-hull hit");
  assert.equal(car.targetSpeed, car.cruiseSpeed, "and should not slow for it either");
});

test("behaviours still run with no obstacle system at all", () => {
  // `obstacles` is optional in the world view — Traffic seeds it empty, but a
  // caller that never sets it must not crash the road.
  const car = driver({
    worldY: 0, offset: 0, w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: 0,
    type: { behaviour: "cruise", w: 34, steerSpeed: 90 },
  });
  driveCar(car, 1 / 60, { cars: [car], playerBody: null });
  assert.equal(car.targetSpeed, car.cruiseSpeed);
});

// --- Driving profiles ----------------------------------------------------------
//
// Two cars running the SAME tactic and differing only in the table they point at
// is the whole claim driving.js makes. These check the claim holds for each knob
// that has teeth, rather than checking the numbers themselves.

const HUSTLER = DRIVING_PROFILES.hustler;

// A car mid-lane-1, optionally shoved off the centre-line, driven one tick.
function laneScenario(offset, drive, world = { cars: [], playerBody: null }) {
  const car = driver({
    worldY: 0, offset, w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: offset, drive,
    type: { behaviour: "cruise", w: 34, steerSpeed: 90, speedMax: 400 },
  });
  driveCar(car, 1 / 60, { obstacles: [], ...world, cars: [car, ...world.cars] });
  return car;
}

test("a disciplined driver aims back at the lane centre it was shoved off", () => {
  // Nothing else re-derives which lane a car belongs in: `cruise` never wrote
  // targetOffset at all, so before keepLane a rammed car steered back to the
  // lane it SPAWNED in, however many manoeuvres ago that was.
  const car = laneScenario(laneOffset(1) + 20, COMMUTER);
  assert.equal(car.targetOffset, laneOffset(1), "commuter discipline is dead centre");
});

test("a sloppy driver holds the line it was shoved to", () => {
  // The same shove, the same tactic, the other profile. laneDiscipline is read
  // as a tolerance, so the hustler accepts sitting off centre and rides the lane
  // edge — which is the most visible difference between the two on the road.
  const off = laneOffset(1) + 20;
  const car = laneScenario(off, HUSTLER);
  assert.equal(car.targetOffset, off, "the hustler should hold its line inside the slack");
  assert.notEqual(car.targetOffset, laneOffset(1));
});

test("a lane preference is not worth a lane change through traffic", () => {
  // The hustler wants the inner lane. It may drift over when the road allows it
  // and must not grind across when it does not — every swerve is a collision.
  const outer = laneOffset(0);
  const clear = laneScenario(outer, HUSTLER);
  assert.ok(clear.targetOffset > outer, "a free inner lane should draw it over");

  const occupant = { worldY: 50, offset: laneOffset(1), w: 34, h: 60, speed: 300, alive: true };
  const held = laneScenario(outer, HUSTLER, { cars: [occupant], playerBody: null });
  assert.equal(held.targetOffset, outer, "an occupied inner lane must not");
});

// A hazard dead ahead in lane 1, with every other lane occupied by traffic. The
// only way through is a lane with a car in it — so what the driver does here is
// decided entirely by what it is willing to hit.
function boxedIn(contact) {
  const car = driver({
    worldY: 0, offset: laneOffset(1), w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: laneOffset(1), contact,
    type: { behaviour: "cruise", w: 34, steerSpeed: 90, speedMax: 400 },
  });
  const hazard = {
    worldY: 150, offset: laneOffset(1), w: 60, h: 14, alive: true, threat: 8,
  };
  const others = [0, 2, 3].map((i) => ({
    worldY: 60, offset: laneOffset(i), w: 34, h: 60, speed: 300, alive: true,
  }));
  driveCar(car, 1 / 60, { cars: [car, ...others], obstacles: [hazard], playerBody: null });
  return car;
}

test("a careful driver stops for a hazard rather than drive into traffic", () => {
  // The sedan's rule, and the one genuinely new capability behind it: with no
  // lane it will take, the hazard is handed to followSpeed as a lead car doing
  // zero. Following a hazard is never the answer WHILE A LANE IS AVAILABLE — and
  // it is exactly the answer when none is.
  const car = boxedIn(0);
  assert.equal(car.targetSpeed, 0, "a commuter with nowhere to go must stop");
});

test("a driver that will take the bump keeps rolling instead", () => {
  // Same road, same tactic, one number different. This is the trade that used to
  // be hard-coded for every car on the road ("a fender-bender beats a blast")
  // and is now the thing that tells two civilians apart: one gives up its speed,
  // the other spends a bump to keep it.
  const car = boxedIn(10);
  assert.ok(car.targetSpeed > 0, "it should have taken a lane and kept moving");
  assert.notEqual(car.targetOffset, laneOffset(1));
});

test("a car that stops for a hazard still gets off the hazard's line", () => {
  // FOUND BY MEASURING THE ROAD, not by reading it. Stopping alone left the car
  // holding the line it had — which is by definition the line with the roadblock
  // in it. It then sat there as a stationary object in a live lane until
  // something rear-ended it and shunted it into the very thing it had stopped
  // for: every single civilian hazard strike in a 15 car-minute sample was that,
  // and nothing else. So the refuge is taken even with somebody standing in it,
  // because by then the car has already given up its speed and the contact it
  // accepts is a nudge rather than a swipe.
  const car = boxedIn(0);
  const hazard = { offset: laneOffset(1), w: 60 };
  assert.ok(
    Math.abs(car.targetOffset - hazard.offset) >= (car.w + hazard.w) / 2,
    `stopped car is aiming at ${car.targetOffset}, still inside the hazard's line`,
  );
});

// A car held up by something slower in the same lane, driven for `seconds`.
function heldUp(drive, seconds) {
  const car = driver({
    worldY: 0, offset: laneOffset(1), w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: laneOffset(1), drive,
    type: { behaviour: "overtake", w: 34, steerSpeed: 90, speedMax: 400 },
  });
  const lead = {
    worldY: 150, offset: laneOffset(1), w: 34, h: 60, speed: 200, alive: true,
  };
  const world = { cars: [car, lead], obstacles: [], playerBody: null };
  for (let t = 0; t < seconds * 60; t++) driveCar(car, 1 / 60, world);
  return car;
}

test("patience decides how long a car sits behind a blocker before passing", () => {
  // Before this, a pass fired the instant the trigger distance was met, so the
  // only thing separating two overtakers was how fast they could steer.
  assert.equal(heldUp(COMMUTER, 0.5).passTarget ?? null, null, "1.2s of patience");
  assert.ok(heldUp(COMMUTER, 2).passTarget, "and it does eventually go");
  assert.ok(heldUp(HUSTLER, 0.5).passTarget, "0.2s of patience goes much sooner");
});

test("frustration is reset when the road clears, not carried around", () => {
  // heldTime measures how long this car has been stuck, not how old it is —
  // otherwise a car that spent a minute in clear traffic would pass the instant
  // it ever met anybody.
  const car = driver({
    worldY: 0, offset: laneOffset(1), w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: laneOffset(1), heldTime: 5,
    type: { behaviour: "overtake", w: 34, steerSpeed: 90, speedMax: 400 },
  });
  driveCar(car, 1 / 60, { cars: [car], obstacles: [], playerBody: null });
  assert.equal(car.heldTime, 0, "an empty road must clear the timer");
});

test("a driver prices a contact with the same formula the solver applies", () => {
  // behaviours.js decides whether to take a lane using collisions.js's own
  // impactCost. A copy of the arithmetic would drift, and a driver making its
  // decisions against physics the game does not run would be wrong in exactly
  // the cases that matter.
  const a = { mass: 1 };
  const b = { mass: 1 };
  let taken = 0;
  const bodies = [
    { ...a, worldY: 0, offset: 0, prevOffset: 0, w: 34, h: 60, speed: 300,
      vLateral: 0, alive: true, damage: (hp) => (taken += hp) },
    { ...b, worldY: 40, offset: 0, prevOffset: 0, w: 34, h: 60, speed: 100,
      vLateral: 0, alive: true, damage: () => {} },
  ];
  resolveCollisions(bodies, 1 / 60);
  assert.ok(taken > 0, "the fixture must actually collide, or this proves nothing");
  assert.equal(taken, impactCost(a, b, 200, 1), "the solver and the estimate disagree");
});

// --- Enemy armament -----------------------------------------------------------

const ENEMY_GUN = ENEMY_WEAPON_TYPES[0];

test("every hostile is armed and nothing else is", () => {
  // game/armament.js: "every hostile is armed, and nothing else is" — faction is
  // the default rather than a per-type flag, so a new enemy type is armed by
  // existing. The other half matters more: an armed civilian would shoot at the
  // player, and killing it back would still fine them (score.js).
  for (const t of CAR_TYPES) {
    const armed = armamentFor(t) !== null;
    assert.equal(armed, t.value >= 0, `${t.id}: armed=${armed} does not match its faction`);
  }
});

test("the enemy's gun is not something the player can end up holding", () => {
  // weapons.js keeps two catalogues for exactly this: Loadout defaults to
  // WEAPON_TYPES and the Phase 5 pickups will roll from it, so anything added
  // there is a weapon the player can pick up.
  const playerIds = new Set(WEAPON_TYPES.map((t) => t.id));
  for (const t of ENEMY_WEAPON_TYPES) {
    assert.ok(!playerIds.has(t.id), `${t.id} appears in the player's catalogue`);
  }
  const loadout = new Loadout();
  assert.ok(
    !loadout.weapons.some((w) => w.type === ENEMY_GUN),
    "the default loadout handed the player the enemy's gun",
  );
});

test("one hostile gun stays inside its sanity band", () => {
  // A BAND, NOT A TARGET — weapons.js is explicit that the blaster is tuned by
  // measuring the road, since what matters is how much hull a minute of driving
  // costs and that depends on how often a gun bears. This only catches the
  // change nobody would measure after: raising `damage` or dropping `interval`
  // far enough that a single hostile becomes a countdown on its own.
  const seconds = (new Player(0, 0).maxHealth / ENEMY_GUN.damage) * ENEMY_GUN.interval;
  assert.ok(
    seconds >= 15,
    `one blaster now empties the player's hull in ${seconds.toFixed(1)}s on its own — ` +
      `too fast for a road that puts several of them on the player at once`,
  );
});

test("every hostile type can shoot behind it", () => {
  // A rearward round leaves the muzzle at the shooter's speed MINUS the muzzle
  // speed (projectiles.js's `dir`), so it only travels backwards while the
  // muzzle speed clears the catalogue's ceiling. Below that, the quickest
  // hostiles quietly lose the ability to shoot at a player sitting behind them —
  // which is most of the time, given where the player is framed.
  assert.ok(
    ENEMY_GUN.muzzleSpeed > fastest,
    `blaster muzzleSpeed ${ENEMY_GUN.muzzleSpeed} must exceed the fastest cruise ${fastest}`,
  );
});

test("a rearward round travels back down the road and still hits", () => {
  // The whole of what projectiles.js needed for enemy fire: a sign on the muzzle
  // speed. The swept hit test is direction-agnostic, and this is what proves it.
  const shots = new Projectiles();
  const s = shots.spawn(0, 0, 400, ENEMY_GUN, 600, -1);
  assert.equal(s.speed, 400 - ENEMY_GUN.muzzleSpeed);
  assert.ok(s.speed < 0, "a rearward shot from a car slower than its gun must go backwards");

  let taken = 0;
  const target = {
    worldY: -180, offset: 0, w: 34, h: 60, alive: true,
    damage(hp) { taken += hp; },
  };
  const view = { distance: 0, playerY: 496, W: 600, H: 800 };
  for (let i = 0; i < 120 && taken === 0; i++) shots.update(1 / 60, [target], view);

  assert.equal(taken, ENEMY_GUN.damage, "the round should have run down onto the car behind it");
  assert.ok(!s.alive, "and been consumed by the hit");
  assert.ok(s.worldY < 0, "it must have ended up behind where it was fired");
});

// An armed hostile at the origin, with the player somewhere near it, driven
// through a real hostile behaviour. `fired` / `laid` record what reached the
// world hooks, which is the only observable this layer has.
function hostileScenario(over = {}, worldOver = {}) {
  const type = CAR_TYPES.find((t) => t.id === "interceptor");
  const car = driver({
    worldY: 0, offset: 0, w: type.w, h: type.h, speed: 420, cruiseSpeed: 420,
    targetSpeed: 420, targetOffset: 0,
    type, drive: drivingFor(type), arms: armFor(type),
    ...over,
  });
  const playerBody = {
    worldY: 300, offset: 0, w: 34, h: 60, speed: 300, alive: true,
    damage() {},
    ...(worldOver.playerBody ?? {}),
  };
  const fired = [];
  const laid = [];
  const world = {
    cars: [car], obstacles: [], playerBody,
    player: new Player(300, 496), H: 800,
    fireShot: (c, t, dir) => fired.push({ car: c, type: t, dir }),
    dropMine: (c, t) => (laid.push({ car: c, type: t }), true),
    ...worldOver,
    playerBody, // worldOver may only override the body's FIELDS, above
  };
  driveCar(car, 1 / 60, world);
  return { car, world, fired, laid };
}

test("a hostile shoots at a player in front of it, up the road", () => {
  const { fired } = hostileScenario();
  assert.equal(fired.length, 1, "expected exactly one round");
  assert.equal(fired[0].dir, 1, "a player ahead must be shot at up the road");
  assert.equal(fired[0].type, ENEMY_GUN);
});

test("a hostile ahead of the player shoots back down the road", () => {
  // The case the `dir` parameter exists for: the enemy is in front, which is
  // where the framing puts most of them.
  const { fired } = hostileScenario({}, { playerBody: { worldY: -260 } });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].dir, -1, "a player behind must be shot at back down the road");
});

test("a hostile holds fire on a player out of its line", () => {
  const { fired } = hostileScenario({}, { playerBody: { offset: 120 } });
  assert.equal(fired.length, 0, "a shot two lanes wide of the player is wasted");
});

test("a hostile holds fire from off screen", () => {
  // game/armament.js: "a car firing from beyond the edge of the screen is an
  // unattributable hit". A player framed at 62% down an 800px canvas can see
  // 304 units of road behind them, so a car 290 back may shoot and one 400 back
  // may not — even though both are inside GUN_RANGE.
  const seen = hostileScenario({}, { playerBody: { worldY: 290 } });
  assert.equal(seen.fired.length, 1, "a car still on screen behind the player should fire");
  const unseen = hostileScenario({}, { playerBody: { worldY: 400 } });
  assert.equal(unseen.fired.length, 0, "a car below the bottom edge must not fire");
});

test("a hostile does not fire a round that cannot catch anything", () => {
  // A car quicker than its own muzzle speed puts rearward rounds out that still
  // drift forwards. Rather than tune the case away, the shot is not taken — and
  // a car pulling away from the player ceasing fire reads correctly anyway.
  const { fired } = hostileScenario(
    { speed: ENEMY_GUN.muzzleSpeed + 400 },
    { playerBody: { worldY: -260 } },
  );
  assert.equal(fired.length, 0, "a round that never closes must not be fired");
});

test("a civilian carries nothing and never fires", () => {
  const sedan = CAR_TYPES.find((t) => t.id === "sedan");
  assert.equal(armFor(sedan), null);
  const { fired, laid } = hostileScenario({ type: sedan, arms: armFor(sedan) });
  assert.equal(fired.length, 0);
  assert.equal(laid.length, 0);
});

test("a hostile lays the catalogue's mine at a player on its tail", () => {
  const { laid } = hostileScenario({}, { playerBody: { worldY: -200 } });
  assert.equal(laid.length, 1, "expected one mine");
  assert.equal(laid[0].type, obstacleTypeById("caltrop"), "the payload must be the mine");
});

test("a hostile does not mine somebody else's traffic", () => {
  // The scoring rule of cartypes.js's NERVE section, at the other end: score.js
  // pays out however a car died, so a civilian killed by a mine the player never
  // laid would fine them for a kill they had no part in.
  const between = {
    worldY: -100, offset: 0, w: 34, h: 60, speed: 300, alive: true,
    type: CAR_TYPES.find((t) => t.id === "sedan"),
  };
  const clear = hostileScenario({}, { playerBody: { worldY: -200 } });
  assert.equal(clear.laid.length, 1, "the test is meaningless if this case does not lay one");

  const blockedByTraffic = hostileScenario({}, {
    playerBody: { worldY: -200 },
    cars: [between],
  });
  assert.equal(blockedByTraffic.laid.length, 0, "a car between the two must veto the drop");
});

test("a hostile will not drop a mine into the player's face", () => {
  // MINE_MIN_LEAD: a mine that appears with no road left to steer around it is
  // not a threat the player can answer, it is just damage.
  const { laid } = hostileScenario({}, { playerBody: { worldY: -40 } });
  assert.equal(laid.length, 0);
});

test("a mine layer runs dry, and its magazine is what rations mines", () => {
  // weapons.js's blaster is deliberately infinite and the layer deliberately is
  // not — see game/armament.js. This pins the pair: a car cannot mine the road
  // indefinitely.
  const arms = armFor(CAR_TYPES.find((t) => t.id === "interceptor"));
  assert.equal(arms.gun.ammo, Infinity, "the enemy gun must never run out");
  assert.ok(Number.isFinite(arms.layer.ammo) && arms.layer.ammo > 0);
  for (let i = 0; i < arms.layer.type.ammo; i++) {
    arms.layer.cooldown = 0;
    assert.ok(arms.layer.tryFire());
  }
  arms.layer.cooldown = 0;
  assert.ok(!arms.layer.tryFire(), "the layer should be empty");
});

test("a laid mine sits clear behind the car that dropped it", () => {
  // obstacles.js's DROP_CLEARANCE: the contact test makes no exception for
  // whoever laid it, so a car sitting inside its own mine would detonate it on
  // the tick it appeared.
  const obstacles = new Obstacles(new Explosions());
  const mine = obstacleTypeById("caltrop");
  const car = { worldY: 1000, offset: 20, h: 62, w: 34 };
  assert.ok(obstacles.drop(mine, car));

  const o = obstacles.list[0];
  assert.ok(o.laid, "a dropped obstacle must be marked as laid");
  assert.equal(o.offset, 20, "it belongs where the car was, not on a lane centre");
  assert.ok(o.worldY < car.worldY, "it must be behind the car");
  assert.ok(
    car.worldY - o.worldY > (car.h + o.h) / 2,
    "the dropper is sitting inside its own mine",
  );
});

test("laid mines and road furniture are budgeted separately", () => {
  // obstacles.js keeps two caps: a run of roadblocks must not quietly disarm
  // every enemy on the road, and a firefight must not starve the road of
  // obstacles. Each failure would look like a bug in the other system.
  const obstacles = new Obstacles(new Explosions());
  const mine = obstacleTypeById("caltrop");
  const car = { worldY: 1000, offset: 0, h: 62, w: 34 };

  let laid = 0;
  while (obstacles.drop(mine, car)) laid++;
  assert.ok(laid > 0 && laid < 8, `expected a small mine cap, got ${laid}`);
  assert.equal(obstacles.count(true), laid);
  assert.equal(obstacles.count(false), 0, "no mine may count against the spawner's budget");

  // ...and the spawner still works with the mine budget full.
  const world = obstacleWorld();
  obstacles.spawn(world);
  assert.equal(obstacles.count(false), 1, "the spawner should be unaffected by laid mines");
});

// --- Obstacle placement -------------------------------------------------------

test("each obstacle type is placed where its catalogue entry says", () => {
  // obstacletypes.js's placement modes, resolved through the real spawner. This
  // is the whole user-visible point of the field: barrels at the edge, trestles
  // in a lane, tetras in the middle, mines anywhere.
  const spots = (id, n) => {
    const type = obstacleTypeById(id);
    const [w] = OBSTACLE_SHAPES[type.shape].size;
    const out = [];
    for (let i = 0; i < n; i++) {
      // A fresh road each time, so nothing that was just placed blocks the next.
      const offset = new Obstacles(new Explosions()).freeOffset(type, 1000, []);
      assert.notEqual(offset, null, `${id}: found nowhere to go on an empty road`);
      out.push({ offset, w });
    }
    return out;
  };

  const edge = ROAD_HALF_WIDTH;
  for (const { offset, w } of spots("barrels", 20)) {
    // Flush with a barrier: the box edge touches the road edge on one side.
    const touching = Math.min(Math.abs(offset - w / 2 + edge), Math.abs(offset + w / 2 - edge));
    assert.ok(touching < 0.001, `barrels at ${offset.toFixed(1)} is not against a barrier`);
  }

  const laneCentres = Array.from({ length: LANE_COUNT }, (_, i) => laneOffset(i));
  for (const { offset } of spots("trestle", 20)) {
    assert.ok(laneCentres.includes(offset), `trestle at ${offset} is not on a lane centre`);
  }

  for (const { offset } of spots("tetra", 10)) {
    assert.equal(offset, 0, "a tetra belongs on the centre-line");
  }

  // The mine is the only type that may be anywhere — which is only observable as
  // it NOT collapsing onto the handful of offsets the other three use.
  const mines = spots("caltrop", 30).map((s) => s.offset);
  assert.ok(new Set(mines).size > 20, "mine placement looks quantised, not free");
  assert.ok(
    mines.some((o) => !laneCentres.includes(o)),
    "no mine landed off a lane centre",
  );
});

test("every obstacle keeps its whole box on the road", () => {
  // A placement may push a hazard flush against a barrier, never past one.
  for (const type of OBSTACLE_TYPES) {
    const [w] = OBSTACLE_SHAPES[type.shape].size;
    const offset = new Obstacles(new Explosions()).freeOffset(type, 1000, []);
    assert.notEqual(offset, null, `${type.id}: found nowhere to go on an empty road`);
    const overhang = Math.abs(offset) + w / 2 - ROAD_HALF_WIDTH;
    assert.ok(
      overhang <= 0.001,
      `${type.id} overhangs the barrier by ${overhang.toFixed(1)}px`,
    );
  }
});

test("a lane- or side-placed obstacle fits inside one lane, artwork and all", () => {
  // Two defects, both reported against the live game, both this shape:
  //
  //   PLACE_LANE  the trestle was 1.25 lanes wide, so sitting on a lane centre
  //               put it 8px over the dashed centre-line. "In the middle of a
  //               lane" only means anything for something a lane can hold.
  //   PLACE_SIDE  the barrels were 1.24 lanes wide, which made the one block the
  //               player is invited to aim AT also the one they could not line
  //               up on from inside their own lane. It also kept a four-lane
  //               road from having three clean lanes left beside it.
  //
  // The bound is on the ARTWORK (`extent`), not the collision box, since the
  // glow is what the player actually sees crossing a line. See TRESTLE_WIDTH and
  // BARRELS_WIDTH in obstacleshapes.js.
  //
  // PLACE_CENTRE is deliberately exempt: the tetra is meant to straddle the
  // centre-line and take a bite out of both middle lanes.
  for (const type of OBSTACLE_TYPES) {
    if (type.placement !== PLACE_LANE && type.placement !== PLACE_SIDE) continue;
    const shape = OBSTACLE_SHAPES[type.shape];
    const [w] = shape.size;
    assert.ok(
      w <= LANE_WIDTH,
      `${type.id} is ${w}px wide but a lane is only ${LANE_WIDTH}px`,
    );
    assert.ok(
      shape.extent.x <= LANE_WIDTH / 2,
      `${type.id}'s artwork reaches ${shape.extent.x}px, past its lane's ${LANE_WIDTH / 2}px edge`,
    );
  }
});

test("every obstacle extent is derived from the shape's own geometry", () => {
  // THIS TEST GUARDS THE TEST ABOVE. The lane-fit assertion is only worth
  // anything if `extent` is the artwork's real reach, and for three of the four
  // shapes it once was not: the trestle declared 29 and drew 33, the tetra
  // declared 37.8 and drew 39, the caltrop declared 20 and drew 21. Nothing
  // broke visibly — sprites.js pads by GLOW_PAD, which absorbed the shortfall —
  // but the lane-fit test was passing on a number that was not the drawing, and
  // the trestle really was half a pixel over its lane edge.
  //
  // The honest check would render each shape and scan the pixels. Node has no
  // canvas, and an obstacle's artwork is a draw() call rather than the point
  // data carShapeExtent gets to measure, so that check cannot run here — see
  // GLOW_BLEED in obstacleshapes.js for the browser snippet that does it.
  //
  // What CAN be enforced headlessly is the discipline that made the numbers
  // right: every extent field must be an expression over the shape's own named
  // constants plus a measured *_BLEED, never a literal somebody typed. A
  // hand-typed number is a claim no one re-measures; a derived one moves when
  // the geometry moves.
  const src = readFileSync(new URL("../src/game/obstacleshapes.js", import.meta.url), "utf8");

  // Extent objects contain no nested braces, so a non-greedy brace match is
  // enough of a parser here.
  const blocks = src.match(/extent:\s*\{[^}]*\}/g) ?? [];
  assert.equal(
    blocks.length,
    OBSTACLE_SHAPES.length,
    "every shape should declare exactly one extent block that this test can read",
  );

  for (const block of blocks) {
    const body = block.replace(/extent:\s*\{/, "").replace(/\}$/, "");
    const fields = body.split(",").map((f) => f.trim()).filter(Boolean);
    assert.deepEqual(
      fields.map((f) => f.split(":")[0].trim()),
      ["x", "up", "down"],
      `extent must declare x, up and down: ${block}`,
    );
    for (const field of fields) {
      const expr = field.slice(field.indexOf(":") + 1).trim();
      assert.match(
        expr,
        /_BLEED\b/,
        `extent field "${field}" must add a measured glow bleed — the artwork ` +
        "reaches past its geometry, and that is the part that leaves the lane",
      );
      // ...and no TERM of the sum may be a bare number, which is what rules out
      // the old `x: 20 + GLOW_BLEED` shape of thing: the bleed was named, but
      // the reach it was added to was still typed from memory. A divisor is
      // fine (TRESTLE_WIDTH / 2 is half a named width, not a guess).
      for (const term of expr.split("+")) {
        assert.match(
          term.trim(),
          /[A-Z][A-Z0-9_]*/,
          `extent field "${field}" adds a bare number — derive it from the ` +
          "shape's own constants so it moves when the artwork does",
        );
      }
    }
  }
});

test("a spawn never closes the road, whatever the placement asks for", () => {
  // THE PASSAGE RULE (game/obstacles.js), which replaced a lane count: the
  // question is whether a drivable gap survives, not whether a lane index is
  // free. Four mines on four lane centres pass a lane count and are impassable,
  // which is exactly the case the old rule got wrong.
  const obstacles = new Obstacles(new Explosions());
  const mine = obstacleTypeById("caltrop");
  const [mineW] = OBSTACLE_SHAPES[mine.shape].size;

  // Park a mine on every lane centre by hand. Between them they leave gaps of
  // LANE_WIDTH - mineW = 39px, which no car in the catalogue fits through.
  for (let i = 0; i < LANE_COUNT; i++) {
    obstacles.list.push({
      alive: true, laid: false, worldY: 1000, offset: laneOffset(i), w: mineW, h: 26,
    });
  }
  const widest = Math.max(...CAR_TYPES.map((t) => t.w));
  assert.ok(LANE_WIDTH - mineW < widest, "this fixture no longer blocks the road");

  for (const type of OBSTACLE_TYPES) {
    assert.equal(
      obstacles.freeOffset(type, 1000, []),
      null,
      `${type.id} was placed on a road that already has no way through`,
    );
  }
});

test("the passage rule is sized against the widest car in the catalogue", () => {
  // A relation between two files: obstacles.js promises a way through, and that
  // promise is only worth making if the rig can use it. Widen a car past the gap
  // the spawner guarantees and the road starts producing hazards the heaviest
  // traffic cannot get around however well it drives.
  const obstacles = new Obstacles(new Explosions());
  const widest = Math.max(...CAR_TYPES.map((t) => t.w));

  // One wall spanning the road from the left barrier, leaving exactly `gap` of
  // clear tarmac against the right one.
  const leaves = (gap) =>
    obstacles.leavesPassage(1000, -gap / 2, 2 * ROAD_HALF_WIDTH - gap);

  for (let gap = 0; gap <= 2 * ROAD_HALF_WIDTH; gap += 2) {
    if (leaves(gap)) {
      assert.ok(
        gap >= widest,
        `a ${gap}px gap was accepted, but the widest car is ${widest}px`,
      );
    }
  }
  // ...and it has to accept something, or the rule reduces to "never spawn".
  assert.ok(leaves(2 * ROAD_HALF_WIDTH), "an empty road must be placeable");
});
