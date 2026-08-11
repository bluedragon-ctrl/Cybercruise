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
//   time     the ctx.currentTime this voice should start at
//   opts     whatever play()'s caller passed through, generator-specific
//   returns  how many seconds this voice needs before it's silent — the ONE
//            piece of information context.js's voice limiter can't know on
//            its own (see its header on why the slot API is two steps)

import {
  isStarted, getCtx, getSfxBus, getDelay, getNoiseBuffer,
  duck, requestVoice, commitVoiceDuration,
} from "./context.js";
import { soundTypeById, registerGenerator } from "./soundtypes.js";

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

// A hostile car destroyed (main.js's onCarDestroyed, when score.js would
// score it a bounty) — GLASS SHATTER, reworked a second time against a
// reference example the user supplied: a genuine glass-break needs BELL-
// LIKE RINGING shards, not flat clicks. The first pass here used short
// bandpassed NOISE bursts for each fragment, which read as generic ticks;
// this pass gives every shard a couple of INHARMONIC SINE PARTIALS instead
// (a fundamental plus a detuned overtone, each with its own independent
// decay) — the same technique real bell/glass-ping synthesis uses, and the
// one thing the reference made obvious was missing.
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
// DELIBERATE, BOUNDED DEPARTURE FROM THE CATALOGUE'S ~1.5kHz TONAL CEILING.
// The shard partials below run up to ~6-7kHz at their brightest — this is
// the ONE place in the whole catalogue that happens, done at explicit
// review direction after hearing the reference example, and pulled back
// from the reference's own ~10-18kHz partials to stay closer to this
// game's restrained register. Every other entry still obeys the ceiling.
//
// SCALED DOWN FROM THE REFERENCE FOR VOICE COUNT: the reference spawns 54
// shards at 3 partials each (162 oscillators) plus a convolver reverb per
// hit. This game can have kill_enemy's maxConcurrent (4) all firing inside
// one tick during a blast chain, so this version uses 16 shards at 2
// partials each (32 oscillators) and no convolver — there's no shared
// reverb bus in context.js to route one through, and building one is out
// of scope here; a touch of shimmer stands in for it instead.
function generateKillEnemy(ctx, dest, t) {
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
  for (let i = 0; i < 10; i++) {
    const start = t + Math.pow(Math.random(), 1.5) * 0.12;
    const freq = 900 + Math.random() * 1300; // 900-2200Hz
    const peak = 0.16 + Math.random() * 0.08;
    shard(start, freq, peak);
  }

  // 5. Secondary cascade — fewer, smaller, later; fading with time so the
  // spray reads as thinning out rather than a second identical burst.
  for (let i = 0; i < 6; i++) {
    const offset = 0.12 + Math.random() * 0.2;
    const start = t + offset;
    const freq = 1100 + Math.random() * 1400; // 1100-2500Hz
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
  thumpGain.gain.exponentialRampToValueAtTime(0.55, t + 0.008);
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
  settleGain.gain.exponentialRampToValueAtTime(0.3, settleStart + 0.04);
  settleGain.gain.exponentialRampToValueAtTime(0.001, settleStart + 0.4);
  settle.connect(settleBand).connect(settleGain).connect(dest);
  settle.start(settleStart);
  settle.stop(settleStart + 0.42);

  return 0.52;
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
// it) — THE ONE THAT MATTERS, and, per review, now the SAME glass-shatter
// shape as generateKillEnemy above.
//
// DELIBERATELY DUPLICATED RATHER THAN CALLED. This function's body is a
// verbatim copy of generateKillEnemy's, not a call to it — on purpose, so
// the two can diverge independently the moment one of them needs to (a
// future retune, a return to the earlier dissonant-dyad design for this
// entry specifically, anything). Sharing the code the way generateFireTracker
// shares generateFireBlaster would be the wrong move here: that sharing
// exists BECAUSE the tracker's identity is "the blaster's body plus
// something extra" and is meant to track the blaster's own retunes forever;
// this pairing has no such relationship — kill_neutral and kill_enemy just
// happen to sound alike today; there is no reason a change to one should
// ever silently reach the other.
//
// WHAT STILL TELLS THEM APART, even with an identical dry generator: this
// entry's catalogue fields in soundtypes.js — the deepest duck of any combat
// sound, the catalogue's only real delaySend so the wrongness hangs into
// the next bar, and the highest priority of the group. The DIFFERENCE
// between "you killed an enemy" and "you did something wrong" now lives
// entirely in the MIX rather than in the waveform, which is a genuine
// departure from the original design brief's dissonant-dyad approach — kept
// because review chose it, not because the brief changed.
//
// REWORKED THE SAME WAY AS generateKillEnemy's own second pass — the
// bell-like ringing shard() technique, the crack/burst/shimmer/spray/
// cascade/thump/wash layering, the same bounded departure from the
// catalogue's ~1.5kHz tonal ceiling — kept numerically identical to that
// function's own body for now precisely BECAUSE this is a duplicate, not a
// shared call: if this entry's own levels ever need to diverge from
// kill_enemy's, this is the one place to change, with no risk of the edit
// reaching kill_enemy too. See that function's own header for the full
// explanation of every layer below.
function generateKillNeutral(ctx, dest, t) {
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

  for (let i = 0; i < 10; i++) {
    const start = t + Math.pow(Math.random(), 1.5) * 0.12;
    const freq = 900 + Math.random() * 1300;
    const peak = 0.16 + Math.random() * 0.08;
    shard(start, freq, peak);
  }

  for (let i = 0; i < 6; i++) {
    const offset = 0.12 + Math.random() * 0.2;
    const start = t + offset;
    const freq = 1100 + Math.random() * 1400;
    const peak = (0.06 + Math.random() * 0.05) * (1 - offset / 0.4);
    shard(start, freq, Math.max(peak, 0.02));
  }

  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(130, t);
  thump.frequency.exponentialRampToValueAtTime(40, t + 0.16);
  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0.001, t);
  thumpGain.gain.exponentialRampToValueAtTime(0.55, t + 0.008);
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
  settleGain.gain.exponentialRampToValueAtTime(0.3, settleStart + 0.04);
  settleGain.gain.exponentialRampToValueAtTime(0.001, settleStart + 0.4);
  settle.connect(settleBand).connect(settleGain).connect(dest);
  settle.start(settleStart);
  settle.stop(settleStart + 0.42);

  return 0.52;
}

registerGenerator("kill_neutral", generateKillNeutral);

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
  const t = ctx.currentTime;

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
  commitVoiceDuration(id, entry.priority, duration);
}
