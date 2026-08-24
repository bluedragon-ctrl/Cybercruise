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
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CAR_TYPES, FOCUS, pickCarType, typeAvailable, ENEMY_FACTION } from "../src/game/cartypes.js";
import { CAR_SHAPES, carShapeExtent, shapeExtent } from "../src/game/carshapes.js";
import { BOSS_SHAPES } from "../src/game/bossshapes.js";
import {
  ACCEL as TRAFFIC_ACCEL,
  RETIRE_MARGIN as TRAFFIC_RETIRE_MARGIN,
  Traffic,
} from "../src/game/traffic.js";
import { driveCar, dodgeDistance, TACTIC_NAMES, TRAIL_ENGAGE } from "../src/game/behaviours.js";
import { DRIVING_PROFILES, drivingFor, typesDriving } from "../src/game/driving.js";
import {
  MIN_SPEED, MAX_SPEED, ACCEL as PLAYER_ACCEL, PLAYER_MASS, Player,
  SHIELD_EXPIRING as PLAYER_SHIELD_EXPIRING,
} from "../src/game/player.js";
import { WHEEL_FRAMES, BUILDING_VARIANTS, buildingFootprint } from "../src/game/sprites.js";
import {
  LANE_COUNT, LANE_WIDTH, ROAD_HALF_WIDTH, laneAt, laneOffset, centerXAt,
  centerOffset, headingAt,
  TILE_STRIDE, DASH_SPAN, blockOf, blockLocalY, blockDestY,
  DIST_UNITS,
} from "../src/game/road.js";
import {
  gridPhase, GRID_SPACING, STREET_WIDTH, STREET_INSET,
  trafficDots, crossStreetBands, avenueCenters, visibleBuildings, visibleNodes,
  tileIntersections, makeBoundedCache, currentSector,
  DOT_SPACING, DOT_SPEED_A, DOT_SPEED_B, DOT_LANE_PHASE,
  FLOOR_PARALLAX, floorDist,
  WIPE_SPAN, materialiseProgress,
} from "../src/game/scenery.js";
import { droneField, DRONE_PARALLAX } from "../src/game/drones.js";
import {
  conduitField, pingField, callsign, announcement, announce, activePing, announceActive,
  nodeId, nodeValue, pingingNodes,
  reset as linksReset,
} from "../src/game/links.js";
import { Wallet, HARVEST_RADIUS, CREDITS_KEY, loadBanked } from "../src/game/wallet.js";
import { edgesAt } from "../src/game/road.js";
import {
  HINT as CONSOLE_HINT, WARN as CONSOLE_WARN, CRITICAL as CONSOLE_CRITICAL,
  push as consolePush, onPush as consoleOnPush, reset as consoleReset,
} from "../src/engine/console.js";
import { CONSOLE_SOUND, CONSOLE_PITCH } from "../src/audio/consolesfx.js";
import { OBSTACLE_SHAPES } from "../src/game/obstacleshapes.js";
import {
  CELL, PLOT, LOT, LOT_SUBDIV, ARTERIAL_PERIOD, SECTOR_PERIOD, sectorIndex,
  lotAt, lotColumns, lotRows, lotX, lotY, plotColumns,
  plotAt, plotRows, plotX, plotY,
  isAvenueCol, isCrossStreetRow, BUILDING, EMPTY, AVENUE, CROSS_STREET, NODE,
} from "../src/game/citygrid.js";
import { NODE_VARIANTS } from "../src/game/nodeshapes.js";
import { resolveCollisions, impactCost, ramSpeed, SIDE_DAMAGE } from "../src/game/collisions.js";
import { Score, DISTANCE_POINTS } from "../src/game/score.js";
import { Loadout, Weapon, WEAPON_TYPES, ENEMY_WEAPON_TYPES } from "../src/game/weapons.js";
import {
  OBSTACLE_TYPES, obstacleTypeById, obstacleAvailable, pickObstacleType,
  PLACE_LANE, PLACE_SIDE,
} from "../src/game/obstacletypes.js";
import { Obstacles, SPAWN_MARGIN as OBSTACLE_SPAWN_MARGIN } from "../src/game/obstacles.js";
import { Explosions } from "../src/game/effects.js";
import { Projectiles } from "../src/game/projectiles.js";
import { armFor, armamentFor } from "../src/game/armament.js";
import {
  NEUTRAL_PALE, SECTOR_COUNT, setSector, BUILDING_EDGE,
  PLAYER, PLAYER_THRUST, HAZARD, CRITICAL_FLASH,
  ENEMY, ENEMY_DEEP, ENEMY_PALE, ENEMY_THRUST,
  NEUTRAL, NEUTRAL_DEEP, NEUTRAL_THRUST,
  GREEN, GREEN_BRIGHT, GREEN_PALE, GREEN_DIM,
} from "../src/engine/palette.js";
import {
  sectorName, update as sectorsUpdate, reset as sectorsReset, glitching as sectorsGlitching,
} from "../src/game/sectors.js";
import { PICKUP_SHAPES } from "../src/game/pickupshapes.js";
import { PICKUP_TYPES, AMMO, HEAL, SHIELD, applyPickup, pickupTypeById } from "../src/game/pickuptypes.js";
import { Pickups } from "../src/game/pickups.js";
import {
  GLOBAL_VOICE_CAP, planVoiceRequest, commitVoice,
  DUCK_ATTACK, DUCK_RELEASE, planDuck,
  isStarted,
} from "../src/audio/context.js";
import { SOUND_TYPES, soundTypeById } from "../src/audio/soundtypes.js";
import { JACK_IN_DURATION } from "../src/audio/sfx.js"; // also registers every catalogue entry's generator, same side effect the old bare import had
import { PLAYER_FIRE_SOUND, ENEMY_FIRE_SOUND } from "../src/audio/weaponsfx.js";
import { PICKUP_SOUND } from "../src/audio/pickupsfx.js";
import { MENU_ACTIONS, MENU_SOUND } from "../src/audio/menusfx.js";
import { SUSTAINED_TYPES, sustainedTypeById } from "../src/audio/sustainedtypes.js";
import "../src/audio/sustainedfx.js"; // side effect: registers every sustained voice's generator
import {
  planAcquire as sustainedPlanAcquire, planSetLevel as sustainedPlanSetLevel, planRelease as sustainedPlanRelease,
} from "../src/audio/sustained.js";
import {
  HULL_HISS_ON, HULL_HISS_OFF, HULL_HISS_PEAK, hullHissActive, hullHissLevel,
  DROPOUT_HULL_THRESHOLD, DROPOUT_MIN_INTERVAL, DROPOUT_MAX_INTERVAL, DROPOUT_MIN_HOLD, DROPOUT_MAX_HOLD,
  stepDropoutTimer, dropoutHoldSeconds,
  CRACKLE_HULL_THRESHOLD, CRACKLE_MIN_INTERVAL, CRACKLE_MAX_INTERVAL, stepCrackleTimer,
  shieldDroneLevel, SHIELD_DRONE_FADE_WINDOW,
  DREAD_RANGE_ON, DREAD_RANGE_OFF, DREAD_RATE_MIN, DREAD_RATE_MAX,
  dreadProximity, dreadPulseLevel, dreadPulseRate, dreadPulseActive,
} from "../src/audio/sustainedfx.js";
import {
  MUSIC_CUTOFF_MIN, MUSIC_CUTOFF_MAX, speedToMusicCutoff,
  MUSIC_CUTOFF_FLOOR, SECTOR_COLLAPSE_OFFSET, SECTOR_COLLAPSE_ATTACK, SECTOR_COLLAPSE_RELEASE,
  composeMusicCutoff, planSetMusicCutoff, planBeginSectorTransition,
  DISCONNECT_FADE,
} from "../src/audio/context.js";
import { chooseBackend, MUSIC_BACKEND_METHODS } from "../src/audio/synth.js";
import * as proceduralmusic from "../src/audio/proceduralmusic.js";
import * as trackmusic from "../src/audio/trackmusic.js";
import {
  shuffleOrder, nextIndex, shouldLoopSingleTrack, retainedTrackNames, nextPlayableIndex, runPreload,
} from "../src/audio/trackmusic.js";
import { MUSIC_DIR, MUSIC_LISTING_URL, TRACK_GAIN, trackGainFor, trackDisplayName, validateMusicConfig } from "../src/audio/musictypes.js";
import { listMusicFiles } from "../tools/serve.js";

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
  // cartypes.js: "12 types * 8 * 2 = 192 sprites at the absolute worst" — one
  // per (type, wheel frame), doubled for the critical-hull blink colour. This is
  // what keeps the cache bounded, so it must not grow silently.
  const worstCase = CAR_TYPES.length * WHEEL_FRAMES * 2;
  assert.equal(
    worstCase,
    192,
    `traffic sprite worst case is now ${worstCase}, not the documented 192 ` +
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

test("shapeExtent bounds every point of every boss hull", () => {
  // The same guard the traffic catalogue gets above, applied to bossshapes.js.
  // These hulls have no car type yet, so nothing else in the game draws them and
  // nothing else would notice a clipped sprite until the boss phase spawns one.
  for (const shape of BOSS_SHAPES) {
    const [w, h] = shape.size;
    const ext = shapeExtent(shape, w, h);
    for (const profile of shape.parts ?? [shape.profile]) {
      for (const [fx, fy] of profile) {
        assert.ok(Math.abs(fx * (w / 2)) <= ext.x, `${shape.name}: x extent clips the profile`);
        assert.ok(-fy * (h / 2) <= ext.up, `${shape.name}: up extent clips the profile`);
        assert.ok(fy * (h / 2) <= ext.down, `${shape.name}: down extent clips the profile`);
      }
    }
  }
});

test("every boss hull says how it meets the ground", () => {
  // carshapes.js's header: a shape must carry wheels, tracks or hover, or it
  // reads as sliding along on its belly. The traffic catalogue can't get this
  // wrong (every entry has wheels); the boss catalogue is the first place where
  // omitting all three is even possible, which is exactly why it is checked.
  //
  // A hull that flies with its blot switched off (`hover: { blot: false }`, the
  // cargo drone) still passes: it HAS said how it meets the ground. That is the
  // whole reason the flag exists rather than the field just being left out --
  // silence here is a mistake, and this test has to be able to see the
  // difference.
  for (const shape of BOSS_SHAPES) {
    assert.ok(shape.wheels || shape.tracks || shape.hover,
      `${shape.name} has no wheels, tracks or hover`);
  }
});

test("boss hulls are not in the traffic catalogue", () => {
  // bossshapes.js's header: these stay out of CAR_SHAPES until they have a
  // cartypes.js record, because "one car type per silhouette" above would fail
  // the moment one lands there without one. Copying a hull across and forgetting
  // its type should break HERE, with a name in the message, rather than as a
  // count mismatch two tests up.
  const names = new Set(CAR_SHAPES.map((s) => s.name));
  for (const shape of BOSS_SHAPES) {
    assert.ok(!names.has(shape.name),
      `${shape.name} is in CAR_SHAPES — it needs a cartypes.js record, or it does not belong there`);
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

test("the floor tile's phase reproduces the world-anchored grid AND street lines", () => {
  // The tile is blitted at gridPhase() - ARTERIAL_PERIOD. Every fine-grid
  // horizontal in it sits at a multiple of GRID_SPACING, and every cross-street
  // band at a multiple of ARTERIAL_PERIOD — since GRID_SPACING divides
  // ARTERIAL_PERIOD, BOTH must land in the same residue class as the
  // world-anchored line the direct render would draw, which is the arithmetic
  // that lets them share one tile. The playerY term in the phase is the
  // load-bearing part and the easy one to drop: without it the grid is
  // misplaced by a mean channel diff of 18.6/255.
  //
  // GRID_SPACING is asserted here rather than CELL because the drawn grid is a
  // SUBDIVISION of the placement grid (CELL / GRID_SUBDIV), so testing CELL
  // would pass while the lines actually drawn were free to be misaligned.
  for (const playerY of [0, 496, 500, 803]) {
    for (let fDist = 0; fDist < 3000; fDist += 7) {
      const phase = gridPhase(fDist, playerY);
      assert.ok(phase >= 0 && phase < ARTERIAL_PERIOD, `phase ${phase} is outside one arterial period`);
      // Where the direct render puts a fine-grid line at wy = k*GRID_SPACING,
      // and a cross-street band at wy = k*ARTERIAL_PERIOD.
      for (const k of [-3, 0, 11, 47]) {
        for (const period of [GRID_SPACING, CELL, ARTERIAL_PERIOD]) {
          const direct = playerY - (k * period - fDist);
          const residue = (((direct - phase) % period) + period) % period;
          assert.ok(
            residue < 1e-9 || period - residue < 1e-9,
            `world line ${k * period} (period ${period}) lands at ${direct}, off the tile's phase ${phase}`,
          );
        }
      }
    }
  }
});

test("the drawn grid spacing subdivides the placement grid", () => {
  // The drawn grid is CELL / GRID_SUBDIV, not CELL, so the floor reads as a fine
  // mesh. Two things rest on it dividing cleanly, and both fail SILENTLY — the
  // game still runs, it just looks subtly wrong:
  //   - every plot and cell boundary must still fall ON a drawn line, or grid
  //     lines cut through the middle of the plots buildings stand on;
  //   - the whole one-tile argument in scenery.js needs GRID_SPACING to divide
  //     ARTERIAL_PERIOD, or the tile's own pattern doesn't repeat at the period
  //     it is blitted at and the fine grid shears at every wrap.
  assert.equal(CELL % GRID_SPACING, 0, `CELL ${CELL} is not a whole number of ${GRID_SPACING}px cells`);
  assert.equal(
    ARTERIAL_PERIOD % GRID_SPACING,
    0,
    `the tile repeats every ${ARTERIAL_PERIOD}px, which is not a whole number of ${GRID_SPACING}px cells`,
  );
});

test("one extra arterial period of tile height is enough to cover the screen at any phase", () => {
  // The tile is H + ARTERIAL_PERIOD tall and blitted at a negative offset in
  // [-ARTERIAL_PERIOD, 0). That single extra period is what lets ONE blit cover
  // the screen whatever the phase — the reason this layer needs no
  // position-keyed cache at all.
  const H = 800;
  for (let fDist = 0; fDist < 640; fDist += 0.5) {
    const destY = gridPhase(fDist, 496) - ARTERIAL_PERIOD;
    assert.ok(
      destY <= 0 && destY >= -ARTERIAL_PERIOD,
      `blit offset ${destY} is outside [-ARTERIAL_PERIOD, 0]`,
    );
    assert.ok(
      destY + (H + ARTERIAL_PERIOD) >= H,
      `the tile stops ${-(destY + ARTERIAL_PERIOD)}px short of the bottom`,
    );
  }
});

// --- The city floor is a pure function of its lot index -----------------------

test("lotAt is deterministic and total", () => {
  // citygrid.js's whole design rests on this: the city is infinite and identical
  // every time you drive past because nothing is stored. A lot that varied
  // between calls would make buildings flicker in and out as you approached.
  for (let lx = 0; lx < 12; lx++) {
    for (let ly = -60; ly < 60; ly++) {
      const a = lotAt(lx, ly);
      const b = lotAt(lx, ly);
      assert.deepEqual(a, b, `lot (${lx}, ${ly}) is not stable across calls`);
      assert.ok(
        a.type === BUILDING || a.type === EMPTY || a.type === AVENUE ||
          a.type === CROSS_STREET || a.type === NODE,
        `lot (${lx}, ${ly}) has an unknown type`,
      );
      if (a.type === BUILDING) {
        assert.ok(Number.isInteger(a.variant) && a.variant >= 0, "building variant must be an index");
        assert.ok(Number.isFinite(a.dx) && Number.isFinite(a.dy), "a sited building must carry a numeric dx/dy");
      }
      if (a.type === NODE) {
        assert.ok(
          Number.isInteger(a.variant) && a.variant >= 0 && a.variant < NODE_VARIANTS,
          "a node variant must be an index inside [0, NODE_VARIANTS)",
        );
      }
    }
  }
});

test("a lot claimed as a street never returns BUILDING", () => {
  // citygrid.js's reserve() runs before any lot's building roll, one PLOT at a
  // time, so a claim always wins every lot inside it outright — this is the
  // assertion that promise actually holds, not just that reserve() returns
  // something non-null.
  for (let lx = 0; lx < 12; lx++) {
    for (let ly = -60; ly < 60; ly++) {
      const bx = Math.floor(lx / LOT_SUBDIV);
      const by = Math.floor(ly / LOT_SUBDIV);
      if (!isAvenueCol(bx) && !isCrossStreetRow(by)) continue;
      const lot = lotAt(lx, ly);
      assert.notEqual(lot.type, BUILDING, `lot (${lx}, ${ly}) is on a street plot but lotAt returned BUILDING`);
      assert.ok(
        lot.type === AVENUE || lot.type === CROSS_STREET,
        `lot (${lx}, ${ly}) is on a street plot but lotAt says type ${lot.type}`,
      );
    }
  }
});

test("LOT subdivides PLOT wholly", () => {
  // Mirrors the drawn-grid-subdivides-CELL test below: LOT_SUBDIV has to be a
  // clean divisor, or a lot's edges don't land on the plot boundaries reserve()
  // reasons about, and a building could be sited straddling one.
  assert.equal(PLOT % LOT, 0, `PLOT ${PLOT} is not a whole number of ${LOT}px lots`);
  assert.equal(LOT, PLOT / LOT_SUBDIV, "LOT and LOT_SUBDIV have drifted apart");
});

test("isCrossStreetRow/isAvenueCol agree with where the ribbon is actually painted", () => {
  // citygrid.js's reserve() and scenery.js's drawn ribbon are two SEPARATE
  // derivations of "where is a street" — one from isCrossStreetRow(by)/
  // isAvenueCol(bx) alone, the other from gridPhase()/ARTERIAL_PERIOD — and
  // nothing before this enforced they agree; a bygone comment claiming "canvas
  // y = 0 stands for plot row by = 0" was the only thing tying them together,
  // and it had drifted a whole PLOT out of true (by ≡ 0 mod 4 was flagged, but
  // the tile actually paints by ≡ 3 mod 4). Quiet with one centred building
  // per plot, since a wrongly-excluded plot just stood empty and a
  // wrongly-included one had 96px of margin to hide in — glaring once
  // citygrid.js's siting starts pushing footprints flush against what it
  // BELIEVES is the plot boundary. This computes each candidate plot's ribbon
  // in screen space via the SAME playerY-(worldY-fDist) mapping road.js's own
  // tested "direct render" formula uses, and cross-checks it against
  // crossStreetBands()/avenueCenters() — scenery.js's actual output — rather
  // than re-deriving gridPhase's own arithmetic a second time.
  for (const playerY of [0, 250, 496, 803]) {
    for (let fDist = 0; fDist < ARTERIAL_PERIOD * 3; fDist += 97) {
      const bands = crossStreetBands(fDist, playerY, 800);
      for (let by = -8; by <= 8; by++) {
        const worldTop = by * PLOT + STREET_INSET;
        const screenTop = Math.min(
          playerY - (worldTop - fDist),
          playerY - (worldTop + STREET_WIDTH - fDist),
        );
        const onScreen = screenTop > -STREET_WIDTH && screenTop < 800;
        const painted = bands.some((top) => Math.abs(top - screenTop) < 1e-6);
        if (onScreen) {
          assert.equal(
            isCrossStreetRow(by), painted,
            `by=${by}'s ribbon is ${painted ? "" : "NOT "}painted at screenTop=${screenTop} ` +
              `(fDist=${fDist}, playerY=${playerY}), but isCrossStreetRow(${by}) says ${isCrossStreetRow(by)}`,
          );
        }
      }
    }
  }

  for (let W = 400; W <= 700; W += 53) {
    const centers = avenueCenters(W);
    for (let bx = 0; bx < plotColumns(W); bx++) {
      const painted = centers.includes(bx * PLOT + PLOT / 2);
      assert.equal(
        isAvenueCol(bx), painted,
        `avenue column bx=${bx} painted=${painted} but isAvenueCol(${bx})=${isAvenueCol(bx)}`,
      );
    }
  }
});

test("a building's footprint never crosses into a street ribbon", () => {
  // citygrid.js's siting pushes a footprint toward whichever edge of its lot
  // faces a street, instead of centring it — this is the check that the push
  // still stops short of the street itself, using the SAME STREET_WIDTH/
  // STREET_INSET scenery.js actually paints the ribbon with, not a value
  // re-derived here.
  for (let lx = -20; lx < 20; lx++) {
    for (let ly = -20; ly < 20; ly++) {
      const lot = lotAt(lx, ly);
      if (lot.type !== BUILDING) continue;

      const { w, d } = buildingFootprint(lot.variant);
      const cx = lotX(lx) + lot.dx;
      const cy = lotY(ly) + lot.dy;
      const left = cx - w / 2;
      const right = cx + w / 2;
      const top = cy - d / 2;
      const bottom = cy + d / 2;

      for (let bx = Math.floor(left / PLOT) - 1; bx <= Math.floor(right / PLOT) + 1; bx++) {
        if (!isAvenueCol(bx)) continue;
        const ribLeft = bx * PLOT + STREET_INSET;
        const ribRight = ribLeft + STREET_WIDTH;
        assert.ok(
          right <= ribLeft || left >= ribRight,
          `building at lot (${lx},${ly}) spans x[${left},${right}], crossing avenue ${bx}'s ribbon [${ribLeft},${ribRight}]`,
        );
      }
      for (let by = Math.floor(top / PLOT) - 1; by <= Math.floor(bottom / PLOT) + 1; by++) {
        if (!isCrossStreetRow(by)) continue;
        const ribTop = by * PLOT + STREET_INSET;
        const ribBottom = ribTop + STREET_WIDTH;
        assert.ok(
          bottom <= ribTop || top >= ribBottom,
          `building at lot (${lx},${ly}) spans y[${top},${bottom}], crossing cross-street ${by}'s ribbon [${ribTop},${ribBottom}]`,
        );
      }
    }
  }
});

test("the building sprite cache stays bounded at BUILDING_VARIANTS * 2 * SECTOR_COUNT", () => {
  // sprites.js: "at most BUILDING_VARIANTS * 2 sprites (one per lean
  // direction) exist no matter how large the city grows." Phase 7f adds a
  // third factor: BUILDING_EDGE/BUILDING_FILL* are baked into a building's
  // own sprite pixels and reassigned per sector (palette.js's setSector), so
  // drawBuildingVariant's cache key carries the sector too — a building
  // revisited after a crossing would otherwise blit its OLD sector's colour
  // forever. spritecache.js's Map has NO eviction, so SECTOR_COUNT has to
  // stay a small, fixed number or this leaks without bound over a long run.
  assert.equal(BUILDING_VARIANTS, 24, `BUILDING_VARIANTS grew to ${BUILDING_VARIANTS} — the catalogue must stay fixed`);
  assert.ok(
    Number.isInteger(SECTOR_COUNT) && SECTOR_COUNT > 0 && SECTOR_COUNT <= 8,
    `SECTOR_COUNT is ${SECTOR_COUNT} — must stay a small, fixed number`,
  );
});

test("the visible floor stays a bounded walk", () => {
  // scenery.js walks every LOT in view each frame, so this product is
  // per-frame work. Subdividing plots into lots roughly quadruples it (more
  // rows AND more columns); this pins the new number so it cannot creep
  // further unnoticed.
  const rows = lotRows(0, 800 + 240);
  const lots = (rows.max - rows.min + 1) * lotColumns(600);
  assert.ok(lots <= 200, `floor walk grew to ${lots} lots per frame`);
});

test("buildings draw far to near, in LOT row order", () => {
  // scenery.js's visibleBuildings walks lot rows, not plot rows — if it ever
  // regressed to plot-row granularity (drawing all of a block's lots as one
  // unordered group), a near lot could paint UNDER a far one from the SAME
  // block, visible only at the scroll offsets where their screen rows
  // actually overlap. `ly` must be non-increasing across the list (rows.max
  // down to rows.min); within one row, siting can jitter `sy` by a few px
  // (see scenery.js's own comment on `ly`) without that being a depth error,
  // so this checks row order directly rather than raw `sy`.
  for (const playerY of [0, 250, 496, 803]) {
    for (let fDist = 0; fDist < 2000; fDist += 97) {
      const buildings = visibleBuildings(fDist, playerY, 600, 800);
      for (let i = 1; i < buildings.length; i++) {
        assert.ok(
          buildings[i].ly <= buildings[i - 1].ly,
          `building ${i} in lot row ${buildings[i].ly} drew after row ${buildings[i - 1].ly} — not far-to-near`,
        );
      }
    }
  }
});

test("the eligible-lot and realized-build fractions, re-measured now that NODE competes for the same lots", () => {
  // citygrid.js's BUILD_CHANCE comment documents the exact numbers a NODE
  // claim should have nudged: eligible-lot fraction (BUILDING+EMPTY / all
  // lots) and realized-build fraction (BUILDING / all lots). This samples
  // lotAt directly, the same way that comment is checked, rather than trusting
  // the prose to still be right now that a NODE plot removes all 4 of its
  // lots from the roll — see BUILD_CHANCE's own re-measured note.
  const counts = {};
  let total = 0;
  for (let lx = -40; lx < 40; lx++) {
    for (let ly = -400; ly < 400; ly++) {
      const t = lotAt(lx, ly).type;
      counts[t] = (counts[t] ?? 0) + 1;
      total++;
    }
  }
  const eligible = (counts[BUILDING] ?? 0) + (counts[EMPTY] ?? 0);
  const eligibleFrac = eligible / total;
  const builtFrac = (counts[BUILDING] ?? 0) / total;
  assert.ok(
    Math.abs(eligibleFrac - 0.4854) < 0.01,
    `eligible-lot fraction drifted to ${eligibleFrac.toFixed(4)}, expected ~0.4854`,
  );
  assert.ok(
    Math.abs(builtFrac - 0.4123) < 0.01,
    `realized-build fraction drifted to ${builtFrac.toFixed(4)}, expected ~0.4123`,
  );
});

// --- Distinguished nodes (Phase 7d) -------------------------------------------

test("the node sprite cache stays bounded at NODE_VARIANTS * SECTOR_COUNT", () => {
  // sprites.js's drawNodeVariant used to key its cache on `v` alone
  // (`node|${v}`), with no lean direction and no continuous parameter the
  // way a building's key carries. Phase 7f adds `sector` as a second, equally
  // bounded factor (NODE_BRACKET/NODE_GLYPH are reassigned per sector too),
  // so the whole cache is now bounded by NODE_VARIANTS * SECTOR_COUNT — this
  // is the assertion that neither constant has quietly grown, mirroring the
  // building catalogue's own "stays bounded" test above.
  assert.equal(NODE_VARIANTS, 6, `NODE_VARIANTS grew to ${NODE_VARIANTS} — the node catalogue must stay fixed`);
  assert.ok(
    Number.isInteger(SECTOR_COUNT) && SECTOR_COUNT > 0 && SECTOR_COUNT <= 8,
    `SECTOR_COUNT is ${SECTOR_COUNT} — must stay a small, fixed number`,
  );
});

test("a NODE claim never lands on an avenue or cross-street plot", () => {
  // citygrid.js's reserve() checks the two street claims BEFORE ever rolling
  // a NODE, so a node can only ever land on ground a street would otherwise
  // have left for a building — this is the assertion that ordering actually
  // holds, not just that it reads that way in reserve()'s own comment. Silent
  // in any test that only samples NODE placement in isolation, since a NODE
  // sitting on top of a street plot would still "work" (nothing draws a
  // building there either way) while quietly punching a hole in the ribbon
  // scenery.js paints independently of reserve() (see the design doc's own
  // note on why this is the bug this sub-phase has to avoid).
  for (let bx = -20; bx < 20; bx++) {
    for (let by = -80; by < 80; by++) {
      const plot = plotAt(bx, by);
      if (!plot || plot.type !== NODE) continue;
      assert.ok(!isAvenueCol(bx), `NODE at plot (${bx}, ${by}) sits on an avenue column`);
      assert.ok(!isCrossStreetRow(by), `NODE at plot (${bx}, ${by}) sits on a cross-street row`);
    }
  }
});

test("plotAt is deterministic — a node is a pure function of the plot index, no state", () => {
  // Mirrors the "lotAt is deterministic and total" test above: citygrid.js's
  // whole design rests on every claim being a pure function of its index, so
  // a node that varied between calls (or with call ORDER) would make a
  // facility flicker in and out as the player approached it.
  for (let bx = -20; bx < 20; bx++) {
    for (let by = -80; by < 80; by++) {
      const a = plotAt(bx, by);
      const b = plotAt(bx, by);
      assert.deepEqual(a, b, `plot (${bx}, ${by})'s claim is not stable across calls`);
      if (a && a.type === NODE) {
        assert.ok(
          Number.isInteger(a.variant) && a.variant >= 0 && a.variant < NODE_VARIANTS,
          `node at (${bx}, ${by}) has a variant outside [0, NODE_VARIANTS)`,
        );
      }
    }
  }
});

test("the distinguished-node count stays rare, and bounded, across a wide sweep", () => {
  // citygrid.js's own NODE_CHANCE comment: mean ~0.9-1.2/frame, 0 on roughly a
  // third of frames, max observed 5 across a sweep of screen widths and scroll
  // positions. Pinned here with slack above that observed max (mirrors the
  // traffic-dot and drone count-bound tests above), so a future retune of
  // NODE_CHANCE or the street periods can't quietly let this drift toward
  // "every intersection" — the one outcome the design doc calls out as
  // actively bad (7e's conduits would mesh across the whole floor instead of
  // linking a few).
  for (const W of [400, 550, 600, 700]) {
    for (const playerY of [0, 250, 496, 803]) {
      for (let fDist = 0; fDist < 20000; fDist += 233) {
        const count = visibleNodes(fDist, playerY, W, 800).length;
        assert.ok(count <= 12, `node count grew to ${count} on screen at once`);
      }
    }
  }
});

test("the node walk is a bounded PLOT-level walk, not a LOT-level one", () => {
  // A NODE is claimed at PLOT granularity (citygrid.js's reserve() runs
  // before any lot inside the plot is examined), so visibleNodes has to walk
  // PLOT rows — walking LOT rows instead (4x finer, per LOT_SUBDIV^2) would
  // visit the SAME claim repeatedly and draw the same marker stacked on
  // itself LOT_SUBDIV times over. This pins the walk at the plot-grained
  // size (~40/frame at 600x800, matching 7a's own budget), not the ~160
  // lot-grained size visibleBuildings's own bound test pins.
  const rows = plotRows(0, 800 + 240);
  const plots = (rows.max - rows.min + 1) * plotColumns(600);
  assert.ok(plots <= 60, `plot-level walk grew to ${plots} plots per frame`);
});

test("the baked registration ticks land on real intersections, not just where isAvenueCol/isCrossStreetRow say so", () => {
  // scenery.js's tileIntersections() is what floorGridTile() actually bakes
  // ticks from, in TILE-LOCAL coordinates; crossStreetBands()/avenueCenters()
  // are the SCREEN-space, per-frame equivalents this file's ribbon tests
  // already trust. This maps every tile-local intersection through the SAME
  // gridPhase offset drawFloorGrid's own blit uses, and checks the result
  // against those two — not against isAvenueCol/isCrossStreetRow directly,
  // which is exactly the shortcut that let the ribbon and citygrid.js's index
  // math drift a whole PLOT apart once already (see isCrossStreetRow's own
  // "+1" comment) while looking consistent on paper.
  const H = 800;
  for (const W of [400, 550, 600, 700]) {
    for (const playerY of [0, 250, 496, 803]) {
      for (let fDist = 0; fDist < ARTERIAL_PERIOD * 3; fDist += 131) {
        const phase = gridPhase(fDist, playerY);
        const destY = phase - ARTERIAL_PERIOD;
        const centers = avenueCenters(W);

        // A band that is only PARTIALLY on screen (its top clipped above the
        // canvas, or spilling past the bottom) can still have its own MID —
        // where the tick actually sits — off screen, so "on screen" for a
        // tick has to be evaluated at the mid, not inherited from the band's
        // own (more permissive) visibility test. Filtering crossStreetBands'
        // own output down to on-screen mids, rather than re-deriving them,
        // keeps this cross-checking crossStreetBands' actual output — the
        // whole point of this test — instead of a second computation of it.
        const expected = new Set();
        for (const top of crossStreetBands(fDist, playerY, H)) {
          const mid = top + STREET_WIDTH / 2;
          if (mid < 0 || mid >= H) continue;
          for (const cx of centers) expected.add(`${cx}|${mid}`);
        }

        const tileHeight = H + ARTERIAL_PERIOD;
        const actual = new Set();
        for (const { x, y } of tileIntersections(W, tileHeight)) {
          const screenY = y + destY;
          if (screenY < 0 || screenY >= H) continue;
          actual.add(`${x}|${screenY}`);
          assert.ok(
            expected.has(`${x}|${screenY}`),
            `tile intersection (${x}, ${screenY}) at fDist=${fDist}, playerY=${playerY}, W=${W} ` +
              `is not one of crossStreetBands/avenueCenters' own painted crossings`,
          );
        }
        assert.equal(
          actual.size, expected.size,
          `expected ${expected.size} on-screen intersections at fDist=${fDist}, playerY=${playerY}, W=${W}, got ${actual.size}`,
        );
      }
    }
  }
});

// --- Materialisation (Phase 7g) -----------------------------------------------

test("materialiseProgress is a pure function of sy — same input, same output, no state", () => {
  for (const sy of [-500, -60, -0.001, 0, 0.001, 30, WIPE_SPAN - 0.001, WIPE_SPAN, WIPE_SPAN + 0.001, 500]) {
    const a = materialiseProgress(sy);
    const b = materialiseProgress(sy);
    assert.equal(a, b, `materialiseProgress(${sy}) is not stable across calls`);
  }
});

test("materialiseProgress clamps to [0, 1] and is monotonic in floor distance — a building never un-materialises as it's approached", () => {
  // `sy` here is replicated exactly as visibleBuildings/visibleNodes compute
  // it for a row: playerY - (lotY(ly) - fDist). Sweeping fDist upward for a
  // FIXED row is "the player keeps approaching that row", and progress must
  // never fall back down as that happens — it falls out of the formula
  // (see scenery.js's own comment on materialiseProgress) rather than being
  // something a caller has to maintain by hand.
  for (const playerY of [0, 250, 496, 803]) {
    for (const ly of [-5, 0, 3, 40]) {
      let last = -Infinity;
      for (let fDist = 0; fDist < 3000; fDist += 17) {
        const sy = playerY - (lotY(ly) - fDist);
        const progress = materialiseProgress(sy);
        assert.ok(progress >= 0 && progress <= 1, `progress ${progress} out of [0,1] at sy=${sy}`);
        assert.ok(progress >= last, `progress fell from ${last} to ${progress} as fDist grew (row ${ly}, playerY ${playerY})`);
        last = progress;
      }
    }
  }
});

test("materialiseProgress reports fully materialised past WIPE_SPAN — the performance guard for the fast blit path", () => {
  // sprites.js's drawBuildingVariant/drawNodeVariant take the plain,
  // unclipped blitSprite path only when progress >= 1 EXACTLY — this is what
  // keeps the ~70-odd already-on-screen buildings a typical frame draws from
  // ever paying for a save/clip/restore (spritecache.js's
  // blitSpriteMaterialising). Progress creeping to 0.999... instead of a
  // hard 1 past the span would silently put every one of those blits through
  // the clipped path without changing how anything looks — this is the test
  // that would catch it.
  for (const sy of [WIPE_SPAN, WIPE_SPAN + 0.01, WIPE_SPAN * 10, 10000]) {
    assert.equal(materialiseProgress(sy), 1, `materialiseProgress(${sy}) !== 1, past WIPE_SPAN (${WIPE_SPAN})`);
  }
});

test("WIPE_SPAN stays under LOT — at most one lot row is ever mid-materialisation at once", () => {
  // Two adjacent lot rows are exactly LOT apart in fDist (lotY's own
  // spacing); a wipe span shorter than that can never have two rows' wipes
  // overlap on screen at the same time, which is what keeps a stopped
  // player looking at a single row resolving rather than a band of
  // half-buildings (see scenery.js's own WIPE_SPAN comment for the reasoning
  // and the speed-to-duration arithmetic).
  assert.ok(
    WIPE_SPAN < LOT,
    `WIPE_SPAN (${WIPE_SPAN}) is not shorter than LOT (${LOT}) — more than one row could be mid-wipe at once`,
  );
});

test("nothing is drawn at progress <= 0 — visibleBuildings/visibleNodes never return an unmaterialised entry", () => {
  for (const W of [400, 600, 700]) {
    for (const playerY of [0, 250, 496, 803]) {
      for (let fDist = 0; fDist < 20000; fDist += 733) {
        for (const b of visibleBuildings(fDist, playerY, W, 800)) {
          assert.ok(b.progress > 0, `visibleBuildings returned a building at progress ${b.progress}`);
        }
        for (const n of visibleNodes(fDist, playerY, W, 800)) {
          assert.ok(n.progress > 0, `visibleNodes returned a node at progress ${n.progress}`);
        }
      }
    }
  }
});

test("visibleBuildings/visibleNodes are pure functions of their arguments, progress included", () => {
  // Mirrors the "plotAt is deterministic" test above: a materialisation
  // effect that depended on anything but (row, fDist) would make a
  // building's wipe progress jitter between two identically-parameterised
  // frames — the one behaviour this whole layer's statelessness rules out.
  const a1 = visibleBuildings(4321, 496, 600, 800);
  const a2 = visibleBuildings(4321, 496, 600, 800);
  assert.deepEqual(a1, a2, "visibleBuildings is not a pure function of its arguments");
  const n1 = visibleNodes(4321, 496, 600, 800);
  const n2 = visibleNodes(4321, 496, 600, 800);
  assert.deepEqual(n1, n2, "visibleNodes is not a pure function of its arguments");
});

// --- Traffic dots (Phase 7b) --------------------------------------------------
//
// These run entirely against scenery.js's pure functions — trafficDots,
// crossStreetBands, avenueCenters — never against drawTrafficDots, which
// touches a canvas. That split is deliberate (see scenery.js's own header):
// it's what lets "is a dot on the road it's supposed to be on" be asserted
// exactly, under plain Node, instead of only checked by eye in a browser.

test("cross-street traffic lanes sit strictly inside the painted ribbon, off its kerbs and centre line", () => {
  // Only x depends on the clock for these lanes (see trafficDots: a
  // cross-street's dots slide in screen x), so at ANY fixed clock the set of
  // distinct y's is the lane geometry itself — exactly FOUR per band (two
  // each direction — see DOT_LANE_OFFSET_INNER/OUTER), and never moving.
  for (const playerY of [0, 250, 496, 803]) {
    for (let fDist = 0; fDist < 2000; fDist += 53) {
      const bands = crossStreetBands(fDist, playerY, 800);
      const dots = trafficDots(0, fDist, playerY, 600, 800);
      const ys = [...new Set(dots.filter((d) => d.alongX).map((d) => d.y))];
      assert.equal(
        ys.length, bands.length * 4,
        `expected 4 lanes per cross-street band, got ${ys.length} distinct y's for ${bands.length} bands`,
      );
      for (const y of ys) {
        const band = bands.find((top) => y > top && y < top + STREET_WIDTH);
        assert.ok(band !== undefined, `lane y=${y} is not strictly inside any cross-street ribbon`);
        assert.notEqual(y, band + STREET_WIDTH / 2, `lane y=${y} sits exactly on the dashed centre line`);
      }
    }
  }
});

test("avenue traffic lanes sit strictly inside the painted ribbon, off its kerbs and centre line", () => {
  // Mirror of the cross-street test above: an avenue's dots slide in screen y,
  // so at any fixed clock the set of distinct x's is the lane geometry itself
  // — four per avenue, two each direction.
  for (let W = 400; W <= 700; W += 47) {
    const centers = avenueCenters(W);
    const dots = trafficDots(0, 0, 496, W, 800);
    const xs = [...new Set(dots.filter((d) => !d.alongX).map((d) => d.x))];
    assert.equal(
      xs.length, centers.length * 4,
      `expected 4 lanes per avenue, got ${xs.length} distinct x's for ${centers.length} avenues`,
    );
    for (const x of xs) {
      const cx = centers.find((c) => x > c - STREET_WIDTH / 2 && x < c + STREET_WIDTH / 2);
      assert.ok(cx !== undefined, `lane x=${x} is not strictly inside any avenue ribbon`);
      assert.notEqual(x, cx, `lane x=${x} sits exactly on the dashed centre line`);
    }
  }
});

test("avenue traffic lanes carry the floor's own scroll, not just their own clock", () => {
  // AN AVENUE'S OWN AXIS (screen y) IS ALSO THE ONE THE FLOOR SCROLLS ON, so a
  // dot's speed there has to be measured against the WORLD (its own speed on
  // top of the floor's scroll, fDist) rather than the screen — the same
  // relative-motion relationship traffic.js's highway cars have to `distance`.
  // Shipped without that term, an avenue dot's y depended only on its own
  // clock and never moved with fDist at all, so at speed (fDist moving far
  // faster than the dot's own 55-70px/s) the dot read as passively carried
  // along by the scroll rather than driving its own line — see scenery.js's
  // avenue loop for the full failure this guards.
  //
  // Every avenue y this frame has to satisfy `y - fDist === clock * speed +
  // phase` (mod DOT_SPACING, for whichever of the four lanes produced it) —
  // i.e. the whole set shifts by exactly fDist as fDist moves, rather than
  // sitting still on screen while the floor around it scrolls past.
  const W = 600, H = 800, playerY = 496, clock = 12.5;
  const residuesFor = (y, fDist) =>
    [
      clock * DOT_SPEED_A,
      clock * DOT_SPEED_A + DOT_LANE_PHASE,
      clock * DOT_SPEED_B,
      clock * DOT_SPEED_B + DOT_LANE_PHASE,
    ].map((r) => (((y - fDist - r) % DOT_SPACING) + DOT_SPACING) % DOT_SPACING);

  for (const fDist of [0, 137, 900.5]) {
    const avenueDots = trafficDots(clock, fDist, playerY, W, H).filter((d) => !d.alongX);
    assert.ok(avenueDots.length > 0, `expected at least one avenue dot at fDist=${fDist}`);
    for (const { y } of avenueDots) {
      const residues = residuesFor(y, fDist);
      assert.ok(
        residues.some((r) => r < 1e-6 || DOT_SPACING - r < 1e-6),
        `avenue dot y=${y} at fDist=${fDist} doesn't land on any lane's own clock+carry phase`,
      );
    }
  }
});

test("crossStreetBands shares gridPhase's own mapping rather than a fresh modulo", () => {
  // scenery.js's header is explicit about this: a dot has to be derived from
  // the SAME phase drawFloorGrid's blit uses, or it can drift from the ribbon
  // the tile actually painted at certain scroll positions. Every band top
  // this function returns has to land in the same residue class (mod
  // ARTERIAL_PERIOD) as gridPhase() + STREET_INSET.
  for (const playerY of [0, 496, 500, 803]) {
    for (let fDist = 0; fDist < 3000; fDist += 37) {
      const phase = gridPhase(fDist, playerY);
      for (const top of crossStreetBands(fDist, playerY, 800)) {
        const residue = (((top - STREET_INSET - phase) % ARTERIAL_PERIOD) + ARTERIAL_PERIOD) % ARTERIAL_PERIOD;
        assert.ok(
          residue < 1e-9 || ARTERIAL_PERIOD - residue < 1e-9,
          `band top ${top} is off gridPhase's own phase ${phase} at fDist=${fDist}, playerY=${playerY}`,
        );
      }
    }
  }
});

test("the floor's traffic-dot count stays bounded", () => {
  // 118-156 is the actual range at 600x800 with today's DOT_SPACING and four
  // lanes per street (see scenery.js's own comment on DOT_SPACING) — above
  // the design doc's original 60-80 by deliberate retune, still one fill()
  // and still trivial against the phase's ~0.5ms/frame budget (measured
  // ~14us; see drawTrafficDots' own comment). Pinned with slack above the
  // observed max so a future retune can't quietly let the per-frame fill
  // grow unbounded.
  for (const playerY of [0, 250, 496, 803]) {
    for (let fDist = 0; fDist < 2000; fDist += 53) {
      for (const clock of [0, 3.3, 17.9, 123.4]) {
        const count = trafficDots(clock, fDist, playerY, 600, 800).length;
        assert.ok(count <= 170, `floor traffic grew to ${count} dots per frame`);
      }
    }
  }
});

// --- Air traffic / drones (Phase 7c) ------------------------------------------
//
// Same split as the traffic-dot tests above: everything here runs against
// droneField, the pure function (see drones.js's own header), never against
// its drawing side.

test("air traffic stratifies between the floor and the road", () => {
  // The whole point of this layer (see the design doc's 7c section): floor at
  // FLOOR_PARALLAX, road/entities at 1, drones strictly between the two.
  assert.ok(DRONE_PARALLAX > FLOOR_PARALLAX, "drones must scroll faster than the floor");
  assert.ok(DRONE_PARALLAX < 1, "drones must scroll slower than the road");
});

test("the drone layer's count stays bounded", () => {
  // Mirrors the floor traffic-dot count test above: pinned with slack above
  // the observed range (5-30 across a wide distance/playerY/clock sweep — see
  // this file's own probe), so a future retune of the row/group spacing can't
  // quietly let this grow toward the "not a hundred" the design doc warns
  // against.
  for (const playerY of [0, 250, 496, 803]) {
    for (let distance = 0; distance < 20000; distance += 733) {
      for (const clock of [0, 3.3, 17.9, 123.4, 987.6]) {
        const count = droneField(clock, distance, playerY, 600, 800).length;
        assert.ok(count <= 50, `air traffic grew to ${count} drones per frame`);
      }
    }
  }
});

test("a drone's ground shadow gap stays bounded however far the run has gone", () => {
  // The naive "one world point, two parallax rates" mechanism this shadow
  // uses is NOT bounded in raw distance (see drones.js's own comment on
  // DRONE_ALTITUDE_MAX for the failure this guards: 1000+px within a couple
  // thousand world units without the cap). Every drone's shadowY must stay
  // within DRONE_ALTITUDE_MAX of its own y, at distances the game plausibly
  // reaches in one run.
  const DRONE_ALTITUDE_MAX = 14; // mirrors the private constant in drones.js —
                                  // duplicated here deliberately so the test
                                  // pins the CONTRACT (a bounded gap) rather
                                  // than importing the implementation detail
                                  // it's meant to be checking independently of
  for (const distance of [0, 500, 5000, 50000, 500000]) {
    const drones = droneField(12.3, distance, 400, 600, 800);
    for (const d of drones) {
      const gap = Math.abs(d.shadowY - d.y);
      assert.ok(gap <= DRONE_ALTITUDE_MAX + 1e-9, `shadow gap ${gap} exceeded the cap at distance=${distance}`);
    }
  }
});

test("every visible drone sits on or off screen consistently with its own bound", () => {
  // droneField's own on-screen filter is the actual correctness gate (see its
  // header) — this just asserts every drone it DOES emit is within the margin
  // it claims to bound itself to, across a wide sweep, rather than trusting
  // the row-walk heuristic above it to never leak an off-screen candidate.
  const MARGIN = 10; // mirrors drones.js's own DRONE_MARGIN
  const W = 600, H = 800;
  for (const playerY of [0, 496, 803]) {
    for (let distance = 0; distance < 8000; distance += 517) {
      for (const d of droneField(distance * 0.01, distance, playerY, W, H)) {
        assert.ok(d.x >= -MARGIN - 1e-6 && d.x <= W + MARGIN + 1e-6, `drone x=${d.x} outside the visible span`);
        assert.ok(d.y >= -MARGIN - 1e-6 && d.y <= H + MARGIN + 1e-6, `drone y=${d.y} outside the visible span`);
      }
    }
  }
});

test("a formation's nav lights blink rather than staying on or off forever", () => {
  // Sampling the SAME scene across a clock sweep, both lit and unlit drones
  // must show up — a blink that never toggled (a phase bug, or BLINK_ON
  // pinned to the whole period) would be invisible to eye-only testing.
  let sawLit = false, sawUnlit = false;
  for (let clock = 0; clock < 30; clock += 0.037) {
    for (const d of droneField(clock, 3000, 450, 600, 800)) {
      if (d.lit) sawLit = true; else sawUnlit = true;
    }
    if (sawLit && sawUnlit) break;
  }
  assert.ok(sawLit, "no drone was ever lit across the clock sweep");
  assert.ok(sawUnlit, "no drone was ever unlit across the clock sweep — the blink never toggles");
});

// --- Links and pings (Phase 7e) -----------------------------------------------
//
// Same split as the traffic-dot/drone tests above: conduitField/pingField are
// pure functions of (clock, nodes), so most of this runs against them
// directly. The console voice (announce/announceActive) is the one stateful
// piece on this floor — see links.js's own header — and gets its own tests,
// isolated from the real singleton SYS LOG via injected push/busy stubs.

test("a conduit's packet position is a pure function of (clock, node index)", () => {
  const nodes = [{ cx: 120, sy: 300, bx: 3, by: -7 }, { cx: 480, sy: 640, bx: -12, by: 205 }];
  for (const clockValue of [0, 1.7, 42.25, 999.9]) {
    const a = conduitField(clockValue, nodes, 600, 800);
    const b = conduitField(clockValue, nodes, 600, 800);
    assert.deepEqual(a, b, `conduitField(${clockValue}, ...) is not stable across calls`);
  }
});

test("a ping's radius/alpha are a pure function of (clock, node index)", () => {
  const nodes = [{ cx: 120, sy: 300, bx: 3, by: -7 }, { cx: 480, sy: 640, bx: -12, by: 205 }];
  for (const clockValue of [0, 1.7, 42.25, 999.9]) {
    const a = pingField(clockValue, nodes);
    const b = pingField(clockValue, nodes);
    assert.deepEqual(a, b, `pingField(${clockValue}, ...) is not stable across calls`);
  }
});

test("conduits and pings are bounded by, and never exceed, the visible node walk", () => {
  // Both conduitField and pingField produce AT MOST one entry per node in
  // the list they're handed — mirrors the design doc's "bound the count by
  // the visible node walk" — so driving them off the REAL visibleNodes()
  // output (rather than a hand-built list) across the same sweep the 7d
  // node-count test uses is what proves a conduit/ping belonging to a node
  // that isn't on screen is never even constructed, not just never drawn.
  for (const W of [400, 550, 600, 700]) {
    for (const playerY of [0, 250, 496, 803]) {
      for (let fDist = 0; fDist < 20000; fDist += 733) {
        const nodes = visibleNodes(fDist, playerY, W, 800);
        for (const clockValue of [0, 17.3, 401.2]) {
          const conduits = conduitField(clockValue, nodes, W, 800);
          const pings = pingField(clockValue, nodes);
          assert.ok(conduits.length <= nodes.length, "more conduits than visible nodes");
          assert.ok(pings.length <= nodes.length, "more pings than visible nodes");
        }
      }
    }
  }
});

test("a callsign is stable for a given plot index", () => {
  // The property that makes the SYS LOG mean anything (see links.js's own
  // header): a node has to read the same name every time the player passes
  // it, which is only true if callsign() is a pure function of (bx, by) with
  // no hidden dependence on call order or on anything else.
  for (const [bx, by] of [[0, 0], [3, -7], [-12, 205], [40, 40000], [-5, -9999]]) {
    const a = callsign(bx, by);
    const b = callsign(bx, by);
    assert.equal(a, b, `callsign(${bx}, ${by}) is not stable across calls`);
    assert.equal(typeof a, "string");
    assert.ok(a.length > 0, `callsign(${bx}, ${by}) is empty`);
  }
});

test("every city-log line is HINT severity, never a gameplay faction colour", () => {
  // console.js maps WARN/CRITICAL to NEUTRAL/HAZARD — gameplay FACTION
  // colours (amber/red) — and the whole point of this floor's colour
  // discipline is protecting the half-second faction read (palette.js's own
  // header). A city callsign flashing hazard-red would read as a threat.
  // Cheap to assert directly across a wide sweep of plot indices, and it's
  // the guard against the single worst regression available here.
  for (let bx = -10; bx < 10; bx++) {
    for (let by = -50; by < 50; by++) {
      const msg = announcement(bx, by);
      assert.equal(msg.severity, CONSOLE_HINT, `announcement(${bx}, ${by}) used a non-HINT severity`);
    }
  }
});

test("a single ping announces exactly once, not once per frame it is alive", () => {
  linksReset();
  const node = { bx: 5, by: -3 };
  let pushCount = 0;
  const push = () => { pushCount++; };
  const busy = () => false;

  // A ping "alive" for several consecutive frames, clock advancing a little
  // each time (well under the rate-limit interval) — announceActive is
  // handed the SAME node object every frame, exactly as announce() would
  // while a real ping's window stays open.
  for (let i = 0; i < 20; i++) {
    announceActive(i * 0.05, node, push, busy);
  }
  assert.equal(pushCount, 1, `a single continuously-alive ping pushed ${pushCount} times, expected exactly 1`);

  // The ping ending (active -> null) and nothing else happening shouldn't
  // push anything either.
  announceActive(1.1, null, push, busy);
  assert.equal(pushCount, 1, "a ping ENDING must not itself push a line");
});

test("the console voice rate-limits city chatter to roughly one line every several seconds", () => {
  // Drives the STATE MACHINE (announceActive) directly with a synthetic
  // node that starts a fresh ping every 0.2s — far more often than any real
  // node's own period (pingState's PING_PERIOD_MIN/MAX, 4.5-9s) — over a
  // long simulated span, so the rate limit is the only thing that could be
  // holding the push count down. If it didn't hold, this would push on
  // nearly every one of the ~9000 edges below instead of a small fraction
  // of them.
  linksReset();
  const nodeA = { bx: 1, by: 1 };
  let pushCount = 0;
  const RATE_LIMIT = 6; // mirrors links.js's own CITY_LINE_MIN_INTERVAL
  const push = () => { pushCount++; };
  const busy = () => false;

  const SPAN = 1800; // seconds — a long simulated drive
  for (let clockValue = 0; clockValue < SPAN; clockValue += 0.1) {
    // Alternate active/inactive every 0.1s so this is a fresh "just started"
    // edge roughly every 0.2s — announceActive only cares about the EDGE,
    // not how long the ping stays alive, so toggling like this is a stress
    // test of the edge path itself rather than a claim about real timing.
    const active = Math.floor(clockValue / 0.1) % 2 === 0 ? nodeA : null;
    announceActive(clockValue, active, push, busy);
  }

  const ceiling = Math.ceil(SPAN / RATE_LIMIT) + 1; // +1 slack for the edge at t=0
  assert.ok(pushCount <= ceiling, `city chatter pushed ${pushCount} times over ${SPAN}s, expected <= ${ceiling}`);
  assert.ok(pushCount > 1, "expected more than one push over a long span — the test isn't exercising anything otherwise");
});

test("announce() (the real wrapper) never pushes a non-HINT line across a wide, real sweep", () => {
  // A lighter integration check of the actual wiring (fDist, visibleNodes,
  // activePing) rather than the synthetic state-machine tests above —
  // whatever DOES get pushed while driving a long simulated stretch with
  // real geography must still be HINT, matching the pure announcement()
  // test above but exercised through the real call path.
  linksReset();
  const pushed = [];
  const push = (text, severity) => pushed.push({ text, severity });
  const busy = () => false;

  const SPEED = 300; // px/s, a plausible mid-range player speed
  const SPAN = 600; // seconds of simulated driving
  for (let t = 0; t < SPAN; t += 0.25) {
    announce(t, t * SPEED, 400, 600, 800, push, busy);
  }

  assert.ok(pushed.length > 0, "expected at least one real city line over a long simulated drive");
  for (const m of pushed) {
    assert.equal(m.severity, CONSOLE_HINT, `announce() pushed "${m.text}" at non-HINT severity`);
  }
});

// --- Sectors (Phase 7f) -------------------------------------------------------

test("sector index is a pure function of distance", () => {
  // citygrid.js's sectorIndex: same fDist in, same sector out, forever — the
  // same contract every other lookup on this floor (plotAt, lotAt, gridPhase)
  // already keeps.
  for (const fDist of [0, 1, 511, 512, 513, 1024, -1, -512, -513, 999999]) {
    const a = sectorIndex(fDist);
    const b = sectorIndex(fDist);
    assert.equal(a, b, `sectorIndex(${fDist}) is not stable across calls`);
    assert.ok(Number.isInteger(a), `sectorIndex(${fDist}) = ${a} is not an integer`);
  }
});

test("sector boundaries land on tile boundaries", () => {
  // The divisibility rule citygrid.js's own SECTOR_PERIOD comment documents:
  // SECTOR_PERIOD must be a whole multiple of ARTERIAL_PERIOD (floor-world
  // units), or a boundary would put a colour seam through the middle of a
  // tile — asserted against the constants themselves, not a hardcoded 512,
  // so retuning either one fails loudly here instead of drawing a seam.
  assert.equal(
    SECTOR_PERIOD % ARTERIAL_PERIOD, 0,
    `SECTOR_PERIOD (${SECTOR_PERIOD}) is not a whole multiple of ARTERIAL_PERIOD (${ARTERIAL_PERIOD})`,
  );

  // The same relation, cross-checked in the space main.js's `distance` and
  // scenery.js's FLOOR_PARALLAX actually put it through: the period expressed
  // in player DISTANCE (SECTOR_PERIOD / FLOOR_PARALLAX) must, once run
  // through the exact fDist = round(distance * FLOOR_PARALLAX) conversion
  // every per-frame layer on this floor uses, land back on a whole multiple
  // of ARTERIAL_PERIOD — catching a mistake where SECTOR_PERIOD looks right
  // in floor-world but FLOOR_PARALLAX doesn't divide it cleanly back out.
  const distancePeriod = SECTOR_PERIOD / FLOOR_PARALLAX;
  for (const k of [1, 2, 3, 17]) {
    const fDist = Math.round(k * distancePeriod * FLOOR_PARALLAX);
    assert.equal(
      fDist % ARTERIAL_PERIOD, 0,
      `distance ${k * distancePeriod} (sector boundary ${k}) maps to fDist ${fDist}, not a whole ARTERIAL_PERIOD`,
    );
  }
});

test("scenery.floorDist is idempotent under pre-rounding", () => {
  // THE PROPERTY THE WHOLE FIX RESTS ON (see scenery.js's own floorDist
  // header): floorDist must give the SAME answer whether it's handed the
  // simulation loop's raw float `distance` or the render loop's own
  // already-rounded `camY` for that same tick — because rounding an integer
  // is a no-op, so the outer Math.round in floorDist's two-step form can't
  // tell the difference. Asserted directly rather than trusted from the
  // arithmetic, across a wide sweep including negatives (floorDist itself
  // makes no assumption distance stays positive, even though play never
  // drives it negative) and half-integers (where Math.round's own
  // round-half-away-from-zero tie-breaking is the one place the two paths
  // could plausibly diverge if the two-step form weren't actually
  // idempotent).
  const samples = [];
  for (let d = -10000; d <= 10000; d += 37.5) samples.push(d);
  samples.push(0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 100000.5, -100000.5, 999999.5, -999999.5);

  for (const d of samples) {
    const direct = floorDist(d);
    const prerounded = floorDist(Math.round(d));
    assert.equal(
      direct, prerounded,
      `floorDist(${d}) = ${direct} disagrees with floorDist(Math.round(${d})) = ${prerounded}`,
    );
  }
});

test("floorDist agrees with the sector index and the floor tile's own phase, checked at boundary ticks specifically", () => {
  // NOT a sweep of arbitrary distances (see the idempotence test above) —
  // this walks real tick-by-tick distance progressions, the same way a
  // player actually drives (speed * STEP accumulated every frame), across a
  // wide speed range, and checks the tick where sectorIndex(floorDist(...))
  // actually changes. That's deliberate: the original bug (see the design
  // doc's own 7f section, "a bug worth recording") only showed up on
  // roughly 1 in 25 sector crossings, on ticks where the raw accumulated
  // float landed close enough to a boundary that rounding it directly vs.
  // rounding it in two steps could disagree — a test sampling clean,
  // idealised boundary values (like "sector boundaries land on tile
  // boundaries" above) would never land on one.
  //
  // A crossing tick's fDist does NOT land exactly ON a boundary — ticks are
  // discrete, so the tick that first reports a new sector is somewhere just
  // PAST the true boundary, by at most one tick's worth of floor-world
  // movement. That overshoot is bounded: the widest speed swept here is 700
  // world units/s, so a tick can move fDist at most
  // 700 * STEP * FLOOR_PARALLAX ≈ 5.83, plus a couple of px of rounding
  // slop — comfortably under OVERSHOOT_BOUND. What has to be true at every
  // crossing is that this overshoot is measured from a REAL boundary, i.e.
  // it agrees with BOTH citygrid.js's own sectorIndex (the crossing lands
  // within OVERSHOOT_BOUND of a whole SECTOR_PERIOD, which — since
  // SECTOR_PERIOD is a whole multiple of ARTERIAL_PERIOD — is also within
  // OVERSHOOT_BOUND of a whole ARTERIAL_PERIOD) and scenery.js's own
  // gridPhase (the floor tile's ACTUAL phase function, not a re-derivation
  // of the modulo — a genuinely independent call that has to read back a
  // small phase, not a mid-tile one, at the same fDist).
  const STEP = 1 / 60;
  const OVERSHOOT_BOUND = 15;
  let crossings = 0;

  // TICKS is sized off the SLOWEST speed swept (120): citygrid.js's
  // SECTOR_PERIOD is ~100,352 world units at the shipped 98x multiplier
  // (see its own header), so covering it at 120 units/s takes ~836s of
  // simulated driving, or ~50,176 ticks at this STEP. 110,000 comfortably
  // clears two crossings even at that slowest speed, and every faster speed
  // in the sweep crosses more often still — this loop cost is pure
  // arithmetic, so the larger budget stays cheap for a test that must run
  // whenever SECTOR_PERIOD_MULT is retuned.
  const TICKS = 110000;

  for (let speed = 120; speed <= 700; speed += 11) {
    let distance = 0;
    let lastSector = sectorIndex(floorDist(distance));
    for (let tick = 0; tick < TICKS; tick++) {
      distance += speed * STEP;
      const fDist = floorDist(distance);
      const sector = sectorIndex(fDist);

      if (sector !== lastSector) {
        crossings++;
        const overshoot = fDist % ARTERIAL_PERIOD;
        assert.ok(
          overshoot >= 0 && overshoot < OVERSHOOT_BOUND,
          `at speed=${speed}, tick=${tick}, distance=${distance.toFixed(2)}: sector changed to ${sector} but fDist=${fDist} is ${overshoot} past the nearest ARTERIAL_PERIOD, not a fresh tile boundary`,
        );
        assert.equal(
          gridPhase(fDist, 0), overshoot,
          `at speed=${speed}, tick=${tick}, distance=${distance.toFixed(2)}: the floor tile's own gridPhase disagrees with fDist's own overshoot from the boundary at fDist=${fDist}`,
        );
        lastSector = sector;
      }
    }
  }

  assert.ok(crossings > 20, `expected many sector crossings across this speed sweep, got ${crossings}`);
});

test("sectors.update()'s palette pick agrees with scenery/road's own camY-based sector, across a wide speed sweep", () => {
  // A REAL BUG, caught by hand in the browser and reproduced here: sectors.js
  // used to compute fDist as Math.round(distance * FLOOR_PARALLAX) straight
  // off the raw simulation `distance` — but scenery.render()/road.render()
  // compute it as Math.round(Math.round(distance) * FLOOR_PARALLAX), because
  // main.js rounds the camera to camY = Math.round(distance) ONCE and hands
  // THAT to every layer (see main.js's own "THE CAMERA IS QUANTISED" header).
  // Those two roundings usually agree, but on roughly 1 in 25 sector
  // crossings (found by sweeping a wide range of speeds) they land on
  // opposite sides of a SECTOR_PERIOD boundary for one tick — and on that
  // tick, setSector() would fire for a sector NEITHER scenery.js's nor
  // road.js's own cache keys agree is current. Since spritecache.js's Map
  // has no eviction, a building or floor tile built under that mismatched
  // palette bakes the WRONG sector's colour in permanently — reproduced live
  // as buildings staying one colour while the road/floor had already moved
  // on to the next.
  //
  // This asserts the FIX rather than re-deriving the bug: whatever palette
  // sectors.update() lands on for a given `distance` must be the SAME
  // palette scenery.js's own currentSector(fDist) would pick for the exact
  // fDist scenery.render()/road.render() actually draw with this frame.
  // Compared via BUILDING_EDGE (a live binding) rather than a raw sector
  // index, since that's what actually ends up baked into a sprite.
  sectorsReset();
  const push = () => {};
  const busy = () => false;
  let clockValue = 0;
  const STEP = 1 / 60;

  for (let speed = 120; speed <= 700; speed += 17) {
    sectorsReset();
    let distance = 0;
    for (let tick = 0; tick < 3000; tick++) {
      distance += speed * STEP;
      clockValue += STEP;
      sectorsUpdate(STEP, clockValue, distance, push, busy);
      const gotEdge = BUILDING_EDGE;

      // Ground truth: the exact fDist scenery.render()/road.render() would
      // compute this frame, via the SAME camY = Math.round(distance) step
      // main.js takes before handing distance to any render-side layer.
      const camY = Math.round(distance);
      const fDist = Math.round(camY * FLOOR_PARALLAX);
      const expectedSector = currentSector(fDist);
      setSector(expectedSector);
      const expectedEdge = BUILDING_EDGE;

      assert.equal(
        gotEdge, expectedEdge,
        `at speed=${speed}, tick=${tick} (distance=${distance.toFixed(2)}), ` +
        `sectors.update() picked a different palette than scenery/road's own camY-based sector would`,
      );
    }
  }
  sectorsReset();
});

test("sector names are stable per index", () => {
  // Same contract as links.js's callsign() (its own test above): a sector
  // has to read the same name every time, which is only true if sectorName
  // is a pure function of the index alone.
  for (const index of [0, 1, 2, 7, -1, -5, 12345]) {
    const a = sectorName(index);
    const b = sectorName(index);
    assert.equal(a, b, `sectorName(${index}) is not stable across calls`);
    assert.equal(typeof a, "string");
    assert.ok(a.length > 0, `sectorName(${index}) is empty`);
  }
});

test("faction colours are byte-identical in every sector", () => {
  // THE single most valuable test in this sub-phase: the guard on the rule
  // that protects gameplay legibility (palette.js's own header — "green is
  // the world, red/amber are gameplay faction, a sector may recolour the
  // city only"). setSector() must never touch any of these, in ANY sector,
  // including sectors well past SECTOR_COUNT (the wrap-around case a long
  // run actually reaches). PLAYER/ENEMY*/NEUTRAL*/HAZARD/CRITICAL_FLASH are
  // the faction read; GREEN* are the road/HUD's own invariant green family,
  // deliberately kept OUT of the sector table (see palette.js's own "why the
  // split falls exactly here" comment) and checked here too since a future
  // change accidentally routing one of them through SECTOR_PALETTES would
  // otherwise pass every other test in this file silently.
  // Snapshotted BEFORE any setSector() call in this file runs, so this is a
  // claim about the actual shipped values, not a tautology against whatever
  // setSector last left behind.
  const before = {
    PLAYER, PLAYER_THRUST, HAZARD, CRITICAL_FLASH,
    ENEMY, ENEMY_DEEP, ENEMY_PALE, ENEMY_THRUST,
    NEUTRAL, NEUTRAL_DEEP, NEUTRAL_THRUST,
    GREEN, GREEN_BRIGHT, GREEN_PALE, GREEN_DIM,
  };
  try {
    for (let i = -3; i < SECTOR_COUNT * 3; i++) {
      setSector(i);
      assert.equal(PLAYER, before.PLAYER, `PLAYER changed after setSector(${i})`);
      assert.equal(PLAYER_THRUST, before.PLAYER_THRUST, `PLAYER_THRUST changed after setSector(${i})`);
      assert.equal(HAZARD, before.HAZARD, `HAZARD changed after setSector(${i})`);
      assert.equal(CRITICAL_FLASH, before.CRITICAL_FLASH, `CRITICAL_FLASH changed after setSector(${i})`);
      assert.equal(ENEMY, before.ENEMY, `ENEMY changed after setSector(${i})`);
      assert.equal(ENEMY_DEEP, before.ENEMY_DEEP, `ENEMY_DEEP changed after setSector(${i})`);
      assert.equal(ENEMY_PALE, before.ENEMY_PALE, `ENEMY_PALE changed after setSector(${i})`);
      assert.equal(ENEMY_THRUST, before.ENEMY_THRUST, `ENEMY_THRUST changed after setSector(${i})`);
      assert.equal(NEUTRAL, before.NEUTRAL, `NEUTRAL changed after setSector(${i})`);
      assert.equal(NEUTRAL_DEEP, before.NEUTRAL_DEEP, `NEUTRAL_DEEP changed after setSector(${i})`);
      assert.equal(NEUTRAL_THRUST, before.NEUTRAL_THRUST, `NEUTRAL_THRUST changed after setSector(${i})`);
      assert.equal(GREEN, before.GREEN, `GREEN changed after setSector(${i}) — the road/HUD's own green must stay out of the sector table`);
      assert.equal(GREEN_BRIGHT, before.GREEN_BRIGHT, `GREEN_BRIGHT changed after setSector(${i})`);
      assert.equal(GREEN_PALE, before.GREEN_PALE, `GREEN_PALE changed after setSector(${i})`);
      assert.equal(GREEN_DIM, before.GREEN_DIM, `GREEN_DIM changed after setSector(${i})`);
    }
  } finally {
    setSector(0); // leave shared palette state as every other test expects it
  }
});

test("the sprite-cache-bound wrap uses a small fixed SECTOR_COUNT, not a growing distance-derived index", () => {
  // citygrid.js's sectorIndex is deliberately UNBOUNDED (it's a statement
  // about geometry — see its own comment); wrapping it to a palette is
  // engine/palette.js's setSector, which must accept any integer, including
  // ones far outside [0, SECTOR_COUNT), and still resolve to one of the
  // SECTOR_COUNT tables rather than throwing or returning undefined colours.
  for (const i of [-1000, -1, 0, 1, SECTOR_COUNT - 1, SECTOR_COUNT, SECTOR_COUNT * 50 + 3]) {
    setSector(i);
    assert.equal(typeof PLAYER, "string", "setSector must never corrupt an invariant binding");
  }
  setSector(0);
});

test("the floor tile cache never holds more than 2 entries", () => {
  // scenery.js's floorGridTile is keyed on (W, H, sector) and MUST stay
  // bounded to 2 (see its own comment: the old sector's tile has to survive
  // long enough to cover whatever hasn't scrolled past a boundary yet while
  // the new one builds). Exercised here against makeBoundedCache directly —
  // floorGridTile itself touches `document` and can't run under plain Node
  // (see this file's header on why spritecache.js/scenery.js's canvas code
  // stays out of these tests), but the eviction rule it's built on has
  // nothing to do with canvases and is exactly what needs pinning.
  const cache = makeBoundedCache(2);
  cache.set("600x800x0", "tileA");
  cache.set("600x800x1", "tileB");
  assert.equal(cache.size, 2);
  cache.set("600x800x2", "tileC");
  assert.equal(cache.size, 2, `cache grew to ${cache.size} entries, expected at most 2`);
  assert.equal(cache.get("600x800x0"), undefined, "the oldest tile should have been evicted");
  assert.equal(cache.get("600x800x1"), "tileB", "the second tile should still be cached");
  assert.equal(cache.get("600x800x2"), "tileC", "the newest tile should be cached");

  // Re-requesting an already-cached key is a HIT, not a fresh insert — it
  // must not itself evict anything (a rebuild-on-every-lookup bug would
  // still pass the raw size check above while thrashing the tile every
  // frame at a stable, non-crossing distance).
  cache.set("600x800x1", "tileB-rebuilt");
  assert.equal(cache.size, 2, "re-setting an existing key changed the cache size");
});

test("every sector crossing pushes a HINT-severity line through the shared city-chatter throttle", () => {
  // Drives game/sectors.js's real update() across enough distance to cross
  // several SECTOR_PERIOD boundaries, with a stubbed push/busy exactly like
  // links.js's own announce() tests use, so this doesn't touch the real
  // singleton SYS LOG. Every push observed must be HINT (never WARN/
  // CRITICAL, which console.js maps to the gameplay faction colours a city
  // line must never borrow — see this file's other "every city-log line is
  // HINT" test for links.js's own version of the same guarantee).
  sectorsReset();
  // announceCityLine's rate-limit clock is SHARED with links.js's own node
  // pings (see links.js's own header on why) — reset it too, or whatever
  // clock value the earlier links.js tests left behind blocks every push
  // this test expects, for a reason that has nothing to do with sectors.
  linksReset();
  const pushed = [];
  const push = (text, severity) => pushed.push({ text, severity });
  const busy = () => false;

  const STEP = 1 / 60;
  const SPEED = 700; // px/s of simulated `distance` — the player's top speed
                      // (player.js's MAX_SPEED), so this reaches a crossing
                      // in the fewest simulated seconds the game itself ever
                      // could. SECTOR_PERIOD's shipped 98x multiplier puts a
                      // boundary every ~143.4s at this speed (citygrid.js's
                      // own SECTOR_PERIOD_MULT comment has the full derivation)
  const SPAN = 600; // seconds — comfortably several crossings at SPEED above
  let distance = 0;
  let clockValue = 0;
  for (let t = 0; t < SPAN; t += STEP) {
    distance += SPEED * STEP;
    clockValue += STEP; // mirrors scenery.js's own clock (announceCityLine's
                         // rate-limit input) without needing scenery.update()
                         // and its own per-run "playing" gating in this test
    sectorsUpdate(STEP, clockValue, distance, push, busy);
  }

  assert.ok(pushed.length > 0, "expected at least one sector crossing over a long simulated drive");
  for (const m of pushed) {
    assert.equal(m.severity, CONSOLE_HINT, `sector crossing pushed "${m.text}" at non-HINT severity`);
  }
  sectorsReset();
  linksReset();
});

test("the rescan glitch is transient — it ends on its own, not just on the next crossing", () => {
  // sectors.js's own glitching() lets this be asserted without a canvas:
  // update() must leave the glitch live for a little while after a crossing
  // (so the rescan has something to draw) and then let it lapse well before
  // the NEXT crossing at this test's speed — a glitch that never clears
  // would silently become a permanent full-screen effect, exactly the
  // "costs nothing when it isn't firing" property this sub-phase exists to
  // guarantee.
  sectorsReset();
  const push = () => {};
  const busy = () => false;
  const STEP = 1 / 60;

  // Cross exactly one boundary, then let a couple of frames pass.
  sectorsUpdate(STEP, 0, 0, push, busy); // settle into sector 0, no crossing
  const distancePeriod = SECTOR_PERIOD / FLOOR_PARALLAX;
  sectorsUpdate(STEP, STEP, distancePeriod + 1, push, busy); // cross into sector 1
  assert.ok(sectorsGlitching(), "expected the glitch to be live immediately after a crossing");

  for (let i = 0; i < 60; i++) sectorsUpdate(STEP, STEP * (i + 2), distancePeriod + 1, push, busy);
  assert.ok(!sectorsGlitching(), "expected the glitch to have lapsed a full second after the crossing");
  sectorsReset();
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

test("a side-swipe pushes the target into a slide, not just apart", () => {
  // collisions.js's PUSH_GAIN turns standing pressure into a vLateral slide
  // that outlives the contact — this is what lets ramming a car sideways
  // carry it into whatever is next to it (another car, a mine) rather than
  // just nudging it apart for one frame.
  const pusher = body({ worldY: 0, offset: 0, speed: 200 });
  const target = body({ worldY: 0, offset: 30, speed: 200 }); // deep lateral overlap
  resolveCollisions([pusher, target], 1 / 60);
  assert.notEqual(target.vLateral, 0, "the target should have been shoved sideways");
  assert.ok(target.offset > 30, "separation alone should have moved it further from the pusher");
});

test("ramSpeed costs a body more speed against a heavier blocker", () => {
  // The same idea sideSwipe/rearEnd give two moving bodies, generalised to a
  // blocker that never moves — see obstacles.js, which prices a static hazard
  // with this exact function.
  const speed = 300;
  const light = ramSpeed(speed, PLAYER_MASS, 0.25);
  const heavy = ramSpeed(speed, PLAYER_MASS, 3.5);
  assert.ok(light < speed, "even a light blocker should cost some speed");
  assert.ok(heavy < light, "a heavier blocker must cost far more speed");
  assert.ok(heavy >= 0, "speed must never go negative");
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
    // A laidOnly hazard (the spike strip) is never available to the SPAWNER at
    // any distance, so the gate below says nothing about it — see
    // obstacleAvailable, and the test just after this one that pins it.
    if (type.laidOnly) continue;
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

// What TAB actually walks (weapons.js's Loadout.next): the catalogue minus the
// layers, which have their own key and their own cycle. Kept as a derived list
// rather than a count so a third layer changes nothing here.
const GUN_TYPES = WEAPON_TYPES.filter((t) => !t.payload);

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
  // A LAP IS THE NUMBER OF GUNS, not the size of the catalogue: next() skips
  // the layers (weapons.js), so stepping WEAPON_TYPES.length times overshoots
  // by however many of those are carried and lands on the wrong weapon.
  for (let i = 0; i < GUN_TYPES.length; i++) loadout.next();
  assert.equal(loadout.current, first);
  assert.ok(!loadout.current.tryFire(), "the cooldown should have survived the swap");
});

test("the loadout cycles through every gun and returns", () => {
  const loadout = new Loadout();
  const seen = new Set();
  for (let i = 0; i < GUN_TYPES.length; i++) {
    seen.add(loadout.current.type.id);
    loadout.next();
  }
  assert.equal(seen.size, GUN_TYPES.length, "TAB does not reach every gun");
  assert.equal(loadout.current.type.id, GUN_TYPES[0].id, "the cycle does not return to the start");
});

test("the player's mine layer is a Weapon like any other, and its payload resolves", () => {
  // weapons.js's "mine" entry mirrors armament.js's own MINE_LAYER — a rate of
  // fire and a magazine, plus a payload naming a real OBSTACLE_TYPES entry.
  const mineType = WEAPON_TYPES.find((t) => t.payload);
  assert.ok(mineType, "expected a mine-layer entry in the player's own catalogue");
  assert.ok(obstacleTypeById(mineType.payload), "the payload must name a real obstacle type");

  const w = new Weapon(mineType);
  assert.ok(w.tryFire(), "the first drop should be free, like any other weapon");
  assert.ok(!w.tryFire(), "a second drop in the same instant must be refused");
});

test("the player's mine is the same hazard the enemy's own mine layer lays", () => {
  // obstacleshapes.js: an obstacle's colour is fixed by its ROLE, not by who
  // owns it — "an amber mine or a red pylon would break the two-family read."
  // The player's mine reuses the enemy's own catalogue entry rather than
  // growing a second, cosmetically distinct one.
  const mineType = WEAPON_TYPES.find((t) => t.payload);
  assert.equal(mineType.payload, "caltrop");
});

test("the deployable cycle only ever selects a layer, never a gun", () => {
  // weapons.js: the deploy key must not be able to reach a gun, or CTRL would
  // fire it out of the wrong slot. Walked a full lap and then some, so a
  // catalogue with the layers at either end is covered too.
  const loadout = new Loadout();
  for (let i = 0; i < WEAPON_TYPES.length * 2 + 1; i++) {
    assert.ok(loadout.deployable, "a catalogue with a layer in it must always have one selected");
    assert.ok(
      loadout.deployable.type.payload,
      `the deploy cycle selected ${loadout.deployable.type.id}, which is a gun`,
    );
    loadout.nextDeployable();
  }
});

test("the two cycles never disturb each other", () => {
  // The whole reason the mine got its own key: laying one must not change
  // which gun is in hand, and picking a gun must not change what CTRL drops.
  const loadout = new Loadout();
  const gun = loadout.current;

  // Five steps over however many layers are carried, so this lands somewhere
  // other than where it started whenever there is more than one — the cursor
  // is read AFTER, not before, since where it ends up is the cycle's own
  // business and not what this test is about.
  for (let i = 0; i < 5; i++) loadout.nextDeployable();
  assert.equal(loadout.current, gun, "cycling deployables moved the gun in hand");
  const layer = loadout.deployable;

  for (let i = 0; i < 5; i++) loadout.next();
  assert.equal(loadout.deployable, layer, "cycling guns moved the selected deployable");
});

test("a loadout carrying no layer has nothing to deploy, and says so", () => {
  // weapons.js's `deployable` returns null rather than throwing: the enemy's
  // own Armament builds a Loadout-shaped thing with no layer in it, and a
  // catalogue is free not to carry one.
  const guns = WEAPON_TYPES.filter((t) => !t.payload);
  const loadout = new Loadout(guns);
  assert.equal(loadout.deployable, null);
  assert.equal(loadout.nextDeployable(), null, "cycling nothing must be a no-op, not a crash");
  assert.equal(loadout.current.type.id, guns[0].id, "and must not have moved the gun in hand");
});

// --- Road obstacles -----------------------------------------------------------

test("every obstacle type carries coherent, positive gameplay numbers", () => {
  for (const t of OBSTACLE_TYPES) {
    assert.ok(t.health > 0, `${t.id}: health must be positive`);
    // WEIGHT IS A SPAWN FREQUENCY, so only a spawnable type needs one. A
    // laidOnly hazard must carry NO weight rather than an unread one — a
    // number the spawner never reads is a number that will eventually be
    // believed by somebody.
    if (t.laidOnly) {
      assert.equal(t.weight, 0, `${t.id}: a laid-only hazard must carry no spawn weight`);
    } else {
      assert.ok(t.weight > 0, `${t.id}: weight must be positive`);
    }
    assert.ok(t.blastRadius >= 0, `${t.id}: blastRadius must not be negative`);
    assert.ok(t.blastDamage >= 0, `${t.id}: blastDamage must not be negative`);
  }
});

test("the spike strip takes speed, not hull — and the mine is still the killer", () => {
  // obstacletypes.js: "the moment a strip does enough damage to be worth
  // laying FOR the damage, the player will simply lay whichever of the two
  // kills faster and the pair collapses into one weapon."
  const spikes = OBSTACLE_TYPES.find((t) => t.id === "spikes");
  const mine = OBSTACLE_TYPES.find((t) => t.id === "caltrop");
  const lightest = Math.min(...CAR_TYPES.map((t) => t.health));

  assert.ok(
    spikes.contactDamage < lightest,
    `a strip's ${spikes.contactDamage} can kill the lightest car outright (${lightest} hull)`,
  );
  assert.ok(spikes.contactDamage < mine.blastDamage, "a strip must not out-hit the mine");
  assert.equal(spikes.blastRadius, 0, "a strip must not explode — it stays on the road");

  // The crawl has to be a real one for EVERY type, not just the heavy ones.
  const slowest = Math.min(...CAR_TYPES.map((t) => t.speedMin));
  assert.ok(
    spikes.slowTo < slowest,
    `a strip's ${spikes.slowTo} is not below the slowest cruise on the road (${slowest})`,
  );
});

test("the spike strip is wide enough to go around and narrow enough to leave a road", () => {
  // obstacleshapes.js: it cannot be threaded, only gone around — but "anything
  // past ~3 lanes here would make a single drop unavoidable".
  const spikes = OBSTACLE_TYPES.find((t) => t.id === "spikes");
  const mine = OBSTACLE_TYPES.find((t) => t.id === "caltrop");
  const stripW = OBSTACLE_SHAPES[spikes.shape].size[0];
  const mineW = OBSTACLE_SHAPES[mine.shape].size[0];
  const widestCar = Math.max(...CAR_TYPES.map((t) => t.w));

  assert.ok(stripW > mineW * 3, "the strip must not read as a wider mine");
  assert.ok(
    stripW > LANE_WIDTH * 2,
    `a strip ${stripW} wide does not span the two lanes that make it un-threadable`,
  );
  // Laid hard against one barrier — the worst case — there must still be room
  // for the widest thing on the road to pass on the other side.
  assert.ok(
    ROAD_HALF_WIDTH * 2 - stripW > widestCar,
    `a strip laid at the edge leaves ${ROAD_HALF_WIDTH * 2 - stripW}, too little for a ${widestCar}-wide car`,
  );
});

// One live car on an otherwise empty road, driven through its own update() so
// the speed band clamp and driveCar both really run — which is the whole point
// of the puncture tests below, since the crawl is defined as the one thing
// allowed to sit outside that clamp.
function lonePuncturedCar() {
  const traffic = new Traffic();
  const player = new Player(300, 496);
  traffic.spawn({ distance: 0, player, H: 800 });
  const car = traffic.cars[0];
  assert.ok(car, "expected spawn to put a car on the road");
  return { car, world: { cars: traffic.cars, obstacles: [], playerBody: null } };
}

test("a car crossing a strip is punctured once, not once per tick", () => {
  // traffic.js's puncture(): a car sits on a strip for many ticks, and the
  // scratch being taken sixty times a second would make the gentlest hazard in
  // the game the deadliest.
  const spikes = OBSTACLE_TYPES.find((t) => t.id === "spikes");
  const { car } = lonePuncturedCar();
  const before = car.health;

  for (let i = 0; i < 60; i++) car.puncture(spikes);

  assert.equal(before - car.health, spikes.contactDamage, "the strip bit more than once");
  assert.equal(car.spikeTime, spikes.slowTime);
});

test("a punctured car is held below its own speed band, then recovers", () => {
  // traffic.js: the crawl is the ONE deliberate exception to cartypes.js's
  // "hard floor and ceiling", which is why it is applied after the clamp.
  const spikes = OBSTACLE_TYPES.find((t) => t.id === "spikes");
  const { car, world } = lonePuncturedCar();
  assert.ok(
    car.type.speedMin > spikes.slowTo,
    "the test is meaningless unless the crawl is below this car's own floor",
  );

  car.puncture(spikes);
  for (let i = 0; i < 60 * 4; i++) car.update(1 / 60, world);
  assert.ok(
    car.speed <= spikes.slowTo + 1,
    `a punctured car settled at ${car.speed}, above its ${spikes.slowTo} crawl`,
  );

  // ...and once the puncture has run out it climbs back into its own band.
  for (let i = 0; i < 60 * 8; i++) car.update(1 / 60, world);
  assert.ok(
    car.speed >= car.type.speedMin,
    `the puncture never wore off — the car is still at ${car.speed}, below its own floor`,
  );
});

test("the strip is feared out of proportion to what it costs", () => {
  // obstacles.js's `threat` and obstacletypes.js's own note: if the AI weighed
  // the strip's 6 damage it would drive straight over every one, which makes
  // it a guaranteed hit and a worse weapon — the interesting thing a strip
  // does is make traffic swerve.
  const spikes = OBSTACLE_TYPES.find((t) => t.id === "spikes");
  const mine = OBSTACLE_TYPES.find((t) => t.id === "caltrop");
  assert.ok(
    spikes.threat > spikes.contactDamage * 3,
    "a strip that reads as harmless to the AI is a strip nothing ever swerves for",
  );
  assert.ok(
    spikes.threat < mine.blastDamage,
    "...but it must still be the mine that empties a lane fastest",
  );
});

test("a laid hazard is never left hanging over a barrier", () => {
  // obstacles.js's drop(): "wherever that car was" says which LANE, not that a
  // hazard may be drawn through the wall. Only bites on the wide ones — a mine
  // laid at the edge was always inside the limit, which is why this went
  // unnoticed until the spike strip.
  const obstacles = new Obstacles(new Explosions());
  for (const type of OBSTACLE_TYPES) {
    const w = OBSTACLE_SHAPES[type.shape].size[0];
    for (const edge of [-ROAD_HALF_WIDTH, ROAD_HALF_WIDTH]) {
      obstacles.list.length = 0;
      // A car pinned against the barrier — the worst case a drop can be given.
      assert.ok(obstacles.drop(type, { worldY: 0, offset: edge, h: 60 }));
      const o = obstacles.list[0];
      assert.ok(
        Math.abs(o.offset) + w / 2 <= ROAD_HALF_WIDTH + 1e-9,
        `${type.id} laid at ${edge} reaches ${Math.abs(o.offset) + w / 2}, past the road's ${ROAD_HALF_WIDTH}`,
      );
    }
  }
});

test("a laid-only hazard never turns up on the road by itself", () => {
  // obstacletypes.js: a spike strip is somebody's deliberate act, and one
  // appearing ahead of the player would read as the city trapping its own
  // traffic. Rolled hard rather than reasoned about, because the failure mode
  // is a rare roll rather than a wrong branch.
  const laidOnly = OBSTACLE_TYPES.filter((t) => t.laidOnly);
  assert.ok(laidOnly.length, "expected at least one laid-only hazard in the catalogue");
  for (let i = 0; i < 2000; i++) {
    const picked = pickObstacleType(Infinity);
    assert.ok(!picked?.laidOnly, `the spawner rolled ${picked?.id}, which is laid-only`);
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
// only need `player`, `distance`, `W`, `H` and (optionally) `cars`. The
// catalogue is free to gate every type behind a minDistance (see "obstacle
// gating uses the same units as the car catalogue" above), so `distance: 0`
// is not guaranteed to have anything available — this sits past every type's
// gate instead, mirroring the CAR_TYPES "far" idiom used for the same reason.
const OBSTACLE_GATE_CLEAR = Math.max(...OBSTACLE_TYPES.map((t) => t.minDistance ?? 0)) * DIST_UNITS;
function obstacleWorld() {
  const player = new Player(300, 496);
  return { player, distance: OBSTACLE_GATE_CLEAR, W: 600, H: 800, cars: [] };
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

test("hitting a heavier obstacle costs far more speed than a light one", () => {
  // obstacletypes.js's `mass`: a trestle is barely felt, a tetra costs nearly
  // as much as parking a rig in the way. Uses obstacles.drop() to place a
  // specific type deterministically rather than relying on spawn()'s random
  // pick.
  const trestle = obstacleTypeById("trestle");
  const tetra = obstacleTypeById("tetra");
  const startSpeed = 300;

  function speedAfterHit(type) {
    const obstacles = new Obstacles(new Explosions());
    const world = obstacleWorld();
    world.player.speed = startSpeed;
    obstacles.drop(type, { worldY: world.distance, offset: 0, h: 0 });
    const o = obstacles.list[0];
    world.distance = o.worldY;
    world.player.x = centerXAt(o.worldY, world.W) + o.offset;
    obstacles.update(1 / 60, world);
    return world.player.speed;
  }

  const afterTrestle = speedAfterHit(trestle);
  const afterTetra = speedAfterHit(tetra);

  assert.ok(afterTrestle < startSpeed, "even a light hazard should cost some speed");
  assert.ok(afterTetra < afterTrestle, "the tetra must cost far more speed than the trestle");
  assert.equal(afterTrestle, ramSpeed(startSpeed, PLAYER_MASS, trestle.mass));
  assert.equal(afterTetra, ramSpeed(startSpeed, PLAYER_MASS, tetra.mass));
});

test("hitting an obstacle also costs a traffic car speed, not just the player", () => {
  // The contact loop in game/obstacles.js treats any live car the same as the
  // player — which is what lets a car SHOVED into a hazard (collisions.js's
  // sideSwipe) pay for it exactly as if it had driven there itself.
  const trestle = obstacleTypeById("trestle");
  const obstacles = new Obstacles(new Explosions());
  const traffic = new Traffic();
  const world = obstacleWorld();
  traffic.spawn(world);
  const car = traffic.cars[0];
  assert.ok(car, "expected spawn to place a car");

  const startSpeed = 300;
  car.speed = startSpeed;
  obstacles.drop(trestle, { worldY: world.distance, offset: 0, h: 0 });
  const o = obstacles.list[0];
  car.worldY = o.worldY;
  car.offset = o.offset;
  world.cars = traffic.cars;

  obstacles.update(1 / 60, world);

  assert.equal(car.speed, ramSpeed(startSpeed, car.mass, trestle.mass));
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
  // The shape of the dial, not its exact settings. Every civilian shares ONE
  // base chassis colour now (cartypes.js), so the dodge/gamble tell has moved
  // to `accent` instead: a civilian with no accent is "amber" and must always
  // dodge, and the roadster's PALE accent is what buys it the room to shoulder
  // through a stack of barrels without muddying that signal for the rest of the
  // traffic — see driving.js's NERVE section.
  const civilians = CAR_TYPES.filter((t) => t.value < 0);
  const amber = civilians.filter((t) => (t.accent ?? t.color) !== NEUTRAL_PALE);
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

// The cheapest lane change `type` could ever make: behaviours.js prices one as a
// side-swipe at the car's own steering rate, so the only thing left to vary is
// who it swipes, and the lightest neighbour is the cheapest. Below this figure a
// `contact` ceiling cannot buy the type anything at all.
function cheapestContact(type) {
  return Math.min(
    ...CAR_TYPES.map((other) => impactCost(type, other, type.steerSpeed, SIDE_DAMAGE)),
  );
}

test("a contact ceiling is either zero or bold enough to do something", () => {
  // The same trap as the nerve test above, sprung by different arithmetic.
  // `contact` is compared against a cost that scales with the car's own
  // steerSpeed, so what counts as a bold number is a property of the TYPE, not
  // of the dial — and a ceiling under the cheapest contact its drivers can even
  // be offered is a tuning attempt that silently did nothing.
  //
  // THIS TEST FOUND ONE. `darter` sat at contact 4 while the cycle's cheapest
  // possible contact is 7.35 hull, so the cycle had been driving at contact 0
  // since the profile was written, and the table said otherwise.
  for (const [name, p] of Object.entries(DRIVING_PROFILES)) {
    if (p.contact === 0) continue; // zero is a decision, not a dead setting
    const users = typesDriving(name, CAR_TYPES);
    if (users.length === 0) continue;
    const floor = Math.min(...users.map(cheapestContact));
    assert.ok(
      p.contact > floor,
      `profile "${name}" has contact ${p.contact}, under the cheapest contact its ` +
        `drivers can be offered (${floor.toFixed(2)} hull) and therefore identical ` +
        `to contact 0. Raise it, or set it to 0 and say so.`,
    );
  }
});

test("every car type names a tactic that actually exists", () => {
  // tacticFor falls back to `cruise` for an unknown name rather than throwing,
  // so a half-written type still drives — but a SHIPPED type taking that path
  // is a catalogue that lies about what its car does.
  //
  // THIS IS THE `convoy` FAILURE, pinned. The rig named a tactic row that
  // resolved to plain `cruise` and carried a comment promising a rolling
  // roadblock, so cartypes.js read as though the rig had a manoeuvre of its own
  // for as long as that row sat there. The row is gone and the rig names
  // `cruise`; this is what stops the next placeholder outliving its author.
  for (const t of CAR_TYPES) {
    assert.ok(
      TACTIC_NAMES.includes(t.behaviour),
      `${t.id} names behaviour "${t.behaviour}", which is not a tactic — it would ` +
        `silently fall back to cruising. Known: ${TACTIC_NAMES.join(", ")}`,
    );
  }
});

test("a chasing driver holds a gap it would still count as contact", () => {
  // The stocker's give-up clock (behaviours.js's `trail`) runs on TRAIL_ENGAGE
  // while its DRIVING holds the profile's `pursueHold`. Those are two numbers
  // in two files, and if the hold gap ever drifted outside the contact gap the
  // car would sit exactly where it means to sit, perfectly in range, and give
  // the player up anyway for no reason either of them could see.
  for (const [name, p] of Object.entries(DRIVING_PROFILES)) {
    if (p.giveUpTime <= 0) continue; // never gives up: nothing to get wrong
    assert.ok(
      p.pursueHold < TRAIL_ENGAGE,
      `profile "${name}" holds station at ${p.pursueHold} but only counts contact ` +
        `inside ${TRAIL_ENGAGE}, so it would disengage while doing its job`,
    );
  }
});

test("a chase range is wider than the gap it chases down to", () => {
  // `pursueRange` is the gap at which chasing STARTS and `pursueHold` the gap
  // it settles at. Inverted, the car would only ever chase when it was already
  // closer than it wanted to be, and would cruise the rest of the time — a
  // hostile that never actually comes after anyone.
  for (const [name, p] of Object.entries(DRIVING_PROFILES)) {
    assert.ok(
      p.pursueHold < p.pursueRange,
      `profile "${name}" holds at ${p.pursueHold} but only chases inside ` +
        `${p.pursueRange}: it would never close on the player at all`,
    );
  }
});

test("the ram's block is slower than the player's own minimum", () => {
  // behaviours.js's `ram`, once ahead of the player, asks for a fraction of
  // THEIR speed with `ramFloor` underneath it. That floor has to sit below the
  // player's own MIN_SPEED or simply lifting off the throttle would out-slow
  // the roadblock and the whole second half of the tactic would go slack.
  for (const [name, p] of Object.entries(DRIVING_PROFILES)) {
    assert.ok(
      p.ramFloor < MIN_SPEED,
      `profile "${name}" blocks at a floor of ${p.ramFloor}, at or above the ` +
        `player's own minimum of ${MIN_SPEED}: they could simply coast past it`,
    );
  }
});

// A hostile that wants the player's line, with that line already occupied by
// something it will not touch. `stale` is the intent left over from whatever it
// was doing before — the thing that must not survive the tick.
function blockedChaseScenario(stale) {
  const type = CAR_TYPES.find((t) => t.id === "interceptor");
  const rig = CAR_TYPES.find((t) => t.id === "rig");
  const here = laneOffset(0);
  const there = laneOffset(LANE_COUNT - 1);

  const car = driver({
    worldY: 0, offset: here, targetOffset: stale, speed: 430, cruiseSpeed: 430,
    targetSpeed: 430, w: type.w, h: type.h, type, drive: drivingFor(type),
    nerve: 0, contact: 0,
  });
  // Parked on the line the hostile wants. The interceptor's `contact` is 0, so
  // it will not take a lane with this in it at any price.
  const wall = driver({
    worldY: 90, offset: there, speed: 195, cruiseSpeed: 195, targetSpeed: 195,
    targetOffset: there, w: rig.w, h: rig.h, type: rig, drive: drivingFor(rig),
  });
  const playerBody = {
    worldY: 300, offset: there, w: 34, h: 60, speed: 460, alive: true,
    prevOffset: there, mass: 1.4, damage() {},
  };
  driveCar(car, 1 / 60, {
    cars: [car, wall], obstacles: [], playerBody,
    player: new Player(300, 496), H: 800,
    fireShot: () => {}, dropMine: () => true,
  });
  return car;
}

test("a chasing car whose line is blocked holds its own line, not a stale one", () => {
  // THE INTENT MUST BE WRITTEN EVERY TICK, which is the rule `keepLane` already
  // enforces for civilians and which the hostile tactics used to break. All
  // four of them read `if (!blocked(...)) car.targetOffset = want;` and did
  // nothing on the other branch — so a car that could not take the player's
  // line went on steering at wherever the player had been several ticks ago,
  // quite possibly straight into the traffic that blocked it.
  //
  // Measured before the fix: a hostile sitting in the outer lane with a stale
  // target of +40 kept asking for +40 for as long as the block lasted.
  const stale = 40;
  const car = blockedChaseScenario(stale);
  assert.notEqual(
    car.targetOffset, stale,
    "a blocked chase must not keep steering at the line it wanted last tick",
  );
  assert.equal(
    car.targetOffset, car.offset,
    "with nowhere it will go, the car should hold the line it is actually on",
  );
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

test("the civilian road is a speed gradient across the lanes", () => {
  // driving.js states the lane preferences BY SPEED: the slow haulers want the
  // lanes by the barrier and the fast machines want the lanes by the centre-line,
  // so the road sorts itself and the player's choice of lane is a choice about
  // what they will meet there. It is the kind of design that survives exactly
  // until somebody retunes a speed range, at which point nothing breaks and the
  // road just quietly stops making sense — so it is asserted rather than written
  // down.
  const civilians = CAR_TYPES.filter((t) => t.value < 0);
  const pace = (t) => (t.speedMin + t.speedMax) / 2;
  const paces = civilians.map(pace).sort((a, b) => a - b);
  const median = paces[Math.floor(paces.length / 2)];

  for (const t of civilians) {
    const home = drivingFor(t).laneHome;
    if (home === "any") continue; // the reference car, filling in what is left
    const wanted = pace(t) < median ? "outer" : "inner";
    assert.equal(
      home,
      wanted,
      `${t.id} cruises at ${pace(t)} against a civilian median of ${median} and wants ` +
        `the ${home} lanes. A car on the wrong side of the median makes the gradient ` +
        `unreadable — retune its speed, or its laneHome.`,
    );
  }
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
//
// `contact` is set on BOTH the car and the profile behind it, because those are
// two different things and behaviours.js reads both: the profile carries the
// CEILING (and a ceiling of zero means "nobody at all"), the car carries the
// figure it rolled under that ceiling. A fixture that set only the roll was
// describing a car whose profile forbids what the car is doing.
function boxedIn(contact, steerSpeed = 90) {
  const car = driver({
    worldY: 0, offset: laneOffset(1), w: 34, h: 60, speed: 300, cruiseSpeed: 300,
    targetSpeed: 300, targetOffset: laneOffset(1), contact,
    drive: { ...COMMUTER, contact },
    type: { behaviour: "cruise", w: 34, steerSpeed, speedMax: 400 },
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

test("a contact ceiling of zero means nobody, even when the swipe would be free", () => {
  // The rig's case, and the reason behaviours.js reads the ceiling off the
  // PROFILE instead of just testing the rolled figure. `contactCost` returns 0
  // for any car steering slower than collisions.js's DAMAGE_FLOOR of 40, so
  // `0 <= 0` used to wave every occupied lane on the road through — which left
  // the heaviest, least agile vehicle in the catalogue as the single one that
  // would slide into a lane with somebody in it without a thought, in flat
  // contradiction of the profile it names.
  const rig = CAR_TYPES.find((t) => t.id === "rig");
  assert.equal(
    cheapestContact(rig),
    0,
    "this proves nothing unless the rig's lane changes really are free",
  );
  assert.ok(rig.steerSpeed < 40, "...which is only true while it steers under the floor");

  const timid = boxedIn(0, rig.steerSpeed);
  assert.equal(timid.targetSpeed, 0, "a free swipe is still a swipe, and this one said no");
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

// --- Seeking, burning and piercing rounds ------------------------------------
//
// The three mechanics that stop the cannon, the tracker and the rocket from
// being one weapon at three sets of numbers (weapons.js). Each is tested at the
// level it lives at: what the CATALOGUE promises, and what projectiles.js does
// with it.

const ROCKET_TYPE = WEAPON_TYPES.find((t) => t.id === "rocket");
const TRACKER_TYPE = WEAPON_TYPES.find((t) => t.id === "tracker");
const SHOT_VIEW = { distance: 0, playerY: 496, W: 600, H: 800 };

// A body of the shape projectiles.js resolves against, with enough hull to
// need `hits` rounds of `damage` to put down.
function dummy(worldY, offset, hits, damage, extra = {}) {
  return {
    worldY, offset, w: 34, h: 60, alive: true,
    health: hits * damage,
    taken: 0,
    seekable: true,
    damage(hp) {
      this.taken += hp;
      this.health -= hp;
      if (this.health <= 0) this.alive = false;
    },
    ...extra,
  };
}

test("a seeking round crosses the lanes to reach what it locked on to", () => {
  // weapons.js's ROCKET: "goes where the TARGET is rather than where it was
  // aimed". Fired dead ahead at nothing, up a lane the target is not in.
  const shots = new Projectiles();
  shots.spawn(0, 0, 400, ROCKET_TYPE, 600);
  const car = dummy(700, 150, 1, ROCKET_TYPE.damage);

  for (let i = 0; i < 200 && car.alive; i++) shots.update(1 / 60, [car], SHOT_VIEW);

  assert.ok(!car.alive, "the rocket should have steered a lane and a half across to reach it");
});

test("a seeker cannot turn faster than its own turnRate", () => {
  // The weapon's difficulty knob (weapons.js) — a seeker that could snap onto
  // a target instantly would make every other weapon pointless.
  const shots = new Projectiles();
  const s = shots.spawn(0, 0, 400, ROCKET_TYPE, 600);
  const car = dummy(900, 250, 1, ROCKET_TYPE.damage);

  const dt = 1 / 60;
  const before = s.offset;
  shots.update(dt, [car], SHOT_VIEW);
  assert.ok(s.offset > before, "it should have begun to turn toward the target");
  assert.ok(
    s.offset - before <= ROCKET_TYPE.turnRate * dt + 1e-9,
    `a seeker turned ${s.offset - before} in one tick, past its own ${ROCKET_TYPE.turnRate}/sec`,
  );
});

test("a seeker locks on to cars only, never to road furniture", () => {
  // projectiles.js's seek(): `seekable` is opt-IN, and traffic.js's Car is the
  // only thing that sets it. The player's gunfire is resolved against ONE flat
  // list of cars and obstacles (main.js), so without this a rocket would turn
  // across two lanes to chase a trestle.
  const shots = new Projectiles();
  const s = shots.spawn(0, 0, 400, ROCKET_TYPE, 600);
  const trestle = dummy(700, 150, 1, ROCKET_TYPE.damage, { seekable: undefined });

  for (let i = 0; i < 30; i++) shots.update(1 / 60, [trestle], SHOT_VIEW);

  assert.equal(s.offset, 0, "the rocket must have held its line rather than chasing the obstacle");
  assert.ok(trestle.alive, "and left it alone");
});

test("a rocket leaves the rail slowly and burns up to its top speed, and no further", () => {
  // weapons.js's ROCKET: "A LAUNCH, NOT A SHOT" — worst weapon in the
  // catalogue at point-blank, fastest at the far end of the road.
  const shots = new Projectiles();
  const shooter = 400;
  const s = shots.spawn(0, 0, shooter, ROCKET_TYPE, 600);
  assert.equal(s.speed, shooter + ROCKET_TYPE.muzzleSpeed, "it must launch at its muzzle speed");

  const cannon = WEAPON_TYPES.find((t) => t.id === "cannon");
  assert.ok(
    ROCKET_TYPE.muzzleSpeed < cannon.muzzleSpeed && ROCKET_TYPE.topSpeed > cannon.muzzleSpeed,
    "the burn must start below the cannon's round and finish above it, or it is just a slow bullet",
  );

  for (let i = 0; i < 300; i++) shots.update(1 / 60, [], SHOT_VIEW);
  assert.equal(s.speed, shooter + ROCKET_TYPE.topSpeed, "the burn must reach the cap");
  for (let i = 0; i < 60; i++) shots.update(1 / 60, [], SHOT_VIEW);
  assert.equal(s.speed, shooter + ROCKET_TYPE.topSpeed, "and must not run past it");
});

test("a piercing round punches through what it kills and stops at what survives", () => {
  // weapons.js's TRACKER: killing is the condition, so the heavy types still
  // stop it dead and the rocket stays the answer to armour.
  const shots = new Projectiles();
  shots.spawn(0, 0, 400, TRACKER_TYPE, 600);
  const first = dummy(300, 0, 1, TRACKER_TYPE.damage);   // dies to one round
  const second = dummy(500, 0, 1, TRACKER_TYPE.damage);  // dies to one round
  const rig = dummy(700, 0, 10, TRACKER_TYPE.damage);    // shrugs it off

  for (let i = 0; i < 200; i++) shots.update(1 / 60, [first, second, rig], SHOT_VIEW);

  assert.ok(!first.alive && !second.alive, "one round should have taken both light cars");
  assert.ok(rig.alive, "and stopped at the heavy one");
  assert.equal(rig.taken, TRACKER_TYPE.damage, "which must have been hit exactly once");
});

test("a piercing round's budget is for its whole life, not for each tick", () => {
  // The bodies a round punches through may fall either side of a tick
  // boundary, so a per-tick allowance would make `pierce` unbounded — see
  // projectiles.js's update().
  const shots = new Projectiles();
  shots.spawn(0, 0, 400, TRACKER_TYPE, 600);
  // One more body in the line than the round is allowed to kill, spread far
  // enough apart that each falls in a different tick.
  const line = [];
  for (let i = 0; i <= TRACKER_TYPE.pierce + 1; i++) {
    line.push(dummy(300 + i * 400, 0, 1, TRACKER_TYPE.damage));
  }

  for (let i = 0; i < 400; i++) shots.update(1 / 60, line, SHOT_VIEW);

  const killed = line.filter((t) => !t.alive).length;
  assert.equal(
    killed, TRACKER_TYPE.pierce + 1,
    `one round killed ${killed} cars, past its pierce budget of ${TRACKER_TYPE.pierce} + the first`,
  );
});

test("the rocket's blast is the widest on the road, but never the hardest hit", () => {
  // weapons.js: a hand-aimed warhead should out-REACH road furniture, but
  // obstacletypes.js calls the mine's blastDamage "the single hardest hit
  // anything on the road can deal" — and that claim has to stay true.
  const mine = OBSTACLE_TYPES.find((t) => t.id === "caltrop");
  const widest = Math.max(...OBSTACLE_TYPES.map((t) => t.blastRadius));
  assert.ok(
    ROCKET_TYPE.blastRadius > widest,
    `the rocket's ${ROCKET_TYPE.blastRadius} no longer out-reaches the road's own ${widest}`,
  );
  for (const t of WEAPON_TYPES) {
    assert.ok(
      (t.blastDamage ?? 0) < mine.blastDamage,
      `${t.id}'s blast now hits for ${t.blastDamage}, matching or beating the mine's ${mine.blastDamage}`,
    );
  }
  // And the reach has to actually clear a car, which is what the old 44 never
  // did — the shortest body in the catalogue is longer than that.
  const shortest = Math.min(...CAR_TYPES.map((t) => t.h));
  assert.ok(
    ROCKET_TYPE.blastRadius > shortest,
    `a blast of ${ROCKET_TYPE.blastRadius} cannot reach past the shortest car (${shortest})`,
  );
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
  const { car, fired } = hostileScenario();
  assert.equal(fired.length, 1, "expected exactly one round");
  assert.equal(fired[0].dir, 1, "a player ahead must be shot at up the road");
  // Whichever gun this type actually carries — the interceptor's own
  // fixture, `hostileScenario`, is armed with its rocket (armament.js's
  // `rocketeer`), not the shared blaster, so this checks the round matches
  // the car's own kit rather than assuming which kit that is.
  assert.equal(fired[0].type, car.arms.gun.type);
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

// The mine tests below need a hostile that actually carries a layer.
// `hostileScenario`'s own default (the interceptor) no longer does — see
// armament.js's `rocketeer` — so these override `arms` explicitly with a
// type that still does. The rival is the shipped stand-in for "a hostile
// that mines", alongside the cycle's own dedicated `raid` tactic.
//
// A FRESH INSTANCE PER CALL, not a shared constant: `Armament` carries real
// cooldown and ammo state, so firing it in one test would leave the next
// test's copy already part-spent or still cooling down.
const mineCapableArms = () => armFor(CAR_TYPES.find((t) => t.id === "rival"));

test("a hostile lays the catalogue's mine at a player on its tail", () => {
  const { laid } = hostileScenario(
    { arms: mineCapableArms() },
    { playerBody: { worldY: -200 } },
  );
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
  const clear = hostileScenario({ arms: mineCapableArms() }, { playerBody: { worldY: -200 } });
  assert.equal(clear.laid.length, 1, "the test is meaningless if this case does not lay one");

  const blockedByTraffic = hostileScenario({ arms: mineCapableArms() }, {
    playerBody: { worldY: -200 },
    cars: [between],
  });
  assert.equal(blockedByTraffic.laid.length, 0, "a car between the two must veto the drop");
});

test("a hostile will not drop a mine into the player's face", () => {
  // MINE_MIN_LEAD: a mine that appears with no road left to steer around it is
  // not a threat the player can answer, it is just damage.
  const { laid } = hostileScenario(
    { arms: mineCapableArms() },
    { playerBody: { worldY: -40 } },
  );
  assert.equal(laid.length, 0);
});

test("a mine layer runs dry, and its magazine is what rations mines", () => {
  // weapons.js's blaster is deliberately infinite and the layer deliberately is
  // not — see game/armament.js. This pins the pair: a car cannot mine the road
  // indefinitely.
  const arms = mineCapableArms();
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
  const widest = Math.max(...CAR_TYPES.map((t) => t.w));

  // Park mines wall-to-wall across the whole road, spaced so every gap between
  // them is narrower than the widest car in the catalogue — a fixture that
  // blocks the road by construction, independent of LANE_WIDTH/ROAD_HALF_WIDTH.
  const step = mineW + widest - 1;
  for (let offset = -ROAD_HALF_WIDTH + mineW / 2; offset - mineW / 2 < ROAD_HALF_WIDTH; offset += step) {
    obstacles.list.push({
      alive: true, laid: false, worldY: 1000, offset, w: mineW, h: 26,
    });
  }

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

// --- Pickups -------------------------------------------------------------

test("every ammo pickup names a weapon the player's own Loadout actually carries", () => {
  const loadout = new Loadout();
  for (const type of PICKUP_TYPES) {
    if (type.kind !== AMMO) continue;
    assert.ok(
      loadout.get(type.weaponId),
      `${type.id} names weaponId "${type.weaponId}", which is not in the player's Loadout`,
    );
  }
});

test("an ammo pickup never offers more than the weapon's own magazine holds", () => {
  const loadout = new Loadout();
  for (const type of PICKUP_TYPES) {
    if (type.kind !== AMMO) continue;
    const weapon = loadout.get(type.weaponId);
    assert.ok(
      type.amount <= weapon.type.ammo,
      `${type.id} refills ${type.amount}, more than the ${weapon.type.ammo}-round magazine it tops up`,
    );
  }
});

test("every pickup type resolves to a real shape", () => {
  for (const type of PICKUP_TYPES) {
    assert.ok(PICKUP_SHAPES[type.shape], `${type.id} names a shape index that doesn't exist`);
  }
});

test("Weapon.refill tops up ammo without ever exceeding the catalogue's own starting figure", () => {
  const rocket = WEAPON_TYPES.find((t) => t.id === "rocket");
  const w = new Weapon(rocket);
  w.ammo = 10;
  w.refill(1000);
  assert.equal(w.ammo, rocket.ammo, "refill must cap at the weapon's own starting ammo");
});

test("Player.heal restores hull without ever exceeding maxHealth", () => {
  const player = new Player(0, 0);
  player.damage(50);
  player.heal(1000);
  assert.equal(player.health, player.maxHealth);
});

test("a shielded player takes no damage from any source", () => {
  // player.js: every damage source in the game (bullets, blast, ramming,
  // wall-scrape) funnels through Player.damage, so guarding it there is the
  // shield's whole implementation — this is the test that proves it.
  const player = new Player(0, 0);
  player.activateShield(2);
  player.damage(9999);
  assert.equal(player.health, player.maxHealth, "a shielded player must take zero damage");
});

test("a second shield extends the timer rather than stacking on top of it", () => {
  const player = new Player(0, 0);
  player.activateShield(2);
  player.activateShield(1); // shorter — must not shrink the running shield
  assert.equal(player.shieldTime, 2);
  player.activateShield(5); // longer — must extend it
  assert.equal(player.shieldTime, 5);
});

test("applyPickup dispatches every kind in the catalogue correctly", () => {
  const player = new Player(0, 0);
  const loadout = new Loadout();

  const ammoType = PICKUP_TYPES.find((t) => t.kind === AMMO);
  const weapon = loadout.get(ammoType.weaponId);
  weapon.ammo = 0;
  applyPickup(ammoType, player, loadout);
  assert.equal(weapon.ammo, ammoType.amount);

  const healType = PICKUP_TYPES.find((t) => t.kind === HEAL);
  player.damage(50);
  applyPickup(healType, player, loadout);
  assert.equal(player.health, player.maxHealth);

  const shieldType = PICKUP_TYPES.find((t) => t.kind === SHIELD);
  applyPickup(shieldType, player, loadout);
  assert.equal(player.shieldTime, shieldType.duration);
});

test("driving onto a pickup applies its effect, removes the crate and bursts once", () => {
  const explosions = new Explosions();
  const pickups = new Pickups(explosions);
  const player = new Player(300, 496);
  const loadout = new Loadout();

  const type = pickupTypeById("fix");
  const [w, h] = PICKUP_SHAPES[type.shape].size;
  const worldY = 500;
  pickups.list.push({ type, worldY, offset: 0, alive: true, age: 0, pulsePhase: 0, w, h });

  player.damage(50);
  const world = { player, distance: worldY, W: 600, H: 800, loadout };
  player.x = centerXAt(worldY, world.W);

  pickups.update(1 / 60, world);

  assert.equal(player.health, player.maxHealth, "the FIX crate should have healed the player");
  assert.equal(pickups.list.length, 0, "a collected crate must not remain on the road");

  const alive = explosions.slots.filter((s) => s.alive);
  assert.equal(alive.length, 1, "collecting a crate should spawn exactly one burst");
});

test("Pickups.drop places a crate at an exact spot, bypassing the random spawner", () => {
  // main.js's own use of this: a destroyed hostile's chance to leave a FIX
  // crate exactly where it died, not somewhere the random road spawner
  // would have put one — see Pickups.drop's header for why it needs no
  // separate budget the way obstacles.js's own drop() does.
  const pickups = new Pickups(new Explosions());
  const type = pickupTypeById("fix");
  pickups.drop(type, 1234, -40);

  assert.equal(pickups.list.length, 1);
  const dropped = pickups.list[0];
  assert.equal(dropped.type, type);
  assert.equal(dropped.worldY, 1234);
  assert.equal(dropped.offset, -40);
});

// --- Phase 8 audio infrastructure: voice limiter + duck (context.js) --------
//
// Both are exercised through their PURE forms (planVoiceRequest/commitVoice,
// planDuck) rather than through context.js's stateful requestVoice()/duck()
// wrappers — those short-circuit to a no-op with no ctx (see context.js's
// header on why nothing here may touch an AudioContext), so testing the real
// decision logic means calling the pure functions directly with plain data,
// exactly as context.js's own header says they're built for.

function voiceRequest(over = {}) {
  return { id: "a", priority: 1, maxConcurrent: 3, minInterval: 0, ...over };
}

test("the voice limiter accepts requests until the global cap, then steals the lowest priority", () => {
  let active = [];
  const now = 0;
  // Fill the global cap with distinct ids (so no per-id cap ever fires) at a
  // range of priorities, lowest first.
  for (let i = 0; i < GLOBAL_VOICE_CAP; i++) {
    const result = planVoiceRequest(active, {}, voiceRequest({ id: `id${i}`, priority: i, maxConcurrent: 1 }), now);
    assert.equal(result.accepted, true, `voice ${i} should fit under the cap`);
    active = commitVoice(result.active, { id: `id${i}`, priority: i }, now, 10);
  }
  assert.equal(active.length, GLOBAL_VOICE_CAP);

  // One more, priority higher than the current lowest (id0, priority 0):
  // must be accepted by stealing id0, not by growing past the cap.
  const stealer = planVoiceRequest(active, {}, voiceRequest({ id: "newcomer", priority: 5, maxConcurrent: 1 }), now);
  assert.equal(stealer.accepted, true);
  // planVoiceRequest only decides and steals — it doesn't add the new voice
  // itself (see context.js's header on why that's commitVoice's job), so the
  // evicted slot shows up as a headcount one BELOW the cap until committed.
  assert.equal(stealer.active.length, GLOBAL_VOICE_CAP - 1, "stealing must free exactly the one slot the newcomer needs");
  assert.ok(!stealer.active.some((v) => v.id === "id0"), "the lowest-priority voice (id0) should have been evicted");

  const committed = commitVoice(stealer.active, { id: "newcomer", priority: 5 }, now, 10);
  assert.equal(committed.length, GLOBAL_VOICE_CAP, "after commitVoice, the cap is filled again with the newcomer in place of id0");
});

test("over the global cap, a request no more important than the lowest active voice is dropped, not stolen for", () => {
  let active = [];
  const now = 0;
  for (let i = 0; i < GLOBAL_VOICE_CAP; i++) {
    const result = planVoiceRequest(active, {}, voiceRequest({ id: `id${i}`, priority: 5, maxConcurrent: 1 }), now);
    active = commitVoice(result.active, { id: `id${i}`, priority: 5 }, now, 10);
  }
  // Tied with the lowest priority already active (all 5s) — must be dropped,
  // not steal one of them for itself.
  const tied = planVoiceRequest(active, {}, voiceRequest({ id: "newcomer", priority: 5, maxConcurrent: 1 }), now);
  assert.equal(tied.accepted, false);
  assert.equal(tied.active.length, GLOBAL_VOICE_CAP, "a dropped request must leave the active set untouched");

  // Strictly lower than everything active — same outcome.
  const lower = planVoiceRequest(active, {}, voiceRequest({ id: "newcomer", priority: 1, maxConcurrent: 1 }), now);
  assert.equal(lower.accepted, false);
});

test("a request over its own maxConcurrent steals its id's oldest instance, not another id's", () => {
  let active = [];
  const now = 0;
  const req = voiceRequest({ id: "kick", priority: 1, maxConcurrent: 2 });
  // Two instances of "kick", staggered in time, plus one unrelated id that
  // must never be touched by kick's own per-id stealing.
  let result = planVoiceRequest(active, {}, req, 0);
  active = commitVoice(result.active, { id: "kick", priority: 1 }, 0, 10);
  result = planVoiceRequest(active, result.lastTrigger, req, 1);
  active = commitVoice(result.active, { id: "kick", priority: 1 }, 1, 10);
  active = commitVoice(active, { id: "other", priority: 1 }, 1, 10);
  assert.equal(active.filter((v) => v.id === "kick").length, 2);

  // A third "kick" is over its maxConcurrent of 2: must steal the OLDEST
  // kick (start: 0), leaving the second kick (start: 1) and "other" alone.
  const third = planVoiceRequest(active, {}, req, 2);
  assert.equal(third.accepted, true);
  const kicksLeft = third.active.filter((v) => v.id === "kick");
  assert.equal(kicksLeft.length, 1);
  assert.equal(kicksLeft[0].start, 1, "the OLDEST kick instance should have been stolen, not the newer one");
  assert.ok(third.active.some((v) => v.id === "other"), "an unrelated id must never be touched by another id's per-id cap");
});

test("minInterval drops a retrigger that arrives too soon, without touching the active set", () => {
  const req = voiceRequest({ id: "rapid", minInterval: 0.2 });
  const first = planVoiceRequest([], {}, req, 0);
  assert.equal(first.accepted, true);
  const active = commitVoice(first.active, { id: "rapid", priority: req.priority }, 0, 10);

  // 0.1s later — under the 0.2s minInterval — must be dropped.
  const tooSoon = planVoiceRequest(active, first.lastTrigger, req, 0.1);
  assert.equal(tooSoon.accepted, false);
  assert.equal(tooSoon.active.length, active.length, "a minInterval rejection must not alter the active set");

  // 0.2s later — right at the boundary — must be allowed again.
  const onTime = planVoiceRequest(active, first.lastTrigger, req, 0.2);
  assert.equal(onTime.accepted, true);
});

test("a voice's slot releases once its scheduled end time has passed, freeing it for a new request", () => {
  const req = voiceRequest({ id: "short", maxConcurrent: 1 });
  const first = planVoiceRequest([], {}, req, 0);
  const active = commitVoice(first.active, { id: "short", priority: req.priority }, 0, 1); // ends at t=1

  // Before it ends, a second instance is over the per-id cap and must steal it.
  const beforeEnd = planVoiceRequest(active, first.lastTrigger, req, 0.5);
  assert.equal(beforeEnd.active.some((v) => v.id === "short"), false, "the still-live voice should have been stolen");

  // After it ends (t=1.5 > end=1), the slot is already free — a new request
  // must be accepted WITHOUT stealing anything, because the expired voice is
  // simply gone from the active set.
  const afterEnd = planVoiceRequest(active, first.lastTrigger, req, 1.5);
  assert.equal(afterEnd.accepted, true);
  assert.equal(afterEnd.active.length, 0, "an expired voice must not still occupy a slot");
});

test("overlapping ducks take the maximum requested depth, never stack past it", () => {
  const first = planDuck([], 0.3, 0);
  assert.equal(first.target, 0.3);

  // A louder duck arrives while the first is still live: target must jump to
  // the louder one, not sum to 0.3 + 0.6.
  const louder = planDuck(first.active, 0.6, DUCK_ATTACK);
  assert.equal(louder.target, 0.6);

  // A quieter duck arrives while the louder one is still live: target must
  // stay at the louder 0.6, not drop to the new, smaller request.
  const quieter = planDuck(louder.active, 0.2, DUCK_ATTACK + 0.05);
  assert.equal(quieter.target, 0.6, "a quieter overlapping duck must not lower the still-active louder one");

  // Once every prior duck has fully released, a fresh request reflects only
  // itself.
  const afterAllReleased = planDuck(quieter.active, 0.1, DUCK_ATTACK + DUCK_RELEASE + 1);
  assert.equal(afterAllReleased.target, 0.1);
  assert.equal(afterAllReleased.active.length, 1, "expired duck records must not accumulate forever");
});

test("every SFX catalogue entry has all required fields, in range, and a registered generator", () => {
  assert.ok(SOUND_TYPES.length > 0);
  for (const entry of SOUND_TYPES) {
    assert.equal(typeof entry.id, "string");
    assert.equal(typeof entry.generator, "function", `${entry.id} must have had its generator registered by sfx.js`);
    assert.equal(typeof entry.gain, "number");
    assert.ok(entry.gain >= 0 && entry.gain <= 1, `${entry.id}'s gain must be in 0..1`);
    assert.ok(entry.duck >= 0 && entry.duck <= 1, `${entry.id}'s duck must be in 0..1`);
    assert.ok(entry.delaySend >= 0 && entry.delaySend <= 1, `${entry.id}'s delaySend must be in 0..1`);
    assert.ok(Number.isInteger(entry.priority) && entry.priority >= 0, `${entry.id}'s priority must be a non-negative integer`);
    assert.ok(Number.isInteger(entry.maxConcurrent) && entry.maxConcurrent >= 1, `${entry.id}'s maxConcurrent must be >= 1`);
    assert.ok(entry.minInterval >= 0, `${entry.id}'s minInterval must be >= 0`);
    assert.equal(soundTypeById(entry.id), entry, "soundTypeById must resolve back to the same entry");
  }
});

test("every SFX catalogue id is unique", () => {
  const ids = SOUND_TYPES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "a duplicate id would let one entry silently shadow another in soundTypeById");
});

// --- Phase 8 step 2: combat sounds — data and wiring, not Web Audio --------
//
// audio/weaponsfx.js is the ONE place a weapons.js catalogue id is mapped to
// the combat sound it plays (see main.js's fireShot/dropMine and the fire
// block in update()). These tests are the guard the task's own brief asks
// for: a future weapon added to WEAPON_TYPES or ENEMY_WEAPON_TYPES with no
// matching entry here would otherwise fire silently, with nothing to say so
// until someone happened to notice in the browser.

test("PLAYER_FIRE_SOUND covers every WEAPON_TYPES id, with no orphaned keys, and every mapped id is a real sound", () => {
  for (const w of WEAPON_TYPES) {
    assert.ok(w.id in PLAYER_FIRE_SOUND, `WEAPON_TYPES entry "${w.id}" has no entry in PLAYER_FIRE_SOUND`);
    assert.ok(
      soundTypeById(PLAYER_FIRE_SOUND[w.id]),
      `PLAYER_FIRE_SOUND["${w.id}"] points at "${PLAYER_FIRE_SOUND[w.id]}", which isn't in SOUND_TYPES`,
    );
  }
  for (const id of Object.keys(PLAYER_FIRE_SOUND)) {
    assert.ok(WEAPON_TYPES.some((w) => w.id === id), `PLAYER_FIRE_SOUND["${id}"] has no matching WEAPON_TYPES entry — an orphan`);
  }
});

test("ENEMY_FIRE_SOUND covers every ENEMY_WEAPON_TYPES id, with no orphaned keys, and every mapped id is a real sound", () => {
  for (const w of ENEMY_WEAPON_TYPES) {
    assert.ok(w.id in ENEMY_FIRE_SOUND, `ENEMY_WEAPON_TYPES entry "${w.id}" has no entry in ENEMY_FIRE_SOUND`);
    assert.ok(
      soundTypeById(ENEMY_FIRE_SOUND[w.id]),
      `ENEMY_FIRE_SOUND["${w.id}"] points at "${ENEMY_FIRE_SOUND[w.id]}", which isn't in SOUND_TYPES`,
    );
  }
  for (const id of Object.keys(ENEMY_FIRE_SOUND)) {
    assert.ok(ENEMY_WEAPON_TYPES.some((w) => w.id === id), `ENEMY_FIRE_SOUND["${id}"] has no matching ENEMY_WEAPON_TYPES entry — an orphan`);
  }
});

test("the kill_enemy/kill_neutral sound split (main.js's onCarDestroyed, value>=0) agrees with score.js's own enemy/civilian classification", () => {
  // score.js's Score.destroyed() classifies purely on `value >= 0` — see its
  // own header: "the scoreboard never asks what faction a car belonged to".
  // main.js's onCarDestroyed mirrors that exact rule rather than reading
  // car.type.faction, on purpose (see its own comment) — so what this test
  // actually guards is that faction and value can never quietly diverge
  // in cartypes.js, which is the one way that mirrored rule could start
  // picking the wrong sound.
  for (const type of CAR_TYPES) {
    const isEnemy = type.faction === ENEMY_FACTION;
    const scoresAsKill = (type.value ?? 0) >= 0;
    assert.equal(
      scoresAsKill, isEnemy,
      `${type.id}: faction is ${type.faction} but value ${type.value} would play the ${scoresAsKill ? "kill_enemy" : "kill_neutral"} sound`,
    );
  }
});

// --- Phase 8 step 3: damage/pickups/shield audio — the sustained lifecycle -
//
// audio/sustained.js's own header explains the pure/stateful split this
// leans on: plan*() functions are plain data in, plain data out, so the
// REGISTRY's own rules (idempotent acquire, ramp-on-change, release reuses
// rather than rebuilds) can be exercised here with no AudioContext at all —
// exactly the same reason context.js's planDuck()/planVoiceRequest() are
// tested that way above, rather than through duck()/requestVoice()
// themselves (which short-circuit to a no-op with no ctx).

test("Player's onDamage callback reports a real hull loss as (hp, false)", () => {
  const calls = [];
  const player = new Player(0, 0, (hp, deflected) => calls.push({ hp, deflected }));
  player.damage(25);
  assert.deepEqual(calls, [{ hp: 25, deflected: false }]);
});

test("Player's onDamage callback reports a shield deflection as (hp, true), and no hull is lost", () => {
  const calls = [];
  const player = new Player(0, 0, (hp, deflected) => calls.push({ hp, deflected }));
  player.activateShield(2);
  player.damage(9999);
  assert.deepEqual(calls, [{ hp: 9999, deflected: true }]);
  assert.equal(player.health, player.maxHealth);
});

test("Player's onDamage callback never fires for a non-positive hp — nothing happened, nothing to report", () => {
  const calls = [];
  const player = new Player(0, 0, (hp, deflected) => calls.push({ hp, deflected }));
  player.damage(0);
  player.damage(-5);
  assert.deepEqual(calls, []);
});

test("Pickups calls onCollect with the collected pickup type, exactly once per crate", () => {
  const explosions = new Explosions();
  const collected = [];
  const pickups = new Pickups(explosions, (type) => collected.push(type));
  const player = new Player(300, 496);
  const loadout = new Loadout();

  const type = pickupTypeById("fix");
  const [w, h] = PICKUP_SHAPES[type.shape].size;
  const worldY = 500;
  pickups.list.push({ type, worldY, offset: 0, alive: true, age: 0, pulsePhase: 0, w, h });

  const world = { player, distance: worldY, W: 600, H: 800, loadout };
  player.x = centerXAt(worldY, world.W);
  pickups.update(1 / 60, world);

  assert.deepEqual(collected, [type]);
});

test("acquiring a sustained id is idempotent — a second acquire is a true no-op, not just an equal one", () => {
  const first = sustainedPlanAcquire({}, "hull_hiss");
  const second = sustainedPlanAcquire(first, "hull_hiss");
  assert.equal(second, first, "re-acquiring an already-tracked id must return the SAME reference — nothing rebuilt");
});

test("release then acquire reuses the same registry entry rather than rebuilding it", () => {
  let state = sustainedPlanAcquire({}, "shield_drone");
  state = sustainedPlanSetLevel(state, "shield_drone", 0.12).state;

  const released = sustainedPlanRelease(state, "shield_drone").state;
  assert.ok("shield_drone" in released, "release must not remove the tracked voice — same graph, gain ramped to zero");
  assert.equal(released.shield_drone.level, 0);

  const reacquired = sustainedPlanAcquire(released, "shield_drone");
  assert.equal(reacquired, released, "re-acquiring a released id must be a no-op — the SAME entry, not a fresh one");
});

test("setLevel only reports a change when the requested value actually differs — 'ramp on change, not every frame'", () => {
  let state = sustainedPlanAcquire({}, "hull_hiss");
  const first = sustainedPlanSetLevel(state, "hull_hiss", 0.05);
  assert.equal(first.changed, true);
  state = first.state;

  // Same value again — as a per-frame poller (updateHullHiss) would send on
  // every tick the hull fraction hasn't moved.
  const repeat = sustainedPlanSetLevel(state, "hull_hiss", 0.05);
  assert.equal(repeat.changed, false, "an unchanged target must not report a change to ramp toward");
  assert.equal(repeat.state, state, "an unchanged target must return the SAME state reference");

  const moved = sustainedPlanSetLevel(state, "hull_hiss", 0.06);
  assert.equal(moved.changed, true);
});

test("releasing an already-silent voice is a no-op — idempotent in both directions", () => {
  let state = sustainedPlanAcquire({}, "wall_scrape");
  const first = sustainedPlanRelease(state, "wall_scrape");
  assert.equal(first.changed, false, "releasing a voice that was never raised above 0 must not report a change");
  const second = sustainedPlanRelease(first.state, "wall_scrape");
  assert.equal(second.changed, false);
});

test("sustained voices have no cap — acquiring more ids than the one-shot GLOBAL_VOICE_CAP never drops any", () => {
  // Contrast with the one-shot voice limiter tested above: there is no
  // priority, no maxConcurrent, no stealing anywhere in planAcquire — this
  // is the architectural guarantee that a sustained voice can never be
  // evicted the way a one-shot can (sustained.js's own header: "a hiss that
  // gets evicted mid-firefight... is a bug that would be very hard to
  // notice"). GLOBAL_VOICE_CAP+5 is an arbitrary count comfortably over the
  // one-shot cap — the real catalogue only ever has 3.
  let state = {};
  const ids = Array.from({ length: GLOBAL_VOICE_CAP + 5 }, (_, i) => `voice${i}`);
  for (const id of ids) state = sustainedPlanAcquire(state, id);
  assert.equal(Object.keys(state).length, ids.length, "every sustained id must be tracked — nothing stolen or dropped");
});

// --- Phase 8 step 3: hull_hiss's own level curve ----------------------------

test("hull_hiss is silent above its threshold, and the curve is monotonic and bounded below it", () => {
  let last = -1;
  for (let frac = 0; frac <= 1; frac += 0.01) {
    const level = hullHissLevel(frac);
    assert.ok(level >= 0 && level <= HULL_HISS_PEAK, `hullHissLevel(${frac.toFixed(2)}) = ${level} is outside [0, HULL_HISS_PEAK]`);
    if (frac >= HULL_HISS_ON) {
      assert.equal(level, 0, `hullHissLevel(${frac.toFixed(2)}) must be silent at/above HULL_HISS_ON`);
    }
  }
  // Monotonic: level must never rise as hull fraction rises (i.e. as damage
  // heals) across the whole domain, not just above the threshold.
  for (let frac = 0; frac <= 1; frac += 0.01) {
    const level = hullHissLevel(frac);
    assert.ok(level <= last + 1e-9 || last === -1, `hullHissLevel is not monotonic: frac=${frac.toFixed(2)} gave ${level}, previous (lower frac) gave ${last}`);
    last = level;
  }
});

test("hull_hiss's curve hits the documented endpoints exactly", () => {
  assert.equal(hullHissLevel(HULL_HISS_ON), 0, "level must be exactly 0 right at the threshold");
  assert.equal(hullHissLevel(0), HULL_HISS_PEAK, "level must reach exactly HULL_HISS_PEAK at 0% hull");
  assert.equal(hullHissLevel(1), 0, "level at full hull must be 0");
});

test("hull_hiss hysteresis: once ON it stays on past HULL_HISS_ON, and only switches off past HULL_HISS_OFF", () => {
  assert.ok(HULL_HISS_OFF > HULL_HISS_ON, "the off-threshold must sit ABOVE the on-threshold, or there is no hysteresis band at all");

  // Starting inactive: switches on only at/below HULL_HISS_ON.
  assert.equal(hullHissActive(HULL_HISS_ON + 0.001, false), false);
  assert.equal(hullHissActive(HULL_HISS_ON, false), true);
  assert.equal(hullHissActive(0, false), true);

  // Starting active: STAYS on all the way up through the gap between the two
  // thresholds — this is the whole point of the hysteresis band.
  assert.equal(hullHissActive(HULL_HISS_ON + 0.01, true), true, "must not flutter off inside the hysteresis gap");
  assert.equal(hullHissActive(HULL_HISS_OFF - 0.001, true), true);
  assert.equal(hullHissActive(HULL_HISS_OFF, true), false, "must switch off once it reaches HULL_HISS_OFF");
  assert.equal(hullHissActive(1, true), false);
});

test("a car scraping the player across the 60% edge cannot flutter the hiss on/off — a hysteresis walk never toggles twice in a row the same way", () => {
  // Simulates hull ticking back and forth across HULL_HISS_ON by a small
  // step (as repeated WALL_DAMAGE ticks might) and checks the active state
  // never oscillates on every single step — it should take a real crossing
  // of the FAR threshold to flip back.
  let active = false;
  let flips = 0;
  const walk = [0.61, 0.59, 0.61, 0.59, 0.61, 0.60, 0.605, 0.595, 0.61];
  for (const frac of walk) {
    const next = hullHissActive(frac, active);
    if (next !== active) flips++;
    active = next;
  }
  assert.ok(flips <= 1, `hiss toggled ${flips} times walking back and forth across HULL_HISS_ON — hysteresis isn't holding`);
});

// --- Phase 8 step 3: dropout/crackle scheduling -----------------------------

test("the dropout timer never fires while inactive, however long it runs", () => {
  let timer = DROPOUT_MIN_INTERVAL;
  let fired = 0;
  for (let i = 0; i < 100000; i++) {
    const step = stepDropoutTimer(timer, 1 / 60, false);
    timer = step.timer;
    if (step.fired) fired++;
  }
  assert.equal(fired, 0, "an inactive (hull >= DROPOUT_HULL_THRESHOLD) dropout timer must never fire");
});

test("the dropout timer's average interval, run continuously active, lands inside its documented [min, max] range", () => {
  let timer = DROPOUT_MIN_INTERVAL;
  let fired = 0;
  const dt = 1 / 60;
  const totalSeconds = 20000; // long enough for a stable average across many events
  for (let t = 0; t < totalSeconds; t += dt) {
    const step = stepDropoutTimer(timer, dt, true);
    timer = step.timer;
    if (step.fired) fired++;
  }
  const avgInterval = totalSeconds / fired;
  assert.ok(
    avgInterval >= DROPOUT_MIN_INTERVAL && avgInterval <= DROPOUT_MAX_INTERVAL,
    `average dropout interval ${avgInterval.toFixed(2)}s is outside [${DROPOUT_MIN_INTERVAL}, ${DROPOUT_MAX_INTERVAL}]`,
  );
});

test("dropoutHoldSeconds always stays within its documented 30-60ms range", () => {
  for (let i = 0; i < 10000; i++) {
    const hold = dropoutHoldSeconds();
    assert.ok(hold >= DROPOUT_MIN_HOLD && hold <= DROPOUT_MAX_HOLD, `dropout hold ${hold} outside [${DROPOUT_MIN_HOLD}, ${DROPOUT_MAX_HOLD}]`);
  }
});

test("the crackle timer never fires while inactive, however long it runs", () => {
  let timer = CRACKLE_MIN_INTERVAL;
  let fired = 0;
  for (let i = 0; i < 100000; i++) {
    const step = stepCrackleTimer(timer, 1 / 60, false);
    timer = step.timer;
    if (step.fired) fired++;
  }
  assert.equal(fired, 0, "an inactive (hull >= CRACKLE_HULL_THRESHOLD) crackle timer must never fire");
});

test("the crackle rate, run continuously active, reads as 'a few per second' — bounded well clear of a metronome or a wall of noise", () => {
  let timer = CRACKLE_MIN_INTERVAL;
  let fired = 0;
  const dt = 1 / 60;
  const totalSeconds = 5000;
  for (let t = 0; t < totalSeconds; t += dt) {
    const step = stepCrackleTimer(timer, dt, true);
    timer = step.timer;
    if (step.fired) fired++;
  }
  const rate = fired / totalSeconds;
  // The clustering bias (see stepCrackleTimer's own header) pulls the mean
  // interval below the base [CRACKLE_MIN_INTERVAL, CRACKLE_MAX_INTERVAL]
  // spread, so the bound here is generous rather than derived from those
  // two constants alone — this is a "sane order of magnitude" check, not a
  // tight pin.
  assert.ok(rate >= 1 && rate <= 10, `crackle rate ${rate.toFixed(2)}/s is not "a few per second"`);
});

test("crackle scheduling is frozen, not reset, while inactive — no burst of events on re-entry", () => {
  // Count down close to firing, then go inactive for a long stretch, then
  // reactivate: the very next active step must fire at most once (whatever
  // was left on the clock), never a backlog of events for the time spent
  // inactive.
  const step = stepCrackleTimer(0, 0, true); // timer already at 0 — fires immediately
  assert.ok(step.fired);
  const armedTimer = step.timer;

  // Long inactive stretch — timer must not move at all.
  const stillInactive = stepCrackleTimer(armedTimer, 1000, false);
  assert.equal(stillInactive.timer, armedTimer, "an inactive timer must not count down at all");
  assert.equal(stillInactive.fired, false);

  // Reactivating with the SAME dt budget it was frozen at must fire at most once.
  const reactivated = stepCrackleTimer(stillInactive.timer, 0.001, true);
  assert.equal(typeof reactivated.fired, "boolean");
});

// --- Phase 8 step 3: shield_drone's fade curve ------------------------------

test("shield_drone is silent once expired, holds at peak with time to spare, and fades linearly across its own window", () => {
  const peak = 0.2;
  const window = 1.5;
  assert.equal(shieldDroneLevel(0, peak, window), 0);
  assert.equal(shieldDroneLevel(-1, peak, window), 0, "an already-expired shield must never report a positive level");
  assert.equal(shieldDroneLevel(window, peak, window), peak);
  assert.equal(shieldDroneLevel(window * 5, peak, window), peak, "well before the fade window, level must hold at peak, not keep climbing");
  assert.ok(Math.abs(shieldDroneLevel(window / 2, peak, window) - peak / 2) < 1e-9, "the fade must be linear across its own window");
});

test("SHIELD_DRONE_FADE_WINDOW reuses player.js's own SHIELD_EXPIRING rather than a second, driftable number", () => {
  assert.equal(SHIELD_DRONE_FADE_WINDOW, PLAYER_SHIELD_EXPIRING / 2);
});

// --- Phase 8 step 3: catalogues ---------------------------------------------

test("every SUSTAINED_TYPES entry has an id and a registered generator", () => {
  assert.ok(SUSTAINED_TYPES.length > 0);
  for (const entry of SUSTAINED_TYPES) {
    assert.equal(typeof entry.id, "string");
    assert.equal(typeof entry.generator, "function", `${entry.id} must have had its generator registered by sustainedfx.js`);
    assert.equal(sustainedTypeById(entry.id), entry, "sustainedTypeById must resolve back to the same entry");
  }
  const ids = SUSTAINED_TYPES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "a duplicate sustained id would let one entry silently shadow another");
});

test("PICKUP_SOUND covers every kind in pickuptypes.js, with no orphaned keys, and every mapped id is a real sound", () => {
  const kinds = new Set(PICKUP_TYPES.map((t) => t.kind));
  for (const kind of kinds) {
    assert.ok(kind in PICKUP_SOUND, `pickup kind "${kind}" has no entry in PICKUP_SOUND`);
    assert.ok(soundTypeById(PICKUP_SOUND[kind]), `PICKUP_SOUND["${kind}"] points at "${PICKUP_SOUND[kind]}", which isn't in SOUND_TYPES`);
  }
  for (const kind of Object.keys(PICKUP_SOUND)) {
    assert.ok(kinds.has(kind), `PICKUP_SOUND["${kind}"] has no matching pickuptypes.js kind — an orphan`);
  }
});

test("player_hit's intensity scaling stays inside sane bounds at both ends of opts.intensity", () => {
  // sfx.js's generatePlayerHit isn't exported (its shaping is internal, same
  // as every other one-shot generator) — but the catalogue entry it's
  // registered against must still exist, self-duck (duck: 0, see its own
  // comment), and be in the combat/damage priority tier alongside the kills.
  const entry = soundTypeById("player_hit");
  assert.equal(entry.duck, 0, "player_hit must self-duck via opts.intensity, not a static catalogue duck");
  assert.ok(entry.priority >= 6, "a real hull loss should sit at or above the player's own weapons tier");
});

// --- Phase 8 step 4: console log ticks --------------------------------------

test("CONSOLE_SOUND/CONSOLE_PITCH cover exactly HINT/WARN/CRITICAL, with no orphans, and pitch strictly descends with severity", () => {
  const severities = [CONSOLE_HINT, CONSOLE_WARN, CONSOLE_CRITICAL];
  for (const s of severities) {
    assert.ok(s in CONSOLE_SOUND, `severity "${s}" has no entry in CONSOLE_SOUND`);
    assert.ok(soundTypeById(CONSOLE_SOUND[s]), `CONSOLE_SOUND["${s}"] points at "${CONSOLE_SOUND[s]}", which isn't in SOUND_TYPES`);
    assert.ok(s in CONSOLE_PITCH, `severity "${s}" has no entry in CONSOLE_PITCH`);
  }
  for (const key of Object.keys(CONSOLE_SOUND)) {
    assert.ok(severities.includes(key), `CONSOLE_SOUND["${key}"] has no matching console.js severity — an orphan`);
  }
  for (const key of Object.keys(CONSOLE_PITCH)) {
    assert.ok(severities.includes(key), `CONSOLE_PITCH["${key}"] has no matching console.js severity — an orphan`);
  }
  assert.ok(
    CONSOLE_PITCH[CONSOLE_HINT] > CONSOLE_PITCH[CONSOLE_WARN] &&
      CONSOLE_PITCH[CONSOLE_WARN] > CONSOLE_PITCH[CONSOLE_CRITICAL],
    "pitch must strictly descend HINT > WARN > CRITICAL — lower reads as worse, per the design brief",
  );
});

test("console.js's onPush() fires the subscriber exactly once per push, with the pushed text and severity", () => {
  consoleReset();
  const calls = [];
  consoleOnPush((text, severity) => calls.push({ text, severity }));
  consolePush("hello", CONSOLE_WARN);
  consolePush("again", CONSOLE_HINT);
  assert.deepEqual(calls, [
    { text: "hello", severity: CONSOLE_WARN },
    { text: "again", severity: CONSOLE_HINT },
  ]);
  consoleReset();
});

test("registering a second subscriber replaces the first — never stacks two callbacks on one push", () => {
  consoleReset();
  let aCalls = 0;
  let bCalls = 0;
  consoleOnPush(() => aCalls++);
  consoleOnPush(() => bCalls++);
  consolePush("x", CONSOLE_HINT);
  assert.equal(aCalls, 0, "the first subscriber must have been replaced, not left running alongside the second");
  assert.equal(bCalls, 1);
  consoleReset();
});

test("the unsubscribe function onPush() returns removes exactly that subscriber", () => {
  consoleReset();
  let calls = 0;
  const unsub = consoleOnPush(() => calls++);
  unsub();
  consolePush("x", CONSOLE_HINT);
  assert.equal(calls, 0, "push() must not call an unsubscribed callback");
  consoleReset();
});

test("reset() clears the subscriber — nothing fires on a push after reset() unless re-registered", () => {
  consoleReset();
  let calls = 0;
  consoleOnPush(() => calls++);
  consoleReset();
  consolePush("x", CONSOLE_HINT);
  assert.equal(calls, 0, "a subscriber registered before reset() must not survive it");
});

// --- Phase 8 step 4: dread_pulse's threat curve -----------------------------

test("dread_pulse's proximity curve is 0 with no hostile in range, clamped to [0,1], and monotonic as the gap closes", () => {
  assert.equal(dreadProximity(Infinity), 0, "no hostile at all (an infinite gap) must report zero proximity");
  assert.equal(dreadProximity(DREAD_RANGE_ON), 0, "proximity must be exactly 0 right at the edge of the threat range");
  assert.equal(dreadProximity(0), 1, "proximity must reach exactly 1 at zero gap");

  let last = -1;
  for (let gap = DREAD_RANGE_ON + 200; gap >= 0; gap -= 5) {
    const p = dreadProximity(gap);
    assert.ok(p >= 0 && p <= 1, `dreadProximity(${gap}) = ${p} outside [0,1]`);
    assert.ok(p >= last - 1e-9, `dreadProximity is not monotonic as gap shrinks: gap=${gap} gave ${p}, previous (larger gap) gave ${last}`);
    last = p;
  }
  assert.ok(
    dreadPulseLevel(0) > dreadPulseLevel(DREAD_RANGE_ON / 2),
    "level must read higher right on the player's tail than mid-range",
  );
});

test("dread_pulse hysteresis: once ON it stays on past DREAD_RANGE_ON, only switches off past DREAD_RANGE_OFF, and `closing` gates it outright", () => {
  assert.ok(DREAD_RANGE_OFF > DREAD_RANGE_ON, "the off-threshold must sit ABOVE the on-threshold, or there is no hysteresis band at all");

  // A hostile that isn't closing never activates the pulse, whatever the gap
  // — and it switches an already-active pulse off outright, no hysteresis.
  assert.equal(dreadPulseActive(0, false, false), false);
  assert.equal(dreadPulseActive(0, false, true), false, "closing must gate the pulse off outright even if it was already active");

  // Starting inactive: switches on only at/below DREAD_RANGE_ON, while closing.
  assert.equal(dreadPulseActive(DREAD_RANGE_ON + 1, true, false), false);
  assert.equal(dreadPulseActive(DREAD_RANGE_ON, true, false), true);

  // Starting active: STAYS on all the way through the gap between the two
  // thresholds — the whole point of the hysteresis band.
  assert.equal(dreadPulseActive(DREAD_RANGE_ON + 10, true, true), true, "must not flutter off inside the hysteresis gap");
  assert.equal(dreadPulseActive(DREAD_RANGE_OFF - 1, true, true), true);
  assert.equal(dreadPulseActive(DREAD_RANGE_OFF, true, true), false, "must switch off once it reaches DREAD_RANGE_OFF");
});

test("dreadPulseRate is bounded at both ends across the full input range, and rises as the gap closes", () => {
  for (let gap = -100; gap <= DREAD_RANGE_ON + 500; gap += 10) {
    const rate = dreadPulseRate(gap);
    assert.ok(
      rate >= DREAD_RATE_MIN - 1e-9 && rate <= DREAD_RATE_MAX + 1e-9,
      `dreadPulseRate(${gap}) = ${rate} outside [${DREAD_RATE_MIN}, ${DREAD_RATE_MAX}]`,
    );
  }
  assert.equal(dreadPulseRate(DREAD_RANGE_ON), DREAD_RATE_MIN, "rate must be exactly the minimum at the edge of the threat range");
  assert.equal(dreadPulseRate(0), DREAD_RATE_MAX, "rate must be exactly the maximum right on the player's tail");
  assert.ok(dreadPulseRate(50) > dreadPulseRate(400), "rate must rise as the gap closes");
});

// --- Phase 8 step 4: speed-linked music filter ------------------------------

test("speedToMusicCutoff stays inside [MUSIC_CUTOFF_MIN, MUSIC_CUTOFF_MAX] for every input, including 0 and MAX_SPEED", () => {
  for (const speed of [-1000, 0, MIN_SPEED - 50, MIN_SPEED, 260, MAX_SPEED, MAX_SPEED + 1000]) {
    const cutoff = speedToMusicCutoff(speed);
    assert.ok(
      cutoff >= MUSIC_CUTOFF_MIN && cutoff <= MUSIC_CUTOFF_MAX,
      `speedToMusicCutoff(${speed}) = ${cutoff} outside [${MUSIC_CUTOFF_MIN}, ${MUSIC_CUTOFF_MAX}]`,
    );
  }
  assert.equal(speedToMusicCutoff(MIN_SPEED), MUSIC_CUTOFF_MIN, "must hit the floor exactly at MIN_SPEED");
  assert.equal(speedToMusicCutoff(MAX_SPEED), MUSIC_CUTOFF_MAX, "must hit the ceiling exactly at MAX_SPEED");
  assert.ok(speedToMusicCutoff(MAX_SPEED) > speedToMusicCutoff(MIN_SPEED), "faster must never read duller than slower");
});

// --- Phase 8 step 5: menu, transitions and the mix pass ---------------------
//
// PROBLEM 1 (context starts on the first keypress, not START GAME) is wired
// entirely in main.js — a `window.addEventListener("keydown", ..., { once:
// true })` — which touches `document`/`window` at import time and so can't
// be imported here (see this file's own header on why main.js itself is
// never one of the modules under test). What CAN be verified in Node is the
// contract that listener relies on: nothing anywhere in the audio module
// graph ever creates an AudioContext merely by being imported. If it did,
// isStarted() would already read true by this point in the suite, having
// imported every audio/*.js module above with no browser `window` in sight —
// and every no-ctx short-circuit this whole file already exercises (duck(),
// requestVoice(), setMusicCutoff(), ...) would have thrown instead of
// quietly no-op'ing the moment any of those ran.

test("importing the whole audio module graph never creates an AudioContext on its own", () => {
  assert.equal(isStarted(), false, "a page loaded and left untouched must never end up with a live AudioContext");
});

// PROBLEM 2: cutoff composition. See context.js's own "Cutoff composition"
// section for the full design — base (speed) x offset (sector transition),
// composed by ONE pair of functions so the two can never fight over
// musicFilter.frequency the way two independent rampers to the same
// AudioParam would.

test("composeMusicCutoff(base, 1) reproduces the base exactly — a released offset must have NO effect", () => {
  for (const base of [MUSIC_CUTOFF_MIN, 1500, MUSIC_CUTOFF_MAX]) {
    assert.equal(composeMusicCutoff(base, 1), base);
  }
});

test("composeMusicCutoff stays sane (never below MUSIC_CUTOFF_FLOOR, never above the base) across the full base x offset space", () => {
  for (let base = MUSIC_CUTOFF_MIN; base <= MUSIC_CUTOFF_MAX; base += 100) {
    for (let offset = SECTOR_COLLAPSE_OFFSET; offset <= 1; offset += 0.05) {
      const composed = composeMusicCutoff(base, offset);
      assert.ok(composed >= MUSIC_CUTOFF_FLOOR, `composeMusicCutoff(${base}, ${offset}) = ${composed} fell below MUSIC_CUTOFF_FLOOR`);
      assert.ok(composed <= base, `composeMusicCutoff(${base}, ${offset}) = ${composed} exceeded its own base — an offset in (0,1] must never brighten it`);
    }
  }
  // The collapse offset itself is deliberately allowed to land BELOW
  // MUSIC_CUTOFF_MIN (see context.js's own header on why this does NOT
  // reuse the speed mapping's own clamp) — confirm it actually does, at
  // least at the darkest base the speed mapping ever produces, or the
  // "reads as darker than the music ever gets in ordinary play" design
  // goal silently stops being true.
  assert.ok(
    composeMusicCutoff(MUSIC_CUTOFF_MIN, SECTOR_COLLAPSE_OFFSET) < MUSIC_CUTOFF_MIN,
    "the sector collapse must be able to go below the speed mapping's own floor",
  );
});

function cutoffState(over = {}) {
  return { cutoffBase: MUSIC_CUTOFF_MAX, lastCutoffTarget: null, transitionEndTime: 0, ...over };
}

test("planSetMusicCutoff suppresses the write while a transition is live, but still tracks the freshest base", () => {
  const state = cutoffState({ transitionEndTime: 5 });
  const plan = planSetMusicCutoff(state, 1200, 2); // now (2) is before transitionEndTime (5)
  assert.equal(plan.write, false, "a speed update mid-transition must not touch the AudioParam");
  assert.equal(plan.state.cutoffBase, 1200, "the new base must still be remembered for whenever the transition releases");
  assert.equal(plan.state.transitionEndTime, 5, "the transition's own end time must be untouched by a suppressed write");
});

test("planSetMusicCutoff resumes writing once the transition has ended, using whatever base was tracked during it", () => {
  // Two suppressed updates during the transition (as main.js would send one
  // per "playing" tick), then one arriving after transitionEndTime — only
  // the last should actually write, and it should write the LATEST base.
  let state = cutoffState({ transitionEndTime: 5 });
  state = planSetMusicCutoff(state, 1100, 2).state;
  state = planSetMusicCutoff(state, 1300, 4).state;
  const after = planSetMusicCutoff(state, 1300, 6); // same value as the last tracked base, but now is PAST transitionEndTime
  assert.equal(after.write, true, "the first update after the transition ends must write, even if the value hasn't changed since the last SUPPRESSED update");
  assert.equal(after.target, 1300);
});

test("planSetMusicCutoff is a plain no-op when the target already matches and no transition is in the way — unchanged from before the transition system existed", () => {
  const state = cutoffState({ cutoffBase: 1800, lastCutoffTarget: 1800, transitionEndTime: 0 });
  const plan = planSetMusicCutoff(state, 1800, 10);
  assert.equal(plan.write, false);
  assert.equal(plan.state, state, "an unchanged target with no transition must return the SAME state reference, mirroring sustained.js's own setLevel dedupe");
});

test("planBeginSectorTransition captures the CURRENT base as its reopen target and schedules the collapse/reopen window ATTACK+RELEASE seconds out", () => {
  const state = cutoffState({ cutoffBase: 2000 });
  const now = 10;
  const plan = planBeginSectorTransition(state, now);
  assert.equal(plan.reopenTarget, 2000, "the reopen must return to the base as it was AT THE MOMENT the crossing fired");
  assert.equal(plan.collapseTarget, composeMusicCutoff(2000, SECTOR_COLLAPSE_OFFSET));
  assert.equal(plan.collapseAt, now + SECTOR_COLLAPSE_ATTACK);
  assert.equal(plan.transitionEndTime, now + SECTOR_COLLAPSE_ATTACK + SECTOR_COLLAPSE_RELEASE);
  assert.equal(plan.state.transitionEndTime, plan.transitionEndTime, "the returned state must track the same end time the caller schedules the reopen ramp against");
  assert.equal(plan.state.lastCutoffTarget, 2000, "starting a transition must also settle lastCutoffTarget at the base, so a post-transition setMusicCutoff() for that exact value is correctly treated as already-applied");
});

test("a speed update mid-transition does not cancel the transition — composing the two end to end", () => {
  // The scenario the whole composition scheme exists for: a crossing begins
  // a transition, a speed update arrives mid-flight (must be suppressed,
  // not cancel anything), and once the transition's own window has elapsed
  // the next speed update writes cleanly again.
  let state = cutoffState({ cutoffBase: 1600 });
  const begin = planBeginSectorTransition(state, 0);
  state = begin.state;
  assert.equal(state.transitionEndTime, SECTOR_COLLAPSE_ATTACK + SECTOR_COLLAPSE_RELEASE);

  const midTransition = planSetMusicCutoff(state, 1900, SECTOR_COLLAPSE_ATTACK); // a speed change right as the collapse leg ends
  assert.equal(midTransition.write, false, "still inside the transition window — must be suppressed");
  state = midTransition.state;

  const afterTransition = planSetMusicCutoff(state, 1900, SECTOR_COLLAPSE_ATTACK + SECTOR_COLLAPSE_RELEASE + 0.01);
  assert.equal(afterTransition.write, true, "once the transition's own window has elapsed, the next update must write normally");
  assert.equal(afterTransition.target, 1900, "and it must write the LATEST base tracked during the transition, not whatever the base was when the transition began");
});

test("SECTOR_COLLAPSE_ATTACK/RELEASE match the design brief's own ~300ms collapse / ~1.5s reopen", () => {
  assert.ok(SECTOR_COLLAPSE_ATTACK > 0.1 && SECTOR_COLLAPSE_ATTACK < 0.6, `SECTOR_COLLAPSE_ATTACK ${SECTOR_COLLAPSE_ATTACK} is not close to the brief's ~300ms`);
  assert.ok(SECTOR_COLLAPSE_RELEASE > 1 && SECTOR_COLLAPSE_RELEASE < 2.2, `SECTOR_COLLAPSE_RELEASE ${SECTOR_COLLAPSE_RELEASE} is not close to the brief's ~1.5s`);
});

// jack_in's own duration and the music scheduler's start-time offset are the
// SAME number by construction (synth.js's jackIn(): `music.start(JACK_IN_DURATION)`)
// rather than two literals that could drift — see that function's own
// header. What's left to guard in Node is just that the shared constant
// itself is still a sane figure near the design brief's own "~1.5s".
test("JACK_IN_DURATION is a sane figure near the design brief's own ~1.5s", () => {
  assert.ok(JACK_IN_DURATION > 1 && JACK_IN_DURATION < 2, `JACK_IN_DURATION ${JACK_IN_DURATION} is not close to ~1.5s`);
});

test("DISCONNECT_FADE is a short, sane head start ahead of the disconnect SFX's own static", () => {
  assert.ok(DISCONNECT_FADE > 0 && DISCONNECT_FADE < 1, `DISCONNECT_FADE ${DISCONNECT_FADE} should be a brief head start, not a long fade`);
});

// The menu action -> sound id map (audio/menusfx.js). Mirrors
// PLAYER_FIRE_SOUND/ENEMY_FIRE_SOUND's own coverage tests above, except the
// "catalogue" being covered (MENU_ACTIONS) is hand-written rather than
// derived from another file's own list — see menusfx.js's own header for why.

test("MENU_SOUND covers exactly MENU_ACTIONS, with no orphaned keys, and every mapped id is a real sound", () => {
  for (const action of MENU_ACTIONS) {
    assert.ok(action in MENU_SOUND, `menu action "${action}" has no entry in MENU_SOUND`);
    assert.ok(soundTypeById(MENU_SOUND[action]), `MENU_SOUND["${action}"] points at "${MENU_SOUND[action]}", which isn't in SOUND_TYPES`);
  }
  const actions = new Set(MENU_ACTIONS);
  for (const key of Object.keys(MENU_SOUND)) {
    assert.ok(actions.has(key), `MENU_SOUND["${key}"] has no matching MENU_ACTIONS entry — an orphan`);
  }
  assert.equal(Object.keys(MENU_SOUND).length, MENU_ACTIONS.length, "MENU_SOUND must cover MENU_ACTIONS exactly, one entry each");
});

// --- The music track backend (audio/trackmusic.js, audio/musictypes.js, ---
// --- audio/synth.js's backend selection, tools/serve.js's listing) --------
//
// Nothing below touches a real fetch, AudioContext or decodeAudioData —
// those don't exist under plain Node (see the project's own testing
// guidance: "measure with headless Node sims; browser import() serves
// stale modules"). What's tested is exactly what CAN be exercised without
// them: the pure playlist/shuffle/failure logic, runPreload()'s async
// control flow driven with fake fetch/decode functions, the backend-choice
// decision, and tools/serve.js's listing endpoint against a throwaway
// fixture directory. Real playback (a track actually decoding and sounding,
// disturb()'s bend, gapless single-track looping) was verified by hand
// against assets/music/under_chrome.ogg — see the PR description.

// A small seeded PRNG (mulberry32) so shuffleOrder's tests are
// deterministic and reproducible — Math.random() itself is never used in a
// test, only as shuffleOrder's own production default.
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("shuffleOrder returns a permutation — every track appears exactly once, for several seeds", () => {
  const names = ["a.ogg", "b.ogg", "c.ogg", "d.ogg", "e.ogg"];
  for (const seed of [1, 2, 42, 1000]) {
    const order = shuffleOrder(names, seededRng(seed));
    assert.deepEqual([...order].sort(), [...names].sort(), `seed ${seed} did not produce a permutation of the input`);
  }
});

test("shuffleOrder does not mutate its input array", () => {
  const names = ["a.ogg", "b.ogg", "c.ogg"];
  const copy = [...names];
  shuffleOrder(names, seededRng(7));
  assert.deepEqual(names, copy);
});

test("nextIndex wraps from the last entry back to 0, and is 0 for an empty order", () => {
  assert.equal(nextIndex(["a", "b", "c"], 2), 0);
  assert.equal(nextIndex(["a", "b", "c"], 0), 1);
  assert.equal(nextIndex([], 0), 0);
});

test("a shuffled order never repeats the previous track on wrap, for more than one file", () => {
  // The structural guarantee nextIndex()'s own header claims: order[last]
  // and order[0] are two different elements of the same permutation, so
  // cycling past the end can never immediately replay what just finished.
  const names = ["a.ogg", "b.ogg", "c.ogg", "d.ogg"];
  for (const seed of [3, 11, 99, 4242]) {
    const order = shuffleOrder(names, seededRng(seed));
    const wrapIndex = nextIndex(order, order.length - 1);
    assert.equal(wrapIndex, 0);
    assert.notEqual(order[order.length - 1], order[wrapIndex], `seed ${seed}: wrap must not repeat the previous track`);
  }
});

test("shouldLoopSingleTrack is true only for a single-file directory", () => {
  assert.equal(shouldLoopSingleTrack(["only.ogg"]), true);
  assert.equal(shouldLoopSingleTrack(["a.ogg", "b.ogg"]), false);
  assert.equal(shouldLoopSingleTrack([]), false);
});

test("retainedTrackNames keeps current and next, and drops a null next", () => {
  assert.deepEqual(retainedTrackNames("a.ogg", "b.ogg"), new Set(["a.ogg", "b.ogg"]));
  assert.deepEqual(retainedTrackNames("a.ogg", null), new Set(["a.ogg"]));
});

test("nextPlayableIndex finds the first non-failed track at or after fromIndex, wrapping", () => {
  const order = ["a.ogg", "b.ogg", "c.ogg", "d.ogg"];
  assert.equal(nextPlayableIndex(order, 0, new Set()), 0, "an empty failed set — the starting index itself is playable");
  assert.equal(nextPlayableIndex(order, 0, new Set(["a.ogg"])), 1, "skips the failed entry at fromIndex");
  assert.equal(nextPlayableIndex(order, 2, new Set(["c.ogg", "d.ogg"])), 0, "wraps past the end of the order");
});

test("nextPlayableIndex returns null once every track has failed", () => {
  const order = ["a.ogg", "b.ogg"];
  assert.equal(nextPlayableIndex(order, 0, new Set(["a.ogg", "b.ogg"])), null);
});

test("nextPlayableIndex returns null for an empty order regardless of fromIndex", () => {
  assert.equal(nextPlayableIndex([], 0, new Set()), null);
});

test("runPreload falls back to an empty, not-ready result when the listing fetch throws", async () => {
  const result = await runPreload({
    fetchListing: async () => { throw new Error("network down"); },
    decodeTrack: async () => { throw new Error("should never be called"); },
  });
  assert.deepEqual(result, { order: [], firstTrackReady: false });
});

test("runPreload falls back to an empty, not-ready result for an empty directory listing", async () => {
  const result = await runPreload({
    fetchListing: async () => [],
    decodeTrack: async () => { throw new Error("should never be called"); },
  });
  assert.deepEqual(result, { order: [], firstTrackReady: false });
});

test("runPreload falls back to an empty, not-ready result for a malformed (non-array) listing", async () => {
  const result = await runPreload({
    fetchListing: async () => ({ oops: "not an array" }),
    decodeTrack: async () => { throw new Error("should never be called"); },
  });
  assert.deepEqual(result, { order: [], firstTrackReady: false });
});

test("runPreload builds a shuffled order and reports NOT ready when the first track fails to decode", async () => {
  const listing = [{ name: "a.ogg", size: 10 }, { name: "b.ogg", size: 20 }];
  const result = await runPreload({
    fetchListing: async () => listing,
    decodeTrack: async () => { throw new Error("corrupt file"); },
    rng: seededRng(5),
  });
  assert.equal(result.firstTrackReady, false, "a decode failure on the first track must not report ready");
  assert.deepEqual([...result.order].sort(), ["a.ogg", "b.ogg"], "the order is still built from the listing even though decoding failed");
});

test("runPreload reports ready once the first track decodes successfully", async () => {
  const listing = [{ name: "a.ogg", size: 10 }, { name: "b.ogg", size: 20 }, { name: "c.ogg", size: 30 }];
  const decoded = [];
  const result = await runPreload({
    fetchListing: async () => listing,
    decodeTrack: async (name) => { decoded.push(name); },
    rng: seededRng(5),
  });
  assert.equal(result.firstTrackReady, true);
  assert.equal(decoded.length, 1, "only the FIRST track is decoded during preload — see the module header on streaming one ahead, never the whole directory");
  assert.equal(decoded[0], result.order[0]);
});

test("runPreload's onOrderReady fires synchronously, before decodeTrack is awaited", async () => {
  // This ordering is what keeps trackmusic.js's own preload() correct — see
  // its header on why decodeAndCache()'s evictStale() (which reads module
  // state set by onOrderReady) must never run against a stale order.
  const events = [];
  await runPreload({
    fetchListing: async () => [{ name: "a.ogg", size: 1 }],
    onOrderReady: () => events.push("order"),
    decodeTrack: async () => { events.push("decode"); },
  });
  assert.deepEqual(events, ["order", "decode"]);
});

// The bug this whole mechanism exists to fix: a listing with tracks must be
// reported SETTLED (and therefore, via trackmusic.js's isAvailable(),
// available) before the first track's decode has resolved — decode can take
// as long as it likes here (never resolving, standing in for "still
// decoding" at the moment jackIn() asks) and onListingSettled must already
// have fired regardless. This is the pure-logic proof of the third state
// synth.js's chooseBackend() now has to resolve to "track" for — see the
// chooseBackend tests below for that half of it.
test("runPreload's onListingSettled fires as soon as the listing resolves, without waiting for decodeTrack", async () => {
  const events = [];
  let releaseDecode;
  const pendingDecode = new Promise((resolve) => {
    releaseDecode = resolve;
  });
  const preloadPromise = runPreload({
    fetchListing: async () => [{ name: "a.ogg", size: 1 }],
    onListingSettled: (order) => events.push(`settled:${order.length}`),
    decodeTrack: async () => {
      events.push("decode-start");
      await pendingDecode;
      events.push("decode-end");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0)); // flush microtasks up to decodeTrack's own first await, without resolving it
  assert.deepEqual(events, ["settled:1", "decode-start"], "the listing must be reported settled while the decode is still pending");
  releaseDecode();
  await preloadPromise;
  assert.deepEqual(events, ["settled:1", "decode-start", "decode-end"]);
});

test("runPreload's onListingSettled fires on the failure and empty-listing paths too, with an empty order", async () => {
  const failureEvents = [];
  await runPreload({
    fetchListing: async () => { throw new Error("network down"); },
    onListingSettled: (order) => failureEvents.push(order),
    decodeTrack: async () => { throw new Error("should never be called"); },
  });
  assert.deepEqual(failureEvents, [[]]);

  const emptyEvents = [];
  await runPreload({
    fetchListing: async () => [],
    onListingSettled: (order) => emptyEvents.push(order),
    decodeTrack: async () => { throw new Error("should never be called"); },
  });
  assert.deepEqual(emptyEvents, [[]]);
});

// --- musictypes.js -----------------------------------------------------

test("validateMusicConfig accepts the shipped configuration as-is", () => {
  assert.deepEqual(validateMusicConfig(), []);
});

test("validateMusicConfig rejects a TRACK_GAIN outside 0..1", () => {
  const errors = validateMusicConfig({ trackGain: 1.5 });
  assert.ok(errors.some((e) => e.includes("TRACK_GAIN")), `expected a TRACK_GAIN error, got: ${errors}`);
});

test("validateMusicConfig rejects an empty MUSIC_DIR", () => {
  const errors = validateMusicConfig({ musicDir: "" });
  assert.ok(errors.some((e) => e.includes("MUSIC_DIR")), `expected a MUSIC_DIR error, got: ${errors}`);
});

test("validateMusicConfig rejects a MUSIC_LISTING_URL that isn't root-relative", () => {
  const errors = validateMusicConfig({ listingUrl: "api/music" });
  assert.ok(errors.some((e) => e.includes("MUSIC_LISTING_URL")), `expected a MUSIC_LISTING_URL error, got: ${errors}`);
});

test("validateMusicConfig rejects an out-of-range per-track override", () => {
  const errors = validateMusicConfig({ overrides: { "loud.ogg": { gain: 3 } } });
  assert.ok(errors.some((e) => e.includes("loud.ogg")), `expected a TRACK_OVERRIDES error naming the offending file, got: ${errors}`);
});

test("trackGainFor uses a per-track override when present, else the blanket TRACK_GAIN", () => {
  assert.equal(trackGainFor("nonexistent-track.ogg"), TRACK_GAIN);
});

test("trackDisplayName strips the extension, reads underscores as word breaks, and upper-cases the result", () => {
  assert.equal(trackDisplayName("under_chrome.ogg"), "UNDER CHROME");
  assert.equal(trackDisplayName("a_long_track_name.ogg"), "A LONG TRACK NAME");
});

test("trackDisplayName falls back to the derived name for a track with no TRACK_OVERRIDES title", () => {
  assert.equal(trackDisplayName("nonexistent-track.ogg"), "NONEXISTENT-TRACK");
});

// --- Backend selection (audio/synth.js) ---------------------------------

test("chooseBackend picks track when available, procedural when not, before anything is frozen", () => {
  assert.equal(chooseBackend(null, true), "track");
  assert.equal(chooseBackend(null, false), "procedural");
});

// The bug fix, made explicit at the pure-decision layer: chooseBackend()'s
// second argument is now trackmusic.js's isAvailable() (a soundtrack
// EXISTS, per the listing), not isReady() (a track has actually finished
// decoding). "Available but not yet decoded" is exactly the state a player
// who presses START GAME promptly used to lose the race in — the listing
// has come back with tracks, but the first one is still mid-decode. That
// state passes `available: true` here (chooseBackend has no notion of
// decode progress at all — it only ever sees the boolean its caller
// computed), so it must resolve to "track", same as a fully-decoded track
// would. See runPreload's own "onListingSettled fires... without waiting
// for decodeTrack" test above for where that boolean actually comes from
// in production.
test("chooseBackend resolves to track for the available-but-not-decoded state, not just the fully-ready one", () => {
  assert.equal(chooseBackend(null, true), "track", "a listing with tracks must win over the procedural loop even before the first buffer has decoded");
});

test("chooseBackend never changes an already-frozen choice, even if availability flips", () => {
  assert.equal(chooseBackend("procedural", true), "procedural", "a run that already committed to procedural must not jump to track mid-run");
  assert.equal(chooseBackend("track", false), "track", "a run that already committed to track must not fall back mid-run");
});

test("both music backends implement the same interface synth.js relies on", () => {
  for (const name of MUSIC_BACKEND_METHODS) {
    assert.equal(typeof proceduralmusic[name], "function", `proceduralmusic.js is missing "${name}"`);
    assert.equal(typeof trackmusic[name], "function", `trackmusic.js is missing "${name}"`);
  }
});

// --- tools/serve.js's music listing endpoint -----------------------------

test("listMusicFiles returns only .ogg files, sorted, with sizes — including a spaced filename", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cybercruise-music-"));
  try {
    await writeFile(path.join(dir, "b_track.ogg"), Buffer.alloc(100));
    await writeFile(path.join(dir, "a track (live).ogg"), Buffer.alloc(50));
    await writeFile(path.join(dir, "notes.txt"), "not audio");
    await writeFile(path.join(dir, "sample.wav"), Buffer.alloc(10)); // a real format, just not the one this endpoint lists — see musictypes.js's header on why Ogg Vorbis specifically
    const tracks = await listMusicFiles(dir);
    assert.deepEqual(tracks, [
      { name: "a track (live).ogg", size: 50 },
      { name: "b_track.ogg", size: 100 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listMusicFiles ignores subdirectories (no recursion)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cybercruise-music-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(dir, "nested"));
    await writeFile(path.join(dir, "nested", "hidden.ogg"), Buffer.alloc(5));
    await writeFile(path.join(dir, "top.ogg"), Buffer.alloc(5));
    const tracks = await listMusicFiles(dir);
    assert.deepEqual(tracks, [{ name: "top.ogg", size: 5 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listMusicFiles returns an empty list for a missing directory rather than throwing", async () => {
  const missing = path.join(tmpdir(), "cybercruise-music-does-not-exist-" + Date.now());
  await assert.doesNotReject(async () => {
    const tracks = await listMusicFiles(missing);
    assert.deepEqual(tracks, []);
  });
});

test("MUSIC_DIR and MUSIC_LISTING_URL are both non-empty, and the listing URL is root-relative", () => {
  assert.ok(MUSIC_DIR.length > 0);
  assert.ok(MUSIC_LISTING_URL.startsWith("/"));
});


// --- Phase 11 groundwork: credits (game/wallet.js) --------------------------
//
// The money system's claims are relations between files — the siphon radius
// against the road's own half-width, the `bounty` field against the faction
// that carries it, the fine's floor against the bank underneath it. Every one
// of them is a paragraph in wallet.js that could quietly stop being true when
// someone retunes a number somewhere else, which is what this whole file is
// for.

// A localStorage stand-in: the real one doesn't exist under plain Node, and a
// test that shared one bank with its neighbours would depend on its own
// running order.
function fakeStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

// A synthetic node, positioned in SCREEN space exactly as scenery.js's
// visibleNodes() reports one, plus the plot index everything about it derives
// from. Placed relative to the road's real edges at its own row, so the
// occlusion rule is exercised against real geometry rather than a guessed
// number.
const TEST_W = 600;
const TEST_PLAYER_Y = 500;
function nodeBeside(distance, { offRoadBy = 20, bx = 3, by = 40 } = {}) {
  const sy = TEST_PLAYER_Y; // level with the player: worldY === distance there
  const { left } = edgesAt(distance, TEST_W);
  return { bx, by, cx: left - offRoadBy, sy, variant: 0, progress: 1 };
}

// A clock value at which the given node is actually mid-ping. The ping window
// is a hash-derived phase of a hash-derived period (links.js), so the honest
// way to test "in range while pinging" is to ask links.js itself when that is,
// rather than to hard-code a number a reseed would invalidate.
// A player stand-in level with a node, `away` px to its right, driving fast
// enough that nothing here can accidentally trigger the slow-uplink route —
// the tests that want that route ask for it explicitly.
function atNode(node, away = 0, speed = 600) {
  return { x: node.cx + away, y: node.sy, speed };
}

function clockWhileQuiet(node) {
  for (let t = 0; t < 60; t += 0.05) {
    if (pingingNodes([node], t).length === 0) return t;
  }
  throw new Error("node never idles in 60s — links.js's duty cycle has changed");
}

function clockWhilePinging(node) {
  for (let t = 0; t < 60; t += 0.05) {
    if (pingingNodes([node], t).length > 0) return t;
  }
  throw new Error("no ping window found in 60s — links.js's duty cycle has changed");
}

test("HARVEST_RADIUS is strictly under ROAD_HALF_WIDTH, so the centre of the road can never earn a credit", () => {
  // wallet.js's whole design claim: a payable node is off the tarmac, so a car
  // on the centre-line is at least ROAD_HALF_WIDTH from the nearest one.
  assert.ok(
    HARVEST_RADIUS < ROAD_HALF_WIDTH,
    `HARVEST_RADIUS ${HARVEST_RADIUS} must stay under ROAD_HALF_WIDTH ${ROAD_HALF_WIDTH}`
  );
});

test("every car type's bounty agrees in sign with its score value", () => {
  // The two are separate fields precisely so they CAN diverge in size — but a
  // car worth points and costing credits (or the reverse) would be telling the
  // player two opposite things about the same kill.
  for (const t of CAR_TYPES) {
    assert.equal(typeof t.bounty, "number", `${t.id} has no bounty`);
    assert.ok(Number.isInteger(t.bounty), `${t.id}'s bounty is not an integer`);
    assert.equal(
      Math.sign(t.bounty), Math.sign(t.value),
      `${t.id} pays ${t.bounty} credits but scores ${t.value}`
    );
  }
});

test("the civilian fine is gentler in credits than in points, relative to the reward", () => {
  // wallet.js's header: the score is where carelessness is punished hard, the
  // wallet is where it is punished honestly (a fine can empty a run, and the
  // bank is out of its reach entirely).
  const enemy = CAR_TYPES.find((t) => t.faction === ENEMY_FACTION);
  const civilian = CAR_TYPES.find((t) => t.faction !== ENEMY_FACTION);
  assert.ok(Math.abs(civilian.bounty) / enemy.bounty < Math.abs(civilian.value) / enemy.value);
});

test("nodeValue is a stable function of the plot index, inside its stated range", () => {
  for (let bx = 0; bx < 8; bx++) {
    for (let by = 0; by < 40; by++) {
      const v = nodeValue(bx, by);
      assert.ok(Number.isInteger(v), `node ${bx},${by} pays a non-integer ${v}`);
      assert.ok(v >= 5 && v <= 25, `node ${bx},${by} pays ${v}, outside 5..25`);
      assert.equal(v, nodeValue(bx, by), "nodeValue is not deterministic");
    }
  }
});

test("a bounty is banked, and a car with no bounty field pays nothing at all", () => {
  const w = new Wallet(fakeStore());
  w.destroyed({ bounty: 25 });
  assert.equal(w.credits, 25);
  // The Phase 10 seam: no `bounty` key at all.
  const before = w.lastAward;
  w.destroyed({ value: 100 });
  assert.equal(w.credits, 25, "a type with no bounty moved the wallet");
  assert.equal(w.lastAward, before, "a type with no bounty flashed an award");
});

test("a fine can empty the run but never overdraws it, and never touches the bank", () => {
  const store = fakeStore();
  const first = new Wallet(store);
  first.destroyed({ bounty: 25 });
  first.destroyed({ bounty: 25 });
  first.bank();
  assert.equal(first.banked, 50);

  const second = new Wallet(store);
  assert.equal(second.banked, 50, "the bank did not survive into the next run");
  second.destroyed({ bounty: 25 });                  // run earnings: 25
  const applied = second.destroyed({ bounty: -40 }); // a fine bigger than the run
  assert.equal(applied, -25, "the HUD would have flashed more than was taken");
  assert.equal(second.earned, 0);
  assert.equal(second.banked, 50, "a fine reached credits banked by an earlier run");
  assert.equal(second.credits, 50);
});

test("bank() commits once and is idempotent, and quotes what the run was worth", () => {
  const store = fakeStore();
  const w = new Wallet(store);
  w.destroyed({ bounty: 25 });
  w.bank();
  w.bank();
  assert.equal(w.banked, 25);
  assert.equal(w.lastRunEarnings, 25);
  assert.equal(loadBanked(store), 25);
});

test("a wallet with no storage at all still runs the whole economy", () => {
  // Private mode, disabled storage, or the test suite itself: only persistence
  // is lost, never the run.
  const w = new Wallet(null);
  w.destroyed({ bounty: 25 });
  w.bank();
  assert.equal(w.banked, 25);
  assert.equal(w.credits, 25);
});

test("spend() refuses to overdraw and persists what is left", () => {
  const store = fakeStore();
  const w = new Wallet(store);
  w.destroyed({ bounty: 25 });
  w.bank();
  assert.equal(w.spend(30), false, "spent more than the wallet held");
  assert.equal(w.spend(10), true);
  assert.equal(w.credits, 15);
  assert.equal(loadBanked(store), 15);
});

test("a node in range while pinging pays exactly once per run", () => {
  const distance = 4000;
  const node = nodeBeside(distance);
  const clock = clockWhilePinging(node);
  const w = new Wallet(null);
  const push = () => {};
  const busy = () => false;

  const paid = w.harvest(0, clock, [node], atNode(node), distance, TEST_W, push, busy);
  assert.equal(paid, nodeValue(node.bx, node.by));
  assert.equal(w.nodes, 1);

  // The same node, still pinging, on the next frame: nothing more.
  const again = w.harvest(0, clock + 0.05, [node], atNode(node), distance, TEST_W, push, busy);
  assert.equal(again, 0, "the same node paid twice in one run");
  assert.equal(w.nodes, 1);
});

test("a node out of range, or under the road, pays nothing however long it pings", () => {
  const distance = 4000;
  const node = nodeBeside(distance);
  const clock = clockWhilePinging(node);
  const push = () => {};
  const busy = () => false;

  const far = new Wallet(null);
  // The player exactly as far from it as the centre of the road would be.
  far.harvest(0, clock, [node], atNode(node, ROAD_HALF_WIDTH), distance, TEST_W, push, busy);
  assert.equal(far.credits, 0, "a node beyond the siphon radius paid out");

  // A node the road is currently covering: invisible, and so worth nothing —
  // even with the player sitting directly on top of it.
  const under = new Wallet(null);
  const buried = { ...node, cx: edgesAt(distance, TEST_W).center };
  under.harvest(0, clock, [buried], atNode(buried), distance, TEST_W, push, busy);
  assert.equal(under.credits, 0, "a node hidden under the road paid out");
});

test("the harvested-node set is pruned by the row watermark rather than growing all run", () => {
  const w = new Wallet(null);
  // Rows the road has long since left behind...
  for (let by = 0; by < 200; by++) w.harvested.add(nodeId(1, by));
  // ...and a screen sitting far ahead of every one of them.
  w.prune([{ bx: 1, by: 500 }]);
  assert.equal(w.harvested.size, 0);

  // A row still on screen is never forgotten — that is what stops a node
  // paying twice while it is still beside the player.
  w.harvested.add(nodeId(1, 500));
  w.prune([{ bx: 1, by: 500 }]);
  assert.equal(w.harvested.size, 1);
});

test("CREDITS_KEY shares the settings namespace and does not collide with them", () => {
  assert.ok(CREDITS_KEY.startsWith("cybercruise."));
  assert.notEqual(CREDITS_KEY, "cybercruise.sound");
  assert.notEqual(CREDITS_KEY, "cybercruise.music");
});

test("a node in reach wears its price dormant, and brightens when it goes live", () => {
  // The affordance, and the only reason the range rule is learnable. TWO
  // states rather than one, because the payout itself is instant: see
  // Wallet.hints() on why "in range and paying" would never be visible.
  const distance = 4000;
  const node = nodeBeside(distance);
  const clock = clockWhilePinging(node);
  const w = new Wallet(null);

  // Dormant: a node not currently pinging still advertises itself — but at
  // the price the route still open to it (the uplink) would actually pay,
  // which is less than the headline value. The HUD never quotes money the
  // player is not on course to receive.
  const quiet = clockWhileQuiet(node);
  const dormant = w.hints(quiet, [node], atNode(node), distance, TEST_W);
  assert.equal(dormant.length, 1);
  assert.equal(dormant[0].live, false);
  assert.equal(dormant[0].full, false);
  assert.ok(dormant[0].value > 0 && dormant[0].value < nodeValue(node.bx, node.by));

  // Live and in reach: full price, because the grab is now the route on offer.
  const lit = w.hints(clock, [node], atNode(node), distance, TEST_W);
  assert.equal(lit[0].live, true);
  assert.equal(lit[0].full, true);
  assert.equal(lit[0].value, nodeValue(node.bx, node.by));

  // Further out on the approach: still advertised, but quieter.
  const far = w.hints(clock, [node], atNode(node, HARVEST_RADIUS + 60), distance, TEST_W);
  assert.equal(far.length, 1);
  assert.ok(far[0].alpha < lit[0].alpha, "a distant node shouts as loudly as one alongside");
});

test("nothing is advertised that could not actually be collected", () => {
  // A marker over a node that pays nothing would be the HUD lying, which is
  // the one thing wallet.js's hint layer is not allowed to do. Same three
  // filters harvest() itself applies.
  const distance = 4000;
  const node = nodeBeside(distance);
  const clock = clockWhilePinging(node);
  const w = new Wallet(null);

  // Already taken this run.
  w.harvest(0, clock, [node], atNode(node), distance, TEST_W, () => {}, () => false);
  assert.equal(w.hints(clock, [node], atNode(node), distance, TEST_W).length, 0);

  // Hidden under the road.
  const buried = { ...node, bx: node.bx + 1, cx: edgesAt(distance, TEST_W).center };
  assert.equal(new Wallet(null).hints(clock, [buried], atNode(buried), distance, TEST_W).length, 0);

  // Too far away to be worth mentioning.
  const fresh = new Wallet(null);
  assert.equal(fresh.hints(clock, [node], atNode(node, 1000), distance, TEST_W).length, 0);
});

test("the siphon hint is pushed once per run, and only once it lands", () => {
  const lines = [];
  const push = (text) => lines.push(text);
  const w = new Wallet(null);

  // Nothing in range: nothing to say.
  w.hint(0, false, push, () => false);
  assert.equal(lines.length, 0);

  // Throttled away (a busy log) leaves the run still un-hinted, so the advice
  // isn't silently lost for the whole drive.
  w.hint(0, true, push, () => true);
  assert.equal(lines.length, 0);
  assert.equal(w.hinted, false);

  // Free log: it lands, once, and never again this run.
  linksReset();
  assert.equal(w.hint(100, true, push, () => false), true);
  w.hint(200, true, push, () => false);
  assert.equal(lines.length, 1);
});

test("every payout leaves a marker on the spot it came from, which ages out on its own", () => {
  const distance = 4000;
  const node = nodeBeside(distance);
  const clock = clockWhilePinging(node);
  const w = new Wallet(null);

  // A siphoned node: anchored on the CITY FLOOR, at the screen position it was
  // taken at.
  w.harvest(0, clock, [node], atNode(node), distance, TEST_W, () => {}, () => false);
  assert.equal(w.marks.length, 1);
  assert.equal(w.marks[0].kind, "floor");
  assert.equal(w.marks[0].x, node.cx);
  assert.equal(w.marks[0].value, nodeValue(node.bx, node.by));

  // A destroyed car: anchored on the ROAD, in world coordinates, because that
  // plane scrolls and bends underneath the marker.
  w.destroyed({ bounty: 25 }, 4200, -40);
  const wreck = w.marks[w.marks.length - 1];
  assert.equal(wreck.kind, "road");
  assert.equal(wreck.worldY, 4200);
  assert.equal(wreck.offset, -40);
  assert.equal(wreck.value, 25);

  // A fine marks what was actually taken, in the negative.
  w.destroyed({ bounty: -15 }, 4300, 0);
  assert.equal(w.marks[w.marks.length - 1].value, -15);

  // ...and a caller with no position to point at simply leaves no marker.
  const before = w.marks.length;
  w.destroyed({ bounty: 25 });
  assert.equal(w.marks.length, before);

  w.update(0.5);
  assert.ok(w.marks.length > 0, "markers vanished before their own lifetime was up");
  w.update(1);
  assert.equal(w.marks.length, 0, "a marker outlived its own lifetime");
});

test("a chain reaction can't stack more than a readable number of markers", () => {
  const w = new Wallet(null);
  for (let i = 0; i < 20; i++) w.destroyed({ bounty: 25 }, 1000 + i, 0);
  assert.ok(w.marks.length <= 5, `${w.marks.length} markers in the air at once`);
  // The oldest go, not the newest: what stays on screen is what just happened.
  assert.equal(w.marks[w.marks.length - 1].worldY, 1019);
});

test("a fine with nothing left to take leaves no marker at all", () => {
  // "-0CR" over a wreck would be noise, and worse, a lie about a penalty that
  // did not land.
  const w = new Wallet(null);
  w.destroyed({ bounty: -15 }, 1000, 0);
  assert.equal(w.earned, 0);
  assert.equal(w.marks.length, 0);
});

// --- The uplink: the slow route to a node the shoulder can't reach ----------

// A player stand-in out past the road's edge on the same side as `node`, at a
// given speed — the position the uplink demands.
function beside(node, distance, speed) {
  const center = centerXAt(distance, TEST_W);
  const side = Math.sign(node.cx - center) || -1;
  // `w` because the uplink's dish is measured off the car's flank
  // (wallet.js's uplinkLink); everything else here only needs a point.
  return { x: center + side * (ROAD_HALF_WIDTH - 17), y: node.sy, speed, w: 34 };
}

// Runs `seconds` of ticks against one node, at 60Hz, exactly as main.js does.
function hold(w, node, player, distance, seconds, clock = 0) {
  let paid = 0;
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    paid += w.holdUplink(dt, clock + t, [node], player, distance, TEST_W, () => {}, () => false);
  }
  return paid;
}

test("a slow car on the node's side eventually takes a node it could never reach", () => {
  // The whole reason this route exists: nodes sit on a fixed column grid while
  // the road wanders across it, so some of them are simply too far out for the
  // shoulder to touch.
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 }); // well beyond HARVEST_RADIUS
  const w = new Wallet(null);
  const player = beside(node, distance, 150);
  assert.ok(
    Math.hypot(node.cx - player.x, node.sy - player.y) > HARVEST_RADIUS,
    "this test is not testing what it thinks it is — the node is grabbable"
  );

  const paid = hold(w, node, player, distance, 3);
  assert.ok(paid > 0, "a held uplink never completed");
  assert.equal(w.nodes, 1);
  // At a discount to the node's headline price: the fast route stays the
  // better one (see UPLINK_FRACTION).
  assert.ok(paid < nodeValue(node.bx, node.by));
});

test("the uplink is bought with speed — too fast and it never starts", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const paid = hold(w, node, beside(node, distance, 600), distance, 5);
  assert.equal(paid, 0);
  assert.equal(w.uplink, null);
});

test("the uplink is bought with position too — the wrong side of the road earns nothing", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const center = centerXAt(distance, TEST_W);
  const side = Math.sign(node.cx - center) || -1;
  // Slow, but out on the OPPOSITE shoulder.
  const wrongSide = { x: center - side * (ROAD_HALF_WIDTH - 17), y: node.sy, speed: 150 };
  assert.equal(hold(w, node, wrongSide, distance, 5), 0);
});

test("a broken hold bleeds away rather than being wiped, and never completes on its own", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);

  hold(w, node, beside(node, distance, 150), distance, 1);
  const banked = w.uplink.held;
  assert.ok(banked > 0);

  // One tick at speed: progress drops, but the attempt survives.
  w.holdUplink(1 / 60, 0, [node], beside(node, distance, 600), distance, TEST_W, () => {}, () => false);
  assert.ok(w.uplink.held < banked, "a broken hold kept its progress");
  assert.ok(w.uplink.held > 0, "a single fast tick wiped the whole attempt");

  // Sustained: it lapses entirely, and nothing is ever paid for it.
  for (let i = 0; i < 600; i++) {
    w.holdUplink(1 / 60, 0, [node], beside(node, distance, 600), distance, TEST_W, () => {}, () => false);
  }
  assert.equal(w.uplink, null);
  assert.equal(w.credits, 0);
});

test("only one uplink runs at a time, and switching nodes starts over", () => {
  const distance = 4000;
  const near = nodeBeside(distance, { offRoadBy: 200, bx: 3, by: 40 });
  const far = { ...near, bx: 4, by: 41, cx: near.cx - 60 };
  const w = new Wallet(null);
  const player = beside(near, distance, 150);

  hold(w, near, player, distance, 1);
  const id = w.uplink.id;
  const progress = w.uplink.held;

  // The same tick sequence against the OTHER node: a new hold, from zero.
  w.holdUplink(1 / 60, 0, [far], player, distance, TEST_W, () => {}, () => false);
  assert.notEqual(w.uplink.id, id);
  assert.ok(w.uplink.held < progress);
});

test("a node that only needs the throttle says so", () => {
  // The prompt exists because "drive slower here" is the one thing about this
  // game the player cannot deduce from watching the road.
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const quiet = clockWhileQuiet(node);

  const fast = w.hints(quiet, [node], beside(node, distance, 600), distance, TEST_W);
  assert.equal(fast.length, 1);
  assert.equal(fast[0].slow, true, "a node in reach of a slow-down said nothing about it");

  // Already slow: no prompt, because the meter itself is now the feedback.
  const slow = w.hints(quiet, [node], beside(node, distance, 150), distance, TEST_W);
  assert.equal(slow[0].slow, false);
});

test("an uplink in progress shows its own meter", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const player = beside(node, distance, 150);
  const quiet = clockWhileQuiet(node);

  assert.equal(w.hints(quiet, [node], player, distance, TEST_W)[0].uplink, 0);
  hold(w, node, player, distance, 1);
  const mid = w.hints(quiet, [node], player, distance, TEST_W)[0].uplink;
  assert.ok(mid > 0 && mid < 1, `meter reads ${mid}`);
});

// The draw call itself, exercised once with a road-anchored receipt alive —
// the one thing in wallet.js that a pure-data test can't reach. A throw here
// is not a cosmetic bug: render() runs inside the rAF callback (engine/loop.js)
// and takes the next frame down with it, so the whole game stops on the frame
// after a kill, half-drawn, with only the city floor on screen.
test("a wreck's receipt draws without taking the frame down with it", () => {
  const distance = 4000;
  const w = new Wallet(null);
  w.award(100); // something for the bounty to land on top of
  w.destroyed({ bounty: 25 }, distance + 40, 30);
  assert.equal(w.marks.length, 1, "the wreck left no marker to draw");

  // Records every call rather than asserting on the pixels: what is under test
  // is that the function completes, and that the receipt was actually emitted
  // (an early return would pass a "did not throw" check trivially).
  const drawn = [];
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === "measureText" ? () => ({ width: 10 }) : (...args) => drawn.push([k, ...args])),
    set: () => true,
  });

  w.renderHints(ctx, 0, [], { x: 0, y: 400, speed: 150 }, distance, TEST_W);
  assert.ok(drawn.some(([k]) => k === "fillText"), "the receipt never reached the canvas");
});

// --- The dish: the same fact, drawn on the car -------------------------------

test("no hold, no dish — the car only wears one while it is actually taking something", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const player = beside(node, distance, 150);
  assert.equal(w.uplinkLink([node], player, player.x), null);
});

test("the dish rides the flank the node is on, clear of the car's own body", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const player = beside(node, distance, 150);
  hold(w, node, player, distance, 1);

  const link = w.uplinkLink([node], player, player.x);
  assert.ok(link, "a running hold drew no dish");
  // The whole point of the marker: it says WHICH WAY the money is.
  assert.equal(Math.sign(link.ax - player.x), Math.sign(node.cx - player.x));
  // Off the edge of the body, never on top of the wireframe.
  assert.ok(Math.abs(link.ax - player.x) >= player.w / 2);
  assert.ok(Math.abs(link.dx - player.x) > Math.abs(link.ax - player.x));
  // And it is aimed at the node it is draining, not at the road ahead.
  assert.ok(Math.sign(link.ux) === Math.sign(node.cx - player.x));
});

test("the dish brightens with the hold it is reporting, and lands on the node", () => {
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const player = beside(node, distance, 150);

  hold(w, node, player, distance, 0.3);
  const early = w.uplinkLink([node], player, player.x);
  hold(w, node, player, distance, 0.6);
  const later = w.uplinkLink([node], player, player.x);
  assert.ok(later.progress > early.progress, "progress went backwards");
  assert.ok(later.progress < 1, "the meter filled before the hold did");
  // The far end is the node itself — the link is between two real things.
  assert.equal(later.nx, node.cx);
  assert.equal(later.ny, node.sy);
});

test("a node the floor is no longer drawing takes its dish with it", () => {
  // uplinkLink reads the node out of the list actually on screen, so a hold on
  // something that has scrolled away draws nothing rather than a beam into an
  // empty patch of city.
  const distance = 4000;
  const node = nodeBeside(distance, { offRoadBy: 200 });
  const w = new Wallet(null);
  const player = beside(node, distance, 150);
  hold(w, node, player, distance, 1);
  assert.equal(w.uplinkLink([], player, player.x), null);
});
