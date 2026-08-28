// Credits — the game's CURRENCY, as opposed to score.js's SCORE.
//
// Two numbers, two modules, because each constraint below would make a
// paragraph of the other's header false:
//
//                score.js                     wallet.js
//   lifetime     one run                      persists across runs*
//   floor        none — a massacre goes red    0, always
//   spent on     nothing, it IS the reward     the upgrade shop
//
// * PERSISTENCE IS BUILT AND SWITCHED OFF. main.js builds its Wallet with a
// null store (see CREDIT_STORE there), so `banked` is always 0 and credits die
// with the run. The reason is not technical: a localStorage bank belongs to a
// browser rather than to a player, and until the game keeps per-player records
// (README's Phase 13) that is a balance people lose by changing device. The
// bank, loadBanked/saveBanked and their tests all still work — turning them on
// is passing a real store at that one call site. Read "persists" below as
// "persists whenever a store is supplied".
//
// TWO SOURCES, AND NEITHER IS DISTANCE. Credits are for what the player went
// and DID:
//
//   BOUNTIES  every destroyed car pays its type's `bounty` (cartypes.js),
//             positive for the enemy, negative for the city's own traffic. A
//             type with NO bounty pays nothing — that omission is the seam
//             bosses and special enemies are built on, rather than a faction
//             check here.
//   SIPHONS   a node on the city floor (game/links.js), drained by holding a
//             link on it from the shoulder. See THE LINK below.
//
// score.js pays for road covered so a player who does nothing still watches a
// number move. A wallet that filled on its own would make the shop a function
// of how long you survived rather than how you drove, and would drown out both
// sources above on any long run.
//
// THE FINE NEVER REACHES THE BANK. A civilian kill can wipe out everything
// earned in the CURRENT run (to zero, never below) and can never touch credits
// banked earlier. Punishing a bad run is the point; undoing an hour of saved
// progress in one accidental broadside is not.
//
// THE LINK — the one way a node is ever taken.
//
// REJECTED: two mechanics, an instant GRAB up close while the node pinged and a
// slow UPLINK from further out at half price. Both worked and together they
// were unlearnable — which one you got depended on whether the node happened to
// be lit, which the player cannot predict, so the same approach to the same
// node produced two mechanics at two prices with an invisible boundary.
//
// Now the charge rate is set by distance alone: point blank completes in
// LINK_NEAR_TIME and reads as instant, the edge of reach takes LINK_FAR_TIME,
// and there is no threshold anywhere between them.
//
// SPEED IS THE PRICE BUT NOT A RULE — nothing here reads the throttle. Speed
// decides how long the car stays in range: at 620 only a close node finishes,
// at a crawl you drain one out past the barrier. Slowing still costs what it
// always did (traffic closes, the score's distance term stalls, every hostile
// gets longer to work on you), but the player learns one sentence instead of a
// number: GET NEAR IT AND STAY NEAR IT.
//
// THE PING NO LONGER GATES MONEY — that was the coin-flip half of the old
// confusion. It is the node advertising itself, and still worth steering at.
//
// BANKED ONCE, in bank(), at the end of the run — not on every credit. The
// run's earnings stay a clean quotable number for the game-over screen, and a
// run abandoned mid-drive banks nothing (death is the only way out of one, so
// there is nothing to lose to that).

import { pingingNodes, nodeId, nodeValue, callsign, announceCityLine } from "./links.js";
import { edgesAt, centerXAt, ROAD_HALF_WIDTH } from "./road.js";
import * as gameConsole from "../engine/console.js";

// Where the bank lives. Same "cybercruise.*" namespace menu.js's SOUND/MUSIC
// settings already use.
export const CREDITS_KEY = "cybercruise.credits";

// How long a "+25CR" / "-15CR" award stays on the HUD, seconds. Matches
// score.js's own AWARD_FLASH: the two readouts sit in the same corner and
// blinking out of step would read as a bug rather than as two facts about the
// same kill.
const AWARD_FLASH = 1.2;

