// Salvage's invariants — the ones that span the two halves of the feature.
//
// Same rule as the rest of test/ (see README-invariants.md): these are not
// unit tests of behaviour, they are the cross-file claims that would otherwise
// only exist in a comment. The three worth pinning here:
//
//   THE KEY FORMAT IS AN ORDERING, not a naming convention. worker/salvage.js
//   claims lexical order IS distance order, and the whole "no sort needed,
//   one list() is the read" design rests on it.
//   THE DELETE FILTER IS THE ONLY THING between a POST and the leaderboard's
//   own key. If sanitizeCollected() ever accepts something salvageKey() could
//   not have produced, a request can delete the board.
//   THE CLIENT LEDGER MUST NOT THROW, whatever state the browser's storage is
//   in — a corrupt local ledger has to cost husks, never the run.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SALVAGE_LIMITS,
  bandPrefix,
  evictions,
  salvageKey,
  sanitizeCollected,
  sanitizeSalvage,
} from "../worker/salvage.js";
import * as salvage from "../src/game/salvage.js";
import {
  CASH,
  PICKUP_TYPES,
  applyPickup,
  pickPickupType,
  pickupAvailable,
  pickupTypeById,
} from "../src/game/pickuptypes.js";
import { PICKUP_SHAPES, pickupExtent, pickupShapeIndex } from "../src/game/pickupshapes.js";
import { SALVAGE_SIZE } from "../src/game/salvageshape.js";
import { PICKUP_SOUND } from "../src/audio/pickupsfx.js";
import { Pickups } from "../src/game/pickups.js";
import { ROAD_HALF_WIDTH } from "../src/game/road.js";

// A localStorage-shaped object, so the client half can be exercised in Node.
function fakeStore(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    data,
  };
}

const KEY = "cybercruise.salvage";

// --- The key format ---------------------------------------------------------

test("lexical key order is distance order", () => {
  const distances = [0, 7, 499, 500, 1234, 50_000, 999_999];
  const keys = distances.map((d) => salvageKey(d, "abcdefgh"));
  assert.deepEqual([...keys].sort(), keys, "padding must make string sort = numeric sort");
});

test("a band prefix matches exactly the keys in that band", () => {
  const { BAND } = SALVAGE_LIMITS;
  const inside = [BAND * 3, BAND * 3 + 1, BAND * 4 - 1];
  const outside = [BAND * 3 - 1, BAND * 4];
  const prefix = bandPrefix(BAND * 3);
  for (const d of inside) assert.ok(salvageKey(d, "abcdefgh").startsWith(prefix), `${d}`);
  for (const d of outside) assert.ok(!salvageKey(d, "abcdefgh").startsWith(prefix), `${d}`);
});

// --- The delete filter ------------------------------------------------------

test("sanitizeCollected accepts what salvageKey produces and nothing else", () => {
  const good = salvageKey(2400, "0a1b2c3d");
  assert.deepEqual(sanitizeCollected([good]), [good]);

  // "top10" is the leaderboard's own key — the one thing a forged `collected`
  // list must never be able to reach. See the worker's header.
  const bad = ["top10", "s:", "s:00004:00002400:0a1b2c3d:x", "local:1-0", "", 7, null, {}];
  assert.deepEqual(sanitizeCollected(bad), []);
  assert.deepEqual(sanitizeCollected("top10"), []);
});

test("sanitizeCollected bounds the delete work one request can ask for", () => {
  const many = Array.from({ length: SALVAGE_LIMITS.MAX_COLLECTED + 20 }, (_, i) =>
    salvageKey(i * 10, "0a1b2c3d")
  );
  assert.equal(sanitizeCollected(many).length, SALVAGE_LIMITS.MAX_COLLECTED);
});

// --- The record filter ------------------------------------------------------

test("sanitizeSalvage keeps a real record and drops garbage", () => {
  assert.deepEqual(sanitizeSalvage({ distance: 2400.7, offset: -61.2, credits: 940.9 }), {
    distance: 2400,
    offset: -61,
    credits: 940,
  });
  // Initials are optional, upper-cased and cut to the vector font's charset,
  // exactly as the board's own sanitize() does it (worker/leaderboard-worker.js).
  assert.equal(sanitizeSalvage({ distance: 1, offset: 0, credits: 0, name: "ab!" }).name, "AB");
  assert.equal("name" in sanitizeSalvage({ distance: 1, offset: 0, credits: 0 }), false);
  assert.equal("name" in sanitizeSalvage({ distance: 1, offset: 0, credits: 0, name: "!!" }), false);

  for (const bad of [
    null,
    {},
    { distance: -1, offset: 0, credits: 0 },
    { distance: 0, offset: SALVAGE_LIMITS.MAX_OFFSET + 1, credits: 0 },
    { distance: 0, offset: 0, credits: -1 },
    { distance: 0, offset: 0, credits: SALVAGE_LIMITS.MAX_CREDITS + 1 },
    { distance: SALVAGE_LIMITS.MAX_DISTANCE + 1, offset: 0, credits: 0 },
    { distance: "far", offset: 0, credits: 0 },
    { distance: NaN, offset: 0, credits: 0 },
  ]) {
    assert.equal(sanitizeSalvage(bad), null, JSON.stringify(bad));
  }
});

