// Links and pings (Phase 7e) — signals moving between the nodes 7d planted.
// 7d gave the floor its facilities; this is what makes them mean something:
// a conduit running off toward the rest of the network, a ping that says a
// node is live right now, and — since this landed after the in-game SYS LOG
// (engine/console.js) shipped — a callsign read out the instant a ping
// starts. Without the console line these are two pretty circles; with it,
// the floor is talking to the deck.
//
// A CONDUIT ANCHORS AT ONE NODE, NOT TWO. The obvious reading of "a line
// between two nodes" doesn't survive contact with citygrid.js's own
// NODE_CHANCE (0.06 of street-adjacent plots — see its own comment): two
// nodes on screen AT ONCE is uncommon, so a conduit that only exists in that
// coincidence would almost never be drawn. Anchoring at one node and running
// off along a heading derived from ITS OWN plot index, to a destination that
// is usually off screen, is both more available (every visible node gets a
// conduit, not just the rare pair) and better fiction — a signal heading
// somewhere beyond the horizon reads as a city-wide network, where a closed
// A-to-B line reads as two boxes with a wire between them. If two nodes
// happen to be on screen and their headings point at each other, that's a
// nice accident; nothing here engineers it.
//
// EVERYTHING BUT THE CONSOLE VOICE IS A PURE FUNCTION OF (clock, node index)
// — same rule as every other per-frame layer on this floor (scenery.js's
// traffic dots, drones.js's own header). conduitField/pingField/announcement
// below take plain data in and return plain data out, so
// test/invariants.test.js can exercise the motion under plain Node with no
// canvas anywhere in the call path; drawConduits/drawPings are the only
// functions here that touch ctx.
//
// THE CONSOLE VOICE IS THE ONE EXCEPTION, and it is the ONLY thing on this
// floor that keeps state at all. Every other layer is a pure function of
// position or time; "a ping just started" is inherently an EDGE, and an edge
// needs memory to detect — see announce() below for what the design doc asks
// to keep that memory to (one scalar: the identity of the last node
// announced), and why.
//
// COST. Genuinely per-frame paths, same as drones.js (7c actually got there
// first — see the design doc's own correction). NO ctx.shadowBlur: the glow
// is neonStroke's own overdraw, same trade drones.js makes and for the same
// reason — a shadow on a path spanning much of the canvas was measured at
// ~0.5ms/frame on its own (see scenery.js's grid-tile header). Batched by
// colour: every conduit's dash in one path, every packet dot in one fill,
// every ping arc gets its own stroke ONLY because pings need independent
// fade alpha a shared path can't express — see drawPings' own comment for
// why that's still "batched", just bounded a different way than the other
// two. Bounded by the visible node walk (scenery.js's visibleNodes) — a
// conduit or ping belonging to a node that isn't on screen costs nothing,
// because it is never constructed in the first place.

import { clock, FLOOR_PARALLAX, visibleNodes } from "./scenery.js";
import { neonStroke } from "../engine/neon.js";
import { CONDUIT_LINE, CONDUIT_PACKET, PING_RING } from "../engine/palette.js";
import * as gameConsole from "../engine/console.js";

// Deterministic hash -> [0, 1) from any number (same trick as road.js,
// scenery.js, citygrid.js and drones.js — each file keeps its own copy
// rather than sharing one, per those files' own comments on why).
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

// --- Conduits ------------------------------------------------------------

// Nominal length a conduit's packet phase runs over, px. Not a claim about
// how far the drawn line reaches (that's clipped to the viewport below) —
// just long enough that, from any point inside a 600x800-ish screen, most
// headings exit the visible rect well before this runs out (the screen's own
// diagonal is ~1000px), which is what makes "usually off screen" true
// without a special case for it.
const CONDUIT_LENGTH = 900;
const PACKET_SPEED = 120; // px/s along the conduit — tuned by eye, faster
                           // than the floor's own traffic (DOT_SPEED_A/B,
                           // scenery.js) so a packet reads as data, not a car
const CONDUIT_DASH = [5, 7];
const CONDUIT_WIDTH = 1;
const PACKET_SIZE = 3; // px square, the packet dot's own body
const CONDUIT_MARGIN = 4; // matches DOT_MARGIN/DRONE_MARGIN's own reasoning:
                           // clip a hair past the edge rather than at it, so
                           // nothing pops in already half-cut

