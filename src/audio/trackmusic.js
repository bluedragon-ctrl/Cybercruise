// The recorded-track music backend — plays Ogg Vorbis files dropped into
// assets/music/ instead of synthesizing anything. The OTHER implementation
// of the same tiny interface proceduralmusic.js implements (see synth.js's
// own header): start(delaySeconds) and disturb(amount). Nothing here is
// called by any other module directly — synth.js's resolveBackend() is the
// only thing that ever touches this file's exports.
//
// --- Why only ONE track is ever held decoded ------------------------------
//
// Decoded PCM is large regardless of how small the compressed file is, and
// the real files make the point better than the arithmetic does: measured on
// the published build, chase.ogg is 2.6MB on disk and 71MB decoded, and
// under_chrome.ogg is 3.8MB and 110MB. decodeAudioData hands back the whole
// thing as one in-memory AudioBuffer — there is no streaming API to decode
// into. So decoding a whole directory up front would scale the game's
// footprint with however much music someone dropped into the folder, for a
// game whose next-largest asset is a sprite sheet.
//
// This file used to keep the current track AND the next one decoded, which
// bounded that at "two tracks" — but two tracks was still 140-220MB held for
// a whole session, plus a fresh allocation of that size (and collection of
// the outgoing one) at every handoff, mid-gameplay. So the two halves of
// "getting the next track ready" are now split apart:
//
//   BYTES are fetched ahead (prefetch()), the moment a track starts playing.
//   A few MB, parked in `encoded`, so the network is never on the critical
//   path at a handoff.
//
//   DECODING happens at the handoff itself (firstPlayableFrom), not before.
//   Steady-state memory is therefore ONE decoded track, briefly two while a
//   handoff is in flight — see evictStale(), which releases the outgoing
//   track's PCM as soon as `index` moves.
//
// THE COST IS A GAP: the next track can't start until it has decoded, which
// measures ~350-560ms per track. That is a deliberate trade, made because a
// short silence between tracks is not something this game's soundtrack needs
// to avoid — it is not crossfading, and a track boundary is already a
// natural break. If seamless handoffs ever matter more than the memory,
// decoding the stream-ahead early is what to put back.
//
// Sitting underneath both halves: tracks decode at a REDUCED SAMPLE RATE
// (musictypes.js's TRACK_DECODE_SAMPLE_RATE, via decodeAtTrackRate below),
// which halves what that one retained buffer costs in the first place.
//
// --- Two separate readiness questions --------------------------------------
//
// Backend choice is frozen once for the whole page life (synth.js). This file's
// job is to give that one-time decision an honest question to answer, and that
// takes TWO booleans, not one:
//
//   isReady()      true only once the FIRST track has finished DECODING, never
//                  "the fetch started" or "the listing came back" — both can
//                  succeed and still leave nothing playable if the decode fails
//                  (a corrupt file, an unsupported codec despite the extension).
//   isAvailable()  true once the listing has come back with at least one track
//                  not already known to have failed — answerable from the small
//                  JSON fetch alone, with no dependency on decodeAudioData.
//
// synth.js's chooseBackend() keys off isAvailable(), because waiting for
// isReady() loses the race against a player who presses START GAME promptly: the
// listing usually resolves well before that, the first decode does not. A
// backend committed to before its first buffer exists is still safe — see
// start()/attemptStart(), which awaits the SAME in-flight decode promise rather
// than re-fetching, and begins playback the moment it resolves.
//
// --- Percent-encoding -------------------------------------------------------
//
// tools/serve.js's listing endpoint returns plain, DECODED filenames (see
// its own header) — "My Track (Live).ogg", not "My%20Track...". Every fetch
// this file makes for actual track bytes has to re-encode that filename as
// a URL path segment (trackUrl() below) — spaces, parentheses and
// apostrophes are all things a file downloaded from somewhere and dropped
// into the folder will realistically contain, even though the one shipped
// sample track (under_chrome.ogg) happens not to. Decoding happens once,
// server-side, in tools/serve.js's own resolveTarget(); this file only ever
// encodes, never decodes.

import { getCtx, getMusicBus } from "./context.js";
import { MUSIC_DIR, MUSIC_LISTING_URL, TRACK_DECODE_SAMPLE_RATE, trackGainFor } from "./musictypes.js";

