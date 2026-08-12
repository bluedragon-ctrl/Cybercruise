// The SFX generator functions, plus play(id, opts) — the single entry point
// every future call site uses to trigger a catalogued sound (soundtypes.js).
// play() is the piece that turns a catalogue entry into an actual Web Audio
// voice: it asks context.js's voice limiter for a slot, builds this sound's
// own little gain/delay-send subgraph off the shared buses, ducks the music
// if asked to, and only then calls the generator. Everything about MIXING a
// sound lives here, once — a new generator function never has to know about
// gain, ducking, delay sends or voice stealing; it just builds oscillators/
// noise into the `dest` node it's handed and reports how long it runs.
//
// A GENERATOR'S CONTRACT: `(ctx, dest, time, opts) => durationSeconds`.
//   ctx      the live AudioContext (context.js's getCtx()) — never null here,
//            play() already checked before calling in
//   dest     a GainNode already at this sound's catalogue `gain` level and
//            already connected to sfxGain (and, if delaySend > 0, already
//            tapped into the shared delay too) — connect straight to this,
//            nothing else
//   time     when this voice should start — ctx.currentTime plus
//            opts.startDelay if the caller passed one (see play() below)
//   opts     whatever play()'s caller passed through, generator-specific
//   returns  how many seconds this voice needs before it's silent — the ONE
//            piece of information context.js's voice limiter can't know on
//            its own (see its header on why the slot API is two steps)
//
// opts.startDelay (seconds, default 0) is the ONE field play() itself reads
// rather than passing straight through to the generator — Phase 8 step 5's
// disconnect polish (synth.js's playDisconnect()) uses it to schedule
// generateDisconnect's own static to begin exactly context.js's
// DISCONNECT_FADE seconds after the music has already started fading to
// silence, so the drop lands in a hole rather than under still-audible
// music. Nothing else in the catalogue needs this today, but it costs
// nothing to have available generically rather than one-off plumbing
// through a `disconnect`-specific code path.

import {
  isStarted, getCtx, getSfxBus, getDelay, getNoiseBuffer,
  duck, requestVoice, commitVoiceDuration,
} from "./context.js";
import { soundTypeById, registerGenerator } from "./soundtypes.js";
import { CONSOLE_SOUND, CONSOLE_PITCH } from "./consolesfx.js";

// --- Generators ----------------------------------------------------------

// The player's own connection dropping (game/disconnect.js) — a TV
// SWITCHING OFF, replacing an earlier "static under a dying carrier" design
// after review. The fiction shifts slightly with it: less "the signal is
// losing lock somewhere out on the line" and more "the deck itself just
// powered down" — still not an explosion thump, still because the car isn't
// destroyed, the LINK is (see disconnect.js's header), just a different take
// on what that failure sounds like.
//
// FOUR BEATS, front-loaded into the first ~200ms rather than spread across
// the whole duration the way the earlier design's slow noise decay was:
//   1. a relay CLICK — the physical "chunk" of the set actually powering
//      down, first and sharpest thing heard
//   2. the picture COLLAPSING — a fast downward sweep (triangle, 1300→45Hz
//      over 160ms) standing in for the horizontal deflection dying
//   3. the bright CENTRE DOT — one short high tick (still under the
//      catalogue's ~1.5kHz tonal ceiling) the instant the collapse finishes
//   4. near silence — a faint 55Hz mains hum, well under everything above,
//      fading out across the REST of the duration below rather than true
//      dead air, so "the set is off" reads against a bare trace of residual
//      hum instead of nothing at all
//
// STILL 1.35s total — load-bearing, unchanged from the earlier design: it
// has to trail out to roughly disconnect.js's CAR_GLITCH_END (~1.4s into its
// 2.6s sequence), not a generic short "hit" length, so the voice limiter
// frees this slot right as the visual sequence's own glitch beat ends, even
// though almost all of the AUDIBLE content now sits in the first 200ms.
function generateDisconnect(ctx, dest, t) {
  // 1. The relay click.
  const click = ctx.createBufferSource();
  click.buffer = getNoiseBuffer();
  const clickBand = ctx.createBiquadFilter();
  clickBand.type = "bandpass";
  clickBand.frequency.value = 180;
  clickBand.Q.value = 4;
  const clickGain = ctx.createGain();
  clickGain.gain.setValueAtTime(0.5, t);
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
  click.connect(clickBand).connect(clickGain).connect(dest);
  click.start(t);
  click.stop(t + 0.02);

  // 2. The picture collapsing.
  const collapseStart = t + 0.01;
  const sweep = ctx.createOscillator();
  sweep.type = "triangle";
  sweep.frequency.setValueAtTime(1300, collapseStart);
  sweep.frequency.exponentialRampToValueAtTime(45, collapseStart + 0.16);
  const sweepGain = ctx.createGain();
  sweepGain.gain.setValueAtTime(0.001, collapseStart);
  sweepGain.gain.exponentialRampToValueAtTime(0.4, collapseStart + 0.01);
  sweepGain.gain.exponentialRampToValueAtTime(0.001, collapseStart + 0.16);
  sweep.connect(sweepGain).connect(dest);
  sweep.start(collapseStart);
  sweep.stop(collapseStart + 0.18);

  // 3. The bright centre dot.
  const dotStart = collapseStart + 0.15;
  const dot = ctx.createOscillator();
  dot.type = "triangle";
  dot.frequency.value = 1400;
  const dotGain = ctx.createGain();
  dotGain.gain.setValueAtTime(0.001, dotStart);
  dotGain.gain.exponentialRampToValueAtTime(0.3, dotStart + 0.004);
  dotGain.gain.exponentialRampToValueAtTime(0.001, dotStart + 0.02);
  dot.connect(dotGain).connect(dest);
  dot.start(dotStart);
  dot.stop(dotStart + 0.025);

  // 4. The residual hum, trailing under the rest of the visual sequence.
  const hum = ctx.createOscillator();
  hum.type = "sine";
  hum.frequency.value = 55;
  const humGain = ctx.createGain();
  humGain.gain.setValueAtTime(0.001, t);
  humGain.gain.setValueAtTime(0.001, dotStart + 0.03);
  humGain.gain.linearRampToValueAtTime(0.03, dotStart + 0.1);
  humGain.gain.exponentialRampToValueAtTime(0.001, t + 1.35);
  hum.connect(humGain).connect(dest);
  hum.start(t);
  hum.stop(t + 1.36);

  return 1.35;
}