// A conduit's own heading, derived from its node's plot index alone — a
// bounded set in principle (any angle is reachable) but fixed FOR that node
// forever, the same "index picks a fixed look" rule drones.js's own
// DRONE_HEADINGS table follows, just continuous here instead of a small
// table: a conduit has no reason to avoid axis-alignment with the street
// grid the way a drone avoids the ground lanes' own headings, since it reads
// as a signal line rather than as more traffic either way.
function conduitSeed(bx, by) {
  return bx * 91711 + by * 51151 + 8009; // this module's own seed space,
                                          // distinct from citygrid's NODE
                                          // roll and from this file's own
                                          // ping/callsign seeds below
}
function conduitHeading(bx, by) {
  const angle = hash(conduitSeed(bx, by)) * Math.PI * 2;
  return { hx: Math.cos(angle), hy: Math.sin(angle) };
}

// How far along the outward ray from (ax, ay), heading (hx, hy), the point
// stays within the viewport (plus CONDUIT_MARGIN) — the diagonal-line
// clipping drones.js's laneSpan already does, simplified: a conduit only
// ever runs FORWARD from its anchor (s=0, which is always on screen, since
// every node this is called for came from visibleNodes), so there is only an
// upper bound to find, never a lower one.
function conduitClip(ax, ay, hx, hy, W, H) {
  let maxS = CONDUIT_LENGTH;
  if (hx > 1e-6) maxS = Math.min(maxS, (W + CONDUIT_MARGIN - ax) / hx);
  else if (hx < -1e-6) maxS = Math.min(maxS, (-CONDUIT_MARGIN - ax) / hx);
  if (hy > 1e-6) maxS = Math.min(maxS, (H + CONDUIT_MARGIN - ay) / hy);
  else if (hy < -1e-6) maxS = Math.min(maxS, (-CONDUIT_MARGIN - ay) / hy);
  return Math.max(0, maxS);
}

// Every conduit visible this frame, as plain data — no canvas anywhere in
// this function, mirroring droneField/trafficDots. `nodes` is expected to be
// scenery.js's own visibleNodes() output (each carrying bx/by — see that
// function's own comment on why); this never re-derives which nodes are on
// screen, it only draws a line off whichever ones the caller already found.
//
// The packet's position is `pos = (t * speed + offset) mod length` exactly
// as the design doc asks — a PHASE, not an entity: nothing here is spawned,
// freed or stored per-packet, `packet` is just null on frames where the
// phase currently sits beyond the clipped, on-screen stretch of its own
// conduit (the far side of it, off in the city the fiction implies is out
// there, not drawn because there's nothing at that screen position to draw).
export function conduitField(clockValue, nodes, W, H) {
  const conduits = [];
  for (const n of nodes) {
    const { hx, hy } = conduitHeading(n.bx, n.by);
    const maxS = conduitClip(n.cx, n.sy, hx, hy, W, H);
    if (maxS <= 0) continue; // heading points straight off the edge from a
                              // node already sitting on it — degenerate, and
                              // rare enough not to be worth a special case
    const phase = hash(conduitSeed(n.bx, n.by) + 3) * CONDUIT_LENGTH;
    const s = mod(clockValue * PACKET_SPEED + phase, CONDUIT_LENGTH);
    const packet = s <= maxS ? { x: n.cx + hx * s, y: n.sy + hy * s } : null;
    conduits.push({
      x1: n.cx, y1: n.sy,
      x2: n.cx + hx * maxS, y2: n.sy + hy * maxS,
      packet,
    });
  }
  return conduits;
}

// --- Pings -----------------------------------------------------------------

// A ping is a short, expanding-and-fading WINDOW inside an otherwise idle
// per-node cycle — period and phase offset both hash-derived from the node's
// own index, so which nodes are pinging (and when) is fixed by the floor
// itself, not rolled. Kept slow (period) and short (duration) on purpose:
// "every couple of seconds from a rare node reads as infrastructure; every
// half second reads as a screensaver" (design doc). Since at most ~1-2 nodes
// are ever visible at once (citygrid.js's own NODE_CHANCE), a ~15-24% duty
// cycle per node already keeps "1-2 alive at once across the whole screen"
// true without needing to cap the list itself.
const PING_PERIOD_MIN = 4.5;
const PING_PERIOD_MAX = 9;
const PING_DURATION = 1.6;
const PING_MAX_RADIUS = 34;