// --- The per-band cap -------------------------------------------------------

test("a full band evicts its oldest, and a band with room evicts nothing", () => {
  const { MAX_PER_BAND } = SALVAGE_LIMITS;
  const band = (n) =>
    Array.from({ length: n }, (_, i) => ({ name: `k${i}`, metadata: { t: 100 + i } }));

  assert.deepEqual(evictions(band(MAX_PER_BAND - 1)), []);
  assert.deepEqual(evictions(band(MAX_PER_BAND)), ["k0"]);
  assert.deepEqual(evictions(band(MAX_PER_BAND + 2)), ["k0", "k1", "k2"]);
  // A key with no timestamp is undatable, so it goes before anything that can
  // be dated rather than surviving on a default.
  const mixed = [{ name: "dated", metadata: { t: 1 } }, ...band(MAX_PER_BAND - 2), { name: "raw" }];
  assert.deepEqual(evictions(mixed), ["raw"]);
});

// --- The client ledger ------------------------------------------------------

test("the local ledger survives every shape of corruption", () => {
  for (const junk of ["", "{", "null", '"x"', '{"a":1}', "[1,2]", '[{"id":"x"}]']) {
    salvage.setStore(fakeStore({ [KEY]: junk }));
    assert.deepEqual(salvage.readLocal(), [], junk);
  }
  // No store at all — Node, or a browser with storage blocked.
  salvage.setStore(null);
  assert.deepEqual(salvage.readLocal(), []);
  assert.deepEqual(salvage.recordLocal({ distance: 1, offset: 0, credits: 2 }), []);
});

test("the local ledger keeps only the newest LOCAL_KEEP husks", () => {
  salvage.setStore(fakeStore());
  let kept = [];
  for (let i = 0; i < 20; i++) {
    kept = salvage.recordLocal({ distance: i * 100, offset: 0, credits: i }, 1000 + i);
  }
  assert.ok(kept.length > 0 && kept.length < 20, "capped, not unbounded");
  assert.equal(kept.at(-1).credits, 19, "the newest death is always kept");
  assert.ok(
    kept.every((e) => e.mine === true && e.id.startsWith("local:")),
    "a local husk is marked as the player's own and can never look like a KV key"
  );
  // ...and therefore can never be sent as a delete target: the worker's own
  // filter would reject the shape even if the client got it wrong.
  assert.deepEqual(sanitizeCollected(kept.map((e) => e.id)), []);
});

test("collected ids: local husks are struck immediately, remote ones queued", () => {
  salvage.setStore(fakeStore());
  const kept = salvage.recordLocal({ distance: 500, offset: 0, credits: 40 });
  salvage.beginRun();

  const remote = salvageKey(2400, "0a1b2c3d");
  salvage.markCollected(remote);
  salvage.markCollected(remote); // twice: the same husk must not be deleted twice
  salvage.markCollected(kept[0].id);

  assert.deepEqual(salvage.collectedIds(), [remote]);
  assert.deepEqual(salvage.readLocal(), [], "the looted local husk is gone from the ledger");

  salvage.clearCollected();
  assert.deepEqual(salvage.collectedIds(), []);
});

// --- The catalogue side ------------------------------------------------------

test("a placed type is never rolled by the road spawner", () => {
  const salvageType = pickupTypeById("salvage");
  assert.equal(salvageType.kind, CASH);
  assert.equal(pickupAvailable(salvageType, Infinity), false);
  // Belt and braces against the roll itself, since `placed` only works if
  // pickPickupType actually honours pickupAvailable.
  for (const distance of [0, 500, 5000, 1e9]) {
    for (let i = 0; i < 200; i++) {
      assert.notEqual(pickPickupType(distance)?.id, "salvage", `rolled at ${distance}`);
    }
  }
  // ...and nothing else in the catalogue is accidentally unrollable.
  assert.equal(PICKUP_TYPES.filter((t) => t.placed).length, 1);
});