registerGenerator("disconnect", generateDisconnect);

// --- Phase 8 step 2: combat -----------------------------------------------
//
// Nine generators for soundtypes.js's combat entries. The shared fiction
// (see that file's own header on this group): the player is jacked into a
// VR deck, the car is a representation, and every one of these is what the
// DECK emits about an event, never the event's own physical sound — a
// discharge, a confirm tone, a fault. No tonal content climbs above
// ~1.5kHz anywhere below, and every noise burst is band-passed or low-
// passed well under 5kHz, per the design brief both files answer to.

// The player's default gun (weapons.js's "cannon") discharging — a
// capacitor releasing, not a gunshot. The saw sweeping DOWN in 40ms is what
// reads as a discharge rather than a note: a synth "pew" holds or rises in
// pitch, a capacitor dumping its charge drops away as it empties.
// Lowpassed at 650Hz — TIGHTER than a first pass at 800Hz — to keep the
// saw's upper harmonics (a sawtooth is harmonically the brightest wave
// available) well clear of the ~1.5kHz ceiling the whole catalogue is held
// to, and to make the shot itself read as SNAPPIER: a shorter envelope
// (40ms vs. 60) and a tighter filter is what separates "a tap-fire weapon"
// from "a single deliberate hit" at a glance — this is the tap-fire one.
// The 10ms noise click layered under it is the contact make — the instant
// the discharge actually leaves the muzzle — bandpassed at 500Hz with a
// narrower Q than a first pass, so it reads as a harder tick.
function generateFireBlaster(ctx, dest, t) {
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(380, t);
  osc.frequency.exponentialRampToValueAtTime(140, t + 0.04);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 650;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.001, t);
  g.gain.exponentialRampToValueAtTime(0.6, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
  osc.connect(lp).connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + 0.05);

  const click = ctx.createBufferSource();
  click.buffer = getNoiseBuffer();
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 500;
  band.Q.value = 4;
  const clickGain = ctx.createGain();
  clickGain.gain.setValueAtTime(0.28, t);
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.01);
  click.connect(band).connect(clickGain).connect(dest);
  click.start(t);
  click.stop(t + 0.015);

  return 0.05;
}

registerGenerator("fire_blaster", generateFireBlaster);

// The player's rocket (weapons.js's "rocket") leaving the rail — the
// heaviest hand weapon, so this is the blaster's discharge gesture
// stretched and weighted, but PUNCHIER than a first pass rather than
// slower: 260ms with a lighter resonance (Q3, not a screaming Q6-9) reads
// as a tighter, harder launch instead of a long wind-up, which matches a
// weapon that only takes 0.35s to reload — the sound shouldn't outlast the
// gap between shots. The lowpass still sweeps down with the pitch so the
// filter audibly closes around the discharge, and a short noise tail
// stands in for the burn rather than a second transient — the launch keeps
// making noise for a beat after the tone has gone, the way a real rocket
// motor's thrust outlasts its own ignition crack, just a shorter beat here.
function generateFireRocket(ctx, dest, t) {
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(200, t);
  osc.frequency.exponentialRampToValueAtTime(75, t + 0.26);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 3; // lighter resonance than a first pass — a tighter launch, not a scream
  lp.frequency.setValueAtTime(750, t);
  lp.frequency.exponentialRampToValueAtTime(140, t + 0.26);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.001, t);
  g.gain.exponentialRampToValueAtTime(0.58, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
  osc.connect(lp).connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + 0.27);

  const tail = ctx.createBufferSource();
  tail.buffer = getNoiseBuffer();
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 550;
  band.Q.value = 1; // tighter than a first pass — a crisper burn, not a wide hiss
  const tailGain = ctx.createGain();
  tailGain.gain.setValueAtTime(0.001, t);
  tailGain.gain.exponentialRampToValueAtTime(0.18, t + 0.05);
  tailGain.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
  tail.connect(band).connect(tailGain).connect(dest);
  tail.start(t);
  tail.stop(t + 0.28);

  return 0.28;
}

registerGenerator("fire_rocket", generateFireRocket);

