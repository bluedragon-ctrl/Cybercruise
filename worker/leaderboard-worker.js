// The shared top-10 leaderboard — a Cloudflare Worker over one KV key.
//
// WHY A SERVER AT ALL. src/game/score.js computes a run's score client-side,
// and until now nothing outside the browser ever saw it (README's Phase 13).
// A SHARED board needs a server for the obvious reason (players don't share a
// browser), and that server is also the first thing in this game's life that
// the client cannot simply lie to — see `sanitize()` below for how much of
// that this actually buys.
//
// WHY ONE KV KEY HOLDING ONE JSON ARRAY, not one KV entry per score. Ten
// scores is not a dataset — it is a value. Storing it as ten separately-keyed
// entries would mean a GET reads and sorts up to ten keys and a POST still has
// to read all of them to know if it's cut a place, for no benefit this size
// never reaches. One key means one GET and one PUT per request, full stop.
// The trade-off that buys: KV is eventually consistent, so two POSTs racing
// on the same key can both read the pre-update list and one write clobbers
// the other's insert. Accepted — the failure mode is "a submission near the
// cutoff occasionally doesn't stick," not data corruption, and a Durable
// Object would trade that for real complexity this board doesn't warrant.
//
// WHY ONE RECORD PER NAME. Without it the board is "whoever resubmits most,"
// not "whoever is best" — a player mashing RECONNECT after every run would
// eventually own every one of the ten rows. A submission only replaces its
// name's existing row when the new score is higher; a lower repeat is
// dropped, not appended.
//
// WHAT THIS DOES NOT DO. No anti-cheat: `sanitize()` below rejects garbage
// (wrong types, absurd magnitudes, characters the client's own vector font
// can't draw) but does not — cannot, statelessly — verify a score was
// actually earned by playing. A `curl` straight at this endpoint can still
// plant a fake entry. Real anti-cheat (signed run replays, server-side
// simulation) is a different, much larger project than "lightweight."
//
// CORS is wide open (`*`) on purpose: this is a public leaderboard, read AND
// write, for a game with no accounts. Restricting the origin would stop
// browser JS on other sites from calling it, but does nothing against a
// direct request with no Origin header at all — so it would add a false
// sense of protection for zero real one. Not pretended otherwise.
//
// ---------------------------------------------------------------------------
// IT ALSO CARRIES SALVAGE, and the path is a historical name. `/leaderboard`
// is now the RUN endpoint: one GET when a run starts, one POST when it ends,
// each carrying both the board and the salvage set (salvage.js, which owns the
// storage and explains the per-key layout). Two features, one round trip each
// way, because they fire at exactly the same two moments in a run's life and
// splitting them would double the request count for nothing. Renaming the path
// would break every deployed client for a tidier URL; not worth it.
//
// GET'S RESPONSE SHAPE CHANGED, from the bare array to `{board, salvage}`.
// src/game/leaderboard.js accepts both, so the site can be deployed before
// this worker and keep working either way round.

import {
  deleteSalvage,
  readSalvage,
  sanitizeCollected,
  sanitizeSalvage,
  writeSalvage,
} from "./salvage.js";

