// The shared top-10 board's client half: network and cache only, never a
// pixel drawn here. See leaderboardrender.js for the ink and nameentry.js for
// how a qualifying score's initials get collected — this module just talks to
// worker/leaderboard-worker.js and remembers the answer.
//
// CACHE, NOT SOURCE OF TRUTH. `cached` is last-known-good, read straight off
// by main.js every frame (leaderboardrender.js's draw()) and by qualifies()
// below — never awaited on the render path, since a frame cannot block on a
// fetch. It starts `null` (not `[]`) so "no board fetched yet" and "board is
// genuinely empty" stay distinguishable: qualifies() treats the former as
// "don't know, don't prompt" rather than guessing every run is a high score.
//
// FAILURES ARE SWALLOWED, deliberately: a dead worker or an offline player
// should not throw or freeze a run over a leaderboard entry, only leave the
// side panel blank and the game otherwise unaffected — see the header on
// worker/leaderboard-worker.js for what the server side does and does not
// guard against.
//
// ---------------------------------------------------------------------------
// IT CARRIES SALVAGE TOO, and this file is the ONLY place either feature
// touches the network. The endpoint is shared (worker/leaderboard-worker.js's
// header on why: both features fire at the same two moments in a run's life,
// so they share the round trip), and so the transport is shared here rather
// than duplicated in salvage.js — which owns the storage and the bookkeeping
// and deliberately knows no URL. The dependency runs one way, this file to
// that one.
//
// REFRESHED PER RUN NOW, not once at startup. The board only ever had to be
// roughly current; a run's salvage IS its content, so newGame() asks again.
// The `fetching` guard below makes the startup call and the first newGame()
// (which happens at module load) one request rather than two.

import * as salvage from "./salvage.js";

// Filled in after `npx wrangler deploy` (worker/README.md) — the one line
// this file needs edited per deployment.
const WORKER_URL = "https://cybercruise-leaderboard.bluedragoncz.workers.dev";

let cached = null;
let fetching = false;

export function getCached() {
  return cached;
}

// Fired once near startup (main.js, alongside newGame()) so the cache is
// warm long before any run could actually end — refetched again after a
// successful submit() so the side panel reflects the player's own entry
// without a second explicit call from main.js.
export async function refresh() {
  if (fetching) return;
  fetching = true;
  try {
    const res = await fetch(`${WORKER_URL}/leaderboard`);
    if (res.ok) {
      const data = await res.json();
      // BOTH SHAPES ACCEPTED. The endpoint used to answer with the bare board
      // array and now answers `{board, salvage}`; tolerating the old one means
      // the site and the worker can be deployed in either order, and a browser
      // holding a cached copy of this file never sees a broken board.
      const board = Array.isArray(data) ? data : data.board;
      if (Array.isArray(board)) cached = board;
      salvage.receive(Array.isArray(data) ? [] : data.salvage);
    } else {
      salvage.receiveNothing();
    }
  } catch {
    // Offline or worker down: `cached` stays whatever it was, and the run
    // drives the player's own local husks alone.
    salvage.receiveNothing();
  } finally {
    fetching = false;
  }
}

// Whether `points` would land on the board as it stands right now. False
// whenever `cached` is still null (see the header) — a run that ends before
// the first refresh() resolves simply doesn't get prompted, rather than
// risking a wrong guess.
export function qualifies(points) {
  if (!cached) return false;
  return cached.length < 10 || points > cached[cached.length - 1].score;
}

// EVERYTHING ONE RUN HAS TO SAY, in one request: the score (only when the run
// qualified and the player actually typed initials), the husk this run leaves
// behind, and the husks it looted on the way. Called exactly once per run,
// from main.js, at the moment the outcome is final — which is why the initials
// can ride along in the same request instead of needing a second one to attach
// them after nameentry.js resolves.
//
// Fire-and-forget from main.js's perspective: the game loop is sync and cannot
// await a POST mid-tick. Updates `cached` from the response so the side panel
// picks up the new entry the moment it lands, with no "submission pending"
// state in main.js.
//
// `name` absent is the ordinary case — most runs never qualify — and is not a
// failure of any kind; the run still leaves its husk and still reports what it
// took.
export async function postRun({ name = null, score = 0, wreck = null } = {}) {
  const collected = salvage.collectedIds();
  const body = {};
  if (name) {
    body.name = name;
    body.score = Math.floor(score);
  }
  // THE INITIALS RIDE ON THE HUSK TOO, which is the whole reason this is one
  // request instead of two: a top-ten run's husk is the one that gets a name
  // under it on the road (pickups.js), and the name only exists once
  // nameentry.js has resolved. Attached here rather than by the caller so
  // "named husk" and "board entry" cannot drift apart.
  if (wreck) body.salvage = name ? { ...wreck, name } : wreck;
  if (collected.length) body.collected = collected;
  // The worker rejects a body carrying none of the three and is right to; the
  // client should not be sending one either.
  if (Object.keys(body).length === 0) return;

  try {
    const res = await fetch(`${WORKER_URL}/leaderboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return;
    salvage.clearCollected();
    const data = await res.json();
    // Present only when this request actually changed the board — see the
    // worker's POST handler on why it does not re-read one to answer a run
    // that never submitted.
    if (Array.isArray(data?.board)) cached = data.board;
  } catch {
    // Best-effort — a failed post means this run's score never reaches the
    // shared board and the husks it looted stay standing for someone else.
  }
}
