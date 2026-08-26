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
export const DRONE_BODY = "rgba(57,255,136,0.4)";     // air traffic (Phase 7c) — a drone's own 2-4px
                                                       // body, dimmer than FLOOR_TRAFFIC's dots: it
                                                       // sits at a shallower parallax than the floor
                                                       // (further from the camera plane than the
                                                       // road, but not the floor's own depth either),
                                                       // and the nav light below is what has to read
                                                       // as "aircraft" — the body itself just has to
                                                       // avoid reading as another ground dot.
                                                       // DELIBERATELY NOT sector-varying (see the
                                                       // SECTOR PALETTES section below) — drones fly
                                                       // the sky band above the floor, not the city
                                                       // itself, and the sub-phase that introduced
                                                       // sectors (7f) scoped "the city" to exactly
                                                       // what its own sprite-cache concern covers:
                                                       // the floor, its buildings and its nodes.
export const DRONE_NAV = "rgba(182,255,204,0.95)";    // a drone's blinking nav light — GREEN_PALE,
                                                       // near-full alpha: the single strongest
                                                       // "aircraft" cue available at 1-2px, so it
                                                       // gets the brightest shade in the family
                                                       // rather than a shadowBlur it can't afford.
                                                       // Still green — red/amber stay reserved for
                                                       // the gameplay faction (see FLOOR_TRAFFIC).
                                                       // Sector-invariant, same reason as DRONE_BODY.
export const DRONE_SHADOW = "rgba(57,255,136,0.12)";  // a drone's ground marker, drawn on the FLOOR
                                                       // at FLOOR_PARALLAX while the drone itself is
                                                       // drawn higher up the parallax stack — dimmer
                                                       // than FLOOR_GRID's own lines so it reads as a
                                                       // faint mark, not another grid line. Sector-
                                                       // invariant too, same reason as DRONE_BODY —
                                                       // it belongs to the drone, not the floor it
                                                       // happens to fall on.
export const ROAD_SURFACE = "#04060a";  // opaque road tarmac — occludes the city floor below,
                                        // selling the road as an elevated ribbon over the city
export const WALL_FILL = "#08160f";     // dark face of the road's elevated side wall