function pingSeed(bx, by) {
  return bx * 60013 + by * 40009 + 9001; // distinct seed space from the
                                          // conduit/callsign ones above/below
}

// Where node (bx, by) sits in its own ping cycle at clockValue — null outside
// the active window. Pure function of (clockValue, bx, by): the period and
// its phase offset are both hash-derived constants for a given node, so
// "is this node pinging right now, and how far into it" needs no state at
// all — only ANNOUNCING that it just started does (see announce() below).
function pingState(bx, by, clockValue) {
  const seed = pingSeed(bx, by);
  const period = PING_PERIOD_MIN + hash(seed + 1) * (PING_PERIOD_MAX - PING_PERIOD_MIN);
  const offset = hash(seed + 2) * period;
  const t = mod(clockValue + offset, period);
  if (t >= PING_DURATION) return null;
  const frac = t / PING_DURATION;
  return { radius: frac * PING_MAX_RADIUS, alpha: 1 - frac };
}

// Every ping ring alive this frame, as plain data — mirrors conduitField:
// takes visibleNodes() output, produces at most one ring per node, never
// invents a node of its own.
export function pingField(clockValue, nodes) {
  const pings = [];
  for (const n of nodes) {
    const state = pingState(n.bx, n.by, clockValue);
    if (!state) continue;
    pings.push({ x: n.cx, y: n.sy, radius: state.radius, alpha: state.alpha });
  }
  return pings;
}

// --- The console voice -------------------------------------------------------

// A-Z minus I/O — both read too easily as 1/0 at 11px in a monospace HUD
// font, and this is exactly the kind of label a player has to tell apart at
// a glance while driving.
const CALLSIGN_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const STATUSES = ["UPLINK", "SWEEP", "RELAY", "SYNC", "TRACE", "CARRIER LOCK", "HANDSHAKE", "PING"];

function callsignSeed(bx, by) {
  return bx * 104729 + by * 65521 + 5003; // this module's own seed space,
                                           // distinct from citygrid's NODE
                                           // roll and from conduit/ping above
}

// A node's stable name, derived from its plot index the same deterministic
// way every other look on this floor is (citygrid.js's own hash trick) —
// same (bx, by) in, same callsign out, every time, forever. THAT'S the whole
// point: it's what turns the log from noise into something recognisable, a
// name the player can drive past twice and notice is the same node — and
// it's free, since placement (citygrid.js's reserve()) is already a pure
// function of the index with nothing to keep in sync.
export function callsign(bx, by) {
  const seed = callsignSeed(bx, by);
  const letter = CALLSIGN_LETTERS[Math.floor(hash(seed) * CALLSIGN_LETTERS.length)];
  const sector = 10 + Math.floor(hash(seed + 1) * 90);
  const suffix = 1 + Math.floor(hash(seed + 2) * 9);
  return hash(seed + 3) < 0.5
    ? `NODE ${sector}${letter}-${suffix}`
    : `GRID-${letter}${sector}`;
}

function statusFor(bx, by) {
  const seed = bx * 40361 + by * 20707 + 6007; // own seed space again
  return STATUSES[Math.floor(hash(seed) * STATUSES.length)];
}

// The full console line for node (bx, by) — a pure function, so the test
// suite can sample it across many indices directly. `severity` rides along
// as a FIELD rather than being passed literally wherever this gets pushed,
// so "every city line is HINT" is something the test suite can assert about
// the data instead of trusting every call site to remember it: WARN/
// CRITICAL map to NEUTRAL/HAZARD in console.js — gameplay FACTION colours —
// and the whole colour discipline this floor follows exists to protect that
// half-second faction read (see palette.js's own header). A sector callsign
// flashing hazard-red would read as a threat that isn't there.
export function announcement(bx, by) {
  return { text: `${callsign(bx, by)} // ${statusFor(bx, by)}`, severity: gameConsole.HINT };
}