// --- Pure playlist logic ----------------------------------------------------
//
// Everything below this line and above "Stateful engine" takes its state as
// plain data and returns plain data — no fetch, no AudioContext, no module-
// level `let`. That split (the same one context.js's planDuck/planVoiceRequest
// already use) is what lets the invariant tests exercise shuffling, wrap
// behaviour, the stream-ahead target, and failure-skipping entirely under
// plain Node, with no fetch/decodeAudioData standing in the way.

// Fisher-Yates, with an injectable RNG so tests can drive it deterministically
// (production always uses the default Math.random). "Shuffle once per run" —
// the design brief's own phrase — means exactly that: called once, when the
// listing first resolves, producing one fixed order the run then cycles
// through; see nextIndex() below for why a fixed cyclic order already
// guarantees the wrap never repeats the previous track without needing a
// SECOND reshuffle at that boundary.
export function shuffleOrder(names, rng = Math.random) {
  const order = [...names];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// The index after `index`, wrapping. The one place "what comes next" is
// decided, shared by playback advance (handleTrackEnded) and the stream-
// ahead target (streamAheadTarget) so the two can never disagree about
// which track is "next". For >1 DISTINCT filenames this also IS the "don't
// repeat the previous track on wrap" guarantee: order[length-1] and
// order[0] are two different elements of the same permutation by
// construction, so the wrap step (index === length-1 -> 0) can never land
// on the track that just finished, with no special-casing needed here.
export function nextIndex(order, index) {
  if (order.length === 0) return 0;
  return (index + 1) % order.length;
}

// True exactly when the directory holds a single file. Web Audio's own
// AudioBufferSourceNode.loop=true is the ONLY gapless way to repeat a
// single buffer — stopping and re-starting a fresh source node on 'ended'
// re-triggers decode-to-playback latency and (per the design brief) can
// audibly gap, which defeats the entire point of a single continuous track.
export function shouldLoopSingleTrack(order) {
  return order.length === 1;
}

// What each of the two caches must hold right now — everything else in
// either is stale and gets released (see evictStale() below). The two are
// deliberately NOT the same set, and that asymmetry is the whole memory
// story: only the track actually sounding is worth holding as decoded PCM
// (tens of MB), while the one queued behind it is held as the compressed
// bytes it arrived as (a few MB) and decoded only when it's needed.
//
// `nextName` is null when there's nothing worth streaming ahead (a single-
// or zero-track directory, or every remaining track has already failed —
// see streamAheadTarget()), in which case nothing is prefetched at all.
//
// One function returning both sets rather than two functions, because this
// IS one policy — "current decoded, next compressed" — and splitting it
// would let the two halves drift into disagreeing about which track is
// which.
export function retainedTrackNames(currentName, nextName) {
  return {
    decoded: new Set([currentName].filter(Boolean)),
    encoded: new Set([nextName].filter(Boolean)),
  };
}

// The first index at or after `fromIndex` (wrapping, checked over at most
// one full lap) whose track ISN'T in `failedNames` — null if every track in
// the directory has failed to decode. `fromIndex` is INCLUSIVE on purpose:
// callers pass the track that just ended's own index +1 (via nextIndex) to
// ask "what comes after", or a target index directly to ask "is this one
// playable, and if not, where's the next one that is" — one function covers
// both because the search logic (skip failures, wrap, bail after one lap)
// is identical either way. An empty `failedNames` set (nothing has failed
// yet) makes this double as the plain "what's the next track, full stop"
// query — streamAheadTarget() below is the only caller that ever passes a
// non-empty one.
export function nextPlayableIndex(order, fromIndex, failedNames) {
  if (order.length === 0) return null;
  for (let step = 0; step < order.length; step++) {
    const idx = (fromIndex + step) % order.length;
    if (!failedNames.has(order[idx])) return idx;
  }
  return null;
}

// The result of one preload pass: the shuffled order (empty if nothing is
// playable) and whether the first track is ready to go. `fetchListing` and
// `decodeTrack` are injected async functions — production wires the real
// fetch(MUSIC_LISTING_URL) and decodeAndCache() (see preload() below); the
// invariant tests wire fakes, so "listing fetch throws", "listing is an
// empty array", and "first track fails to decode" are all exercised as
// plain async logic with no fetch/AudioContext involved at all. This is the
// pure-ish core of what both isReady() and isAvailable() below ultimately
// answer — the former from `firstTrackReady`, the latter from `order`,
// both populated straight from this function's return value.
//
// `onOrderReady`, if given, fires SYNCHRONOUSLY right after the shuffle,
// before `decodeTrack` is ever awaited — production's preload() (below)
// uses this to adopt the new `order` into module state before its own
// decodeAndCache(order[0]) call runs. That ordering still matters: the
// prefetch that follows picks its target with streamAheadTarget(), which
// reads the module-level `order`/`index` — against the OLD (empty) `order`
// there is no second track to name, and the stream-ahead would silently
// never happen, leaving every handoff to download from scratch.
//
// `onListingSettled`, if given, fires in EVERY branch below — including the
// two failure paths `onOrderReady` never reaches — the moment the listing
// question itself is answered, still before `decodeTrack` is ever awaited.
// This is what backs isAvailable()/whenListingSettled() below: "a
// soundtrack exists" is answerable from the listing alone (a small JSON
// fetch), and synth.js's jackIn() needs exactly that signal, independent of
// however long decoding the first track's several MB of Ogg still takes —
// see this module's header and synth.js's own "Music backend selection"
// section for why conflating the two cost trackmusic.js its race against
// jackIn() before this existed.
export async function runPreload({ fetchListing, decodeTrack, onOrderReady, onListingSettled, rng = Math.random }) {
  let listing;
  try {
    listing = await fetchListing();
  } catch {
    onListingSettled?.([]);
    return { order: [], firstTrackReady: false }; // network/parse failure — a normal path, not an error; see the module header
  }
  if (!Array.isArray(listing) || listing.length === 0) {
    onListingSettled?.([]);
    return { order: [], firstTrackReady: false }; // empty (or malformed) directory listing — same fallback path
  }

  const order = shuffleOrder(
    listing.map((t) => t.name),
    rng
  );
  onOrderReady?.(order);
  onListingSettled?.(order);
  const firstTrackReady = await decodeTrack(order[0]).then(
    () => true,
    () => false
  );
  return { order, firstTrackReady };
}

// --- Stateful engine ---------------------------------------------------------
//
// Everything below touches module-level state and/or the real
// fetch/AudioContext — the thin imperative shell the pure functions above
// exist to keep small. Not unit-tested directly (matches context.js's own
// duck()/setMusicCutoff() stateful wrappers, which aren't tested either —
// only their plan* counterparts are); exercised for real via the SFX
// gallery and manual playback against assets/music/under_chrome.ogg.

let order = []; // fixed once preload() resolves — see shuffleOrder's own "once per run" note
let index = 0; // which entry of `order` is currently playing (or about to)
let firstTrackReady = false; // isReady()'s backing flag — see runPreload()
let preloadPromise = null; // preload() is idempotent; this is what makes a second call a no-op join rather than a second fetch

// isAvailable()'s and whenListingSettled()'s backing state — see both
// functions below. Created eagerly at module load (not lazily inside
// preload()) so a caller that asks "is the listing known yet?" before
// preload() has ever been called still gets a promise that resolves
// correctly once it eventually is, rather than throwing or hanging on
// something that doesn't exist yet.
let resolveListingSettled;
const listingSettledPromise = new Promise((resolve) => {
  resolveListingSettled = resolve;
});

const buffers = new Map(); // name -> decoded AudioBuffer; normally just the track that's sounding — see evictStale()
const encoded = new Map(); // name -> the stream-ahead track's raw compressed bytes, waiting to be decoded at the handoff. A few MB against the tens of MB the same track costs decoded, which is the entire reason this cache exists separately from `buffers`
const decoding = new Map(); // name -> in-flight decode Promise, so a background stream-ahead and a same-track request from handleTrackEnded share one fetch instead of racing two
const prefetching = new Map(); // name -> in-flight byte fetch Promise; decodeAndCache() joins one of these rather than starting a second download of a track already on its way in
const failedTracks = new Set(); // names that have failed to decode at least once this run — nextPlayableIndex() routes around these so a permanently corrupt file isn't re-fetched every time the playlist wraps back to it

let trackFilter = null; // this backend's OWN lowpass — disturb() bends THIS, never context.js's musicFilter (see the project's own critical-constraint note: everything downstream of musicGain is off-limits)
let trackGainNode = null; // this backend's OWN trim (musictypes.js's TRACK_GAIN/overrides) — feeds context.js's getMusicBus(), same as proceduralmusic.js's voices do directly
let currentSource = null; // the currently-playing AudioBufferSourceNode — disturb() bends THIS node's .detune
let started = false; // start() is one-shot, same contract as proceduralmusic.js's own `started`

// The SYS LOG announcement's SUBSCRIBER SEAM — same shape as
// engine/console.js's own onPush (see that file's header for why the
// pattern exists at all): this file must not import console.js (an
// engine-layer, presentation-only module has no business depending on
// which audio backend is currently feeding it), so it stays ignorant of
// what, if anything, is listening. onTrackChange(fn) registers a callback
// playIndex() (below) invokes with the raw track name every time playback
// actually switches to it — main.js is what registers the real handler, at
// module scope, and turns that name into an actual console line (see its
// own onTrackChange). One subscriber, not a list, for the same reason
// console.js's seam only ever needs one.
let trackChangeSubscriber = null;

export function onTrackChange(fn) {
  trackChangeSubscriber = fn;
  return () => {
    if (trackChangeSubscriber === fn) trackChangeSubscriber = null;
  };
}

// A SECOND, separate subscriber seam — for the one failure mode start()
// can't route around: EVERY track in the directory failing to decode. Same
// single-subscriber shape as onTrackChange just above, for the same reason
// (synth.js is the only production subscriber; see its own registration).
// Deliberately distinct from onTrackChange rather than reusing it with a
// null name or similar — "a track started" and "nothing will EVER start"
// are different facts with different consequences for the listener, and
// collapsing them would make synth.js's handler guess which one just fired.
let exhaustedSubscriber = null;

export function onExhausted(fn) {
  exhaustedSubscriber = fn;
  return () => {
    if (exhaustedSubscriber === fn) exhaustedSubscriber = null;
  };
}

const TRACK_FILTER_REST = 9000; // Hz — near-transparent at rest. Unlike proceduralmusic.js's pad (deliberately dulled to 900Hz as PART of its tone), a mastered recording is expected to already carry its own frequency balance; this filter's only job is to host disturb()'s dip below.
const TRACK_DISTURB_DETUNE_CENTS = 20; // cents at amount=1 — noticeably SUBTLER than proceduralmusic.js's 45: that bend souring one pad voice among six oscillators; this one bends the WHOLE mastered mix at once, so the same cent value would read as a much bigger wobble. Tune by ear against a real track.
const TRACK_DISTURB_FILTER_DROP = 250; // Hz shaved off TRACK_FILTER_REST at amount=1 — a small, "optional" dip per the design brief, scaled down for the same reason as the detune above
const TRACK_DISTURB_RECOVER = 1.0; // seconds — matches proceduralmusic.js's own ~1s recovery, per the design brief
const GAIN_SPLICE_RAMP = 0.05; // seconds — a brief ramp on trackGainNode at every track change, so a per-track gain override (musictypes.js's TRACK_OVERRIDES) can't click at the splice; mirrors context.js's own ramp-not-snap convention throughout this file's sibling modules

function trackUrl(name) {
  // Only the filename is encoded — see the module header on why MUSIC_DIR
  // itself never needs it (a fixed, developer-authored path, not something
  // that will ever contain a space or apostrophe the way a downloaded
  // track's filename can).
  //
  // RELATIVE, with no leading slash, so the URL resolves against the page
  // rather than the domain root — that is what lets the game play its music
  // when published under a subdirectory (a GitHub Pages project site). See
  // musictypes.js's MUSIC_DIR for the full reasoning; this is the fetch that
  // would 404 on every track if the slash came back.
  return `${MUSIC_DIR}/${encodeURIComponent(name)}`;
}

// Which track (if any) should be background-decoded next, given what's
// currently playing — nextPlayableIndex() routing around `failedTracks`, so
// a background stream-ahead has no reason to keep re-fetching a name
// already known to fail on this run (unlike handleTrackEnded()'s own walk,
// which HAS to keep trying — there's nothing else left to play). Null for
// an empty or single-track directory (see shouldLoopSingleTrack — a lone
// file never needs a "next" buffer) or once every remaining track has
// already failed.
function streamAheadTarget() {
  if (order.length <= 1) return null;
  const candidate = nextPlayableIndex(order, nextIndex(order, index), failedTracks);
  return candidate === null ? null : order[candidate];
}

// Releases whatever neither cache is supposed to be holding any more.
//
// CALLED FROM playIndex(), NOT FROM decodeAndCache(), and that move is
// load-bearing now that only the CURRENT track stays decoded. Eviction
// decides what to keep by reading the module-level `index`, which still
// points at the OUTGOING track for the whole of a handoff — so running this
// mid-decode (as it used to) would look at the buffer that was just decoded
// for the track about to play, correctly conclude it isn't the current one,
// and delete it on the spot. playIndex() is the one moment `index` and
// reality agree, so that is where this belongs.
function evictStale() {
  const keep = retainedTrackNames(order[index], streamAheadTarget());
  for (const name of buffers.keys()) {
    if (!keep.decoded.has(name)) buffers.delete(name);
  }
  for (const name of encoded.keys()) {
    if (!keep.encoded.has(name)) encoded.delete(name);
  }
}

// Downloads `name`'s compressed bytes and parks them in `encoded`, WITHOUT
// decoding — the cheap half of getting a track ready. Called for the
// stream-ahead target so that when the handoff comes, the several MB of Ogg
// are already in hand and only the decode is left to do (see the module
// header on why the decode itself is no longer done ahead of time).
//
// Never throws, and never records a failure: a track that couldn't be
// PREFETCHED isn't a track that has failed to DECODE — it just isn't ready
// early, and decodeAndCache() will fetch it again at the handoff and record
// a real failure then if there is one. Marking it failed here would retire a
// track from the playlist over a single transient network blip.
function prefetch(name) {
  if (!name || encoded.has(name) || buffers.has(name)) return Promise.resolve();
  const inFlight = prefetching.get(name);
  if (inFlight) return inFlight;

  const attempt = (async () => {
    const res = await fetch(trackUrl(name));
    if (!res.ok) throw new Error(`prefetch ${name} failed: ${res.status}`);
    encoded.set(name, await res.arrayBuffer());
  })()
    .catch(() => {})
    .finally(() => prefetching.delete(name));

  prefetching.set(name, attempt);
  return attempt;
}

// Decodes `bytes` to PCM at TRACK_DECODE_SAMPLE_RATE rather than at the
// game's own output rate — see musictypes.js's constant for the measured
// numbers and the reasoning. The short version: decodeAudioData resamples to
// whatever context decodes it, so decoding in a throwaway OfflineAudioContext
// at a lower rate is what makes a track cost half the memory, and the
// resulting buffer still plays at full quality through the normal graph
// because AudioBufferSourceNode resamples on the fly.
//
// A FRESH OfflineAudioContext PER DECODE, deliberately: it exists only to
// carry a sample rate into decodeAudioData and is never started or connected
// to anything, so it is cheap, and a fresh one cannot inherit state from a
// previous decode that failed partway. Its length of 1 frame is the minimum
// the constructor accepts — nothing is ever rendered through it.
//
// FALLS BACK TO THE LIVE CONTEXT if the browser won't build an
// OfflineAudioContext at this rate (or lacks the constructor entirely). That
// costs the memory saving and nothing else — the track still decodes and
// still plays, which matters more than the footprint. Kept as a fallback
// rather than a hard requirement because this whole change is an
// optimisation; it must not become a new way for music to fail outright.
//
// ONLY THE CONSTRUCTOR IS GUARDED, not the decode, and that split is not
// cosmetic: decodeAudioData DETACHES the ArrayBuffer it is handed. Wrapping
// the decode too would mean a genuinely corrupt file failed once, then failed
// again in the fallback on a now-detached buffer — reporting "detached
// ArrayBuffer" to decodeAndCache()'s catch instead of the real decode error.
// An unsupported rate throws from the constructor with the bytes untouched,
// which is exactly the case worth retrying.
async function decodeAtTrackRate(ctx, bytes) {
  let decoder = ctx;
  try {
    decoder = new OfflineAudioContext(2, 1, TRACK_DECODE_SAMPLE_RATE);
  } catch {
    decoder = ctx; // unsupported rate or no OfflineAudioContext — decode natively
  }
  return await decoder.decodeAudioData(bytes);
}

// Decodes `name` and caches the result, or records it in `failedTracks` —
// never throws. Dedupes against an in-flight decode of the SAME name (the
// background stream-ahead and handleTrackEnded's own "make sure the next
// buffer is ready" check can both ask for the same track close together;
// this makes the second ask join the first fetch instead of starting a
// second one).
function decodeAndCache(name) {
  if (buffers.has(name)) return Promise.resolve();
  const inFlight = decoding.get(name);
  if (inFlight) return inFlight;

  const attempt = (async () => {
    const ctx = getCtx();
    // Join an in-flight prefetch of this same track rather than racing a
    // second download of it — the stream-ahead usually IS the track being
    // asked for here, arriving early enough to still be downloading when a
    // short track ends.
    const pending = prefetching.get(name);
    if (pending) await pending;

    // Taking the bytes REMOVES them from the cache, and that is not just
    // tidiness: decodeAudioData detaches the ArrayBuffer it is handed, so
    // anything that fished the same entry out afterwards would be holding a
    // zero-length husk. One owner, taken exactly once.
    let arrayBuffer = encoded.get(name);
    if (arrayBuffer) {
      encoded.delete(name);
    } else {
      const res = await fetch(trackUrl(name));
      if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`);
      arrayBuffer = await res.arrayBuffer();
    }

    buffers.set(name, await decodeAtTrackRate(ctx, arrayBuffer));
  })()
    .catch(() => {
      // A failed decode is SKIPPED, not fatal — see the module header and
      // handleTrackEnded()/nextPlayableIndex() below, which route around any
      // name in `failedTracks`.
      failedTracks.add(name);
    })
    .finally(() => decoding.delete(name));

  decoding.set(name, attempt);
  return attempt;
}

function buildTrackChain(ctx, musicBus) {
  trackFilter = ctx.createBiquadFilter();
  trackFilter.type = "lowpass";
  trackFilter.frequency.value = TRACK_FILTER_REST;

  trackGainNode = ctx.createGain();
  trackGainNode.gain.value = 0; // set for real by playIndex()'s own ramp, immediately after this runs

  trackFilter.connect(trackGainNode);
  trackGainNode.connect(musicBus);
}

function playIndex(i, delaySeconds) {
  const name = order[i];
  const buffer = buffers.get(name);
  if (!buffer) return; // defensive only — every caller (start(), handleTrackEnded()) confirms the buffer is decoded before reaching here; see their own comments

  const ctx = getCtx();
  const musicBus = getMusicBus();
  if (!trackFilter) buildTrackChain(ctx, musicBus);

  const t = ctx.currentTime;
  const targetGain = trackGainFor(name);
  trackGainNode.gain.cancelScheduledValues(t);
  trackGainNode.gain.setValueAtTime(trackGainNode.gain.value, t);
  trackGainNode.gain.linearRampToValueAtTime(targetGain, t + GAIN_SPLICE_RAMP);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const loopSingle = shouldLoopSingleTrack(order);
  source.loop = loopSingle;
  source.connect(trackFilter);

  if (!loopSingle) {
    source.onended = () => {
      if (source !== currentSource) return; // a stale 'ended' from a source already superseded — same defensive pattern disturb() below uses
      handleTrackEnded();
    };
  }

  source.start(ctx.currentTime + Math.max(0, delaySeconds));
  currentSource = source;
  index = i;

  // Every call to playIndex() is a track actually starting to sound — the
  // FIRST one (start(), on jackIn()) and every mid-run HANDOFF
  // (handleTrackEnded(), below) alike, since both funnel through here and
  // nowhere else ever calls this. That's what makes one call site enough
  // to cover "at first play and at every handoff" — see onTrackChange's own
  // header above.
  trackChangeSubscriber?.(name);

  if (!loopSingle) {
    // Only the BYTES are fetched ahead now, not the decoded audio — the
    // decode happens at the next handoff (see firstPlayableFrom). That is
    // what keeps one decoded track in memory instead of two.
    prefetch(streamAheadTarget());
  }

  // AFTER `index` was updated above, so this sees the track that is actually
  // playing — see evictStale()'s own header on why nowhere else will do.
  // This is the moment the outgoing track's decoded PCM is released.
  evictStale();
}

// Walks forward from `fromIndex` (INCLUSIVE) through the playlist — via
// nextPlayableIndex, which already skips anything in `failedTracks` —
// decoding as needed, until it finds a track that's actually playable or
// the whole playlist has been exhausted. Shared by handleTrackEnded() (every
// handoff after the first) and attemptStart() below (the first track,
// which — under the new availability-based selection — might still be
// decoding, or might already have failed, by the time start() is called):
// both are "find the next thing that will actually make sound starting from
// here", differing only in what each does once it's found one (or found
// none) — see their own callers.
async function firstPlayableFrom(fromIndex) {
  let from = fromIndex;
  for (let step = 0; step < order.length; step++) {
    const candidate = nextPlayableIndex(order, from, failedTracks);
    if (candidate === null) return null; // every remaining track has failed to decode
    const name = order[candidate];
    if (!buffers.has(name)) await decodeAndCache(name);
    if (buffers.has(name)) return candidate;
    from = nextIndex(order, candidate); // that one just failed on THIS attempt — resume the search past it
  }
  return null;
}

// Called from the just-finished source's own 'onended'. If literally every
// remaining track has failed, this simply stops — an edge case past what
// the design brief asks for (a whole directory of corrupt files), not one
// synth.js falls back to procedural for mid-run (see its own header on why
// backend swaps never happen after start() once something has audibly
// played — unlike attemptStart()'s own exhaustion path below, which fires
// BEFORE anything has played and is handled differently for exactly that
// reason).
async function handleTrackEnded() {
  const candidate = await firstPlayableFrom(nextIndex(order, index));
  if (candidate === null) return;
  playIndex(candidate, 0);
}

// Commits to actually starting playback, from whatever state the first
// track happens to be in when start() (below) is called — this is the
// piece that makes availability-based selection (synth.js may now choose
// "track" while the first buffer is STILL DECODING, or even before its
// decode has been attempted at all) safe: it doesn't assume readiness the
// way the old ready-gated start() did.
//
// `targetTime` is an ABSOLUTE ctx.currentTime, fixed once at the top of
// start() (see below) — NOT a relative delay recomputed on every await.
// That's what keeps the first note landing exactly `delaySeconds` after
// start() was called (in sync with the jack_in riser — see synth.js's own
// jackIn()) even though decodeAndCache() below may await for a while: every
// resumption re-reads ctx.currentTime and re-subtracts it from the SAME
// fixed target, so waiting longer only ever shrinks the remaining gap
// (floored at 0 — the note plays as soon as it can, rather than going
// negative and trying to schedule a source in the past), never re-bases it.
async function attemptStart(targetTime) {
  const candidate = await firstPlayableFrom(index);
  if (candidate === null) {
    // EVERY track in the directory failed to decode. The freeze contract
    // (see synth.js's header) forbids swapping backends mid-run because an
    // audible jump from one already-sounding thing to another reads as a
    // bug — but nothing has sounded yet here; start() was called, this
    // backend was chosen, and it turned out to have nothing playable at
    // all. That's not a mid-run swap, it's the primary choice failing to
    // pan out before it ever produced anything — so synth.js's
    // onExhausted() subscriber (registered once, at module scope) is
    // free to actually start the procedural backend as a last resort
    // rather than leaving the run silent, which is a worse bug than the
    // one this whole mechanism exists to avoid. See synth.js's own
    // onExhausted handler for the fallback and its console logging.
    exhaustedSubscriber?.();
    return;
  }
  playIndex(candidate, Math.max(0, targetTime - getCtx().currentTime));
}

// Fetches the listing and decodes the first track, exactly once per page
// life — called from synth.js's startContext() as soon as the AudioContext
// exists, so the menu screen's own idle time (see that module's header) is
// what a track gets decoded during, well before START GAME needs an answer.
// Idempotent: a second call (there isn't one in production, but this stays
// safe against ever adding one) joins the same in-flight/settled promise
// rather than re-fetching.
export function preload() {
  if (preloadPromise) return preloadPromise;
  preloadPromise = runPreload({
    fetchListing: async () => {
      const res = await fetch(MUSIC_LISTING_URL);
      if (!res.ok) throw new Error(`listing fetch failed: ${res.status}`);
      return res.json();
    },
    // Adopt the order into module state BEFORE the decode below runs — see
    // runPreload()'s own header on why the timing matters here.
    onOrderReady: (newOrder) => {
      order = newOrder;
      index = 0;
    },
    // Unblocks whenListingSettled() (and, through it, isAvailable() readers
    // like synth.js's jackIn()) the moment the listing question is
    // answered — success or failure alike — without waiting on the decode
    // below. resolveListingSettled is idempotent (a Promise executor's
    // resolve is a no-op after the first call), which matters here only in
    // that it makes this safe to reason about even though runPreload()
    // guarantees a single call anyway.
    onListingSettled: () => resolveListingSettled(),
    decodeTrack: (name) => decodeAndCache(name),
  }).then((result) => {
    firstTrackReady = result.firstTrackReady;
    prefetch(streamAheadTarget()); // pull the SECOND track's bytes in early — see the module header on why only its bytes, and never more than one ahead
  });
  return preloadPromise;
}

// True only once the FIRST track has actually finished decoding (not
// "fetch started", not "listing succeeded" — see runPreload()); false for
// every other state. Kept exactly as-is — other call sites (the SFX
// gallery's introspection) and the invariant tests still depend on this
// meaning "fully ready to play," distinct from isAvailable() below.
// synth.js's resolveBackend() no longer reads this to choose a backend
// (see isAvailable()) — decode readiness and soundtrack availability are
// different questions now; see this module's header and synth.js's own
// "Music backend selection" section for why conflating them was the bug.
export function isReady() {
  return firstTrackReady;
}

// True once the directory listing has come back with at least one track
// that hasn't (yet) permanently failed to decode. THIS is what synth.js's
// chooseBackend() now consumes, via resolveBackend(): "a soundtrack exists"
// is answerable from the listing alone — a small JSON fetch, typically long
// resolved before the player has navigated the menu and confirmed START
// GAME — without waiting for several MB of Ogg to finish decoding. Before
// the listing has settled, `order` is still its initial empty array, so
// this correctly (and harmlessly) reads as "not available yet" — callers
// that need to distinguish "not available" from "not known yet" use
// whenListingSettled() below instead of polling this.
//
// `failedTracks.size < order.length` only matters once every remaining
// track has actually been attempted and failed (see attemptStart()'s own
// exhaustion path) — in the common case this check runs (right when the
// listing arrives, or shortly after), failedTracks is still empty, so this
// reduces to the simple "order.length > 0" the requirement describes.
export function isAvailable() {
  return order.length > 0 && failedTracks.size < order.length;
}

// Resolves once the listing fetch has settled, one way or another — success
// with tracks, success but empty, or failure alike (see runPreload()'s
// onListingSettled). Exists so synth.js's jackIn() can await "is the
// availability answer known yet?" with its own bounded timeout, rather than
// polling isAvailable() (which can't distinguish "genuinely no soundtrack"
// from "listing fetch hasn't come back yet" — both read as `false`). Safe
// to call before preload() has ever run — see listingSettledPromise's own
// declaration above for why.
export function whenListingSettled() {
  return listingSettledPromise;
}

// Part of the two-backend interface (see the module header). Under the new
// availability-based selection, synth.js may commit to this backend well
// before the first track has finished decoding — sometimes before its
// decode has even been attempted — so this can no longer just check
// firstTrackReady and bail. attemptStart() (above) does the real work:
// it reuses whatever decode of order[index] is already in flight (the
// `decoding` map dedupes against decodeAndCache()'s own fetch, so this
// never starts a second one), plays as soon as that resolves, and — if it
// fails — walks forward through the rest of the playlist exactly like a
// mid-run handoff would. `targetTime` is fixed HERE, once, from the real
// ctx.currentTime at the moment start() is actually called, so a long wait
// inside attemptStart() shrinks the remaining gap rather than re-basing it
// off whatever ctx.currentTime happens to be when the decode finally
// resolves — see attemptStart()'s own header.
export function start(delaySeconds = 0.1) {
  if (started) return;
  started = true;
  attemptStart(getCtx().currentTime + delaySeconds);
}

// Part of the two-backend interface. See the module header on why the
// bend/dip here are noticeably smaller than proceduralmusic.js's own
// disturb() — this one warps the entire mastered mix, not one voice among
// several.
export function disturb(amount) {
  if (!currentSource || !trackFilter) return; // nothing sounding yet — mirrors proceduralmusic.js's own "no pad currently sounding" no-op
  const ctx = getCtx();
  const t = ctx.currentTime;
  const clamped = Math.max(0, Math.min(1, amount));

  currentSource.detune.cancelScheduledValues(t);
  currentSource.detune.setValueAtTime(currentSource.detune.value, t);
  currentSource.detune.linearRampToValueAtTime(-clamped * TRACK_DISTURB_DETUNE_CENTS, t + 0.05);
  currentSource.detune.linearRampToValueAtTime(0, t + 0.05 + TRACK_DISTURB_RECOVER);

  trackFilter.frequency.cancelScheduledValues(t);
  trackFilter.frequency.setValueAtTime(trackFilter.frequency.value, t);
  trackFilter.frequency.linearRampToValueAtTime(Math.max(400, TRACK_FILTER_REST - clamped * TRACK_DISTURB_FILTER_DROP), t + 0.05);
  trackFilter.frequency.linearRampToValueAtTime(TRACK_FILTER_REST, t + 0.05 + TRACK_DISTURB_RECOVER);
}

// Dev-only introspection for the SFX gallery's A/B panel (src/demo/
// sfxgallery.js) — lets it show which track is actually playing without
// the gallery having to duplicate this module's own shuffle/advance state.
// Not part of the two-backend interface (synth.js never calls this) and not
// meant to be — a query, not a control.
export function currentTrackName() {
  return order[index] ?? null;
}