// --- Sector palettes (Phase 7f) -----------------------------------------------
//
// THE SPLIT. Every colour above this point (GREEN family, ROAD_SURFACE,
// WALL_FILL, and everything below — car surfaces, gameplay accents, pickup
// reticles) is a plain `const`: fixed for the life of the page. Everything in
// this section is a `let`, reassigned by setSector() below, because a sector
// changes what the WORLD looks like — road AND city together, so the drive
// reads as one continuous place changing colour rather than two layers
// disagreeing about which one just crossed a line — and nothing else.
//
// WHY THE LINE FALLS EXACTLY HERE. Two rules from this file's own header
// decide it, and they draw the same boundary from two different directions:
//   - Gameplay faction colours (PLAYER/ENEMY*/NEUTRAL*/HAZARD/the HUD) must
//     stay invariant so the half-second faction read never competes with a
//     sector's own palette — see this file's header. None of them are here.
//   - spritecache.js's key must cover everything that changes an asset's
//     pixels, and the cache entries a sector recolour touches have to stay
//     CHEAP to multiply: 48 building sprites + 6 node sprites (see
//     sprites.js), plus road.js's own strip cache (bounded by the visible
//     block range already, not by variant count — see its own render()) —
//     not the car catalogue's 160 sprites / ~7MB. Only the colours those
//     bounded catalogues actually bake in are below.
// GREEN/GREEN_BRIGHT/GREEN_PALE/GREEN_DIM stay CONST and out of this table even
// though they read as "the world": main.js's HUD and menu.js import them
// directly, and the SYS LOG and score/hull readout have to keep reading the same
// whatever is outside the windshield, or the player loses their fixed reference
// for "what colour is a real gameplay signal". Where the ROAD or a BUILDING
// needs its own green it gets its OWN name below (ROAD_EDGE/ROAD_EDGE_DIM/
// ROAD_CENTERLINE, BUILDING_EDGE/BUILDING_EDGE_DIM), precisely so it can vary
// without repainting the HUD out from under it.
//
// LIVE BINDINGS, NOT AN ACCESSOR. palette.js is imported directly by every
// module that wants a colour (road.js, sprites.js, scenery.js, ...); routing
// every one of those call sites through a function instead would touch the
// whole project for one sub-phase. ES module bindings are live, so an
// `export let` reassigned here is picked up by every importer with ZERO
// call-site changes — see setSector() below.
//
// THE TRAP THIS DOESN'T FIX. A live binding only helps a call site that reads
// the name itself each time it's used. It does NOT update a value some OTHER
// module already copied into its own structure at import time — engine/
// console.js does exactly this (`const COLORS = { [HINT]: GREEN_PALE, ... }`,
// built once at module load) and would never see a reassignment. Harmless
// there on purpose (GREEN_PALE isn't in this table, and the SYS LOG shouldn't
// shift with the city anyway — see the split above), but it was checked
// project-wide before relying on this mechanism: nothing below this table is
// captured into a module-level object anywhere else in src/. If a future
// sector-varying colour needs to be added, that grep has to be repeated.
const SECTOR_PALETTES = [
  {
    // Sector 0 — the game's original green, byte-for-byte: a fresh run must
    // look exactly like it did before this sub-phase shipped.
    ROAD_EDGE: "#39ff88",
    ROAD_EDGE_DIM: "#1f8f52",
    ROAD_CENTERLINE: "#b6ffcc",
    BUILDING_EDGE: "#39ff88",
    BUILDING_EDGE_DIM: "#1f8f52",
    BUILDING_FILL: "#07130d",
    BUILDING_FILL_SIDE: "#050c08",
    BUILDING_FILL_ROOF: "#0a1c12",
    FLOOR_GRID: "rgba(57,255,136,0.14)",
    FLOOR_STREET: "rgba(57,255,136,0.055)",
    FLOOR_STREET_LINE: "rgba(125,255,176,0.4)",
    FLOOR_TRAFFIC: "rgba(125,255,176,0.6)",
    FLOOR_TICK: "rgba(57,255,136,0.3)",
    NODE_BRACKET: "#7dffb0",
    NODE_GLYPH: "#d8ffe6",
    CONDUIT_LINE: "rgba(57,255,136,0.22)",
    CONDUIT_PACKET: "rgba(216,255,230,0.9)",
    PING_RING: "rgba(125,255,176,0.6)",
  },
  {
    // Sector 1 — AZURE. Same brightness/alpha relationships as sector 0
    // (base -> bright -> near-white, same three alphas for grid/street/tick),
    // hue rotated from green toward blue.
    ROAD_EDGE: "#4696ff",
    ROAD_EDGE_DIM: "#27548f",
    ROAD_CENTERLINE: "#c9e2ff",
    BUILDING_EDGE: "#4696ff",
    BUILDING_EDGE_DIM: "#27548f",
    BUILDING_FILL: "#070d13",
    BUILDING_FILL_SIDE: "#05080c",
    BUILDING_FILL_ROOF: "#0a111c",
    FLOOR_GRID: "rgba(70,150,255,0.14)",
    FLOOR_STREET: "rgba(70,150,255,0.055)",
    FLOOR_STREET_LINE: "rgba(130,190,255,0.4)",
    FLOOR_TRAFFIC: "rgba(130,190,255,0.6)",
    FLOOR_TICK: "rgba(70,150,255,0.3)",
    NODE_BRACKET: "#82beff",
    NODE_GLYPH: "#d8ecff",
    CONDUIT_LINE: "rgba(70,150,255,0.22)",
    CONDUIT_PACKET: "rgba(216,236,255,0.9)",
    PING_RING: "rgba(130,190,255,0.6)",
  },
  {
    // Sector 2 — TEAL.
    ROAD_EDGE: "#39ffdd",
    ROAD_EDGE_DIM: "#208f7c",
    ROAD_CENTERLINE: "#c9fff2",
    BUILDING_EDGE: "#39ffdd",
    BUILDING_EDGE_DIM: "#208f7c",
    BUILDING_FILL: "#071311",
    BUILDING_FILL_SIDE: "#050c0b",
    BUILDING_FILL_ROOF: "#0a1c19",
    FLOOR_GRID: "rgba(57,255,221,0.14)",
    FLOOR_STREET: "rgba(57,255,221,0.055)",
    FLOOR_STREET_LINE: "rgba(125,255,232,0.4)",
    FLOOR_TRAFFIC: "rgba(125,255,232,0.6)",
    FLOOR_TICK: "rgba(57,255,221,0.3)",
    NODE_BRACKET: "#7dffe8",
    NODE_GLYPH: "#d8fff7",
    CONDUIT_LINE: "rgba(57,255,221,0.22)",
    CONDUIT_PACKET: "rgba(216,255,247,0.9)",
    PING_RING: "rgba(125,255,232,0.6)",
  },
  {
    // Sector 3 — VIOLET. The one candidate the design doc flagged as risky
    // ("neon purple... sits close enough to magenta/red to start competing")
    // — kept deliberately blue-leaning (hue ~258°) rather than a redder
    // magenta-purple, and judged in the browser with hostile traffic and
    // hazards on screen, not on an empty road, per that same note: at this
    // hue it reads as clearly distinct from PLAYER_THRUST's magenta (~322°)
    // and HAZARD/ENEMY's red (~0°) at speed. If a future palette pass wants
    // to push this warmer, re-run that check before shipping it.
    ROAD_EDGE: "#966eff",
    ROAD_EDGE_DIM: "#543e8f",
    ROAD_CENTERLINE: "#e0d3ff",
    BUILDING_EDGE: "#966eff",
    BUILDING_EDGE_DIM: "#543e8f",
    BUILDING_FILL: "#0d0713",
    BUILDING_FILL_SIDE: "#09050e",
    BUILDING_FILL_ROOF: "#140a1c",
    FLOOR_GRID: "rgba(150,110,255,0.14)",
    FLOOR_STREET: "rgba(150,110,255,0.055)",
    FLOOR_STREET_LINE: "rgba(189,156,255,0.4)",
    FLOOR_TRAFFIC: "rgba(189,156,255,0.6)",
    FLOOR_TICK: "rgba(150,110,255,0.3)",
    NODE_BRACKET: "#bd9cff",
    NODE_GLYPH: "#e7dcff",
    CONDUIT_LINE: "rgba(150,110,255,0.22)",
    CONDUIT_PACKET: "rgba(231,220,255,0.9)",
    PING_RING: "rgba(189,156,255,0.6)",
  },
];

