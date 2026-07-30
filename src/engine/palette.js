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
export const ROADSIDE_FILL = "rgba(30,120,70,0.12)"; // faint green ground OUTSIDE the road
                                                     // (the road surface itself stays black)
export const GRID_LINE = "rgba(57,255,136,0.22)";    // roadside floor grid (Tron-style)
export const FLOOR_GRID = "rgba(57,255,136,0.14)";   // the LOWER city floor grid (dimmer,
                                                     // it's further from the camera than the road)
export const ROAD_SURFACE = "#04060a";  // opaque road tarmac — occludes the city floor below,
                                        // selling the road as an elevated ribbon over the city
export const WALL_FILL = "#08160f";     // dark face of the road's elevated side wall
export const BUILDING_FILL = "#07130d"; // opaque dark body so buildings occlude the
                                        // floor grid and the boxes behind them

// --- Gameplay entity accents ---
export const PLAYER = "#39f6ff";        // player car (cyan)
export const PLAYER_THRUST = "#ff36c8"; // player thruster glow (magenta)
export const HAZARD = "#ff4d4d";        // damage / collision flash (red)
export const ENEMY = "#ff3b3b";         // enemy car (red) — added in a later phase
export const NEUTRAL = "#ffb020";       // neutral/friendly car (amber) — later phase
