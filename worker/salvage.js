// SALVAGE — the server half of "the road remembers who died on it".
//
// A run that ends leaves a husk of the player's car (src/game/salvageshape.js)
// at the distance it died at, carrying a cut of the credits that run had
// earned. Every later run, by anybody, drives past it and can loot it. This
// file owns the storage; leaderboard-worker.js owns the HTTP around it and
// src/game/salvage.js is the client half.
//
// WHY DISTANCE IS THE SHARED AXIS, and the city is not. worldseed.js re-salts
// the world every run, so no two players ever drive the same buildings — but
// they all drive the same NUMBER. Placing by distance means the mechanic works
// with no seed sharing at all, and "someone died at 2,400m" is a fact both
// runs agree on. This is the question salvageshape.js's header left open.
//
// WHY ONE KV KEY PER SALVAGE, where the leaderboard is one key holding one
// array. The board is a value: ten rows rewritten wholesale, and its header
// accepts that two racing POSTs can lose one insert near the cutoff. Salvage
// cannot accept that. Every run both reads the set AND writes to it (one new
// husk, plus a delete for each one looted), so a single shared key would have
// concurrent runs clobbering each other's inserts and deletes — the failure
// mode being other players' salvage vanishing, or looted salvage resurrecting,
// rather than one lost row. Distinct keys never contend: a put and a delete
// from two different runs both land.
//
// WHY THE PAYLOAD IS IN KV METADATA AND THE VALUE IS EMPTY. list() returns
// each key's metadata with it, so a whole run's worth of salvage is ONE read
// operation with no per-key get() behind it — which is the entire reason a
// per-key layout is affordable here. Metadata is capped at 1024 bytes; a
// record is four small fields, nowhere near it.
//
// KEY FORMAT: `s:<band>:<distance>:<id>`, both numbers zero-padded so the
// lexical order KV lists in IS distance order, free. The band is repeated in
// the key rather than derived, because it is what makes a BAND a prefix — and
// a band being listable on its own is what makes the per-band cap below one
// list instead of a full scan.
//
// TWO BOUNDS ON THE STORE, doing different jobs:
//
//   PER-BAND CAP  most runs die early, so without it the first kilometre
//                 becomes a junkyard while the tail stays empty. Capped per
//                 500-unit band, evicting that band's oldest, the road stays
//                 populated the whole way out instead of front-loaded.
//   TTL           a band nobody ever drives to again would otherwise hold its
//                 salvage forever. Expiry is free (KV does it, no write op)
//                 and keeps the set recent rather than archival.
//
// NO ANTI-CHEAT, exactly as the leaderboard's header says of itself. The
// magnitude checks in sanitizeSalvage() are a GARBAGE FILTER — wrong types,
// absurd numbers, an offset off the tarmac — not a balance cap. A direct
// request can still plant a rich husk. The payout rate that turns `credits`
// into money is the client's catalogue number (src/game/pickuptypes.js) and is
// deliberately not enforced here: this endpoint stores what it is told a run
// was worth, and nothing more.

const PREFIX = "s:";
const BAND = 500; // world units per band — see PER-BAND CAP above
const BAND_DIGITS = 5; // bands 0..99999, i.e. out to 50,000,000 units
const DIST_DIGITS = 8;
const ID_CHARS = 8;
// Eight husks per 500 units is one every 60 units at worst, against a road 286
// wide (ROAD_HALF_WIDTH * 2, src/game/road.js) — dense enough that a busy band
// reads as a graveyard, sparse enough that it never walls the road off. Not
// measured against real road time yet; the first number here to revisit once
// there is some.
const MAX_PER_BAND = 8;
const TTL = 30 * 24 * 60 * 60; // seconds
// KV's own list() page size. Nothing paginates: with the per-band cap above,
// 1000 keys is 125 fully-packed bands, and a player who outdrives that has
// gone further than any salvage worth showing them.
const LIST_LIMIT = 1000;
// Bounds the delete work one request can ask for. A run collecting more than
// this many husks is not a run, it is someone hammering the endpoint.
const MAX_COLLECTED = 64;

// Garbage filters, not balance numbers — see the header. MAX_CREDITS mirrors
// the board's own MAX_SCORE for the same reason it exists there.
const MAX_CREDITS = 10_000_000;
const MAX_DISTANCE = BAND * 10 ** BAND_DIGITS - 1;
// ROAD_HALF_WIDTH is 143 (src/game/road.js); this is generous slack around it
// rather than the figure itself, since tying the two would make a road-width
// change silently reject husks already in the store.
const MAX_OFFSET = 400;
const MAX_NAME_LEN = 3;
const NAME_CHARS = /[^A-Z0-9 ]/g;

const KEY_RE = new RegExp(
  `^${PREFIX}\\d{${BAND_DIGITS}}:\\d{${DIST_DIGITS}}:[0-9a-z]{${ID_CHARS}}$`
);