test("a husk pays its rate of the dead run's credits, and only CASH pays at all", () => {
  const salvageType = pickupTypeById("salvage");
  const wallet = { paid: 0, award(n) { this.paid += n; } };

  applyPickup(salvageType, null, null, wallet, Math.round(940 * salvageType.rate));
  assert.equal(wallet.paid, 94);

  // Every other kind ignores the wallet entirely — the argument rides in the
  // shared list (pickuptypes.js's applyPickup) precisely so it can be ignored.
  const heal = pickupTypeById("fix");
  const player = { healed: 0, heal(n) { this.healed += n; } };
  applyPickup(heal, player, null, wallet, 999);
  assert.equal(wallet.paid, 94, "a heal must not reach the wallet");
});

// --- Placement ---------------------------------------------------------------

test("the placement cursor walks the set once, and re-derives itself when it changes", () => {
  const pickups = new Pickups(null, null);
  const player = { y: 400 };
  const husk = (distance) => ({ id: `k${distance}`, distance, offset: 0, credits: 100 });
  const placed = () => pickups.list.map((p) => p.worldY);

  // The horizon is `distance + player.y + SPAWN_MARGIN`, so at distance 0 that
  // is 550: the first two are inside it, the third is not yet.
  const set = [husk(100), husk(500), husk(4000)];
  pickups.placeSalvage({ salvage: set, distance: 0, player });
  assert.deepEqual(placed(), [100, 500]);

  // Called again with the same set and no progress: nothing is placed twice.
  pickups.placeSalvage({ salvage: set, distance: 0, player });
  assert.deepEqual(placed(), [100, 500]);

  // ...and the third arrives only once the player has driven up to it.
  pickups.placeSalvage({ salvage: set, distance: 3600, player });
  assert.deepEqual(placed(), [100, 500, 4000]);

  // A NEW SET MID-RUN is the routine case, not the exceptional one — the
  // run-start fetch is not awaited (leaderboard.js), so most runs begin on the
  // local ledger and adopt the merged set a moment later. Everything already
  // behind the player is skipped rather than dumped on the road behind them.
  const fresh = new Pickups(null, null);
  fresh.placeSalvage({ salvage: [husk(100)], distance: 0, player });
  fresh.placeSalvage({ salvage: [husk(50), husk(100), husk(9000)], distance: 3000, player });
  assert.deepEqual(
    fresh.list.map((p) => p.worldY),
    [100],
    "husks behind the player are skipped, and nothing ahead is placed early"
  );
});

test("a husk placed off the tarmac is pulled back onto it", () => {
  const pickups = new Pickups(null, null);
  const half = ROAD_HALF_WIDTH - SALVAGE_SIZE[0] / 2;
  pickups.placeSalvage({
    salvage: [{ id: "a", distance: 10, offset: 9999, credits: 1 }],
    distance: 0,
    player: { y: 400 },
  });
  assert.equal(pickups.list[0].offset, half);
});

// --- The artwork's bounds ----------------------------------------------------

test("the salvage sprite's extent covers its own footprint", () => {
  // The extent sizes the cached sprite (sprites.js's drawSalvageCached). If it
  // under-reports, the husk is silently clipped at the sprite edge — a drawing
  // bug a long way from the number that caused it, which is the same guard
  // road-and-caches.test.js gives every car and boss hull.
  const i = pickupShapeIndex("SALVAGE");
  const ext = pickupExtent(i);
  assert.deepEqual(PICKUP_SHAPES[i].size, SALVAGE_SIZE, "footprint must be the artwork's own");
  assert.ok(ext.x >= SALVAGE_SIZE[0] / 2, "x extent clips the husk");
  assert.ok(ext.up >= SALVAGE_SIZE[1] / 2, "up extent clips the husk");
  assert.ok(ext.down >= SALVAGE_SIZE[1] / 2, "down extent clips the husk");
});

test("every pickup kind has a sound", () => {
  // pickupsfx.js's own header: a kind added with no entry here collects
  // silently, with nothing to say so until someone notices in the browser.
  for (const type of PICKUP_TYPES) {
    assert.ok(PICKUP_SOUND[type.kind], `${type.id} (${type.kind}) has no sound`);
  }
});

test("receive merges remote and local into one distance-ordered set", () => {
  salvage.setStore(fakeStore());
  salvage.recordLocal({ distance: 1500, offset: 0, credits: 40 });

  const set = salvage.receive([
    { id: "a", distance: 3000, offset: 0, credits: 10 },
    { id: "b", distance: 200, offset: 0, credits: 20 },
  ]);
  assert.deepEqual(
    set.map((e) => e.distance),
    [200, 1500, 3000]
  );
  assert.equal(set.filter((e) => e.mine).length, 1);

  // A worker that answered with nothing usable must not empty the road of the
  // player's own husks.
  salvage.setStore(fakeStore());
  salvage.recordLocal({ distance: 900, offset: 0, credits: 5 });
  assert.equal(salvage.receive(undefined).length, 1);
  assert.equal(salvage.receiveNothing().length, 1);
});
