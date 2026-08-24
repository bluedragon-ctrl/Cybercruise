// Credits — the game's CURRENCY, as opposed to score.js's SCORE.
//
// WHY THIS IS NOT A THIRD TERM IN score.js. The two numbers are different
// animals and keeping them apart is what lets each stay honest about itself:
//
//                score.js                     wallet.js
//   lifetime     one run                      persists across runs
//   floor        none — a massacre goes red    0, always
//   spent on     nothing, it IS the reward     the Phase 11 upgrade shop
//
// score.js's header is explicit that its total is deliberately unclamped and
// that distance is its metronome. A persisted, floored, shop-facing currency
// bolted into that class would make every one of those paragraphs false. So:
// two modules, one call site each in main.js, and the shop later imports
// exactly one of them.
//
// TWO SOURCES, and neither of them is distance — that is the whole point.
// Credits are for things the player went and DID:
//
//   BOUNTIES  every destroyed car pays its type's `bounty` (cartypes.js),
//             positive for the enemy, negative for the city's own traffic.
//             A type with NO bounty pays nothing at all, which is the seam
//             Phase 10's bosses and special enemies are built on — "not every
//             enemy is worth money" is expressed by leaving the field off,
//             not by a faction check here.
//   SIPHONS   a node on the city floor (game/links.js), taken either by
//             driving up alongside it while it pings (HARVEST_RADIUS) or by
//             holding a slow uplink on it from further out (UPLINK_*). Two
//             routes, one payout — see THE TWO ROUTES below.
//
// NO DISTANCE TERM, deliberately. score.js pays for road covered because a
// player who does nothing should still watch a number move; a wallet that
// filled up on its own would make the shop a function of how long you
// survived rather than of how you drove, and would drown out both sources
// above the moment a run went long.
//
// THE FINE NEVER REACHES THE BANK. A civilian kill can wipe out everything
// earned in the CURRENT run (down to zero, never below) and can never touch
// credits banked from earlier runs. Punishing a bad run is the point; undoing
// an hour of saved-up shop progress in one accidental broadside is not.
//
// THE TWO ROUTES TO A NODE, and why there have to be two. Nodes sit on a fixed
// column grid (citygrid.js's PLOT) while the road wanders across it, so a node
// can simply be too far out for the shoulder to reach — at which point the
// only honest answers are "that one was never yours" or "there is another way
// to get it". The second is better, because the other way costs something the
// first one doesn't:
//
//   GRAB     inside HARVEST_RADIUS, while the node is pinging: instant, free,
//            and available at any speed. The reward for being in the right
//            place at the right moment.
//   UPLINK   inside UPLINK_RADIUS, on the node's side of the road, holding
//            under UPLINK_MAX_SPEED for UPLINK_TIME: slow, deliberate, and
//            available whether or not the node is lit. The reward for GIVING
//            SOMETHING UP for it.
//
// Slowing down on this road is a real price — traffic catches up from behind,
// the distance term of the score stalls, and every hostile on screen gets
// longer to work on you — which is exactly what stops the second route from
// being a free replacement for the first.
//
// BANKED AT THE END OF THE RUN, once, in bank() — not on every credit. The
// run's earnings therefore stay a clean, quotable number for the game-over
// screen, and a run abandoned mid-drive banks nothing (there is no way out of
// a run but death, so there is nothing to lose to that).

import { pingingNodes, nodeId, nodeValue, callsign, announceCityLine } from "./links.js";
import { edgesAt, centerXAt } from "./road.js";
import { glowText, neonStroke } from "../engine/neon.js";
import { GREEN_PALE, GREEN_BRIGHT, HAZARD } from "../engine/palette.js";
import * as gameConsole from "../engine/console.js";

// Where the bank lives. Same "cybercruise.*" namespace menu.js's SOUND/MUSIC
// settings already use.
export const CREDITS_KEY = "cybercruise.credits";

// How long a "+25CR" / "-15CR" award stays on the HUD, seconds. Matches
// score.js's own AWARD_FLASH: the two readouts sit in the same corner and
// blinking out of step would read as a bug rather than as two facts about the
// same kill.
const AWARD_FLASH = 1.2;

// SIPHON RANGE, px, measured from the player's car to the node's marker on the
// floor below — the one number that decides whether credits are a decision or
// a trickle.
//
// SIZED AGAINST THE ROAD, NOT BY EYE, and the relation is the whole design:
// it is STRICTLY LESS THAN road.js's ROAD_HALF_WIDTH (143). Since a payable
// node is by definition off the tarmac (offRoad below), a car sitting on the
// centre-line is at least ROAD_HALF_WIDTH from the nearest one — so with this
// under that figure, DRIVING THE MIDDLE CAN NEVER EARN A CREDIT, no matter how
// the road happens to bend. Not approximately never: never. Meanwhile a car
// scraping the shoulder is ~17px inside the barrier and reaches 113px past it,
// which covers the plot columns that actually sit beside the road.
//
// That is the trade this number exists to create: money lives at the edges,
// where the wall is and where there is nowhere to dodge to. Raise it above
// ROAD_HALF_WIDTH and the detour stops costing anything (measured: at 150 a
// centre-line drive quietly collects ~3 CR/min it did nothing for — see
// tools/econsim.js); drop it much below and the shoulder itself stops being
// enough.
export const HARVEST_RADIUS = 130;