// The tracker (weapons.js's "tracker") — the blaster's own discharge body,
// PLUS a 4-tick triangle figure around 180-220Hz, faster and busier than a
// first pass's 3 ticks. The body is what tells the player "this is player
// gunfire"; the ticking figure on top is the one thing that tells them
// it's THIS gun rather than the cannon — a seeking round audibly checking
// its lock, not a second weapon's worth of new material. A 4th tick and a
// tighter 25ms spacing (down from 30) is what pushes it from "settling"
// into "actively seeking" — busier ticking reads as more alert. Reuses
// generateFireBlaster wholesale rather than duplicating its envelope, so a
// future retune of the shared discharge body only has to happen once.
function generateFireTracker(ctx, dest, t) {
  const bodyDuration = generateFireBlaster(ctx, dest, t);

  const tickFreqs = [180, 220, 195, 205]; // busier climb/settle than a straight run
  let end = bodyDuration;
  tickFreqs.forEach((freq, i) => {
    const start = t + 0.015 + i * 0.025;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, start);
    g.gain.exponentialRampToValueAtTime(0.28, start + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, start + 0.018);
    osc.connect(g).connect(dest);
    osc.start(start);
    osc.stop(start + 0.023);
    end = Math.max(end, start + 0.023 - t);
  });

  return end;
}

registerGenerator("fire_tracker", generateFireTracker);

// A mine or spike strip being laid (weapons.js's "mine"/"spikes", both
// dropped through main.js's dropMine) — ONE triangle note gliding
// 200→150Hz over 100ms, a console acknowledging a command rather than a
// weapon discharging at all. A single continuous glide reads as one
// unbroken acknowledgement tone rather than two stepped notes — simpler
// and cleaner than a first pass's two-note figure, and still nothing like
// the fire_* sounds above: the player didn't just release something
// outward, they told the car to leave something behind, and the confirm
// tone should read as an acknowledgement, not a shot.
function generateMinePlaced(ctx, dest, t) {
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(200, t);
  osc.frequency.exponentialRampToValueAtTime(150, t + 0.1);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.001, t);
  g.gain.exponentialRampToValueAtTime(0.4, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + 0.12);
  return 0.12;
}

registerGenerator("mine_placed", generateMinePlaced);

// TAB/E cycling the loadout (main.js's consumePress("swap")/("deploy")) —
// two DESCENDING triangle blips (240→180Hz), a relay throwing. Triangle
// rather than a first pass's square, and descending rather than
// ascending: a softer waveform and a falling contour read as a settle
// ("selection made") rather than an alert, which is the right register for
// a sound that fires on every single TAB/E press regardless of whether
// anything about the road just changed. Deliberately dry (no delaySend)
// and quiet (soundtypes.js's gain) — this is the one combat-adjacent sound
// that is pure UI and should never compete for the player's attention
// against anything actually happening on the road.
function generateWeaponSwap(ctx, dest, t) {
  const notes = [
    { freq: 240, start: 0 },
    { freq: 180, start: 0.035 },
  ];
  for (const n of notes) {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = n.freq;
    const g = ctx.createGain();
    const s = t + n.start;
    g.gain.setValueAtTime(0.001, s);
    g.gain.exponentialRampToValueAtTime(0.22, s + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, s + 0.035);
    osc.connect(g).connect(dest);
    osc.start(s);
    osc.stop(s + 0.04);
  }
  return 0.075;
}

registerGenerator("weapon_swap", generateWeaponSwap);

// A trigger pull that spends no round (main.js: weapon.tryFire() withheld
// because the weapon is empty) — TWO short HARD-GATED squares back to
// back, not one longer blip. Every other generator here ramps its gain up
// and down (exponentialRampToValueAtTime) because a ramp is what makes a
// discharge sound like it was released; these snap to level and snap back
// to silence with setValueAtTime alone, because a refusal has no release —
// the gun simply didn't do anything. The double tap over a single longer
// gate is what makes it read as "no, no" rather than just "no" — a more
// insistent, more obviously NEGATIVE gesture, which matters here because
// it can repeat on every frame the trigger is held (rate-limited by
// soundtypes.js's own minInterval on this entry, not by anything in the
// shape itself).
function generateDryFire(ctx, dest, t) {
  function blip(start) {
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 90;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35, start);
    g.gain.setValueAtTime(0.35, start + 0.015);
    g.gain.setValueAtTime(0.0001, start + 0.016);
    osc.connect(g).connect(dest);
    osc.start(start);
    osc.stop(start + 0.02);
  }
  blip(t);
  blip(t + 0.03);
  return 0.05;
}

registerGenerator("dry_fire", generateDryFire);

// Any hostile gun discharging (weapons.js's ENEMY_WEAPON_TYPES: blaster,
// smg, missile — all three collapse onto this one sound, see
// audio/weaponsfx.js for why). The SAME sweep pitch as generateFireBlaster
// (320→110Hz) rather than a different one — the design brief is explicit
// that player and enemy fire are told apart by TIMBRE, not pitch, because
// pitch separation would cost headroom this narrow a band can't spare, and
// the player has to tell who fired without looking. A square wave (odd
// harmonics only, versus the saw's full set), a WIDER bandpass at 250Hz
// (Q1.6, looser than a first pass's Q2.5) and a slightly longer 85ms
// envelope are what do it: rougher and grittier against the blaster's
// tight, lowpassed warmth — the enemy's gun sounding a little cruder is
// part of what tells it apart at a glance (or rather, an earful).
function generateFireEnemy(ctx, dest, t) {
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(320, t);
  osc.frequency.exponentialRampToValueAtTime(110, t + 0.085);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 250;
  band.Q.value = 1.6; // wider/grittier than the blaster's own filtering
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.001, t);
  g.gain.exponentialRampToValueAtTime(0.42, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.085);
  osc.connect(band).connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + 0.095);
  return 0.095;
}

