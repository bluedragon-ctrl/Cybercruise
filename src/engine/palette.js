// Central colour palette — cyberpunk "old green phosphor monitor" aesthetic.
//
// The WORLD (road, buildings, scenery) and all UI TEXT are shades of neon
// green, to evoke an 80s green CRT terminal. GAMEPLAY ENTITIES instead get
// distinct accent colours so they stand out against the green background:
//   - player  -> cyan (+ magenta thrusters)
//   - enemies -> red        (added in a later phase)
//   - neutral -> amber      (added in a later phase)
//
// Keep new world/scenery colours as greens here so the whole game stays
// coherent from one file.

// --- World / UI: green phosphor family ---
export const GREEN = "#39ff88";        // primary neon green (barriers, building edges)
export const GREEN_BRIGHT = "#7dffb0"; // brighter readouts / emphasis
export const GREEN_PALE = "#b6ffcc";   // pale green (lane dashes, secondary text, labels)
export const GREEN_DIM = "#1f8f52";    // muted green (faint fills / far scenery)
export const GRID_LINE = "rgba(57,255,136,0.22)";    // grid backdrop in the asset gallery
export const FLOOR_GRID = "rgba(57,255,136,0.14)";   // the LOWER city floor grid (dimmer,
                                                     // it's further from the camera than the road)
export const FLOOR_STREET = "rgba(57,255,136,0.055)"; // an avenue/cross-street's wide bed —
                                                       // dimmer than FLOOR_GRID's own lines, so
                                                       // the street reads as open ground, not a
                                                       // brighter version of the grid
export const FLOOR_STREET_LINE = "rgba(125,255,176,0.4)"; // a street's bright dashed centre
                                                           // line — GREEN_BRIGHT, so it pops
                                                           // against both the bed and the grid
export const ROAD_SURFACE = "#04060a";  // opaque road tarmac — occludes the city floor below,
                                        // selling the road as an elevated ribbon over the city
export const WALL_FILL = "#08160f";     // dark face of the road's elevated side wall
// Building faces. All three are OPAQUE (buildings occlude the floor grid and the
// boxes behind them), and they differ slightly so the three visible faces read as
// a lit solid rather than one flat silhouette: the roof catches the most light,
// the road-facing front wall less, the side wall least.
export const BUILDING_FILL = "#07130d";      // front (camera-facing) wall
export const BUILDING_FILL_SIDE = "#050c08"; // side wall — in shadow
export const BUILDING_FILL_ROOF = "#0a1c12"; // roof — the brightest face

// Car surfaces. Like the building faces above, all three are OPAQUE and differ
// by HEIGHT off the road: the chassis sits on the tarmac, spoilers and canopies
// stand proud of it, and wing bars and box tops are higher still. Being opaque is
// the point — a spoiler has to hide the bodywork under it, or the car reads as a
// flat x-ray outline instead of a solid object. See game/carshapes.js.
export const CAR_FILL = "#0b1118";        // chassis, on the road
export const CAR_FILL_RAISED = "#131f2b"; // canopies, scoops, ram bars, pods
export const CAR_FILL_HIGH = "#1b2c3c";   // wing bars, trailer tops — highest

// --- Gameplay entity accents ---
export const PLAYER = "#39f6ff";        // player car (cyan)
export const PLAYER_THRUST = "#ff36c8"; // player thruster glow (magenta)
export const HAZARD = "#ff4d4d";        // damage / collision flash (red)
// A car about to be destroyed blinks between its own colour and this (see
// traffic.js). Deliberately OUTSIDE both traffic families and far brighter than
// either: on an enemy car, red-on-red would be no signal at all, so the tell is
// the alternation, and this is the frame you can't miss.
export const CRITICAL_FLASH = "#ffd6d6"; // white-hot, red cast

// The rocket (game/weapons.js) and its own detonation (game/effects.js's
// drawFireballBurst) share this pair, the same way a wreck reuses a dying car's
// colour/thrust — the burst is visibly the same ordnance that just flew in.
// Deliberately its own hue rather than borrowed from ENEMY_THRUST or NEUTRAL:
// both of those already mean something else (enemy exhaust, civilian traffic),
// and this is the game's first FIRE-coloured effect — see drawFireballBurst's
// header for why every other explosion avoids this palette on purpose.
export const ROCKET = "#ff7a1a";     // rocket body / fireball outer ring
export const ROCKET_HOT = "#ffde6b"; // rocket burner flicker / fireball inner glow

// Traffic (see game/cartypes.js) reads as two families at a glance: everything
// hostile is in the RED family, everything neutral in the AMBER family. New car
// types should stay inside their family's shades rather than introduce a new hue
// — the faction has to be readable in the half-second before impact.
//
// COLOUR IS NOT AN IDENTITY. Car types outnumber the shades here, and always
// will: a type is told apart by its SILHOUETTE (game/carshapes.js), so colour
// only has to answer two questions — "is it hostile?" (the family) and "is it
// heavy?" (the shade). Shades therefore REPEAT across types by design. Giving
// every type its own hue would break the half-second faction read, which is the
// only thing colour is load-bearing for.
export const ENEMY = "#ff3b3b";          // enemy car (red)
export const ENEMY_DEEP = "#c81e5a";     // heavy enemy (crimson)
export const ENEMY_PALE = "#ff7a7a";     // light, fast enemy (washed red)
export const ENEMY_THRUST = "#ff8a3b";   // enemy exhaust (orange)
export const NEUTRAL = "#ffb020";        // neutral/civilian car (amber)
export const NEUTRAL_DEEP = "#c8801a";   // heavy neutral / truck (deep amber)
export const NEUTRAL_PALE = "#ffe08a";   // light, fast neutral (pale amber)
export const NEUTRAL_THRUST = "#ffd76a"; // neutral exhaust (warm amber)

// The shield pickup (game/player.js) and the reticle it rides in on
// (game/pickupshapes.js) — the player's own cyan, so the buff reads as an
// extension of the car rather than a foreign effect. SHIELD_FLICKER is the
// near-white it flashes toward in its last second, the same "about to lose
// it" tell CRITICAL_FLASH already gives a dying car, moved into the player's
// own family instead of the traffic one.
export const SHIELD_FLICKER = "#eafff5";

// Pickup reticle families (game/pickupshapes.js). The shared diamond frame
// every crate rides in is tinted by KIND rather than always green, so the
// three kinds of buff read apart before the player is close enough to see the
// glyph at the centre: ammo crates -> gray, boosts (shield, etc.) -> purple,
// healing stays the world's own green (see GREEN/GREEN_BRIGHT/GREEN_DIM
// above).
export const GRAY = "#8a94a0";
export const GRAY_BRIGHT = "#c3ccd6";
export const GRAY_DIM = "#4a525c";
export const PURPLE = "#b866ff";
export const PURPLE_BRIGHT = "#d9aeff";
export const PURPLE_DIM = "#5c2e8f";