// HOW FAR OFF A PAYABLE NODE ANNOUNCES ITSELF, px. Money the player can't see
// coming teaches nothing: without a marker, a credit that lands while you
// happen to be near the shoulder reads as a random event rather than as
// something you did, and the whole point of the range rule is that it is a
// choice. So a live node advertises its price from well outside the range it
// can actually be taken at, and the label goes BRIGHT the moment it is
// actually paying — the transition is the teacher.
//
// Comfortably wider than HARVEST_RADIUS (roughly double) so the player has
// time to decide and steer: at 350 u/s the road covers this in under two
// seconds, which is about one lane change plus the commitment to make it.
const DETECT_RADIUS = 300;

// The one-off SYS LOG line the first payable node of a run triggers — the
// thing that says out loud what the marker means. Once per run only: it is a
// tutorial line, and a tutorial line that repeats is nagging. Phrased as the
// deck reporting a capability rather than as instructions, which is the voice
// every other line in that log uses (links.js's own announcement()).
const SIPHON_HINT = "SIGNAL NODE LIVE // CLOSE ALONGSIDE TO SIPHON";

// How long a payout's own "+14CR" hangs over the SPOT IT CAME FROM, seconds,
// and how far it drifts upward while it does. Shorter than the HUD's award
// flash: that one is a running total being updated, this one is a pointer at a
// place, and the place is scrolling away underneath it.
//
// EVERY payout gets one — a siphoned node, a bounty, a fine — because the HUD
// corner can only say HOW MUCH, and on a road where three cars can go up in
// one chain reaction, WHICH ONE PAID is the half the player actually needs in
// order to do it again on purpose. It is the same lesson in both cases: money
// has a source, and the source is a thing you did to something.
const AWARD_MARK_LIFE = 0.9;
const AWARD_MARK_RISE = 26;

// Ceiling on how many of those can be in the air at once. A chain reaction can
// kill half a lane in one tick, and a stack of overlapping numbers is worse
// than no numbers at all — the oldest is dropped rather than the newest, so
// what stays on screen is what just happened.
const MAX_AWARD_MARKS = 5;

// THE UPLINK: how far out it reaches, how slow the player has to be holding
// it, and how long it takes to complete.
//
// The radius is DETECT_RADIUS itself, deliberately: everything the floor
// advertises is obtainable one way or the other, so a price tag is never a
// tease. Anything further out doesn't announce itself and can't be taken.
//
// THE SPEED CEILING is the whole cost of this route. The player's band is
// 120..620 (player.js), so this sits at the bottom quarter of it — not a
// nudge off the throttle but a genuine crawl, long enough for the traffic
// behind to arrive. Retune this before retuning the time: how SLOW is what
// the player feels, how LONG is just how long they feel it for.
const UPLINK_MAX_SPEED = 200;
// The hold, seconds — the download runs half again as fast as it first
// shipped (2.6s), because the crawl itself was carrying the cost and the extra
// second on top of it was just dead air: a player who has already given up
// their speed has made the decision, and holding them there longer only
// punishes a choice they committed to. The ceiling above is untouched, so the
// route still costs exactly what it always did — it just stops overcharging.
const UPLINK_TIME = 1.75;  // seconds held before it pays

// What the uplink route actually pays, as a fraction of the node's value.
//
// IT HAS TO BE LESS THAN THE GRAB, and time alone can't do that job: nodes
// linger on the half-speed floor plane for many seconds (scenery.js's
// FLOOR_PARALLAX), so a crawling car satisfies almost any hold time on almost
// every node that goes past — measured, a full-price uplink earned three times
// what shoulder-hugging did and made the fast route pointless (tools/
// econsim.js). Halving the payout puts the two within sight of each other
// while leaving the uplink strictly better than driving past.
//
// It also says the right thing: a node you took at speed, in its own live
// window, gave you the whole packet; one you forced out of a dormant relay by
// sitting on it gave you what it had.
const UPLINK_FRACTION = 0.5;
// Progress bleeds away rather than snapping to zero when the hold breaks, so
// clipping a car mid-uplink costs the player time rather than the whole
// attempt. Faster than it fills, so a hold that is mostly broken never
// completes by accident.
const UPLINK_DECAY = 1.5;