// SIPHON RANGE, px, from the car to the node's marker on the floor below.
// Everything inside this reaches; how fast it drains is the falloff below.
//
// Wide on purpose, well past the barrier. Nodes sit on a fixed column grid
// (citygrid.js's PLOT) while the road wanders across it, so a node can be too
// far out for the shoulder to touch — reach that far and they stop being a
// tease. The cost of a distant node is the TIME it takes, which is the
// falloff's job, not this number's.
//
// This is also the radius a payable node ADVERTISES from, and the two must be
// one figure: a price tag on something out of reach is a tease, and a node
// that pays without announcing itself first reads as a random event.
export const LINK_RADIUS = 300;

// WHAT KEEPS THE MIDDLE OF THE ROAD WORTHLESS. This used to fall out of
// arithmetic — the old grab radius was strictly under road.js's
// ROAD_HALF_WIDTH (143), so the centre-line could never earn a credit. A reach
// of 300px cannot promise that, so the promise moves here as an explicit rule:
// the car must be OUT PAST THE SHOULDER LINE on the node's own side before
// anything charges. Centre-line pays nothing, whatever is beside it.
//
// Half the road's half-width — the outer half of your own side, a real
// commitment to the wall with nowhere left to dodge, which is the same trade
// the old radius bought: money lives at the edges. Measured against the centre
// at the car's OWN row, so a bend can't make it mean two things at once.
const LINK_SHOULDER = ROAD_HALF_WIDTH * 0.5;

// THE FALLOFF: how long a node takes to drain, near and far. These two numbers
// ARE the merge — one act whose duration slides with distance, so there is no
// boundary to be on the wrong side of.
//
// NEAR reads as instant: at point blank the bar is gone almost before it is
// seen. FAR makes a distant column a decision — at 350 u/s the car crosses the
// whole reach in well under 4s, so an outer node cannot be taken at speed.
// Nothing reads the throttle; this IS the throttle rule, spelled as geometry.
//
// Both MEASURED, not guessed (tools/econsim.js, 300s per style).
//
// REJECTED: 5.5s at the far end. A node 220px out took 4.1s, and at 350 u/s
// the car only gets a second or two near its closest approach, so the whole
// outer band was "near-stop or forget it" — a wall, not a choice. At 4.0s,
// with the curve below, that node takes 2.3s: reachable by easing off.
const LINK_NEAR_TIME = 0.3;
const LINK_FAR_TIME = 4.0;

// Broken holds BLEED rather than snapping to zero, so clipping a car mid-drain
// costs time, not the attempt. Progress is normalised 0..1 (fill rate depends
// on range, so seconds-held wouldn't compare between nodes); this is the same
// units per second.
//
// Faster than the FAR end fills (0.5/s), so a mostly-broken hold never
// completes by accident out where holds are slow. NOT faster than the near end
// — point blank completes in 0.2s, and a decay outrunning that would make a
// node you are sitting on impossible to finish through the smallest bump.
const LINK_DECAY = 1.5;

const SIPHON_HINT = "SIGNAL NODE IN REACH // HOLD THE SHOULDER TO SIPHON";

