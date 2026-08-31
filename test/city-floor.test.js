// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// The parallax city: its lot grid, nodes, materialisation, traffic dots, drones, links and sectors.
//
// Everything imported here is DOM-free at module scope, so the game's real
// modules load under plain Node.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Traffic } from "../src/game/traffic.js";
import { MAX_SPEED } from "../src/game/player.js";
import { BUILDING_VARIANTS, buildingFootprint } from "../src/game/sprites.js";
import {
  gridPhase,
  STREET_WIDTH,
  STREET_INSET,
  trafficDots,
  crossStreetBands,
  avenueCenters,
  visibleBuildings,
  visibleNodes,
  tileIntersections,
  makeBoundedCache,
  currentSector,
  DOT_SPACING,
  DOT_SPEED_A,
  DOT_SPEED_B,
  DOT_LANE_PHASE,
  FLOOR_PARALLAX,
  floorDist,
  WIPE_SPAN,
  materialiseProgress,
} from "../src/game/scenery.js";
import { droneField, DRONE_PARALLAX } from "../src/game/drones.js";
import {
  conduitField,
  pingField,
  callsign,
  announcement,
  announce,
  activePing,
  announceActive,
  nodeValue,
  reset as linksReset,
} from "../src/game/links.js";
import { HINT as CONSOLE_HINT } from "../src/engine/console.js";
import {
  CELL,
  PLOT,
  LOT,
  LOT_SUBDIV,
  ARTERIAL_PERIOD,
  SECTOR_PERIOD,
  sectorIndex,
  lotAt,
  lotColumns,
  lotRows,
  lotX,
  lotY,
  plotColumns,
  plotAt,
  plotRows,
  isAvenueCol,
  isCrossStreetRow,
  BUILDING,
  EMPTY,
  AVENUE,
  CROSS_STREET,
  NODE,
} from "../src/game/citygrid.js";
import { NODE_VARIANTS } from "../src/game/nodeshapes.js";
import {
  SECTOR_COUNT,
  setSector,
  BUILDING_EDGE,
  PLAYER,
  PLAYER_THRUST,
  HAZARD,
  CRITICAL_FLASH,
  ENEMY,
  ENEMY_DEEP,
  ENEMY_PALE,
  ENEMY_THRUST,
  NEUTRAL,
  NEUTRAL_DEEP,
  NEUTRAL_THRUST,
  GREEN,
  GREEN_BRIGHT,
  GREEN_PALE,
  GREEN_DIM,
} from "../src/engine/palette.js";
import {
  sectorName,
  update as sectorsUpdate,
  reset as sectorsReset,
  glitching as sectorsGlitching,
} from "../src/game/sectors.js";
import { worldSeed, reseedWorld } from "../src/game/worldseed.js";
import { slowest } from "../test-support/fixtures.js";

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

// --- The run's own world seed (worldseed.js) ----------------------------------
//
// Every other measurement in this file is taken at SEED 0 — the city that
// shipped before worldseed.js existed, and the one citygrid.js's own BUILD_
// CHANCE and NODE_CHANCE comments were measured against. The three tests below
// are the only ones in the suite that move the seed, and each puts it back, so
// nothing here depends on the order the file happens to run in.

// The city as ONE SIGNATURE PER SALTED FILE, not one for the city as a whole.
// The distinction is the entire point: the salt is added inside four separate
// copies of hash(), so the failure to catch is one of them losing it while the
// other three still move. A single whole-city signature cannot see that — the
// three that still move keep the signature changing, and the frozen layer rides
// along invisibly. (Written that way first, and it passed with the salt stripped
// out of citygrid.js entirely.) Each key below comes from exactly one file, so a
// desalted file turns into a named failing assertion.
function cityLayers() {
  const lots = [];
  for (let lx = -6; lx < 6; lx++) {
    for (let ly = -30; ly < 30; ly++) {
      const lot = lotAt(lx, ly);
      lots.push(`${lot.type}:${lot.variant ?? ""}`);
    }
  }
  const nodes = [];
  const links = [];
  for (let bx = -10; bx < 10; bx++) {
    for (let by = -40; by < 40; by++) {
      const plot = plotAt(bx, by);
      if (plot && plot.type === NODE) nodes.push(`${bx},${by}:${plot.variant}`);
      // Sampled at EVERY plot index, not just the ones currently holding a
      // node, and that is not laziness about the walk: WHICH plots are nodes is
      // a citygrid.js roll, so a list gathered only at node plots moves with
      // citygrid's salt even when links.js has lost its own. (Written that way
      // first, and links.js was the one file the desalting check then missed.)
      // A fixed index set makes this layer answer for links.js alone.
      links.push(`${callsign(bx, by)}:${nodeValue(bx, by)}`);
    }
  }
  const sectorNames = [];
  for (let i = 0; i < 20; i++) sectorNames.push(sectorName(i));
  const drones = droneField(12.5, 4321, 496, 600, 800).map((d) => `${d.x.toFixed(2)},${d.y.toFixed(2)}`);
  return {
    // citygrid.js — the buildings and their variants
    lots: lots.join("|"),
    // citygrid.js — which plots are nodes at all, and which variant
    nodes: nodes.join("|"),
    // links.js — callsigns and prices (its conduit, ping and status rolls all
    // share this file's one hash, so these two answer for the file)
    links: links.join("|"),
    // sectors.js
    sectorNames: sectorNames.join("|"),
    // drones.js
    drones: drones.join("|"),
  };
}