// Packs a plot index into the one scalar announce() below remembers. bx
// stays tiny (a screen's worth of plot columns — plotColumns(W), a handful
// even at fullscreen widths) for as long as this game has screens, so a
// factor of 1024 leaves by all the room it could plausibly reach over a run
// (by grows with distance driven; even hours of continuous play stays many
// orders of magnitude under it) with no collision.
function nodeId(bx, by) {
  return by * 1024 + bx;
}

// Minimum gap, in clock seconds, between two city lines — the hard ceiling
// the design doc asks for ("roughly one city line every several seconds")
// regardless of how often nodes actually start pinging. Backstop for
// isBusy() below rather than a replacement for it: isBusy() keeps city
// chatter off the log AT ALL while it's showing real content, and this caps
// how fast it can talk even across the quiet stretches where isBusy() alone
// would let it.
//
// SHARED, not just this file's own. Phase 7f's sector crossings (game/
// sectors.js) are city chatter too — a new region announcing itself the
// instant a node also starts pinging shouldn't get a line of its own on top
// of this one, or the two features would double the log's actual "how often
// can the city talk" rate despite each individually respecting it. One
// clock, below, shared by both — see announceCityLine.
const CITY_LINE_MIN_INTERVAL = 6;

// THE ONE SCALAR THIS FLOOR KEEPS. Everything above is a pure function of
// position or time; "a ping just started" is inherently an edge, and
// detecting an edge needs to remember which side of it the last frame was
// on. Kept to the minimum the design doc asks for: not which nodes have
// EVER pinged, not a per-node cooldown, just the identity of whichever node
// is the CURRENTLY active announcement (or null) — so a ping that stays
// alive across many frames announces once, and the same node's NEXT cycle
// (after the log goes quiet on it again) announces again, because that's a
// fresh edge too.
let lastAnnouncedId = null;
let lastCityLineAt = -Infinity;

// THE SHARED THROTTLE ITSELF. Anything on the floor that wants to speak in
// the SYS LOG as "city chatter" — a node's ping starting (below) or a
// sector's own crossing (game/sectors.js) — goes through here rather than
// calling gameConsole.push() directly, so the two features can't bypass each
// other's rate limit by each keeping a clock of their own. Returns whether
// the line actually went out, in case a future caller ever needs to know.
export function announceCityLine(clockValue, text, severity, push = gameConsole.push, busy = gameConsole.isBusy) {
  if (busy()) return false;
  if (clockValue - lastCityLineAt < CITY_LINE_MIN_INTERVAL) return false;
  push(text, severity);
  lastCityLineAt = clockValue;
  return true;
}

// Pure: of the nodes currently on screen, which one (if any) is CURRENTLY
// mid-ping at clockValue. "1-2 alive at once" (pingState's own comment)
// makes picking the first a non-issue in practice, and the rate limit in
// announceActive below would mostly suppress a second simultaneous start
// anyway — there is nothing to gain from tracking more than one.
//
// Split out from announceActive below so the test suite can drive the
// STATE MACHINE (announceActive) with a synthetic node sequence, without
// needing real geography to put a node on screen at an exact clock value —
// this is the piece that actually depends on visibleNodes/pingState.
export function activePing(nodes, clockValue) {
  for (const n of nodes) {
    if (pingState(n.bx, n.by, clockValue)) return n;
  }
  return null;
}

// THE STATE MACHINE ITSELF: pushes one SYS LOG line the moment `active`'s
// identity changes from whatever it was last call, and does nothing on every
// call in between — which is what makes a ping that stays active across many
// frames announce once rather than once per frame, and the SAME node's next
// cycle (after `active` has gone back to null in between, a fresh edge)
// announce again. `active` is a node object ({ bx, by, ... }) or null, and
// is expected to come from activePing() above — this function itself never
// calls it, which is what lets the test suite exercise the edge logic with a
// hand-built sequence instead of real timing.
//
// `push`/`busy` default to the real console.js, and exist as parameters (not
// a hard import call) so test/invariants.test.js can drive this function
// with a counting stub instead of mutating the real, singleton SYS LOG —
// the same reasoning main.js's own onCarDestroyed/fireShot/dropMine take
// callbacks rather than importing their targets directly.
export function announceActive(clockValue, active, push = gameConsole.push, busy = gameConsole.isBusy) {
  const activeId = active ? nodeId(active.bx, active.by) : null;
  if (activeId === lastAnnouncedId) return; // no edge — either still the
                                             // same ping, or still quiet
  lastAnnouncedId = activeId;
  if (activeId === null) return; // the edge was a ping ENDING, not starting

  const msg = announcement(active.bx, active.by);
  announceCityLine(clockValue, msg.text, msg.severity, push, busy);
}