function pad(n, digits) {
  return String(n).padStart(digits, "0");
}

export function salvageKey(distance, id) {
  const band = Math.floor(distance / BAND);
  return `${PREFIX}${pad(band, BAND_DIGITS)}:${pad(distance, DIST_DIGITS)}:${id}`;
}

export function bandPrefix(distance) {
  return `${PREFIX}${pad(Math.floor(distance / BAND), BAND_DIGITS)}:`;
}

function newId() {
  let id = "";
  for (let i = 0; i < ID_CHARS; i++) id += Math.floor(Math.random() * 36).toString(36);
  return id;
}

// Coerces an untrusted `salvage` field into `{distance, offset, credits, name}`
// or returns null. `name` is optional and absent for the overwhelming majority
// of husks: only a run that qualified for the board was ever asked for
// initials (src/game/nameentry.js), so an anonymous husk is the normal case
// and a named one is the trophy.
export function sanitizeSalvage(body) {
  if (!body || typeof body !== "object") return null;
  const distance = Math.floor(Number(body.distance));
  if (!Number.isFinite(distance) || distance < 0 || distance > MAX_DISTANCE) return null;
  const offset = Math.round(Number(body.offset));
  if (!Number.isFinite(offset) || Math.abs(offset) > MAX_OFFSET) return null;
  const credits = Math.floor(Number(body.credits));
  if (!Number.isFinite(credits) || credits < 0 || credits > MAX_CREDITS) return null;

  const record = { distance, offset, credits };
  if (typeof body.name === "string") {
    const name = body.name.toUpperCase().replace(NAME_CHARS, "").slice(0, MAX_NAME_LEN);
    if (name.length > 0) record.name = name;
  }
  return record;
}

// Which of `keys` a fresh insert into the same band has to evict to stay under
// MAX_PER_BAND. Oldest first, by the `t` metadata every record is written
// with; a record without one sorts as oldest, so anything hand-made or
// pre-dating the field goes before anything that can be dated.
export function evictions(keys, cap = MAX_PER_BAND) {
  const over = keys.length + 1 - cap;
  if (over <= 0) return [];
  return [...keys]
    .sort((a, b) => (a.metadata?.t ?? 0) - (b.metadata?.t ?? 0))
    .slice(0, over)
    .map((k) => k.name);
}

// Keeps only the ids that could have come from salvageKey(). Deleting is the
// one operation a request can ask to perform on keys it did not create, so the
// shape is checked rather than trusted — a `collected` list naming "top10"
// would otherwise wipe the leaderboard.
export function sanitizeCollected(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((k) => typeof k === "string" && KEY_RE.test(k)).slice(0, MAX_COLLECTED);
}

// Every husk currently on the road, as `{id, distance, offset, credits, name?}`
// — `id` being the KV key itself, which is what the client hands back in
// `collected` when it loots one. One list() call, no gets: see the header.
export async function readSalvage(env) {
  const { keys } = await env.LEADERBOARD.list({ prefix: PREFIX, limit: LIST_LIMIT });
  const out = [];
  for (const key of keys) {
    const m = key.metadata;
    // A key with no usable metadata is half-written or hand-made. Skipped
    // rather than defaulted, since a husk with a guessed payout is worse than
    // no husk.
    if (!m || typeof m.c !== "number" || typeof m.d !== "number") continue;
    const entry = { id: key.name, distance: m.d, offset: m.o ?? 0, credits: m.c };
    if (m.n) entry.name = m.n;
    out.push(entry);
  }
  return out;
}

// Writes one husk, evicting its band's oldest first if the band is full.
// Metadata keys are one letter each: this is a fixed private shape read only
// by readSalvage() above, and the 1024-byte metadata budget is better spent on
// headroom than on spelling four field names out per record.
export async function writeSalvage(env, record, now = Date.now()) {
  const { keys } = await env.LEADERBOARD.list({ prefix: bandPrefix(record.distance) });
  await Promise.all(evictions(keys).map((k) => env.LEADERBOARD.delete(k)));

  const metadata = { d: record.distance, o: record.offset, c: record.credits, t: now };
  if (record.name) metadata.n = record.name;
  const key = salvageKey(record.distance, newId());
  await env.LEADERBOARD.put(key, "", { metadata, expirationTtl: TTL });
  return key;
}

// Removes the husks a run looted. A key already gone — another run got there
// first, in the window between the two reading the list — deletes as a no-op,
// which is the correct outcome and not worth distinguishing.
export function deleteSalvage(env, ids) {
  return Promise.all(ids.map((id) => env.LEADERBOARD.delete(id)));
}

export const SALVAGE_LIMITS = {
  BAND,
  MAX_PER_BAND,
  TTL,
  LIST_LIMIT,
  MAX_COLLECTED,
  MAX_CREDITS,
  MAX_OFFSET,
  MAX_DISTANCE,
};