// THE SIPHON RIG — upgrades.js's fifth CAR SYSTEM. `player.siphonLevel` is the
// tier owned (0..3, 0 = stock car).
//
// WHY IT SELLS YIELD AND NOT RANGE: tools/econsim.js was run against range and
// drain-time separately, and both saturate almost immediately — past ~360px /
// ~3s the hunter style already takes essentially every node it passes, so a
// tier of either alone would be a shelf row that sells nothing. Yield has no
// ceiling, so it is the number on the shelf (upgrades.js's `unit: "%"`) and
// the only one the rig promises. Range and drain ride the SAME tier, so the
// two axes that stall are never sold as if they don't.
//
// TIER 0 RESTATES THE CONSTANTS ABOVE by reference, not by literal — a car
// with no rig bought must behave identically to one in a build without it.
//
// THE DRAIN LADDER IS FLAT 4/3/2/1s, not a curve: the wait is the pain the
// upgrade removes, and the player should feel each second go rather than do
// arithmetic to notice. (The SQUARED falloff below is a different job —
// earning the closer approach.)
//
// `yield` is read by both hints() (the floating price) and collect() (what
// lands), from this one table, so the HUD can never quote a price the wallet
// won't pay.
//
// THREE FLAT ARRAYS, ONE LINE EACH, NO TRAILING COMMENTS — required, not
// style: tools/car-editor/constants.js can only reach a bare
// `const NAME = [a, b, c];` (patcher.js's patchArrayConstantElement), and that
// patcher splits on commas with no comment-awareness, so a comment after an
// element is read as part of the next one. Index === player.siphonLevel.
const SIPHON_RANGES = [LINK_RADIUS, 330, 360, 390];
const SIPHON_FAR_TIMES = [LINK_FAR_TIME, 3.0, 2.0, 1.0];
const SIPHON_YIELDS = [1.00, 1.20, 1.40, 1.60];

// `player` is read defensively (`?.`) — the test suite and tools/econsim.js
// both drive this module with plain `{x, y, speed}` stand-ins that carry no
// siphonLevel at all, and that has to mean "stock", not a crash.
function siphonTier(player) {
  const level = player?.siphonLevel ?? 0;
  return {
    range: SIPHON_RANGES[level] ?? SIPHON_RANGES[0],
    farTime: SIPHON_FAR_TIMES[level] ?? SIPHON_FAR_TIMES[0],
    yield: SIPHON_YIELDS[level] ?? SIPHON_YIELDS[0],
  };
}

// How long a payout's "+14CR" hangs over the SPOT IT CAME FROM, and how far it
// drifts up. Shorter than the HUD's award flash: that is a running total, this
// is a pointer at a place, and the place is scrolling away underneath it.
//
// EVERY payout gets one — node, bounty, fine — because the HUD corner can only
// say HOW MUCH, and when three cars go up in one chain reaction WHICH ONE PAID
// is the half the player needs to do it again on purpose.
export const AWARD_MARK_LIFE = 0.9;
export const AWARD_MARK_RISE = 26;

// Ceiling on how many of those can be in the air at once. A chain reaction can
// kill half a lane in one tick, and a stack of overlapping numbers is worse
// than no numbers at all — the oldest is dropped rather than the newest, so
// what stays on screen is what just happened.
const MAX_AWARD_MARKS = 5;

// THE DISH: the marker on the car saying a link is running.
//
// The node's fill bar is the instrument — how far along, to the pixel — but it
// lives out on the floor, on the thing being drained. It cannot say the CAR is
// the other end, and "am I downloading?" is asked with eyes on your own car,
// mid-traffic, while paying for the answer in speed.
//
// AIMED at the node, which is the part that teaches: the dish swings to the
// side the money is on, so it answers "which way" as well as "yes".
//
// On the flank, not the roof — the car is 34px wide, so anything over the
// wireframe competes with it while the outside edge is against empty tarmac.
// The offset clears the body, so the link never crosses the car.
export const DISH_MAST = 9;    // px from the car's flank out to the dish's middle
export const DISH_R = 6;       // the dish's own radius

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