registerGenerator("fire_enemy", generateFireEnemy);

// --- The shared glass-shatter body ---------------------------------------
//
// ONE implementation, TWO catalogue entries (kill_enemy and kill_neutral). Every
// number either entry might want to move on its own is a field of the `cfg` it
// passes in (see GLASS_SHATTER_BASE), so "make kill_neutral's shatter thinner /
// heavier / longer" is a one-line override rather than an edit to a shared body.
// If a future retune is STRUCTURAL rather than numeric — a different set of
// layers, not different numbers — fork this function at that point.
//
// SIX LAYERS:
//   1. a double-transient CRACK — two close noise clicks (12ms apart),
//      bandpassed bright, standing in for the initial stress fracture
//   2. a dense noise BURST sweeping down — the mass of glass separating
//      at once, brief and centred lower than the crack
//   3. a short, quiet SHIMMER — a touch of fine-dust sparkle up front,
//      much shorter and quieter than the crack/burst so it reads as
//      texture, not its own event
//   4. a PRIMARY SPRAY of ringing shards (see shard() below), skewed
//      toward the very start of the sound — the main spray of fragments
//   5. a smaller, quieter SECONDARY CASCADE of shards spread later and
//      wider — smaller pieces settling after the main spray
//   6. a low THUMP (130→40Hz sine) and a low noise WASH tying the whole
//      thing back to a KILL rather than glass breaking in isolation, and
//      to the game's own low-register identity
//
// Every shard is a couple of INHARMONIC SINE PARTIALS (a fundamental plus a
// detuned overtone, each with its own independent decay) rather than a
// bandpassed noise burst — the technique real bell/glass-ping synthesis uses.
// A genuine glass-break needs BELL-LIKE RINGING shards, not flat clicks.
//
// DELIBERATE, BOUNDED DEPARTURE FROM THE CATALOGUE'S ~1.5kHz TONAL CEILING: the
// shard partials run up to ~6-7kHz at their brightest. This is the ONE place in
// the catalogue that happens; every other entry still obeys the ceiling.
//
// VOICE COUNT IS THE CONSTRAINT: kill_enemy's maxConcurrent (4) can all fire
// inside one tick during a blast chain, so this uses 16 shards at 2 partials
// each (32 oscillators) and no convolver — there is no shared reverb bus in
// context.js to route one through, and the shimmer layer stands in for it.
const GLASS_SHATTER_BASE = {
  shards: 10, // the primary spray
  shardBand: [900, 2200], // Hz — the primary spray's own fundamental range
  cascadeShards: 6, // the secondary, thinner cascade
  cascadeBand: [1100, 2500], // Hz — slightly higher/smaller pieces
  thumpPeak: 0.55, // the low impact thump that keeps this reading as a KILL
  settlePeak: 0.3, // the low noise wash under the settling shards
  duration: 0.52, // what the voice limiter is told (see the generator contract)
};