// THE DISH: the marker on the car itself that says an uplink is running.
//
// WHY THE CAR NEEDS ONE AT ALL, given the node already grows a fill bar. The
// bar is the instrument — how far along, to the pixel — and it lives out on
// the floor, on the thing being drained. What it cannot say is that the CAR is
// the other end of that link, and "am I currently downloading?" is a question
// the player asks with their eyes on their own car, in the middle of traffic,
// while paying for the answer in speed. So: a small dish on the flank, aimed
// at the node, with the link drawn between them.
//
// AIMED, and that is the part that teaches. The dish swings to the side the
// money is on, so the affordance answers "which way" as well as "yes" — the
// same job the SLOW prompt does for speed, done for direction.
//
// It hangs off the flank rather than sitting on the roof because the car is
// 34px wide: anything drawn on top of the wireframe competes with it, while
// anything on the outside edge is against empty tarmac. The offset clears the
// body, so the link never crosses the car it comes from.
const DISH_MAST = 9;    // px from the car's flank out to the dish's middle
const DISH_R = 6;       // the dish's own radius

// The link itself: dashes that march FROM THE NODE TOWARD THE CAR, because
// that is the direction the data is going and a beam that ran the other way
// would quietly say the player is uploading something. Speed is in px/sec of
// dash travel — brisk enough to read as flow at a glance, slow enough not to
// strobe.
const LINK_DASH = 7;
const LINK_GAP = 6;
const LINK_MARCH = 34;

// Both parts brighten as the hold fills, from "connecting" to "about to pay".
// The floor's bar is still the precise reading; this is the glance version, so
// it only has to get louder in the right direction.
const LINK_MIN_ALPHA = 0.3;

// Nodes UNDER the road pay nothing, however close they are. The city floor
// runs beneath the elevated road ribbon and the road paints an opaque surface
// over it (scenery.js's header, main.js's draw order), so a node in a column
// the road happens to be crossing is INVISIBLE — and an invisible node is the
// one thing a proximity rule must not reward, since it would pay best for
// driving dead centre and show the player nothing for it. Checked against the
// road's real edges at the node's own row, so it stays true through a bend.
function offRoad(node, worldY, W) {
  const { left, right } = edgesAt(worldY, W);
  return node.cx < left || node.cx > right;
}

// Whether the car is out on the same side of the road as the node — the
// uplink's one positional demand, and what keeps it a DECISION rather than a
// slow-motion version of driving straight. Each side is measured against the
// road's centre at ITS OWN row, so a bend can't make "the left side" mean two
// different things at two ends of the screen.
function sameSide(node, nodeWorldY, playerX, playerWorldY, W) {
  const nodeSide = Math.sign(node.cx - centerXAt(nodeWorldY, W));
  const playerSide = Math.sign(playerX - centerXAt(playerWorldY, W));
  return nodeSide !== 0 && nodeSide === playerSide;
}

// Above this many remembered ids, prune (see prune() below). Sized well past
// what a screen can hold — nodes are 6% of street-adjacent plots (citygrid.js)
// and a screen is a handful of plot columns, so a few dozen ids covers many
// screens' worth of road and the prune is a rare event rather than a per-frame
// scan.
const PRUNE_AT = 64;

// Storage, reached through this one helper rather than by touching
// localStorage directly, for two reasons: the test suite imports this module
// under plain Node (no DOM — see test/invariants.test.js's header), and a
// browser with storage disabled or a full quota should cost the player their
// bank, not their run. Both cases end up here as "no storage", and everything
// below already works with a bank that is always 0.
function storage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // some browsers THROW on the property access itself
  }
}

