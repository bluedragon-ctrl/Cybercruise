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
//
// ONE DELIBERATE EXCEPTION: kill_enemy and kill_neutral's shard partials
// (sfx.js's generateKillEnemy/generateKillNeutral) run up to ~6-7kHz —
// reworked into a genuine glass-shatter ring after review, against a
// reference example, and the one place in the catalogue this ceiling is
// knowingly crossed. Every other entry still obeys it.

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

  // --- Phase 8 step 2: combat --------------------------------------------
  //
  // The deck reporting on the world, not the world itself — see the design
  // brief main.js's combat call sites are wired against (Phase 8 step 2's
  // task description): a discharge, a confirm tone, a fault, never an
  // engine note or a metal crunch. Every generator lives in sfx.js.
  //
  // PRIORITY LADDER, highest to lowest, and it is deliberate about what gets
  // evicted first when the GLOBAL_VOICE_CAP (context.js) is full mid-fight:
  // kill_neutral (the one penalty sound that must never be swallowed) >
  // kill_enemy/kill_obstacle (the kills) > the player's own weapons >
  // fire_enemy (incoming fire the player can survive missing) >
  // weapon_swap/dry_fire (pure UI, correct to lose first).
  //
  // DUCK: 0 on pure UI (weapon_swap/dry_fire) — a menu tick pumping the
  // music would read as a mixing bug, not a UI cue. Everything that fires a
  // round or lays a hazard gets a LIGHT duck (0.08-0.15) — see the mix
  // rebalance note below for why that changed from an initial 0, and
  // MAX_DUCK_DB (context.js) for why the dip is now worth having at all.
  // The kills get a heavier one; kill_neutral the heaviest of all, because
  // it is the one combat sound meant to visibly push the music aside for a
  // moment.
  //
  // MIX REBALANCE (post-review): SFX was found to read too quiet against
  // MUSIC at 100/100 — the music bus routinely sums several simultaneous
  // voices (music.js's pad alone is six detuned oscillators through one
  // gain stage) where every combat sound here is a single one-shot, so raw
  // gain values below were bumped catalogue-wide and weapon fire — which
  // previously never ducked at all — was given a small duck so a shot
  // reads even mid-passage rather than relying on level alone.
  {
    id: "fire_blaster",
    generator: null, // sfx.js's registerGenerator("fire_blaster", ...)
    gain: 0.85, // raised from 0.7 in the mix rebalance — see the header note above
    duck: 0.12, // a light poke so tap-fire still reads mid-passage; see the header note above
    delaySend: 0, // "Dry" — a capacitor discharge doesn't echo
    priority: 6, // player weapons tier
    maxConcurrent: 3, // several rounds can be in flight/overlap under rapid tapping
    // JUST UNDER THE CANNON'S OWN 0.16s FIRE INTERVAL (weapons.js's "cannon").
    // isDown("fire") holds this weapon capable of firing every frame it's
    // ready, so without a floor here every shot's own attack transient would
    // fight the voice limiter — see the catalogue header's own note on this
    // exact entry.
    minInterval: 0.14,
  },
  {
    id: "fire_rocket",
    generator: null, // sfx.js's registerGenerator("fire_rocket", ...)
    gain: 0.95, // the heaviest hand weapon in the game — reads louder than the tap-fire cannon; raised in the mix rebalance
    duck: 0.15, // the deepest weapon duck — the heaviest hand weapon earns the biggest poke
    delaySend: 0,
    priority: 6,
    maxConcurrent: 2, // the rocket's own 0.35s reload rarely has more than one in flight
    minInterval: 0.1,
  },
  {
    id: "fire_tracker",
    generator: null, // sfx.js's registerGenerator("fire_tracker", ...)
    gain: 0.8, // quieter than the blaster per-round — the tracker's identity is the BURST, not one loud hit; raised in the mix rebalance
    // Lighter than the other guns' — this fires up to 8x in one burst, and
    // planDuck's max-not-stack rule means a whole burst still only dips the
    // music ONCE to this depth, not eight times, but a smaller number here
    // keeps the burst from reading as one long continuous duck either.
    duck: 0.08,
    delaySend: 0,
    priority: 6,
    maxConcurrent: 3,
    // UNDER THE TRACKER'S OWN 0.05s burstInterval (weapons.js's "tracker"),
    // for the same reason the blaster's floor sits under ITS interval — an
    // 8-round burst must still sound like 8 rounds, not get thinned into 2
    // or 3 by its own sound effect.
    minInterval: 0.04,
  },
  {
    id: "mine_placed",
    generator: null, // sfx.js's registerGenerator("mine_placed", ...)
    gain: 0.7, // raised in the mix rebalance
    duck: 0.08, // a light poke, same reasoning as the guns above — still an armed action
    delaySend: 0,
    priority: 6, // sits with the player's other weapons — laying a mine is still an armed action
    maxConcurrent: 2,
    minInterval: 0.15, // under the mine's own 1s reload, spikes' 2.5s — just a spam floor
  },
  {
    id: "weapon_swap",
    generator: null, // sfx.js's registerGenerator("weapon_swap", ...)
    gain: 0.5, // quiet — this is a UI tick, not a weapon report; still nudged up in the mix rebalance so it doesn't vanish entirely
    duck: 0,
    delaySend: 0, // "Fully dry" per the brief
    priority: 4, // UI tier, lowest of the combat group — correct to lose a steal in a firefight
    maxConcurrent: 2,
    minInterval: 0.05, // TAB/E are edge-triggered (consumePress), but a defensive floor costs nothing
  },
  {
    id: "dry_fire",
    generator: null, // sfx.js's registerGenerator("dry_fire", ...)
    gain: 0.55, // raised in the mix rebalance
    duck: 0,
    delaySend: 0,
    priority: 4, // UI tier — a refusal losing to real combat sounds is correct
    maxConcurrent: 1, // one refusal reads; two overlapping would just be a buzz
    // THE FLOOR THAT MATTERS MOST HERE, ALONGSIDE fire_blaster's. main.js
    // calls play("dry_fire") every frame the player holds fire against an
    // empty weapon — isDown("fire") never edge-triggers — so without a wide
    // floor a held trigger on an empty gun would machine-gun this exactly
    // the way an unthrottled fire_blaster would. Sized in whole seconds
    // rather than a fraction, because "one refusal, not sixty" (the design
    // brief's own words) means the player should hear it once per attempt,
    // not once per frame.
    minInterval: 0.6,
  },
  {
    id: "fire_enemy",
    generator: null, // sfx.js's registerGenerator("fire_enemy", ...)
    gain: 0.7, // quieter than the player's own blaster — this is background threat, not the player's own report; raised in the mix rebalance
    duck: 0.08, // a small poke — incoming fire should register even mid-passage, not just the player's own shots
    delaySend: 0,
    priority: 5, // between the player's weapons and the UI tier
    maxConcurrent: 3, // several hostiles can bear at once (trail/pursue/gunner packs)
    // LOW ON PURPOSE: every hostile gun in the game (blaster, smg, missile —
    // weapons.js's ENEMY_WEAPON_TYPES) collapses onto this ONE sound id (see
    // audio/weaponsfx.js), so a real floor here would mean two DIFFERENT
    // cars shooting a fraction of a second apart lose one of their reports
    // to the other. maxConcurrent and the global voice cap are what thin a
    // real firefight; this only stops one car's own burst weapon (smg)
    // machine-gunning itself.
    minInterval: 0.03,
  },
  {
    id: "kill_enemy",
    generator: null, // sfx.js's registerGenerator("kill_enemy", ...)
    gain: 1, // MAXED in the mix rebalance — this and kill_neutral were flagged as hard to notice against music at 100/100
    duck: 0.4, // deepened alongside the gain bump — "something landed" should be unmissable, not a small dip
    delaySend: 0, // a process being killed, not a fireball with a trailing echo
    priority: 8, // kills tier
    maxConcurrent: 4, // a rocket's splash or a mine's chain can drop several cars in one tick
    // A CHAIN-KILL FLOOR, not a rapid-fire one. traffic.js's `exploded` sweep
    // can detonate several cars in the SAME tick (the ctx.currentTime a
    // blast chain reads is effectively identical across all of them), so
    // without this every car in a chain would still physically sound at
    // once regardless of maxConcurrent (voice-stealing only stops the
    // BOOKKEEPING from overflowing, it can't un-start an oscillator that's
    // already playing — see context.js's voice limiter header). This is
    // what actually thins the chain, per the task's own instruction to rely
    // on maxConcurrent/minInterval rather than inventing call-site
    // suppression.
    minInterval: 0.08,
  },
  {
    id: "kill_obstacle",
    generator: null, // sfx.js's registerGenerator("kill_obstacle", ...)
    gain: 0.8, // a shade under kill_enemy — a roadblock breaking matters less than a kill; raised in the mix rebalance
    duck: 0.2,
    delaySend: 0,
    priority: 7, // kills tier, just under kill_enemy
    maxConcurrent: 3,
    minInterval: 0.08, // same chain-thinning reasoning as kill_enemy above, nudged for its own slightly longer 340ms tail
  },
  {
    id: "kill_neutral",
    generator: null, // sfx.js's registerGenerator("kill_neutral", ...)
    // THE MOST DISTINCTIVE CALL IN THE DESIGN — see the task brief's own
    // words: "it should sound like you did something wrong." Its generator
    // is now, per review, the SAME glass-shatter shape as kill_enemy's (see
    // sfx.js's generateKillNeutral for why that's a deliberate code
    // duplication rather than a shared call) — so what actually makes THIS
    // entry read as the one that matters is everything below: the deepest
    // duck of any combat sound, the catalogue's only real delaySend, and
    // the highest priority of the group. The distinction moved from the
    // waveform into the mix.
    gain: 1, // MAXED in the mix rebalance, alongside kill_enemy — see that entry's own note
    duck: 0.75, // the largest duck of any combat sound, deepened further — the only one meant to be truly unmissable
    delaySend: 0.5, // "high, so it hangs over the next bar" — the one combat sound allowed to trail
    priority: 9, // highest of the combat group — must never lose a voice slot to a kill or a weapon
    maxConcurrent: 1, // a second overlapping penalty tone would blur into noise, not read as two fines
    // Killing a second civilian a beat later must get its OWN full,
    // unmuddied penalty tone, not a note stacked on top of the first one's
    // tail — that's what this floor is for, sized against the generator's
    // own ~520ms length.
    minInterval: 0.25,
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