function glassShatter(ctx, dest, t, cfg) {
  // One ringing fragment: a fundamental plus a randomly-detuned inharmonic
  // overtone, each with its OWN randomised decay so no two shards ring
  // identically — the same "no two wrecks alike" idea effects.js's own
  // seeded wreck variation uses elsewhere in this codebase, applied here
  // via Math.random() instead of a seed since this sound has no seed input.
  function shard(startTime, baseFreq, peak) {
    const partials = [
      { ratio: 1, level: 1, decay: 0.05 + Math.random() * 0.11 },
      { ratio: 2.2 + Math.random() * 0.8, level: 0.5, decay: 0.03 + Math.random() * 0.05 },
    ];
    for (const p of partials) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      const freq = baseFreq * p.ratio;
      osc.frequency.setValueAtTime(freq, startTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.92, startTime + p.decay);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, startTime);
      g.gain.linearRampToValueAtTime(peak * p.level, startTime + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, startTime + p.decay);
      osc.connect(g).connect(dest);
      osc.start(startTime);
      osc.stop(startTime + p.decay + 0.03);
    }
  }

  // 1. The crack: two close bandpassed noise clicks.
  [[0, 2400, 0.5], [0.012, 2900, 0.35]].forEach(([offset, freq, peak]) => {
    const start = t + offset;
    const src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer();
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = freq;
    band.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, start);
    g.gain.exponentialRampToValueAtTime(0.001, start + 0.045);
    src.connect(band).connect(g).connect(dest);
    src.start(start);
    src.stop(start + 0.05);
  });

  // 2. The burst: the mass separating, sweeping down and out.
  const burstStart = t + 0.005;
  const burst = ctx.createBufferSource();
  burst.buffer = getNoiseBuffer();
  const burstBand = ctx.createBiquadFilter();
  burstBand.type = "bandpass";
  burstBand.Q.value = 0.9;
  burstBand.frequency.setValueAtTime(4500, burstStart);
  burstBand.frequency.exponentialRampToValueAtTime(2000, burstStart + 0.35);
  const burstGain = ctx.createGain();
  burstGain.gain.setValueAtTime(0.001, burstStart);
  burstGain.gain.exponentialRampToValueAtTime(0.35, burstStart + 0.01);
  burstGain.gain.exponentialRampToValueAtTime(0.001, burstStart + 0.35);
  burst.connect(burstBand).connect(burstGain).connect(dest);
  burst.start(burstStart);
  burst.stop(burstStart + 0.37);

  // 3. A short shimmer — a touch of fine-dust sparkle, not a long hiss.
  const shimmerStart = t + 0.01;
  const shimmer = ctx.createBufferSource();
  shimmer.buffer = getNoiseBuffer();
  const shimmerBand = ctx.createBiquadFilter();
  shimmerBand.type = "bandpass";
  shimmerBand.frequency.value = 3200;
  shimmerBand.Q.value = 1.6;
  const shimmerGain = ctx.createGain();
  shimmerGain.gain.setValueAtTime(0.001, shimmerStart);
  shimmerGain.gain.exponentialRampToValueAtTime(0.15, shimmerStart + 0.02);
  shimmerGain.gain.exponentialRampToValueAtTime(0.001, shimmerStart + 0.2);
  shimmer.connect(shimmerBand).connect(shimmerGain).connect(dest);
  shimmer.start(shimmerStart);
  shimmer.stop(shimmerStart + 0.22);

  // 4. Primary spray — skewed toward the very start (Math.pow(rand, 1.5),
  // same skew the reference uses, so most shards cluster right at impact
  // rather than spreading evenly).
  const [primaryLow, primaryHigh] = cfg.shardBand;
  for (let i = 0; i < cfg.shards; i++) {
    const start = t + Math.pow(Math.random(), 1.5) * 0.12;
    const freq = primaryLow + Math.random() * (primaryHigh - primaryLow);
    const peak = 0.16 + Math.random() * 0.08;
    shard(start, freq, peak);
  }

  // 5. Secondary cascade — fewer, smaller, later; fading with time so the
  // spray reads as thinning out rather than a second identical burst.
  const [cascadeLow, cascadeHigh] = cfg.cascadeBand;
  for (let i = 0; i < cfg.cascadeShards; i++) {
    const offset = 0.12 + Math.random() * 0.2;
    const start = t + offset;
    const freq = cascadeLow + Math.random() * (cascadeHigh - cascadeLow);
    const peak = (0.06 + Math.random() * 0.05) * (1 - offset / 0.4);
    shard(start, freq, Math.max(peak, 0.02));
  }

  // 6. The impact thump and the low settling wash — what keeps this
  // reading as a KILL, not glass breaking in isolation.
  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(130, t);
  thump.frequency.exponentialRampToValueAtTime(40, t + 0.16);
  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0.001, t);
  thumpGain.gain.exponentialRampToValueAtTime(cfg.thumpPeak, t + 0.008);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  thump.connect(thumpGain).connect(dest);
  thump.start(t);
  thump.stop(t + 0.18);

  const settleStart = t + 0.05;
  const settle = ctx.createBufferSource();
  settle.buffer = getNoiseBuffer();
  const settleBand = ctx.createBiquadFilter();
  settleBand.type = "bandpass";
  settleBand.Q.value = 0.8;
  settleBand.frequency.setValueAtTime(400, settleStart);
  settleBand.frequency.exponentialRampToValueAtTime(150, settleStart + 0.4);
  const settleGain = ctx.createGain();
  settleGain.gain.setValueAtTime(0.001, settleStart);
  settleGain.gain.exponentialRampToValueAtTime(cfg.settlePeak, settleStart + 0.04);
  settleGain.gain.exponentialRampToValueAtTime(0.001, settleStart + 0.4);
  settle.connect(settleBand).connect(settleGain).connect(dest);
  settle.start(settleStart);
  settle.stop(settleStart + 0.42);

  return cfg.duration;
}

// A hostile car destroyed (main.js's onCarDestroyed, when score.js would
// score it a bounty) — GLASS SHATTER. The whole body lives in
// glassShatter() above (see its own header for every layer, the shard
// technique, and the one bounded departure from the catalogue's tonal
// ceiling); this entry is the baseline configuration of it, and
// kill_neutral below is the same shape with its own cfg.
function generateKillEnemy(ctx, dest, t) {
  return glassShatter(ctx, dest, t, GLASS_SHATTER_BASE);
}

registerGenerator("kill_enemy", generateKillEnemy);

// A roadblock or mine destroyed (obstacles.js's detonate(), any family) — a
// closing bandpass sweep (900→120Hz) plus a short fixed-pitch sub THUMP
// (90→50Hz over 100ms), rather than generateKillEnemy's own shatter-cascade
// shape above: furniture breaking is a smaller, duller event than a kill,
// and a single sweep with a touch of low-end weight under it reads as
// exactly that without needing kill_enemy's multi-shard cascade scaled down.
function generateKillObstacle(ctx, dest, t) {
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer();
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 1.5;
  band.frequency.setValueAtTime(950, t);
  band.frequency.exponentialRampToValueAtTime(140, t + 0.32);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.001, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.48, t + 0.015);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
  noise.connect(band).connect(noiseGain).connect(dest);
  noise.start(t);
  noise.stop(t + 0.34);

  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(90, t);
  thump.frequency.exponentialRampToValueAtTime(50, t + 0.1);
  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0.001, t);
  thumpGain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  thump.connect(thumpGain).connect(dest);
  thump.start(t);
  thump.stop(t + 0.12);

  return 0.34;
}

registerGenerator("kill_obstacle", generateKillObstacle);