// A small, fixed number, on purpose: spritecache.js's Map has NO eviction, so
// every (variant, sector) pair a building or node is ever drawn in stays
// cached forever — see sprites.js's drawBuildingVariant/drawNodeVariant.
// SECTOR_PALETTES.length rather than a bare number, so the two can never
// silently drift apart.
export const SECTOR_COUNT = SECTOR_PALETTES.length;

function mod(n, m) {
  return ((n % m) + m) % m;
}

// The live bindings every city-side module actually imports. Initialised to
// sector 0 so a page load that never calls setSector (the asset gallery,
// every test in test/) renders exactly what shipped before this sub-phase.
export let ROAD_EDGE = SECTOR_PALETTES[0].ROAD_EDGE;
export let ROAD_EDGE_DIM = SECTOR_PALETTES[0].ROAD_EDGE_DIM;
export let ROAD_CENTERLINE = SECTOR_PALETTES[0].ROAD_CENTERLINE;
export let BUILDING_EDGE = SECTOR_PALETTES[0].BUILDING_EDGE;
export let BUILDING_EDGE_DIM = SECTOR_PALETTES[0].BUILDING_EDGE_DIM;
export let BUILDING_FILL = SECTOR_PALETTES[0].BUILDING_FILL;
export let BUILDING_FILL_SIDE = SECTOR_PALETTES[0].BUILDING_FILL_SIDE;
export let BUILDING_FILL_ROOF = SECTOR_PALETTES[0].BUILDING_FILL_ROOF;
export let FLOOR_GRID = SECTOR_PALETTES[0].FLOOR_GRID;
export let FLOOR_STREET = SECTOR_PALETTES[0].FLOOR_STREET;
export let FLOOR_STREET_LINE = SECTOR_PALETTES[0].FLOOR_STREET_LINE;
export let FLOOR_TRAFFIC = SECTOR_PALETTES[0].FLOOR_TRAFFIC;
export let FLOOR_TICK = SECTOR_PALETTES[0].FLOOR_TICK;
export let NODE_BRACKET = SECTOR_PALETTES[0].NODE_BRACKET;
export let NODE_GLYPH = SECTOR_PALETTES[0].NODE_GLYPH;
export let CONDUIT_LINE = SECTOR_PALETTES[0].CONDUIT_LINE;
export let CONDUIT_PACKET = SECTOR_PALETTES[0].CONDUIT_PACKET;
export let PING_RING = SECTOR_PALETTES[0].PING_RING;

