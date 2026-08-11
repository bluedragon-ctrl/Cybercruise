// The SFX GAMEPLAY catalogue — what each sound effect IS, as data, mirroring
// the project's established catalogue convention (see game/pickuptypes.js and
// game/obstacletypes.js: gameplay data lives in one file, keyed by id, and a
// separate file does the actual work). Adding sound #2 through #30 in a later
// pass means one entry here plus one generator function in sfx.js — nothing
// about mixing, ducking or voice-stealing needs to change, because play() in
// sfx.js already reads all of that off this table.
//
// Fields:
//   id            stable key call sites use — main.js will call play("disconnect")
//                 the same way it calls music.playDisconnect() today
//   generator     function (ctx, dest, time, opts) => duration (seconds) that
//                 builds the voice. Starts out `null` here — see the note
//                 below on why this file never imports sfx.js — and is filled
//                 in by sfx.js's registerGenerator() as soon as that module
//                 loads, which always happens before anything can call play()
//   gain          per-sound mix level (0..1), applied by sfx.js's play() to a
//                 gain node the generator is handed as `dest` — the
//                 generator never has to know its own level
//   duck          0..1 — how hard this sound ducks the music bus (0 = none).
//                 See context.js's duck()/planDuck() for the max-not-stack
//                 rule this feeds
//   delaySend     0..1 — send level into the shared feedback delay
//                 (context.js's getDelay()). 0 = dry only
//   priority      integer — used by the voice limiter (context.js) when the
//                 global voice cap is full and something has to be evicted.
//                 Higher survives; ties favour whichever is already playing
//   maxConcurrent cap on simultaneous instances of this id; a request over
//                 the cap steals this id's own oldest instance
//   minInterval   seconds — a retrigger of this id sooner than this after its
//                 last one is dropped outright, before it even competes for a
//                 voice slot. What keeps a rapid-fire weapon's SFX from
//                 machine-gunning the voice limiter every frame
//
// WHY `generator` STARTS NULL. sfx.js needs this catalogue (to look entries
// up by id in play()), and this file needs sfx.js's generator functions — a
// straight two-way import would be circular. Rather than lean on ES module
// hoisting to make that safe (fragile: it only works if every generator stays
// a hoisted `function` declaration and nobody "simplifies" one into a
// `const` arrow later), the dependency runs ONE way: sfx.js imports this
// file, defines its generator functions, and calls registerGenerator() once
// per sound as it loads. This file only ever WRITES to `generator` through
// that one function — nothing here calls a generator directly.
//
// CONSTRAINTS THE WHOLE ~30-SOUND CATALOGUE SHARES, worth knowing before
// writing a new generator even though nothing here enforces them yet:
// no tonal content above ~1.5kHz, noise rolled off above ~5kHz, and every
// sound sits in one of four bands — 30-70Hz impacts/sub, 70-200Hz bass &
// weapons, 200-600Hz pad & UI ticks, 600Hz-2kHz noise textures. A narrow palette
// on purpose: thirty sounds that each grabbed their own slice of the spectrum
// would turn into noise the moment three overlap.

export const SOUND_TYPES = [
  {
    id: "disconnect",
    generator: null, // filled in by sfx.js's registerGenerator("disconnect", ...) — see the header
    gain: 1, // routes at full sfxGain level, same as the old synth.js's playDisconnect did
    duck: 0, // the player is already frozen in "dying" when this fires — nothing left to duck out of the way of it
    delaySend: 0, // a dying signal trailing into an echo would read as it recovering, not dying — kept dry
    priority: 10, // the single most important sound in the game so far: the run just ended
    maxConcurrent: 1, // only one player, only one death at a time
    minInterval: 0, // never retriggered rapidly — newGame()'s own pacing is the only thing that could call this again
  },
];

// One named sound type. Mirrors obstacletypes.js's obstacleTypeById /
// pickuptypes.js's pickupTypeById exactly.
export function soundTypeById(id) {
  return SOUND_TYPES.find((t) => t.id === id) ?? null;
}

// Called once per sound by sfx.js as it defines each generator — see the
// header's note on why the dependency runs this direction. A no-op if `id`
// isn't in the catalogue, which should only ever happen if sfx.js and this
// file's ids have drifted apart (caught by the invariant test that every
// catalogue entry ends up with a real generator function).
export function registerGenerator(id, fn) {
  const entry = soundTypeById(id);
  if (entry) entry.generator = fn;
}
