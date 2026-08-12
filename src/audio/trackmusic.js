// The recorded-track music backend — plays Ogg Vorbis files dropped into
// assets/music/ instead of synthesizing anything. The OTHER implementation
// of the same tiny interface proceduralmusic.js implements (see synth.js's
// own header): start(delaySeconds) and disturb(amount). Nothing here is
// called by any other module directly — synth.js's resolveBackend() is the
// only thing that ever touches this file's exports.
//
// --- Why decoding is streamed one track ahead, never the whole directory ---
//
// Decoded PCM is large regardless of how small the compressed file is: a
// 3-minute stereo track at 44.1kHz decodes to roughly 3*60*44100*2*4 bytes
// (Float32, 2 channels) — about 60MB for THAT ONE TRACK, and decodeAudioData
// hands back the whole thing as one in-memory AudioBuffer, no streaming API
// involved. Decoding an entire multi-track directory up front the moment the
// context exists would mean the game's memory footprint scales with however
// much music someone has dropped into the folder, for a game that today has
// no other asset anywhere near that size. Instead: decode the CURRENT track
// and, in the background, the NEXT one — see decodeAndCache()/evictStale()
// below — so memory stays bounded at "two tracks decoded" no matter how many
// files exist, and the background decode has an entire track's playback
// time (minutes) to finish before it's actually needed.
//
// --- Why backend selection can't be redone mid-run ------------------------
//
// See synth.js's own header for the full reasoning (backend choice is
// frozen there, once, for the whole page life). What THIS file is
// responsible for is making sure synth.js's ONE-TIME readiness check
// (isReady(), below) is honest: it only ever reports true once the FIRST
// track has actually finished decoding, never "the fetch started" or "the
// listing came back" — those can both succeed and still leave the game with
// nothing playable if the decode itself fails (a corrupt file, an
// unsupported codec despite the .ogg extension).
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
import { MUSIC_DIR, MUSIC_LISTING_URL, trackGainFor } from "./musictypes.js";

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

// The set of track names that must stay decoded right now — everything else
// in the buffer cache is stale and gets released (see evictStale() below).
// `nextName` is null when there's nothing worth streaming ahead (a single-
// or zero-track directory, or every remaining track has already failed —
// see streamAheadTarget()), in which case only the current track is kept.
export function retainedTrackNames(currentName, nextName) {
  return new Set([currentName, nextName].filter(Boolean));
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
// pure-ish core of what synth.js's isReady() ultimately answers.
//
// `onOrderReady`, if given, fires SYNCHRONOUSLY right after the shuffle,
// before `decodeTrack` is ever awaited — production's preload() (below)
// uses this to adopt the new `order` into module state before its own
// decodeAndCache(order[0]) call runs. That ordering matters:
// decodeAndCache()'s own evictStale() reads the module-level `order`/
// `index` to decide what's safe to keep, and it runs mid-decode — if it ran
// against the OLD (empty) `order` instead, it would treat the buffer it
// just finished decoding as stale and delete it on the spot.
export async function runPreload({ fetchListing, decodeTrack, onOrderReady, rng = Math.random }) {
  let listing;
  try {
    listing = await fetchListing();
  } catch {
    return { order: [], firstTrackReady: false }; // network/parse failure — a normal path, not an error; see the module header
  }
  if (!Array.isArray(listing) || listing.length === 0) {
    return { order: [], firstTrackReady: false }; // empty (or malformed) directory listing — same fallback path
  }

  const order = shuffleOrder(
    listing.map((t) => t.name),
    rng
  );
  onOrderReady?.(order);
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

const buffers = new Map(); // name -> decoded AudioBuffer; kept to at most {current, next} — see evictStale()
const decoding = new Map(); // name -> in-flight decode Promise, so a background stream-ahead and a same-track request from handleTrackEnded share one fetch instead of racing two
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
  return `/${MUSIC_DIR}/${encodeURIComponent(name)}`;
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

function evictStale() {
  const keep = retainedTrackNames(order[index], streamAheadTarget());
  for (const name of buffers.keys()) {
    if (!keep.has(name)) buffers.delete(name);
  }
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
    const res = await fetch(trackUrl(name));
    if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    buffers.set(name, audioBuffer);
    evictStale();
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
    const ahead = streamAheadTarget();
    if (ahead) decodeAndCache(ahead);
  }
}

// Called from the just-finished source's own 'onended'. Walks forward
// through the playlist (via nextPlayableIndex, which already skips anything
// in `failedTracks`) until it finds a track that's already decoded or can
// be decoded in time, and plays it back to back with no gap. If literally
// every remaining track has failed, this simply stops — an edge case past
// what the design brief asks for (a whole directory of corrupt files), not
// one synth.js falls back to procedural for mid-run (see its own header on
// why backend swaps never happen after start()).
async function handleTrackEnded() {
  let from = nextIndex(order, index);
  for (let step = 0; step < order.length; step++) {
    const candidate = nextPlayableIndex(order, from, failedTracks);
    if (candidate === null) return; // every remaining track has failed to decode
    const name = order[candidate];
    if (!buffers.has(name)) await decodeAndCache(name);
    if (buffers.has(name)) {
      playIndex(candidate, 0);
      return;
    }
    from = nextIndex(order, candidate); // that one just failed on THIS attempt — resume the search past it
  }
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
    decodeTrack: (name) => decodeAndCache(name),
  }).then((result) => {
    firstTrackReady = result.firstTrackReady;
    const ahead = streamAheadTarget();
    if (ahead) decodeAndCache(ahead); // stream the SECOND track in ahead of time too — see the module header on why never more than one ahead
  });
  return preloadPromise;
}

// synth.js's resolveBackend() reads this ONCE, at the moment anything first
// asks the facade to actually start playing, to decide track vs.
// procedural — see that module's own header for the freeze. True only once
// the FIRST track has actually finished decoding (not "fetch started", not
// "listing succeeded" — see runPreload()); false for every other state,
// which is exactly "not ready yet", "listing failed", and "directory empty"
// collapsed into the one boolean synth.js's chooseBackend() consumes.
export function isReady() {
  return firstTrackReady;
}

// Part of the two-backend interface (see the module header). A no-op if
// called before preload() has produced a playable first track — synth.js's
// resolveBackend() is what's supposed to prevent that in practice (it only
// ever selects this backend when isReady() is already true), but this stays
// defensive rather than throwing, matching every other entry point in this
// audio layer's own no-throw contract.
export function start(delaySeconds = 0.1) {
  if (started) return;
  started = true;
  if (!firstTrackReady) return;
  playIndex(index, delaySeconds);
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
