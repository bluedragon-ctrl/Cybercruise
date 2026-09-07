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
// pinned to its limit. On a 600px canvas with ROAD_HALF_WIDTH = 143 this leaves
// at least 600/2 - 60 - 143 = 97px of roadside on the tight side. Raising it
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

// --- Camera ----------------------------------------------------------------
//
// How much of the road's sideways wander the camera CANCELS. 0 = the camera is
// fixed to the world and the road slides across the frame, dragging every car
// on it sideways (how the game shipped up to here). 1 = the camera pans with
// the road so the CENTRE-LINE is always at the middle of the screen, and the
// car's screen x then shows only what the player steered, not where the road
// happens to be.
//
// It is a fraction rather than a flag because the two ends are not the only
// interesting settings: part-way is a camera that leans into a bend without
// fully following it, which keeps some of the road's own motion as a cue.
//
// AT 1. Both planes follow it: the road and everything holding a road-relative
// `offset` (road.js's cameraX), and the city floor with the conduits, markers
// and sky traffic over it (scenery.js's floorCameraX, which pans the floor at
// the FULL rate — see its own comment for why that is not FLOOR_PARALLAX).
//
// Lowering it is safe and needs nothing else changed; 0 restores the original
// fixed camera exactly. What is NOT free is raising ROAD_AMPLITUDE far past its
// 60, which the pan doubles the screen cost of — road.js's render() derives the
// ceiling (75) and a test holds it.
export const CAMERA_FOLLOW = 1;

// --- The 3D city floor (Phase 16a, PROOF OF CONCEPT) ----------------------
//
// 0 keeps the floor exactly as it shipped: buildings as cached sprites under
// buildingshapes.js's oblique projection, ground as one blitted tile. 1 draws
// both on the GPU through a real pinhole camera — game/citycamera.js says what
// that buys and engine/gl/city3d.js how it is drawn.
//
// IT IS A FLAG AND NOT A FRACTION, unlike CAMERA_FOLLOW above: the two paths
// are two renderers, not two settings of one, and there is no meaningful blend
// between a sprite and a mesh. The continuous knob is CITY_TILT below, whose
// 90 makes the 3D path's GROUND land pixel-for-pixel where the 2D path's does
// (citycamera.js derives that), so the two can be compared with only the
// buildings differing.
//
// AT THE SHIPPED CITY_TILT OF 90 THE GROUND IS PIXEL-IDENTICAL either way
// (citycamera.js derives that), so switching this on moves the floor grid, the
// streets, the ticks, the nodes, the traffic dots, the conduits and the award
// marks by exactly nothing. The buildings are the whole of the difference.
//
// That is only true at 90. Tilt the camera and the two flat layers still drawn
// on the 2D canvas — links.js's conduits and walletrender.js's award marks —
// stay where the parallel projection would have put them, because they are not
// reprojected yet; node sprites and traffic dots are (scenery.js's
// floorProject) but keep their authored size. Anyone dialling CITY_TILT down
// from the console is looking at a half-ported floor, and should know it.
export const CITY_3D = 1;

// Degrees the eye looks DOWN from the horizon. 90 is STRAIGHT DOWN, and is
// what ships.
//
// THE TRADE THIS KNOB SETS. Steep keeps the map legible — the ground stays at
// or near 1:1, so the city reads at the density it always did — but a
// building's height projects as radial splay away from the vanishing point
// rather than as rise up the screen, so the skyline flattens: at 68 a 96-unit
// tower rises 41px where the oblique projection gave it 96, and at 90 it rises
// none at all. Shallow (45-55) puts the rise back and produces a real receding
// skyline, at the cost of the far half of the map compressing into a band and
// of every flat layer needing the reprojection the PoC has not finished.
// buildingshapes.js's projection is, in these terms, "tilt 90 for the ground
// and tilt 0 for the heights" at once — impossible for a camera, and exactly
// why it was chosen.
//
// 90 RESOLVES THE TRADE RATHER THAN SPLITTING IT, because of where the
// vanishing point lands. At 90 it is the anchor: the ground point under screen
// (W/2, playerY), which at CAMERA_FOLLOW = 1 is the road's own centre-line. So
// the one place a top-down camera degenerates — zero lean, roof only, no wall
// visible — is under 143px of opaque tarmac, and every building the player can
// actually see is off-centre enough to have a real one. It also keeps the
// ground pixel-identical to the 2D floor, which is what lets this ship without
// the flat layers being ported first.
//
// test/city-camera.test.js holds the road-covers-the-vanishing-point claim,
// since it is an agreement between three files and nothing here would notice
// it breaking.
export const CITY_TILT = 90;

// Degrees the eye is turned about the vertical — map rotation, and the thing
// the sprite path could not express at all. Shipped at 0; it exists to be
// turned from the console (cybercruise.city3d({ yaw: 20 })) because "can this
// rotate" is one of the two questions this PoC is here to answer.
export const CITY_YAW = 0;

// The eye's height above the floor, in floor units, and the PERSPECTIVE
// STRENGTH. At the shipped tilt of 90 it is the ONLY thing it controls: the
// ground is 1:1 at any height (focal is pinned to height / sin(tilt), so the
// two cancel), and what is left is how far a building's roof is thrown outward
// from the vanishing point — a point at height z is drawn at
// height / (height - z) times its base's distance from the centre.
//
// So this reads as "how tall the city looks", and it is the one number to
// reach for if the skyline feels wrong:
//
//   900   a 96-unit tower throws its roof 36px out at the screen edge. Flat,
//         map-like, closest to a plan view.
//   800   ~41px. What ships. Enough lean to say "solid" and to mirror visibly
//         about the road, while the floor still reads as the TACTICAL MAP the
//         whole layer is framed as (README, Phase 7) rather than as scenery —
//         which is the reason to sit nearer the flat end of this range than
//         the dramatic one.
//   520   ~68px. Walls read clearly and blocks read as buildings rather than
//         as symbols.
//   340   ~120px. Dramatic, and past the point where an edge building's roof
//         lands over its neighbours.
//
// The floor of the clamp in citycamera.js exists for the same arithmetic: the
// tallest thing in the catalogue is a 96 tower under a mast reaching 1.4x, so
// an eye below ~134 would put geometry above the camera and the divide flips.
export const CITY_EYE_HEIGHT = 800;
