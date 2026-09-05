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