// Re-points every binding above at sector `index`'s palette. Called ONCE PER
// FRAME from game/sectors.js's update() — not only on a crossing — which is
// what lets this file stay a plain table lookup with no notion of "did the
// sector just change": that edge belongs to game/sectors.js (it also drives
// the rescan glitch and the SYS LOG line), this function only ever answers
// "what does sector N look like" for whichever N it's given, exactly like
// citygrid.js's plotAt answers "what's on this plot" with no memory of the
// last plot asked about. `index` is expected to be citygrid.js's own
// unbounded sectorIndex() output — wrapped here, not there, since how many
// looks exist to cycle through is this file's call.
export function setSector(index) {
  const p = SECTOR_PALETTES[mod(index, SECTOR_COUNT)];
  ROAD_EDGE = p.ROAD_EDGE;
  ROAD_EDGE_DIM = p.ROAD_EDGE_DIM;
  ROAD_CENTERLINE = p.ROAD_CENTERLINE;
  BUILDING_EDGE = p.BUILDING_EDGE;
  BUILDING_EDGE_DIM = p.BUILDING_EDGE_DIM;
  BUILDING_FILL = p.BUILDING_FILL;
  BUILDING_FILL_SIDE = p.BUILDING_FILL_SIDE;
  BUILDING_FILL_ROOF = p.BUILDING_FILL_ROOF;
  FLOOR_GRID = p.FLOOR_GRID;
  FLOOR_STREET = p.FLOOR_STREET;
  FLOOR_STREET_LINE = p.FLOOR_STREET_LINE;
  FLOOR_TRAFFIC = p.FLOOR_TRAFFIC;
  FLOOR_TICK = p.FLOOR_TICK;
  NODE_BRACKET = p.NODE_BRACKET;
  NODE_GLYPH = p.NODE_GLYPH;
  CONDUIT_LINE = p.CONDUIT_LINE;
  CONDUIT_PACKET = p.CONDUIT_PACKET;
  PING_RING = p.PING_RING;
}

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

// The shop's cargo drone (game/hauler.js) — the hull that comes down and lifts
// the player's car off the road. It used to borrow ENEMY red, purely because it
// was drawn for the boss-hull gallery, where everything reads as hostile
// hardware — which left the one vehicle in the game that HELPS the player
// painted like the thing about to ram them.
//
// So it sits in the PLAYER's cyan family, a few steps darker, for exactly the
// reason PICKUP_FRAME below does: nothing out there is cyan except the car the
// player is driving, so cyan is this game's word for "this one is on your
// side". A service hue of its own (purple was the candidate) was rejected
// because sector 3's city is already violet — see SECTOR_PALETTES, and the note
// there on how little room that hue has left — so the drone would have flown a
// same-hue hull against a same-hue skyline in a third of the game.
//
// DARKER than PLAYER — much darker, and by a wider margin than PICKUP_FRAME
// needs. A crate sits on the tarmac BESIDE the car; this hull closes around it,
// and the whole brief for the CLAW LIFTER (see bossshapes.js) is that the car
// stays visible through the open middle. Two cyans of similar value, overlapping
// like that, merge into one bright mass and the car stops being findable inside
// its own rescue. Judged in the browser at the lift's own scale, against four
// candidate shades with the car drawn underneath: this is the darkest step that
// still reads as lit hardware rather than a grey silhouette, and the first one
// where the car is unmistakably the brightest thing in the frame. Push it back
// toward PLAYER and that separation is what gets spent.
//
// HAULER_THRUST is the pale accent for the hull's lit details — hinge
// shoulders, avionics — where ENEMY_THRUST's orange used to sit. It stays a
// step under the car too, for the same reason.
export const HAULER = "#197c88";        // cargo-drone hull lines
export const HAULER_THRUST = "#43aab5"; // its lit details / hinge shoulders

// The pickup reticle (game/pickupshapes.js). ONE frame colour for EVERY crate,
// and it is the PLAYER's own cyan a few steps darker. Hazards are red, traffic
// is red or amber, the world is green — nothing out there is cyan except the
// car the player is driving. Painting every buff crate's frame in the car's own
// colour makes "this one is MINE, drive into it" readable at the same
// half-second range the traffic faction read works at (see ENEMY/NEUTRAL
// above), long before the glyph at the centre is legible.
//
// DARKER than PLAYER, not equal to it, for two reasons: a crate lying on the
// tarmac must not out-glow the car itself, and keeping a step between them
// stops a distant crate from reading as another cyan car. The three shades
// hold the same base -> bright -> dim relationship every other family here
// does, with BRIGHT still a step under PLAYER.
//
// This deliberately REPLACES per-kind frame tinting (ammo -> gray, boosts ->
// purple, healing -> green). Which buff it is, is the GLYPH's job; the frame
// answers the question that matters sooner — friendly, or something to dodge.
export const PICKUP_FRAME = "#2bb9bf";        // diamond edge
export const PICKUP_FRAME_BRIGHT = "#32d8e0"; // corner brackets
export const PICKUP_FRAME_DIM = "#18676b";    // inner diamond
