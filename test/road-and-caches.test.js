// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// The road ribbon, its strip cache, and the speed band the whole catalogue is sized against.
//
// Everything imported here is DOM-free at module scope, so the game's real
// modules load under plain Node.

import test from "node:test";
import assert from "node:assert/strict";
import { CAR_TYPES } from "../src/game/cartypes.js";
import { CAR_SHAPES, carShapeExtent, shapeExtent } from "../src/game/carshapes.js";
import { BOSS_SHAPES } from "../src/game/bossshapes.js";
import { CYCLE_SHAPES } from "../src/game/cycleshapes.js";
import { ACCEL as TRAFFIC_ACCEL } from "../src/game/traffic.js";
import { DRIVING_PROFILES, typesDriving } from "../src/game/driving.js";
import { MIN_SPEED, MAX_SPEED, ACCEL as PLAYER_ACCEL } from "../src/game/player.js";
import { WHEEL_FRAMES } from "../src/game/sprites.js";
import {
  LANE_COUNT,
  ROAD_HALF_WIDTH,
  laneAt,
  laneOffset,
  centerOffset,
  headingAt,
  TILE_STRIDE,
  DASH_SPAN,
  blockOf,
  blockLocalY,
  blockDestY,
} from "../src/game/road.js";
import { gridPhase, GRID_SPACING } from "../src/game/scenery.js";
import { CELL, ARTERIAL_PERIOD } from "../src/game/citygrid.js";
import { driver, slowest, fastest } from "../test-support/fixtures.js";

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
  // cartypes.js: "15 types * 8 * 2 = 240 sprites at worst" — one per (type,
  // wheel frame), doubled for the critical-hull blink colour. This is what
  // keeps the cache bounded, so it must not grow silently. The figure last
  // moved when the motorcycle fleet landed (192 -> 240): three types is ~1.5 MB
  // of sprite cache, which is the cost cycleshapes.js's staging deferred until
  // each of those hulls had a record.
  const worstCase = CAR_TYPES.length * WHEEL_FRAMES * 2;
  assert.equal(
    worstCase,
    240,
    `traffic sprite worst case is now ${worstCase}, not the documented 240 ` +
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

// --- The staged two- and three-wheeler catalogue ------------------------------
//
// cycleshapes.js gets the same three guards bossshapes.js gets above, for the
// same reason: nothing in the game draws these yet, so nothing else would
// notice a clipped sprite or a hull sliding along on its belly until the phase
// that spawns one. The gallery is the only thing that renders them, and the
// gallery cannot fail a build.

test("shapeExtent bounds every point of every two- and three-wheeler hull", () => {
  for (const shape of CYCLE_SHAPES) {
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

test("every two- and three-wheeler hull says how it meets the ground", () => {
  for (const shape of CYCLE_SHAPES) {
    assert.ok(shape.wheels || shape.tracks || shape.hover,
      `${shape.name} has no wheels, tracks or hover`);
  }
});

test("two- and three-wheeler hulls are not in the traffic catalogue", () => {
  // cycleshapes.js's header: these stay out of CAR_SHAPES until they have a
  // cartypes.js record. Copying one across and forgetting its type should break
  // HERE, with a name in the message.
  const names = new Set(CAR_SHAPES.map((s) => s.name));
  for (const shape of CYCLE_SHAPES) {
    assert.ok(!names.has(shape.name),
      `${shape.name} is in CAR_SHAPES — it needs a cartypes.js record, or it does not belong there`);
  }
});

test("the wheel count each hull's pitch claims is the wheel count it draws", () => {
  // The whole point of this catalogue is "every wheel visible", and a `solo`
  // flag silently dropped from a tuple turns a tricycle into a four-wheeler
  // without changing anything else about the shape. Counting is the only way
  // that shows up outside the gallery.
  const drawn = (shape) =>
    (shape.wheels ?? []).reduce((n, [, , , , solo = false]) => n + (solo ? 1 : 2), 0);
  const expected = { MOTORCYCLE: 2, TRICYCLE: 3 };
  for (const shape of CYCLE_SHAPES) {
    assert.equal(drawn(shape), expected[shape.family],
      `${shape.name} is a ${shape.family} but draws ${drawn(shape)} wheels`);
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