export function loadBanked(store = storage()) {
  if (!store) return 0;
  const raw = store.getItem(CREDITS_KEY);
  if (raw === null) return 0;
  const n = parseInt(raw, 10);
  // A corrupt or hand-edited value reads as a fresh wallet rather than as NaN
  // spreading through every total the HUD prints.
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function saveBanked(value, store = storage()) {
  if (!store) return;
  try {
    store.setItem(CREDITS_KEY, String(Math.max(0, Math.floor(value))));
  } catch {
    // Quota or private-mode refusal. The run keeps its earnings on screen;
    // only the persistence is lost, and losing it silently beats taking the
    // frame down mid-drive.
  }
}

export class Wallet {
  // `store` is injectable for the same reason links.js's announce() takes its
  // push/busy: the test suite drives this with a plain object instead of a
  // real, shared localStorage.
  constructor(store = storage()) {
    this.store = store;
    this.banked = loadBanked(store); // committed by earlier runs, read once
    this.earned = 0;                 // THIS run, never negative (see award())
    this.bounties = 0;               // credits from kills this run, gross
    this.siphoned = 0;               // credits from nodes this run
    this.nodes = 0;                  // how many nodes were siphoned

    // Which nodes this run has already paid for. THE ONE GROWING STRUCTURE in
    // the money system, and it is bounded — see prune().
    this.harvested = new Set();

    // Presentational only, exactly like score.js's own pair: the totals above
    // have already banked whatever these are flashing.
    this.lastAward = 0;
    this.awardTimer = 0;

    // What the last banked run was worth — see bank().
    this.lastRunEarnings = 0;

    // Whether this run has already explained itself once (SIPHON_HINT).
    this.hinted = false;

    // Floating "+25CR" markers over the places payouts came from — see
    // AWARD_MARK_LIFE, and mark() below for the two ways one can be anchored.
    this.marks = [];

    // The uplink in progress: which node, and how many seconds of hold it has
    // banked. ONE AT A TIME — the demand is that the player commit to a node,
    // and a rig that could quietly charge three at once would be exactly the
    // opposite of that. Switching targets starts the new one from zero.
    this.uplink = null; // { id, held }
  }

  // What the player can actually spend: earlier runs plus this run so far. The
  // HUD prints this, and the shop will read it after bank().
  get credits() {
    return this.banked + this.earned;
  }

  // Applies a signed amount to the run's earnings under the floor rule at the
  // top of this file, and flashes it. Returns what was ACTUALLY applied, which
  // is not the same as `amount` when a fine hits an empty wallet — the HUD
  // should say "-8" when 8 is all there was to take, not "-25".
  award(amount) {
    const applied = Math.max(amount, -this.earned);
    this.earned += applied;
    this.lastAward = applied;
    this.awardTimer = AWARD_FLASH;
    return applied;
  }

  // Puts a floating number over the place a payout came from. TWO ANCHORS,
  // because the two things that pay sit on DIFFERENT PLANES of this world:
  //
  //   "floor"  a node on the lower city plane, which scrolls at its own
  //            parallax rate (scenery.js) — pinned to the screen position it
  //            was taken at, since over the marker's ~1s life the floor has
  //            barely moved and re-deriving its plot position every frame
  //            would cost more than it could possibly buy.
  //   "road"   a wreck on the road plane, anchored in WORLD coordinates
  //            (worldY plus the car's own lane offset) and re-projected every
  //            frame. This one has to be exact: the road scrolls at full speed
  //            and it BENDS, so a marker pinned to a screen position would
  //            slide off the wreck it is labelling within a few frames.
  mark(entry) {
    this.marks.push({ ...entry, life: AWARD_MARK_LIFE });
    if (this.marks.length > MAX_AWARD_MARKS) this.marks.shift();
  }

  // A car has been destroyed. Takes the CAR_TYPES entry, mirroring
  // score.js's destroyed() — same call site in main.js, same "the catalogue
  // decides what a car is worth" rule, different field. A type with no
  // `bounty` does not even flash, since nothing happened financially and a
  // "+0" on the HUD would be noise.
  // `worldY`/`offset` are the wreck's own position on the road, straight off
  // the car (traffic.js) — optional, so a caller with nothing to point at (a
  // test, or any future payout with no place attached to it) still scores
  // normally and simply leaves no marker.
  destroyed(type, worldY = null, offset = 0) {
    const bounty = type.bounty ?? 0;
    if (bounty === 0) return 0;
    const applied = this.award(bounty);
    if (applied > 0) this.bounties += applied;
    // A fine shows what was ACTUALLY taken, not what the car was worth (see
    // award) — and shows nothing at all when an already-empty wallet had
    // nothing left to take, since "-0CR" over a wreck is noise.
    if (worldY !== null && applied !== 0) this.mark({ kind: "road", worldY, offset, value: applied });
    return applied;
  }

  // --- Siphoning ------------------------------------------------------------

  // Pays for every node that is pinging, in range, off the road, and not
  // already paid for this run. Called once per playing tick from main.js with
  // the node list scenery.js already built for the frame.
  //
  // `push`/`busy` ride through to links.js's shared city-line throttle exactly
  // as they do in announce(), so the test suite can watch what this says
  // without mutating the real SYS LOG.
  //
  // THE MONEY IS NOT THROTTLED, THE LINE IS. announceCityLine drops a line
  // when the log is busy or when the city spoke recently — right for chatter,
  // wrong for income, since it would make the player's earnings depend on how
  // noisy the log happened to be. So the payout happens unconditionally here
  // and only the sentence about it goes through the rate limit.
  harvest(dt, clockValue, nodes, player, distance, W, push = gameConsole.push, busy = gameConsole.isBusy) {
    let total = 0;

    // ROUTE ONE — the grab. Every node pinging inside the close radius pays at
    // once, whatever the car is doing.
    for (const n of pingingNodes(nodes, clockValue)) {
      if (!this.payable(n, player, distance, W)) continue;
      const dx = n.cx - player.x;
      const dy = n.sy - player.y;
      if (dx * dx + dy * dy > HARVEST_RADIUS * HARVEST_RADIUS) continue;
      total += this.collect(clockValue, n, push, busy);
    }

    // ROUTE TWO — the uplink. One node at a time, and only while the car is
    // holding its side of the road slowly enough to be doing it deliberately.
    total += this.holdUplink(dt, clockValue, nodes, player, distance, W, push, busy);

    if (this.harvested.size > PRUNE_AT) this.prune(nodes);
    return total;
  }

  // The three things that are true of every node either route can pay for:
  // not already taken this run, not hidden under the road, and inside the
  // radius the floor advertises. Shared by both routes and by the hint layer,
  // so a marker can never appear over something that would refuse to pay.
  payable(node, player, distance, W) {
    if (this.harvested.has(nodeId(node.bx, node.by))) return false;
    if (!offRoad(node, distance + (player.y - node.sy), W)) return false;
    return Math.hypot(node.cx - player.x, node.sy - player.y) <= DETECT_RADIUS;
  }

  // Whether an uplink could be running on this node right now — the extra
  // demands route two makes on top of payable(): the player's side of the
  // road, and a speed low enough to mean it.
  uplinkable(node, player, distance, W) {
    if (player.speed > UPLINK_MAX_SPEED) return false;
    return sameSide(node, distance + (player.y - node.sy), player.x, distance, W);
  }

  // Advances (or bleeds) the one uplink, and pays out when it completes.
  // Split out of harvest() above so the state machine can be driven directly
  // by the test suite, the same reasoning links.js splits announceActive from
  // announce.
  holdUplink(dt, clockValue, nodes, player, distance, W, push = gameConsole.push, busy = gameConsole.isBusy) {
    // The nearest node this car is currently entitled to be charging. Nearest
    // rather than best-paying: the player is steering at a place, and a rule
    // that silently preferred a further, richer node would put the meter on
    // something they weren't looking at.
    let target = null;
    let best = Infinity;
    for (const n of nodes) {
      if (!this.payable(n, player, distance, W)) continue;
      if (!this.uplinkable(n, player, distance, W)) continue;
      const d = Math.hypot(n.cx - player.x, n.sy - player.y);
      if (d < best) { best = d; target = n; }
    }

    if (!target) {
      // Nothing eligible: whatever was being held bleeds away, and is dropped
      // entirely once it's gone.
      if (this.uplink) {
        this.uplink.held -= dt * UPLINK_DECAY;
        if (this.uplink.held <= 0) this.uplink = null;
      }
      return 0;
    }

    const id = nodeId(target.bx, target.by);
    if (!this.uplink || this.uplink.id !== id) this.uplink = { id, held: 0 };
    this.uplink.held += dt;
    if (this.uplink.held < UPLINK_TIME) return 0;

    this.uplink = null;
    return this.collect(clockValue, target, push, busy, UPLINK_FRACTION);
  }

  // The payout itself, shared by both routes so they can never drift apart:
  // one entry in the claimed set, one award, one marker over the spot, one
  // line in the log.
  //
  // THE MONEY IS NOT THROTTLED, THE LINE IS. announceCityLine drops a line
  // when the log is busy or when the city spoke recently — right for chatter,
  // wrong for income, since it would make the player's earnings depend on how
  // noisy the log happened to be. So the payout happens unconditionally here
  // and only the sentence about it goes through the rate limit.
  // `fraction` is how much of the node's price this route pays — 1 for the
  // grab, UPLINK_FRACTION for the uplink. Never rounds to nothing: a node that
  // took a hold and paid zero would read as a bug.
  collect(clockValue, node, push = gameConsole.push, busy = gameConsole.isBusy, fraction = 1) {
    this.harvested.add(nodeId(node.bx, node.by));
    const value = Math.max(1, Math.round(nodeValue(node.bx, node.by) * fraction));
    this.award(value);
    this.siphoned += value;
    this.nodes++;
    // Where it happened, for the floating marker — see mark().
    this.mark({ kind: "floor", x: node.cx, y: node.sy, value });
    announceCityLine(clockValue, `${callsign(node.bx, node.by)} // SIPHON +${value}CR`, gameConsole.HINT, push, busy);
    return value;
  }

  // Forgets nodes the road has left behind, so the set above can't grow for
  // the length of a run. Safe BECAUSE ids are monotonic in the plot row
  // (links.js's nodeId) and the world only ever scrolls one way: a row below
  // everything currently on screen is a row the player can never reach again,
  // so an id from it can never come up for payment a second time.
  prune(nodes) {
    let minRow = Infinity;
    for (const n of nodes) minRow = Math.min(minRow, n.by);
    if (!Number.isFinite(minRow)) return; // no nodes on screen: nothing to
                                           // measure the watermark against,
                                           // and the set is already bounded
    const floorId = minRow * 1024;
    for (const id of this.harvested) {
      if (id < floorId) this.harvested.delete(id);
    }
  }

  // --- Run lifecycle ---------------------------------------------------------

  update(dt) {
    if (this.awardTimer > 0) this.awardTimer -= dt;
    // Backwards, so removing one doesn't skip its neighbour.
    for (let i = this.marks.length - 1; i >= 0; i--) {
      this.marks[i].life -= dt;
      if (this.marks[i].life <= 0) this.marks.splice(i, 1);
    }
  }

  // --- The affordance --------------------------------------------------------

  // Which nodes are worth SHOWING the player, and how loudly — pure data, no
  // canvas, so the whole rule is testable the same way links.js's own fields
  // are. One entry per unclaimed, reachable node inside DETECT_RADIUS:
  //
  //   value    what it pays, so the label can quote a real number
  //   live     whether it is PINGING, i.e. whether it would pay right now
  //   alpha    fades up as the player closes on it, so a node across the road
  //            doesn't shout as loudly as the one they are drawing level with
  //
  // TWO STATES, NOT ONE, and the reason is that a payout is INSTANT: the tick
  // a node starts pinging with the player already alongside is the tick it is
  // collected, so an "in range and paying" marker would flash for a single
  // frame and teach nobody anything. What the player needs to learn is earlier
  // than that — "the boxes out past the barrier are worth money, and they only
  // pay while they are lit" — so a dormant node in reach still wears its price
  // faintly, and going live is what brightens it. The pair reads as a thing
  // waiting to be worth taking.
  //
  // Everything else harvest() insists on is enforced here too (unclaimed, off
  // the road): a marker over a node that could not be collected would be the
  // HUD lying, and this game's HUD does not lie.
  hints(clockValue, nodes, player, distance, W) {
    const live = new Set(pingingNodes(nodes, clockValue).map((n) => nodeId(n.bx, n.by)));
    const out = [];
    for (const n of nodes) {
      if (!this.payable(n, player, distance, W)) continue;

      const id = nodeId(n.bx, n.by);
      const dist = Math.hypot(n.cx - player.x, n.sy - player.y);
      const lit = live.has(id);
      const grabbable = lit && dist <= HARVEST_RADIUS;
      out.push({
        x: n.cx, y: n.sy,
        // THE PRICE THIS PLAYER WOULD ACTUALLY GET, not the node's headline
        // value: a label quoting the full price while the car is on course to
        // collect half of it would be the HUD lying about money, which is the
        // one thing it may never do. A node that is lit and in reach quotes
        // full; anything else quotes the uplink's share, since that is the
        // route still open to it.
        value: grabbable
          ? nodeValue(n.bx, n.by)
          : Math.max(1, Math.round(nodeValue(n.bx, n.by) * UPLINK_FRACTION)),
        full: grabbable,
        live: lit,
        // How far the uplink on THIS node has got, 0..1 — the meter the player
        // watches while paying the speed for it.
        uplink: this.uplink && this.uplink.id === id ? Math.min(1, this.uplink.held / UPLINK_TIME) : 0,
        // Whether the ONLY thing standing between the car and this node is the
        // throttle: right side of the road, in reach, going too fast. This is
        // what earns the "SLOW" prompt, and it is the whole reason a node out
        // past the shoulder is not just a tease.
        slow: !live.has(id)
          && dist > HARVEST_RADIUS
          && player.speed > UPLINK_MAX_SPEED
          && sameSide(n, distance + (player.y - n.sy), player.x, distance, W),
        // Fades up over the approach, full once inside the radius that pays on
        // sight.
        alpha: dist <= HARVEST_RADIUS
          ? 1
          : 0.3 + 0.7 * (1 - (dist - HARVEST_RADIUS) / (DETECT_RADIUS - HARVEST_RADIUS)),
      });
    }
    return out;
  }

  // The one-off teaching line, pushed the first time a run puts a payable node
  // in front of the player. Goes through links.js's shared city-line throttle
  // like every other thing the floor says — but unlike a siphon payout, THIS
  // one may be dropped by the throttle without costing the player anything, so
  // the flag is only set when the line actually went out.
  hint(clockValue, anyHint, push = gameConsole.push, busy = gameConsole.isBusy) {
    if (this.hinted || !anyHint) return false;
    this.hinted = announceCityLine(clockValue, SIPHON_HINT, gameConsole.HINT, push, busy);
    return this.hinted;
  }

  // Draws the markers over the city floor. One of the two functions in this
  // file that touch a canvas — this one and renderUplink() below, kept at the
  // bottom behind the same wall links.js puts between its own pure fields and
  // its two draw calls.
  //
  // Cost is bounded by what hints() returns, which the range rule holds to
  // "the odd node beside the player" — nowhere near the per-frame node walk
  // the floor already pays for.
  renderHints(ctx, clockValue, nodes, player, distance, W) {
    const marks = this.hints(clockValue, nodes, player, distance, W);
    for (const m of marks) {
      ctx.save();
      // A dormant node's price is a hint, not an offer — held well under the
      // live one so the two never compete for the same glance. A node being
      // uplinked reads as live whatever its ping is doing, because it is: the
      // player is taking it right now.
      const hot = m.live || m.uplink > 0;
      ctx.globalAlpha = m.alpha * (hot ? 1 : 0.45);
      glowText(ctx, `+${m.value}CR`, m.x, m.y + 22, hot ? GREEN_BRIGHT : GREEN_PALE, 11, "center", hot ? 10 : 4);

      // THE UPLINK METER: a plain bar under the price, filling as the hold is
      // banked. No glow and no neonStroke — this is an instrument, like the
      // hull bar, and it has to be readable at a glance while the player is
      // watching traffic rather than watching it.
      if (m.uplink > 0) {
        const bw = 38;
        const bx = m.x - bw / 2;
        const by = m.y + 28;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(bx - 1, by - 1, bw + 2, 5);
        ctx.fillStyle = GREEN_BRIGHT;
        ctx.fillRect(bx, by, bw * m.uplink, 3);
      } else if (m.slow) {
        // The prompt, and the only place this game tells the player what to
        // do: they are on the right side of the road with a node in reach and
        // nothing between them and it but speed.
        glowText(ctx, "SLOW", m.x, m.y + 34, GREEN_PALE, 9, "center", 4);
      }
      ctx.restore();
    }

    // The receipts: what each recent payout was worth, hanging over the place
    // it came from and drifting up as it fades. Drawn even when the thing that
    // paid is gone — a collected node has stopped pinging and a destroyed car
    // has left the road entirely, which is the point: these are not labels on
    // objects, they are labels on things that HAPPENED.
    for (const m of this.marks) {
      const frac = Math.max(0, m.life / AWARD_MARK_LIFE);
      // Where it sits this frame — see mark() on why the road plane has to be
      // re-projected while the floor plane does not.
      const x = m.kind === "road" ? centerXAt(m.worldY, W) + m.offset : m.x;
      // `player.y` is the screen row the car is drawn at — the same projection
      // every entity on the road plane uses in main.js's render.
      const y = (m.kind === "road" ? player.y - (m.worldY - distance) : m.y) - (1 - frac) * AWARD_MARK_RISE;
      ctx.save();
      ctx.globalAlpha = frac;
      // Red for a fine, in the same HAZARD the HUD's own award uses — the one
      // place money is allowed to borrow a faction colour, because here it IS
      // reporting on a faction: the car under this number was a civilian.
      glowText(ctx, `${m.value >= 0 ? "+" : ""}${m.value}CR`, x, y, m.value >= 0 ? GREEN_BRIGHT : HAZARD, 13, "center", 12, true);
      ctx.restore();
    }
  }

  // WHERE THE LINK RUNS THIS FRAME, or null when nothing is being uplinked:
  // the node end, the car end, and how far along the hold is. Pure, and split
  // out of the drawing below for the same reason hints() is split out of
  // renderHints() — the geometry is checkable without a canvas, and the only
  // thing left in the render method is ink.
  //
  // `carX` is the car's INTERPOLATED position (player.renderX), not player.x:
  // the dish is bolted to a car being drawn between two logic steps, and a
  // dish that used the logic position would swim against its own car.
  //
  // The node is looked up in the list the floor just drew rather than being
  // remembered when the hold started, so the link is always attached to where
  // that node actually is on screen — it scrolls down the floor plane while
  // the hold runs, and a cached position would leave the beam pointing at a
  // spot the node had already left.
  uplinkLink(nodes, player, carX) {
    if (!this.uplink) return null;
    const node = nodes.find((n) => nodeId(n.bx, n.by) === this.uplink.id);
    if (!node) return null;

    const dx = node.cx - carX;
    const dy = node.sy - player.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return null; // degenerate; nothing sane to aim at

    // Which flank the dish rides: the node's side, always, since that is the
    // half of the answer the floor's own meter cannot give.
    const side = dx >= 0 ? 1 : -1;
    const ax = carX + side * (player.w / 2);
    const ux = dx / len, uy = dy / len;
    return {
      // The mast's foot on the car's flank, and the dish's middle out past it.
      ax, ay: player.y,
      dx: ax + ux * DISH_MAST, dy: player.y + uy * DISH_MAST,
      // The far end: the node itself.
      nx: node.cx, ny: node.sy,
      // Unit vector from car to node — the direction the dish faces and the
      // line the dashes travel along.
      ux, uy,
      progress: Math.min(1, this.uplink.held / UPLINK_TIME),
    };
  }

  // THE DISH AND ITS LINK. Drawn from main.js immediately AFTER the car, so
  // the dish sits on the car rather than under it — and drawn in two
  // neonStrokes rather than a dozen (see neon.js on why the path is batched):
  // one for the link's dashes, one for the dish and its mast.
  //
  // The second function in this file that touches a canvas, and the only one
  // that draws in the CAR's layer rather than on the city floor — which is
  // exactly the point of it (see THE DISH above).
  renderUplink(ctx, clockValue, nodes, player, carX) {
    const link = this.uplinkLink(nodes, player, carX);
    if (!link) return;

    // Faint at the moment the link takes, bright as it comes good.
    const alpha = LINK_MIN_ALPHA + (1 - LINK_MIN_ALPHA) * link.progress;

    // THE LINK: dashes marching node -> car. `clockValue` drives the march, so
    // it keeps step with the same floor clock the nodes' own pings run on and
    // stops dead when the game does.
    const start = DISH_MAST + DISH_R;                       // clear of the dish's mouth
    const span = Math.hypot(link.nx - link.ax, link.ny - link.ay) - start;
    if (span > 0) {
      const period = LINK_DASH + LINK_GAP;
      // Subtracted, not added: the pattern slides back down the beam toward
      // the car, which is the direction the credits are going.
      const phase = (clockValue * LINK_MARCH) % period;
      neonStroke(ctx, (c) => {
        for (let d = span - phase; d > 0; d -= period) {
          const from = Math.max(0, d - LINK_DASH);
          c.moveTo(link.ax + link.ux * (start + from), link.ay + link.uy * (start + from));
          c.lineTo(link.ax + link.ux * (start + d), link.ay + link.uy * (start + d));
        }
      }, GREEN_BRIGHT, 1.5, 3.5, 0.12, alpha * 0.8);
    }

    // THE DISH: a mast off the flank, a half-circle whose OPEN side faces the
    // node (the bulge points back at the car, the way a real dish's does), and
    // a stub feed horn standing in its mouth.
    const theta = Math.atan2(link.uy, link.ux);
    neonStroke(ctx, (c) => {
      c.moveTo(link.ax, link.ay);
      c.lineTo(link.dx, link.dy);
      c.moveTo(link.dx + Math.cos(theta + Math.PI / 2) * DISH_R,
               link.dy + Math.sin(theta + Math.PI / 2) * DISH_R);
      c.arc(link.dx, link.dy, DISH_R, theta + Math.PI / 2, theta + Math.PI * 1.5);
      c.moveTo(link.dx, link.dy);
      c.lineTo(link.dx + link.ux * DISH_R * 0.8, link.dy + link.uy * DISH_R * 0.8);
    }, GREEN_BRIGHT, 1.5, 3.5, 0.14, alpha);
  }

  // 0..1 while an award is still worth drawing, 0 once it has faded — same
  // contract as score.js's awardAlpha, read by the same HUD.
  get awardAlpha() {
    return Math.max(0, this.awardTimer / AWARD_FLASH);
  }

  // Commits this run's earnings. Called once, from main.js, at the moment the
  // player dies — not when the game-over screen finally appears, so a player
  // who closes the tab during the death sequence still keeps what they earned.
  // Idempotent: a second call banks nothing, because `earned` is zeroed here.
  bank() {
    if (this.earned <= 0) return this.banked;
    // Kept so the game-over screen can quote what THIS run was worth after the
    // earnings themselves have moved into the bank — the screen appears a
    // couple of seconds after bank() runs (main.js banks at the moment of
    // death, not when the menu opens), so it can't read `earned` any more.
    this.lastRunEarnings = this.earned;
    this.banked += this.earned;
    this.earned = 0;
    saveBanked(this.banked, this.store);
    return this.banked;
  }

  // Spends credits — the shop's entry point (Phase 11), here now because the
  // floor rule belongs with the rest of the money arithmetic rather than in a
  // screen. Refuses rather than overdrawing, and persists immediately: a
  // purchase is a decision the player made, not run earnings waiting on the
  // outcome of a drive.
  spend(amount) {
    if (amount <= 0 || amount > this.credits) return false;
    // Comes out of the bank first, then out of the current run's earnings —
    // matters only if a shop is ever opened mid-run, which Phase 11 may or may
    // not do; either way the total the player sees is the one that moves.
    const fromBank = Math.min(this.banked, amount);
    this.banked -= fromBank;
    this.earned -= amount - fromBank;
    saveBanked(this.banked, this.store);
    return true;
  }
}
