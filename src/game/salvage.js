// Salvage — the client's record of who died where, and which husks this run
// has already looted. Storage and bookkeeping only: not one pixel is drawn
// here, nothing is placed on the road here, and NOTHING IS FETCHED HERE.
// worker/salvage.js is the server half and explains the storage; pickups.js
// puts the husks on the tarmac, salvageshape.js draws them, and leaderboard.js
// owns every byte that crosses the network for both features (its own header:
// network and cache only). That split is why this file has no WORKER_URL in
// it and no fetch to go with one — a second module knowing the endpoint would
// make "the one line this file needs edited per deployment" two lines.
//
// THE LOCAL HALF, and why it exists. Two problems share one answer:
//
//   DAY ONE     an empty store means the mechanic is invisible until enough
//               strangers have died, which is the worst possible introduction
//               for the one feature that has to be noticed to be understood.
//   OFFLINE     a player with no network would never see salvage at all, and
//               the game is otherwise entirely playable without one.
//
// So a run's own death is recorded in localStorage as well as posted, and run
// start merges the local husks with the remote ones. The player's own wrecks
// are always on the road, immediately, network or no network. That is also the
// answer to the question salvageshape.js's header left open — "your own
// previous death this session OR a seed shared through the leaderboard worker"
// turns out to be both, for less machinery than either alone would need in
// order to be good.
//
// LOCAL HUSKS ARE NOT ANONYMOUS the way remote ones are: the player knows
// which car is theirs, so a local husk carries `mine: true`. A local id is
// `local:<n>` and can never collide with a worker key — worker/salvage.js's
// KEY_RE rejects that shape, so a local id can also never be sent as a delete
// target by a confused client.
//
// COLLECTED IDS ARE HELD, NOT SENT AS THEY HAPPEN. Looting is a per-frame
// event and a run posts exactly once, at the end (main.js). A run that never
// gets to post — the tab closed, a dead network — leaves those husks standing,
// which is the right failure of the two available: salvage resurrecting is a
// smaller wrong than salvage vanishing for everybody.

const STORE_KEY = "cybercruise.salvage";

// How many of the player's own past husks the browser keeps. Small on purpose:
// this is the garnish that guarantees the road is never empty, not a second
// copy of the shared set, and an unbounded ledger would eventually have a solo
// player driving through nothing but their own past mistakes.
const LOCAL_KEEP = 6;

// The browser's own store, or null where there isn't one (a Node test, a
// browser with storage blocked). Same guard wallet.js's own storage() uses,
// for the same reason: this degrades to "no local husks", never to a throw.
function storage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let store = storage();
let cached = null; // last-known-good merged set; null until the first receive
let collected = []; // ids looted this run, sent at run end

// For tests: swap in a localStorage-shaped object. Passing null is "no store",
// which is exactly the offline/blocked case.
export function setStore(next) {
  store = next;
  cached = null;
  collected = [];
}

// Read straight off the game loop, so it answers `[]` rather than null before
// the first run — pickups.js has nothing to decide when the set is unknown,
// unlike leaderboard.js's qualifies(), which does.
export function getCached() {
  return cached ?? [];
}

// --- The local ledger --------------------------------------------------------

// The player's own past husks. Tolerates every shape the key can be corrupted
// into — hand-edited, half-written, left over from an older format — by
// answering `[]`: a broken local ledger is a reason to see fewer husks and
// never a reason for the game not to start.
export function readLocal() {
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(STORE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e) =>
        e &&
        typeof e.id === "string" &&
        Number.isFinite(e.distance) &&
        Number.isFinite(e.credits)
    );
  } catch {
    return [];
  }
}

function writeLocal(list) {
  if (!store) return;
  try {
    store.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    // Quota, private mode, storage switched off mid-session: the run still
    // posted to the worker, so the husk itself is not lost — only this
    // browser's copy of it.
  }
}

// Appends one husk and trims to the newest LOCAL_KEEP. A no-op with no store,
// returning what the ledger actually holds afterwards (nothing) rather than
// the list it would have written — a caller that believed the return would
// otherwise think the husk was kept.
export function recordLocal(record, now = Date.now()) {
  if (!store) return [];
  const list = readLocal();
  list.push({ ...record, id: `local:${now}-${list.length}`, mine: true });
  const kept = list.slice(-LOCAL_KEEP);
  writeLocal(kept);
  return kept;
}

// Forgets a local husk once it has been looted. Local salvage is consumed on
// collect exactly as remote salvage is — the mechanic is that a husk is looted
// once — and since this ledger is one browser's alone there is no race to lose
// and nothing worth deferring to run end.
export function forgetLocal(id) {
  writeLocal(readLocal().filter((e) => e.id !== id));
}

// --- The set this run drives through -----------------------------------------

// Remote husks and local ones as one distance-ordered list. Exported for the
// test suite, the only caller that cares about the halves separately.
export function merge(remote, local) {
  return [...(Array.isArray(remote) ? remote : []), ...local].sort(
    (a, b) => a.distance - b.distance
  );
}

// Hands this run its set — called by leaderboard.js when the run-start GET
// lands, with whatever the worker sent. A run that starts before it resolves
// simply has no remote husks for a fraction of a second, which costs nothing:
// every husk is placed AHEAD of the player, and the player is at distance 0.
export function receive(remote) {
  cached = merge(remote, readLocal());
  return cached;
}

// The offline path: the worker never answered, so the player drives their own
// husks rather than an empty road. Does not overwrite a set already received —
// a failed refresh mid-session must not throw away a good one.
export function receiveNothing() {
  if (!cached) cached = readLocal();
  return cached;
}

// --- Per-run bookkeeping -----------------------------------------------------

export function beginRun() {
  collected = [];
}

// One husk looted.
export function markCollected(id) {
  if (typeof id !== "string") return;
  if (id.startsWith("local:")) {
    forgetLocal(id);
    return;
  }
  if (!collected.includes(id)) collected.push(id);
}

export function collectedIds() {
  return collected;
}

// Called by leaderboard.js once the run-end POST has actually landed. Sent is
// sent: whatever happens next in this session, the same deletes must not go
// out twice.
export function clearCollected() {
  collected = [];
}