// A civilian destroyed (main.js's onCarDestroyed, when score.js would fine
// it) — THE ONE THAT MATTERS, and, per review, the SAME glass-shatter shape
// as generateKillEnemy above (glassShatter(), see its own header for every
// layer).
//
// ITS OWN cfg, NOT A SHARED CONSTANT WITH kill_enemy — the two pass separate
// objects even though every value in them is identical today. That is the
// point: this pairing has no relationship the way generateFireTracker's reuse
// of generateFireBlaster does (the tracker IS "the blaster plus something
// extra" and is meant to track the blaster's retunes forever); kill_neutral
// and kill_enemy just happen to sound alike right now. A future retune of
// either — a heavier spray here, a return to something closer to the earlier
// dissonant-dyad design — is an edit to THIS object alone and cannot reach
// kill_enemy. What that no longer buys, and shouldn't: an accidental
// one-sided edit to 115 lines of look-alike code, which is what the two
// verbatim-duplicated bodies here used to risk.
//
// WHAT TELLS THEM APART TODAY, given an identical dry generator: this entry's
// catalogue fields in soundtypes.js — the deepest duck of any combat sound,
// the catalogue's only real delaySend so the wrongness hangs into the next
// bar, and the highest priority of the group. The DIFFERENCE between "you
// killed an enemy" and "you did something wrong" lives entirely in the MIX
// rather than in the waveform, a genuine departure from the original design
// brief's dissonant-dyad approach — kept because review chose it, not because
// the brief changed.
const KILL_NEUTRAL_SHATTER = { ...GLASS_SHATTER_BASE };

function generateKillNeutral(ctx, dest, t) {
  return glassShatter(ctx, dest, t, KILL_NEUTRAL_SHATTER);
}

registerGenerator("kill_neutral", generateKillNeutral);

// --- Phase 8 step 3: damage feedback + pickups -----------------------------

// A real hull loss (player.js's damage(), the branch that isn't deflected by
// a shield) — an amplitude-GATED square, not a thud: per the design brief,
// "the car is not taking damage, the signal is." opts.intensity (0..1, hp
// lost relative to maxHealth — main.js computes this, this file only shapes
// it) scales three things TOGETHER: peak gain, how deep the gate cuts, and
// how hard the music ducks — a wall-scrape graze and a rocket to the hull
// are the SAME sound at different depths, not three separate recipes.
//
// SELF-DUCKING, UNLIKE EVERY OTHER GENERATOR HERE. soundtypes.js's own
// `duck` field is a fixed per-entry number decided once, at catalogue-write
// time; this is the one sound whose duck has to move with a value that only
// exists at CALL time (opts.intensity), so this entry's catalogue duck is 0
// and the generator calls context.js's duck() directly — see that entry's
// own comment in soundtypes.js.
//
// THE GATE IS HAND-STEPPED (setValueAtTime per half-cycle), not an LFO like
// the sustained voices' own tremolos (sustainedfx.js) — this is a single
// ~120ms burst, not a held voice, so scheduling a handful of discrete steps
// up front is simpler than spinning up an oscillator+gain pair for a sound
// that's over before the LFO would complete even one full cycle at 30Hz.
function generatePlayerHit(ctx, dest, t, opts = {}) {
  const intensity = Math.max(0, Math.min(1, opts.intensity ?? 0.6));
  const dur = 0.12;
  const gateHz = 30;
  const halfPeriod = 1 / gateHz / 2;

  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.value = 55;

  const gain = ctx.createGain();
  const peak = 0.08 + intensity * 0.5; // a graze barely registers; a heavy hit reads clearly
  const off = peak * Math.max(0.05, 0.55 - intensity * 0.5); // deeper gate (lower off-level) at higher intensity
  let time = t;
  let on = true;
  while (time < t + dur) {
    gain.gain.setValueAtTime(on ? peak : off, time);
    on = !on;
    time += halfPeriod;
  }
  gain.gain.setValueAtTime(0.0001, t + dur);

  osc.connect(gain).connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.01);

  duck(0.08 + intensity * 0.35); // see the header — this entry ducks itself rather than through soundtypes.js's static field

  return dur;
}

registerGenerator("player_hit", generatePlayerHit);

// A hit the SHIELD absorbed (player.js's damage(), the deflected branch) —
// a short, soft, ROUNDED swell of the same fifth shield_drone holds (sine,
// not player_hit's gated square): per the design brief, "what a hit sounds
// like when the shield eats it... the fifth from the drone briefly
// swelling." Without this the shield reads as dead on impact — a hit simply
// produces no sound at all, which is indistinguishable from nothing having
// happened.
function generateShieldDeflect(ctx, dest, t) {
  const freqs = [110, 164.81]; // A2, E3 — the same fifth shield_drone/pickup_shield use
  const dur = 0.3;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(0.35, t + 0.04); // soft, ROUNDED attack — not snapped like player_hit's hard gate
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  gain.connect(dest);
  for (const freq of freqs) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
  return dur;
}

registerGenerator("shield_deflect", generateShieldDeflect);

// An ammo crate collected (game/pickuptypes.js's AMMO kind, any of the four
// weapon-specific crates — see audio/pickupsfx.js for why they collapse onto
// this one id) — two IDENTICAL 165Hz triangle taps in unison, per the design
// brief: "Two 165Hz triangle taps, unison." Deliberately the plainest of the
// three pickup sounds — ammo is the least consequential of the three kinds,
// so it gets the least eventful confirmation tone.
function generatePickupAmmo(ctx, dest, t) {
  function tap(start) {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 165;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.3, start + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.05);
    osc.connect(g).connect(dest);
    osc.start(start);
    osc.stop(start + 0.06);
  }
  tap(t);
  tap(t + 0.07);
  return 0.13;
}

registerGenerator("pickup_ammo", generatePickupAmmo);