// Whether the car is out on the same side as the node — half of the link's one
// positional demand (LINK_SHOULDER is the other half), and what keeps it a
// DECISION rather than slow-motion straight-line driving. Each side is
// measured against the road's centre at ITS OWN row, so a bend can't make "the
// left side" mean two things at two ends of the screen.
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
// under plain Node (no DOM — see test/economy.test.js's header), and a
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

    // The link in progress: which node, and how much of it is drained, 0..1.
    // NORMALISED rather than counted in seconds, because how fast it fills
    // depends on range (linkRate) — seconds-held would not mean the same thing
    // on two different nodes. ONE AT A TIME: the demand is that the player
    // commit to a node, and a rig that could quietly charge three at once
    // would be exactly the opposite of that. Switching targets starts the new
    // one from zero.
    this.link = null; // { id, charge }
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
  // because the two things that pay sit on DIFFERENT PLANES:
  //
  //   "floor"  a node on the lower city plane (scenery.js parallax) — pinned
  //            to the SCREEN position it was taken at. Over the marker's ~1s
  //            life the floor barely moves, so re-deriving its plot position
  //            every frame would cost more than it buys.
  //   "road"   a wreck on the road plane, anchored in WORLD coordinates
  //            (worldY plus lane offset) and re-projected every frame. The
  //            road scrolls at full speed and BENDS, so a screen-pinned marker
  //            would slide off its wreck within a few frames.
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

  // Drains every node the car is entitled to be draining, and pays for the
  // ones that finish. Called once per playing tick from main.js with the node
  // list scenery.js already built for the frame.
  //
  // `push`/`busy` ride through to links.js's shared city-line throttle as they
  // do in announce(), so the test suite can watch what this says without
  // mutating the real SYS LOG. See collect() for why only the LINE is
  // throttled and never the money.
  harvest(dt, clockValue, nodes, player, distance, W, push = gameConsole.push, busy = gameConsole.isBusy) {
    const total = this.holdLink(dt, clockValue, nodes, player, distance, W, push, busy);
    if (this.harvested.size > PRUNE_AT) this.prune(nodes);
    return total;
  }

  // The three things that are true of every node the link can ever pay for:
  // not already taken this run, not hidden under the road, and inside the
  // reach the floor advertises. Shared by the drain and by the hint layer, so
  // a marker can never appear over something that would refuse to pay.
  //
  // NOTE what is NOT here: whether the node is pinging. The ping stopped
  // gating money when the two routes became one (see THE LINK) — it lights the
  // label, nothing more.
  //
  // THE REACH IS THE PLAYER'S OWN, not a constant, once the SIPHON RIG
  // (siphonTier) exists — a car with the rig bought can be entitled to a node
  // a stock car can't even see as payable.
  payable(node, player, distance, W) {
    if (this.harvested.has(nodeId(node.bx, node.by))) return false;
    if (!offRoad(node, distance + (player.y - node.sy), W)) return false;
    return Math.hypot(node.cx - player.x, node.sy - player.y) <= siphonTier(player).range;
  }

  // Whether the car is positioned to be draining this node at all: out past
  // the shoulder line, on the node's own side. The single rule that keeps the
  // middle of the road worthless (see LINK_SHOULDER) — and the only positional
  // demand left, now that speed is geometry rather than a ceiling.
  linkable(node, player, distance, W) {
    if (Math.abs(player.x - centerXAt(distance, W)) < LINK_SHOULDER) return false;
    return sameSide(node, distance + (player.y - node.sy), player.x, distance, W);
  }

  // HOW FAST THIS NODE DRAINS, in progress per second, given how far off it
  // is. The whole merge lives in this one line: near is quick enough to read
  // as instant, far is slow enough to be a decision, and everything between
  // is the same act taking longer.
  //
  // Interpolated on TIME rather than on rate, because time is what the player
  // experiences — a curve that interpolated the rate would spend most of the
  // reach feeling identical and then collapse at the end.
  //
  // SQUARED, not straight, which is what makes the outer half playable. A
  // straight line spends its budget evenly, so halfway out a node already
  // costs half the maximum and the whole outer band needs a near-stop.
  // Squaring keeps the near half cheap and loads the cost into the last
  // stretch: at 150px a node drains in 1.2s instead of 2.9s, while the
  // outermost column still asks for 4s.
  //
  // Measured, this HELPED the balance (econsim): crawling fell from 1.55x a
  // fast style's income to 1.36x, because a car at speed can now finish the
  // nodes it passes. Slowing still pays, it just no longer pays for all of it.
  //
  // `player` is OPTIONAL and reads as stock when omitted (siphonTier's own
  // default) — test/economy.test.js calls this with a bare distance to probe
  // the stock curve, and that has to keep working unchanged.
  linkRate(dist, player) {
    const tier = siphonTier(player);
    const t = Math.min(1, Math.max(0, dist / tier.range));
    return 1 / (LINK_NEAR_TIME + (tier.farTime - LINK_NEAR_TIME) * t * t);
  }

  // Advances (or bleeds) the one link, and pays out when it completes. Split
  // out of harvest() above so the state machine can be driven directly by the
  // test suite, the same reasoning links.js splits announceActive from
  // announce.
  holdLink(dt, clockValue, nodes, player, distance, W, push = gameConsole.push, busy = gameConsole.isBusy) {
    // The nearest node this car is currently entitled to be charging. Nearest
    // rather than best-paying: the player is steering at a place, and a rule
    // that silently preferred a further, richer node would put the meter on
    // something they weren't looking at. It is also the fastest-draining one
    // by definition, so "nearest" and "the one about to pay" never disagree.
    let target = null;
    let best = Infinity;
    for (const n of nodes) {
      if (!this.payable(n, player, distance, W)) continue;
      if (!this.linkable(n, player, distance, W)) continue;
      const d = Math.hypot(n.cx - player.x, n.sy - player.y);
      if (d < best) { best = d; target = n; }
    }

    if (!target) {
      // Nothing eligible: whatever was being held bleeds away, and is dropped
      // entirely once it's gone.
      if (this.link) {
        this.link.charge -= dt * LINK_DECAY;
        if (this.link.charge <= 0) this.link = null;
      }
      return 0;
    }

    const id = nodeId(target.bx, target.by);
    if (!this.link || this.link.id !== id) this.link = { id, charge: 0 };
    // Charged at the rate for where the car is THIS tick, not where it was
    // when the link opened: closing the distance mid-drain speeds it up, which
    // is the same sentence the mechanic already tells the player.
    this.link.charge += dt * this.linkRate(best, player);
    if (this.link.charge < 1) return 0;

    this.link = null;
    return this.collect(clockValue, target, player, push, busy);
  }

  // The payout itself, shared by both routes so they can never drift apart:
  // one entry in the claimed set, one award, one marker over the spot, one
  // line in the log.
  //
  // THE MONEY IS NOT THROTTLED, THE LINE IS. announceCityLine drops a line
  // when the log is busy or the city spoke recently — right for chatter, wrong
  // for income, which would otherwise depend on how noisy the log happened to
  // be. The payout is unconditional; only the sentence is rate-limited.
  //
  // ONE PRICE, no fractions: a node is worth what the floor says, whether it
  // was taken in a fifth of a second alongside or ground out from the far side
  // of the barrier. (The old half-price uplink existed to stop a second route
  // eating the first; with one route there is nothing to protect.)
  //
  // The SIPHON RIG is not an exception to that — `nodeValue` is what the CITY
  // says a node is worth, `siphonTier(player).yield` is what the CAR can pull
  // out of it, and hints() quotes the same product.
  collect(clockValue, node, player, push = gameConsole.push, busy = gameConsole.isBusy) {
    this.harvested.add(nodeId(node.bx, node.by));
    const value = Math.round(nodeValue(node.bx, node.by) * siphonTier(player).yield);
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
  // are. One entry per unclaimed, reachable node inside the player's own
  // reach (siphonTier(player).range, LINK_RADIUS on a stock car):
  //
  //   value     what it pays — the node's price, flat, because there is only
  //             one price now (see collect)
  //   live      whether it is PINGING. Advertising only: it no longer decides
  //             anything about money, it just means the floor is pointing
  //   charge    how far the link on THIS node has got, 0..1
  //   alpha     fades up as the player closes on it, so a node across the road
  //             doesn't shout as loudly as the one they are drawing level with
  //
  // NO PROMPT FIELD — a decision, not an omission. REJECTED: SHOULDER over any
  // node the car wasn't positioned to drain, and SLOW before it. The mechanic
  // draws itself now (beam from car to node, bar filling over it), and a
  // player who can see the money, the beam and the bar doesn't need a word for
  // what the picture says. What a player who is NOT collecting needs is to
  // notice the number at all, so the price got bigger instead (renderHints).
  //
  // THE LABEL IS HONEST BY CONSTRUCTION. With two routes it had to quote the
  // price for whichever was open — full up close, half otherwise. One route,
  // one number: what is written over a node is what lands in the wallet.
  //
  // Everything else the drain insists on is enforced here too (unclaimed, off
  // the road, in reach): a marker over a node that could not be collected
  // would be the HUD lying, and this game's HUD does not lie.
  hints(clockValue, nodes, player, distance, W) {
    const live = new Set(pingingNodes(nodes, clockValue).map((n) => nodeId(n.bx, n.by)));
    const tier = siphonTier(player);
    const out = [];
    for (const n of nodes) {
      if (!this.payable(n, player, distance, W)) continue;

      const id = nodeId(n.bx, n.by);
      const dist = Math.hypot(n.cx - player.x, n.sy - player.y);
      out.push({
        x: n.cx, y: n.sy,
        // The RIG's yield, applied here too — see collect()'s own note on why
        // this is the one thing that still has to match it exactly.
        value: Math.round(nodeValue(n.bx, n.by) * tier.yield),
        live: live.has(id),
        charge: this.link && this.link.id === id ? Math.min(1, this.link.charge) : 0,
        // Fades up over the approach — brightest where the drain is fastest.
        alpha: 1 - 0.7 * Math.min(1, dist / tier.range),
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

  // WHERE THE LINK RUNS THIS FRAME, or null when nothing is being drained:
  // the node end, the car end, and how far along the drain is. Pure, and split
  // out of the drawing below for the same reason hints() is split out of
  // renderHints() — the geometry is checkable without a canvas, and the only
  // thing left in the render method is ink.
  //
  // `carX` is the car's INTERPOLATED position (player.renderX), not player.x:
  // the dish is bolted to a car being drawn between two logic steps, and a
  // dish that used the logic position would swim against its own car.
  //
  // The node is looked up in the list the floor just drew rather than being
  // remembered when the drain started, so the link is always attached to where
  // that node actually is on screen — it scrolls down the floor plane while
  // the hold runs, and a cached position would leave the beam pointing at a
  // spot the node had already left.
  linkGeometry(nodes, player, carX) {
    if (!this.link) return null;
    const node = nodes.find((n) => nodeId(n.bx, n.by) === this.link.id);
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
      progress: Math.min(1, this.link.charge),
    };
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

  // Spends credits — the shop's entry point (game/upgrades.js's purchase()),
  // here rather than in a screen because the floor rule belongs with the rest
  // of the money arithmetic. Refuses rather than overdrawing, and persists immediately: a
  // purchase is a decision the player made, not run earnings waiting on the
  // outcome of a drive.
  spend(amount) {
    if (amount <= 0 || amount > this.credits) return false;
    // Comes out of the bank first, then out of the current run's earnings. The
    // shop IS opened mid-run (every SHOP_INTERVAL — game/hauler.js), so this
    // ordering is live rather than hypothetical; with the persisted bank
    // switched off (main.js's CREDIT_STORE) every purchase currently comes
    // wholly out of the run's own earnings, and the total the player sees is
    // the one that moves either way.
    const fromBank = Math.min(this.banked, amount);
    this.banked -= fromBank;
    this.earned -= amount - fromBank;
    saveBanked(this.banked, this.store);
    return true;
  }
}