const KV_KEY = "top10";
const MAX_ENTRIES = 10;
const MAX_NAME_LEN = 3;
const NAME_CHARS = /[^A-Z0-9 ]/g;
// Not derived from cartypes.js/score.js's tuning — this is a garbage filter,
// not a balance number, and tying it to the catalogues would make a tuning
// pass silently change what the leaderboard accepts. Comfortably past
// anything a real run can reach today in either direction; revisit only if
// that stops being true.
//
// MIN_SCORE IS NEGATIVE, deliberately: src/game/score.js's own header says
// the total is NOT clamped at zero — a run that massacres civilians early can
// sit in the red until the distance term digs it back out — so a leaderboard
// that only accepted non-negative scores would reject a run the game itself
// considers a valid, if bad, result. (Caught by a submission from a real
// negative-scoring run getting silently 400'd — src/game/leaderboard.js's
// submit() only surfaces network failures, not rejected ones, so this needs
// to actually accept what the client can legitimately send.)
const MAX_SCORE = 10_000_000;
const MIN_SCORE = -10_000_000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function readBoard(env) {
  const raw = await env.LEADERBOARD.get(KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBoard(env, board) {
  return env.LEADERBOARD.put(KV_KEY, JSON.stringify(board));
}

// Coerces an untrusted POST body into `{name, score}` or returns null if it
// can't be made sane. NAME_CHARS strips to the same charset the client's
// vector font can draw (src/engine/vectorfont.js's GLYPHS) — a name with a
// character neither side can render would silently vanish from one screen
// and not the other.
function sanitize(body) {
  if (!body || typeof body.name !== "string") return null;
  const name = body.name.toUpperCase().replace(NAME_CHARS, "").slice(0, MAX_NAME_LEN);
  if (name.length === 0) return null;
  const score = Math.floor(Number(body.score));
  if (!Number.isFinite(score) || score < MIN_SCORE || score > MAX_SCORE) return null;
  return { name, score };
}

// Upserts `entry` into `board` (one record per name — see the header),
// re-sorts descending, and trims to MAX_ENTRIES.
function applyEntry(board, entry) {
  const existing = board.findIndex((e) => e.name === entry.name);
  if (existing >= 0) {
    if (entry.score <= board[existing].score) return board; // lower repeat: dropped
    board = board.filter((_, i) => i !== existing);
  }
  board = [...board, entry].sort((a, b) => b.score - a.score).slice(0, MAX_ENTRIES);
  return board;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/leaderboard") return new Response("Not found", { status: 404 });

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    if (request.method === "GET") {
      const [board, salvage] = await Promise.all([readBoard(env), readSalvage(env)]);
      return json({ board, salvage });
    }

    // ONE POST PER RUN, carrying up to three independent things: the score
    // (only when the run qualified and the player typed initials), the husk it
    // leaves behind, and the husks it looted. Each is optional and each is
    // applied on its own — a run that scored nothing still leaves salvage, and
    // a run that looted nothing still posts its own. The one case rejected
    // outright is a body carrying NONE of the three, which is a client bug
    // worth hearing about rather than a no-op worth accepting.
    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }

      // `name`/`score` are optional now — an absent pair is the normal shape
      // for the ~90% of runs that never reach nameentry.js. Only a pair that
      // is PRESENT and unusable is an error, so a garbage score still can't
      // slip onto the board unnoticed.
      const submitting = body.name !== undefined || body.score !== undefined;
      const entry = submitting ? sanitize(body) : null;
      if (submitting && !entry) return json({ error: "invalid name/score" }, 400);

      const salvage = body.salvage !== undefined ? sanitizeSalvage(body.salvage) : null;
      if (body.salvage !== undefined && !salvage) return json({ error: "invalid salvage" }, 400);

      const collected = sanitizeCollected(body.collected);
      if (!entry && !salvage && collected.length === 0) return json({ error: "empty run" }, 400);

      // The board is read-modify-written and the salvage keys are not, so only
      // the board half is serialised; the rest runs alongside it.
      const work = [];
      if (salvage) work.push(writeSalvage(env, salvage));
      if (collected.length) work.push(deleteSalvage(env, collected));

      let board = null;
      if (entry) {
        board = applyEntry(await readBoard(env), entry);
        work.push(writeBoard(env, board));
      }
      await Promise.all(work);

      // The updated board comes back so the game-over screen shows the
      // player's own row without a second call — and ONLY when this request
      // actually changed it, since re-reading it to answer a run that never
      // submitted would spend a KV read to tell the client what it already
      // knows. The salvage set never comes back at all: the run that posted is
      // over, and the next one reads it fresh on GET.
      return json(board ? { board } : {});
    }

    return json({ error: "method not allowed" }, 405);
  },
};
