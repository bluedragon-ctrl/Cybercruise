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
    if (res.ok) cached = await res.json();
  } catch {
    // Offline or worker down: `cached` stays whatever it was.
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

// Fire-and-forget from main.js's perspective — the game loop is sync and
// cannot await a POST mid-tick. Updates `cached` from the response so the
// side panel picks up the new entry the moment it lands, with no extra state
// in main.js to track "submission pending".
export async function submit(name, points) {
  try {
    const res = await fetch(`${WORKER_URL}/leaderboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, score: Math.floor(points) }),
    });
    if (res.ok) cached = await res.json();
  } catch {
    // Best-effort — a failed submit just means this run's score never
    // reaches the shared board.
  }
}