// A FIX crate collected (game/pickuptypes.js's HEAL kind) — a rising fifth,
// A2->E3 over ~250ms, per the design brief. PICKUPS STAY ASCENDING BUT LOW:
// per the brief, "ascending-and-bright is the obvious reward shape and is
// exactly what would tip this into arcade-toy territory" — so this climbs
// exactly one interval (a fifth) entirely below 165Hz, told apart from
// pickup_shield below by WHICH interval it climbs, not by how bright it gets.
function generatePickupHeal(ctx, dest, t) {
  const dur = 0.25;
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(110, t); // A2
  osc.frequency.exponentialRampToValueAtTime(164.81, t + dur); // E3 — a fifth up
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.4, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.02);
  return dur;
}

registerGenerator("pickup_heal", generatePickupHeal);

// A SHIELD crate collected (game/pickuptypes.js's SHIELD kind) — a rising
// OCTAVE, A2->A3 over ~300ms, per the design brief: "Rising octave A2→A3,
// then shield_drone takes over." The wider interval (an octave, against
// pickup_heal's fifth) is what tells the two apart at a glance — still low,
// still triangle, same "ascending but restrained" family. shield_drone
// itself (sustainedfx.js) is driven independently off player.shieldTime in
// main.js's update loop, not from anything in this function — this is only
// the confirmation tone for the INSTANT of collection.
function generatePickupShield(ctx, dest, t) {
  const dur = 0.3;
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(110, t); // A2
  osc.frequency.exponentialRampToValueAtTime(220, t + dur); // A3 — an octave up
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.4, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.02);
  return dur;
}

registerGenerator("pickup_shield", generatePickupShield);

// --- Phase 8 step 4: console log ticks ------------------------------------
//
// engine/console.js's push() — a single soft 40ms triangle blip, severity
// picking the pitch (audio/consolesfx.js's CONSOLE_PITCH). ONE SHARED SHAPE,
// THREE REGISTRATIONS: the three ids differ only in pitch — waveform,
// envelope and duration are identical — so this is one parameterised builder
// called once per severity, rather than three duplicated bodies (nothing
// here is expected to diverge the way, say, kill_neutral might from
// kill_enemy one day) or a single id taking a severity opt (soundtypes.js's
// own entries want independent gain/priority per severity, which a shared id
// can't express through that table).
function generateConsoleTick(freq) {
  return function (ctx, dest, t) {
    const dur = 0.04;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.01);
    return dur;
  };
}

// Driven straight off CONSOLE_SOUND/CONSOLE_PITCH rather than three literal
// calls, so the id a severity maps to and the pitch that id actually rings
// can never drift apart — see consolesfx.js's own header.
for (const severity of Object.keys(CONSOLE_SOUND)) {
  registerGenerator(CONSOLE_SOUND[severity], generateConsoleTick(CONSOLE_PITCH[severity]));
}

// --- Phase 8 step 5: menu ---------------------------------------------------
//
// Four short, dry, triangle-only blips — see soundtypes.js's own header for
// the shared reasoning (pure interface, no delay send, low gain). All four
// stay well inside the catalogue's existing pitch vocabulary — 110Hz/164.81Hz
// are the exact A2/E3 pair shield_deflect and the two pickups already use —
// rather than inventing a new register just for menu chrome.

// "A cursor step, nothing more" — the plainest generator in the catalogue,
// on purpose: this fires on every single up/down press in the menu, so
// anything more eventful than a bare tick would wear thin within a minute
// of navigating SOUND/MUSIC rows.
function generateMenuMove(ctx, dest, t) {
  const dur = 0.025;
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = 130;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.3, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.01);
  return dur;
}

registerGenerator("menu_move", generateMenuMove);

// A DESCENDING fifth, E3->A2 — per the design brief, "you are going down
// into the system, not levelling up", the opposite contour from every
// ascending pickup tone in the catalogue (generatePickupHeal/Shield above),
// deliberately: this needed to read as entering the deck, not as a reward.
// A single continuous glide, the same shape those two pickups use just
// inverted, rather than two discrete notes — one unbroken descent reads as
// one committed action.
function generateMenuConfirm(ctx, dest, t) {
  const dur = 0.2;
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(164.81, t); // E3
  osc.frequency.exponentialRampToValueAtTime(110, t + dur); // A2 — a fifth down
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.02);
  return dur;
}

registerGenerator("menu_confirm", generateMenuConfirm);

// A single, softer note at the bottom of menu_confirm's own glide (A2) —
// "backing out" is the same direction as confirming, just without following
// through the whole descent, so sharing the LANDING pitch (rather than
// inventing a third one) is what ties the two together as the same family
// of gesture.
function generateMenuBack(ctx, dest, t) {
  const dur = 0.06;
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = 110; // A2
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.01);
  return dur;
}

registerGenerator("menu_back", generateMenuBack);

// A near-inaudible tick meant to be heard many times a second while a
// volume bar is being dragged — see soundtypes.js's own minInterval comment
// for why the RATE this repeats at, not this generator's own envelope, is
// what actually reads as "scrubbing a slider".
function generateMenuAdjust(ctx, dest, t) {
  const dur = 0.02;
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = 150;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.15, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.005);
  return dur;
}

registerGenerator("menu_adjust", generateMenuAdjust);

// --- Phase 8 step 5: transitions ---------------------------------------------

