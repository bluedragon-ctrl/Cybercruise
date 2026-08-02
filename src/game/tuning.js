// Gameplay tuning knobs, gathered in one place.
//
// Everything here is a FEEL dial: a number you can turn to change how the game
// plays without touching the code that uses it. Nothing in this file has any
// behaviour of its own, and nothing else in the codebase should have to be
// edited to try a different value. If you find yourself hunting through modules
// to retune something, move that constant here.
//
// Constants that are *structural* rather than tuning — canvas geometry, lane
// counts, cache strides — stay with the code that owns them, because changing
// them means changing surrounding logic too.

// --- Road shape ------------------------------------------------------------
//
// The road's centre-line is an OVERDRIVEN, SOFT-CLIPPED wave (see road.js's
// centerOffset for the maths). Two sines of different wavelengths are summed to
// give a non-repeating wander, that wander is amplified past the range the road
// is allowed to occupy, and the excess is flattened off. Wherever the amplified
// wave runs past its limit the road holds a constant offset — i.e. it goes
// DEAD STRAIGHT — and the turns become the transitions between those straights.
//
// So the knob you want is ROAD_STRAIGHTNESS.

// THE FEEL THESE DEFAULTS AIM AT is a HIGHWAY: long straights joined by gentle,
// sweeping curves you barely have to steer for. The failure mode on the other
// side is a wavy forest road — constant turning, cars visibly leaning most of
// the time. Three knobs decide which one you get, and they interact:
//
//   ROAD_STRAIGHTNESS   how MUCH of the road is straight
//   ROAD_AMPLITUDE      how FAR the road travels sideways between straights
//   ROAD_TURN_RATE      how QUICKLY it works through the whole pattern
//
// The lean the road puts on a car is the product of all three. Highway means
// keeping that lean small (~12°) while still spending most of the road dead
// straight, which is why the amplitude here is modest: a road that swings far
// AND often has to turn hard to do it, and hard turning is the forest road.

// How far the road centre may sit from the canvas centre, in px. Also the
// offset it holds on a straight, since straights are exactly where the curve is
// pinned to its limit. On a 600px canvas with ROAD_HALF_WIDTH = 130 this leaves
// at least 600/2 - 60 - 130 = 110px of roadside on the tight side. Raising it
// steepens every turn in proportion.
export const ROAD_AMPLITUDE = 60;

// How hard the wander is driven into the clip. 1 = no clipping at all (a pure
// sine road: turn after turn, never straight). Higher = the wave spends more of
// its length pinned, so straights get longer and turns get correspondingly
// shorter and sharper for the same ROAD_TURN_RATE.
//
//   1.0 → 0% straight   2.0 → ~42%   2.8 → ~62% ← default   3.5 → ~73%
//
// Past ~3 the turns start to read as kinks between straights rather than as
// curves, which is its own kind of wrong. If you raise it, drop ROAD_TURN_RATE
// to keep the lean where it is.
export const ROAD_STRAIGHTNESS = 2.8;

// How quickly the road works through its shape, as a multiplier on both wave
// frequencies at once. Bigger = shorter straights AND shorter, sharper turns;
// smaller = a longer, lazier road. At the default the straights run ~11s each
// at cruising speed and the curves between them ~4s.
export const ROAD_TURN_RATE = 0.6;

// The two waves that are summed to make the wander. Their frequencies are in
// radians per world unit, before ROAD_TURN_RATE scales them; the weights are
// relative (they get normalised, so only their ratio matters). Deliberately
// non-harmonic so the pattern of straights and bends does not visibly repeat.
export const ROAD_WAVE_A_FREQ = 0.0009;
export const ROAD_WAVE_A_WEIGHT = 1;
export const ROAD_WAVE_B_FREQ = 0.0024;
export const ROAD_WAVE_B_WEIGHT = 0.44;
export const ROAD_WAVE_B_PHASE = 1.7;