test("the world seed defaults to 0 — the city this whole suite measures", () => {
  // Not a triviality: it is the reason every measured number in this file (and
  // in citygrid.js's own comments) means something run to run. If the default
  // ever became a random draw, nothing below would be reproducible and a red
  // test would be unrepeatable rather than informative. main.js's newGame() is
  // the ONE caller that asks for a random seed — see worldseed.js.
  assert.equal(worldSeed(), 0, `the world seed defaults to ${worldSeed()}, not 0`);
});

test("every salted layer follows the seed — no layer left frozen at seed 0", () => {
  // The failure this exists for is a SILENT one: any one of the four hash()
  // copies losing its salt — a refactor, a merge, a hand-inlined hash — leaves
  // that layer frozen while the rest of the city moves around it. Nothing about
  // it is visible in a screenshot (a frozen layer is still perfectly
  // self-consistent) and no other test in this file would notice. Checked layer
  // by layer for the reason cityLayers() gives.
  const atZero = cityLayers();
  try {
    reseedWorld(4242);
    const atFourK = cityLayers();
    reseedWorld(90210);
    const atNinety = cityLayers();
    for (const layer of Object.keys(atZero)) {
      assert.notEqual(atFourK[layer], atZero[layer], `the "${layer}" layer did not follow the world seed`);
      assert.notEqual(atNinety[layer], atFourK[layer], `the "${layer}" layer is the same at two different seeds`);
    }

    // The other half of the contract, and the one that makes a seed worth
    // printing: a run is replayable. Same seed in, same city out — which is also
    // what lets a world bug found at some seed be reached again by seeding it
    // back, rather than by re-rolling until it happens to return.
    reseedWorld(4242);
    assert.deepEqual(cityLayers(), atFourK, "the same seed did not reproduce the same city");
    reseedWorld(0);
    assert.deepEqual(cityLayers(), atZero, "seeding back to 0 did not restore the shipped city");
  } finally {
    reseedWorld(0);
  }
});

test("the eligible-lot and realized-build fractions hold across seeds, not just at seed 0", () => {
  // The risk this change introduced. citygrid.js's BUILD_CHANCE comment states
  // two measured fractions, and the test above pins them at seed 0 — but the
  // player now gets an arbitrary seed, so those numbers are only worth stating
  // if they describe EVERY city rather than the one that used to be the only
  // one. The sin-hash is not a real PRNG, and a salt that happened to correlate
  // with the lot lattice is exactly the way this could go quietly wrong.
  //
  // MEASURED across 401 salts while writing this: eligible 0.4831-0.4895, built
  // 0.4093-0.4170 — both comfortably inside the +/-0.01 band the seed-0 test
  // already uses, which is why that band is reused here rather than widened.
  // The seeds below are fixed rather than drawn, for the same reason the default
  // seed is 0: a red result has to be repeatable.
  const seeds = [];
  for (let i = 0; i < 16; i++) seeds.push(i * 61549 + 7);
  try {
    for (const s of seeds) {
      reseedWorld(s);
      const counts = {};
      let total = 0;
      for (let lx = -40; lx < 40; lx++) {
        for (let ly = -400; ly < 400; ly++) {
          const t = lotAt(lx, ly).type;
          counts[t] = (counts[t] ?? 0) + 1;
          total++;
        }
      }
      const eligibleFrac = ((counts[BUILDING] ?? 0) + (counts[EMPTY] ?? 0)) / total;
      const builtFrac = (counts[BUILDING] ?? 0) / total;
      assert.ok(
        Math.abs(eligibleFrac - 0.4854) < 0.01,
        `seed ${s}: eligible-lot fraction ${eligibleFrac.toFixed(4)}, expected ~0.4854`,
      );
      assert.ok(
        Math.abs(builtFrac - 0.4123) < 0.01,
        `seed ${s}: realized-build fraction ${builtFrac.toFixed(4)}, expected ~0.4123`,
      );
    }
  } finally {
    reseedWorld(0);
  }
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