// EXPORTED, not a local constant — synth.js's facade reads this directly
// (its jackIn() call bundles play("jack_in") with the CHOSEN music backend's
// own start(JACK_IN_DURATION) — either backend, see synth.js's own "Music
// backend selection" section), so the riser's own length and the moment the
// music's first downbeat is scheduled to land can never drift apart: one
// number, read by both. See proceduralmusic.js's start() header (and
// trackmusic.js's) for the other half of that seam.
export const JACK_IN_DURATION = 1.5; // seconds — "~1.5s" per the design brief

// The player jacking into the deck for the first time — a DESCENDING
// gesture (a sub sweep down to 40Hz, plus a noise wash sliding down
// alongside it), per the design brief: "you never hear the world, you hear
// the deck reporting on the world", and the first thing the deck reports is
// itself booting down INTO the game rather than up out of it — the same
// "descending, not triumphant" instinct menu_confirm's own glide follows,
// stretched out and given real weight here since this is the one moment in
// the whole game that gets uncontested space (nothing else is sounding on
// the music bus yet — see this entry's own duck:0 in soundtypes.js).
//
// TWO LAYERS, MOVING TOGETHER: the sub oscillator is the gesture's
// backbone — a long, mostly-exponential descent that only reaches its floor
// right at the very end, so the ear tracks ONE continuous fall rather than
// a sweep that arrives early and just sits there. The noise wash's own
// bandpass centre frequency slides down the SAME direction over the SAME
// duration, so it reads as texture riding the same descent rather than a
// second, independent event layered on top.
function generateJackIn(ctx, dest, t) {
  const dur = JACK_IN_DURATION;

  const sub = ctx.createOscillator();
  sub.type = "sine";
  sub.frequency.setValueAtTime(300, t);
  sub.frequency.exponentialRampToValueAtTime(40, t + dur * 0.9);
  const subGain = ctx.createGain();
  subGain.gain.setValueAtTime(0.0001, t);
  subGain.gain.exponentialRampToValueAtTime(0.5, t + 0.3);
  subGain.gain.setValueAtTime(0.5, t + dur * 0.6);
  subGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  sub.connect(subGain).connect(dest);
  sub.start(t);
  sub.stop(t + dur + 0.05);

  // getNoiseBuffer() is one second of shared white noise (context.js) — this
  // gesture runs longer than that, hence `loop = true`, the same way any
  // other sustained noise texture in this codebase would have to.
  const wash = ctx.createBufferSource();
  wash.buffer = getNoiseBuffer();
  wash.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 0.6;
  band.frequency.setValueAtTime(2000, t);
  band.frequency.exponentialRampToValueAtTime(150, t + dur);
  const washGain = ctx.createGain();
  washGain.gain.setValueAtTime(0.0001, t);
  washGain.gain.exponentialRampToValueAtTime(0.25, t + 0.4);
  washGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  wash.connect(band).connect(washGain).connect(dest);
  wash.start(t);
  wash.stop(t + dur + 0.05);

  return dur;
}

registerGenerator("jack_in", generateJackIn);

// A single decaying triangle "gong" — deliberately plain on its own; what
// actually makes this ring out (per the design brief) is soundtypes.js's
// own high delaySend on this entry, not anything in the envelope below. 82Hz
// sits in the same low register the pad's own bass line occupies
// (proceduralmusic.js's PROGRESSION), so the gong reads as coming from the SAME
// instrument family as the music rather than a separate alert layer bolted
// on top of it.
function generateSectorShift(ctx, dest, t) {
  const dur = 2.0;
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = 82;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.05);
  return dur;
}

registerGenerator("sector_shift", generateSectorShift);

// --- play() ----------------------------------------------------------------
//
// Looks up `id` in the catalogue, asks context.js's voice limiter whether it
// may play right now, and if so builds this call's own gain (+ optional
// delay send) off the shared buses before handing control to the generator.
// A no-op — never a throw — if audio hasn't started yet (context.js's
// isStarted()), if `id` isn't in the catalogue, or if the voice limiter says
// no room: every one of those is a normal, expected outcome (a sound played
// before START GAME, a typo'd id during development, a rapid-fire weapon
// that just lost a steal), not an error condition worth crashing a frame
// over.
export function play(id, opts) {
  if (!isStarted()) return;
  const entry = soundTypeById(id);
  if (!entry || !entry.generator) return;

  const accepted = requestVoice(id, {
    priority: entry.priority,
    maxConcurrent: entry.maxConcurrent,
    minInterval: entry.minInterval,
  });
  if (!accepted) return;

  const ctx = getCtx();
  const t = ctx.currentTime + (opts?.startDelay ?? 0);

  // This call's own gain stage, at the catalogue's mix level, feeding the
  // shared sfx bus — every generator connects to THIS, never to getSfxBus()
  // directly, so a per-sound gain never has to be re-derived inside the
  // generator itself.
  const dest = ctx.createGain();
  dest.gain.value = entry.gain;
  dest.connect(getSfxBus());

  if (entry.delaySend > 0) {
    const send = ctx.createGain();
    send.gain.value = entry.delaySend;
    dest.connect(send).connect(getDelay());
  }

  if (entry.duck > 0) duck(entry.duck);

  const duration = entry.generator(ctx, dest, t, opts);
  // commitVoiceDuration measures its own `end` from ctx.currentTime, not
  // from `t` — so a delayed voice (opts.startDelay > 0) has to report the
  // delay AS PART OF its duration, or the voice limiter would think this
  // slot frees up startDelay seconds before the sound actually finishes.
  commitVoiceDuration(id, entry.priority, (opts?.startDelay ?? 0) + duration);
}