// The real thing: re-derives which nodes are on screen right now and hands
// the result to the state machine above. Called from main.js's update(),
// once per tick, after `distance` has been advanced for it — the same
// "playing"-only cadence scenery.update/gameConsole.update already run on,
// so this reads the SAME `clock` those freeze with (pause, death) rather
// than a second one of its own.
export function announce(clockValue, distance, playerY, W, H, push = gameConsole.push, busy = gameConsole.isBusy) {
  const fDist = Math.round(distance * FLOOR_PARALLAX);
  const nodes = visibleNodes(fDist, playerY, W, H);
  announceActive(clockValue, activePing(nodes, clockValue), push, busy);
}

export function reset() {
  lastAnnouncedId = null;
  lastCityLineAt = -Infinity;
}

// --- Drawing -----------------------------------------------------------------

function drawConduits(ctx, conduits) {
  if (conduits.length === 0) return;

  // Every conduit's dash in ONE batched, dashed neonStroke call — the
  // per-frame cost this pays is bounded by the visible node count, not by a
  // call per conduit (see this file's header).
  ctx.save();
  ctx.setLineDash(CONDUIT_DASH);
  neonStroke(ctx, (c) => {
    for (const link of conduits) {
      c.moveTo(link.x1, link.y1);
      c.lineTo(link.x2, link.y2);
    }
  }, CONDUIT_LINE, CONDUIT_WIDTH, 3);
  ctx.restore();

  // Every LIVE packet dot in one rect batch/fill — no ctx.shadowBlur, the
  // "bright" in "a single bright packet dot" is CONDUIT_PACKET's own alpha,
  // same trade scenery.js's floor traffic and drones.js's own bodies make.
  let any = false;
  ctx.beginPath();
  for (const link of conduits) {
    if (!link.packet) continue;
    any = true;
    const { x, y } = link.packet;
    ctx.rect(x - PACKET_SIZE / 2, y - PACKET_SIZE / 2, PACKET_SIZE, PACKET_SIZE);
  }
  if (any) {
    ctx.fillStyle = CONDUIT_PACKET;
    ctx.fill();
  }
}

// One neonStroke call PER ACTIVE PING, not per node — and not one shared
// batched path either, unlike the dashes/packets above. A ping's alpha fades
// over its own lifetime (pingState's `alpha`), and a single ctx.stroke() call
// can only carry one alpha for everything drawn in it, so batching every
// ring into one path would force them all to share one fade — wrong the
// moment two rings are mid-cycle at different points in it. This still
// costs nothing extra in practice: pingField is independently bounded to
// "1-2 alive at once" by the ping duty cycle (see pingState's own comment),
// regardless of how many nodes happen to be on screen, so this never scales
// with the node count the dash/packet batching above exists to bound.
function drawPings(ctx, pings) {
  for (const p of pings) {
    neonStroke(ctx, (c) => {
      c.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    }, PING_RING, 1.5, 3, 0.13, p.alpha);
  }
}

// Draw order: called from main.js right after scenery.render() (which draws
// the nodes these attach to) and before drones.render() — conduits and pings
// are ground-plane annotation, the same plane as the nodes themselves, not
// the sky band drones occupy above it.
//
// Recomputes fDist itself rather than having it threaded through, same
// reasoning drones.js's own render() gives for doing the same with its own
// copy: both are one-liners off the same `distance`.
export function render(ctx, distance, playerY, W, H) {
  const fDist = Math.round(distance * FLOOR_PARALLAX);
  const nodes = visibleNodes(fDist, playerY, W, H);
  if (nodes.length === 0) return;
  drawConduits(ctx, conduitField(clock, nodes, W, H));
  drawPings(ctx, pingField(clock, nodes));
}
