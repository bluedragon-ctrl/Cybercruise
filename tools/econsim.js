// Credit-economy measurement — a headless drive, run for a few simulated
// minutes, reporting what the road actually PAYS.
//
// WHY THIS EXISTS. game/wallet.js makes a claim that no amount of staring at
// the canvas can settle: that siphoning nodes is a REAL choice, i.e. that
// hugging the shoulders to reach them earns meaningfully more than driving the
// middle and ignoring them, and that neither figure is so large it drowns out
// the bounties from shooting. Both halves of that are geometry — plot columns
// (citygrid.js), the road's own wander (road.js), the floor's half-speed
// parallax (scenery.js) and the ping duty cycle (links.js) multiplied together
// — and geometry is exactly the kind of claim that quietly stops being true
// when someone retunes one of those five files.
//
// So this runs the REAL modules: the real visibleNodes walk, the real ping
// phases, the real Wallet with its real range and occlusion rules, on a road
// with no renderer attached. Nothing here is a model of the economy; it is the
// economy with the drawing removed. (Same contract tools/drivesim.js states
// for the driving profiles — see its header.)
//
// Run with:  npm run econ      (or: node tools/econsim.js [seconds] [speed])
//
// READING THE OUTPUT. One row per driving STYLE — how the simulated player
// uses the road — and the figures are per minute so the run length doesn't
// matter:
//
//   nodes/min   nodes actually siphoned
//   cr/min      credits from those siphons
//   speed       the average speed that cost, world units/sec — the uplink
//               styles buy their nodes with this, and a style that earns twice
//               as much at half the pace has not necessarily won
//   kills-eq    the same income expressed in enemy kills (cartypes.js's
//               `bounty`), which is the only scale that means anything: this
//               is how many enemies a minute of node-hunting is worth
//
// WHAT GOOD LOOKS LIKE. `centre` should be at or near ZERO — a player who
// never leaves the middle lanes is not supposed to be paid for scenery. The
// shoulder styles should be clearly positive, and `hunter` (which actively
// chases the nearest node it can reach) is the ceiling: the best a player can
// do without a single shot fired. If that ceiling ever climbs past a few kills
// a minute, the guns have stopped mattering — retune links.js's NODE_VALUE_MIN/
// MAX, not this file.

import * as scenery from "../src/game/scenery.js";
import * as road from "../src/game/road.js";
import { Wallet } from "../src/game/wallet.js";
import { CAR_TYPES, ENEMY_FACTION } from "../src/game/cartypes.js";

const W = 600;
const H = 800;
const PLAYER_Y = H * 0.62; // main.js's own framing
const DT = 1 / 60;
const STEER_SPEED = 260; // player.js's own full-lock lateral speed
const CAR_HALF_W = 17;   // roughly the player car's half width — how close to
                          // the barrier the tarmac actually lets it get

// A stub SYS LOG. The wallet pushes a line per siphon through links.js's
// shared city-line throttle; here it goes nowhere, and `busy` is always false
// so the throttle behaves as it does on a quiet log.
const push = () => {};
const busy = () => false;

// The styles themselves: each returns the screen x the player should be at,
// given the road's edges this tick and the nodes on screen. Deliberately
// written as "where does this player want to be", with the STEER_SPEED cap
// applied by the caller, so no style can teleport across the road.
const STYLES = {
  // Dead centre, every tick. The control: what a player who never thinks
  // about money earns anyway.
  centre: (edges) => edges.center,
  // Pinned to the left barrier for the whole run — the naive "just hug a side"
  // play, which only ever reaches half the city.
  "shoulder L": (edges) => edges.left + CAR_HALF_W,
  "shoulder R": (edges) => edges.right - CAR_HALF_W,
  // Actively goes for it: steers at whichever off-road node column is nearest,
  // clamped to the tarmac. The ceiling of what the GRAB route can pay.
  hunter: (edges, nodes) => {
    let best = null;
    let bestD = Infinity;
    for (const n of nodes) {
      // Only the ones a player could actually be paid for: off the road at
      // their own row (the wallet's own occlusion rule) and ahead of / beside
      // the car rather than already behind it.
      if (n.cx > edges.left && n.cx < edges.right) continue;
      if (n.sy > PLAYER_Y + 120) continue;
      const d = Math.abs(n.cx - edges.center);
      if (d < bestD) { bestD = d; best = n; }
    }
    if (!best) return edges.center;
    return Math.max(edges.left + CAR_HALF_W, Math.min(edges.right - CAR_HALF_W, best.cx));
  },
};

// Styles that BUY TIME: they ease off whenever a node is out on their side of
// the road, so the link has long enough to drain something the shoulder would
// otherwise sail past. Nothing in wallet.js reads the throttle any more (see
// its THE LINK header) — slowing simply keeps the car in range for longer, and
// the speed given up is reported alongside what it bought.
const CRAWLERS = new Set(["crawler"]);
STYLES.crawler = STYLES.hunter;

function run(styleName, seconds, speed) {
  const style = STYLES[styleName];
  const wallet = new Wallet(null); // null storage: nothing this measures is
                                    // allowed to touch a real bank
  let distance = 0;
  let clock = 0;
  let x = W / 2;
  let speedSum = 0;
  let ticks = 0;

  for (let t = 0; t < seconds; t += DT) {
    const edges = road.edgesAt(distance, W);
    const nodes = scenery.visibleNodes(scenery.floorDist(distance), PLAYER_Y, W, H);

    // Steer toward the style's target, capped exactly as the real car is.
    const want = style(edges, nodes);
    const step = STEER_SPEED * DT;
    x += Math.max(-step, Math.min(step, want - x));
    x = Math.max(edges.left + CAR_HALF_W, Math.min(edges.right - CAR_HALF_W, x));

    // A crawling style drops its speed whenever there is something on its side
    // worth staying beside — the real trade the mechanic asks the player to
    // make, simulated as bluntly as possible.
    let v = speed;
    if (CRAWLERS.has(styleName)) {
      const worth = nodes.some((n) =>
        (n.cx < edges.left || n.cx > edges.right) &&
        Math.sign(n.cx - edges.center) === Math.sign(x - edges.center) &&
        Math.hypot(n.cx - x, n.sy - PLAYER_Y) < 300
      );
      if (worth) v = Math.min(speed, 200);
    }

    distance += v * DT;
    clock += DT;
    speedSum += v;
    ticks++;

    wallet.harvest(DT, clock, nodes, { x, y: PLAYER_Y, speed: v }, distance, W, push, busy);
  }

  const minutes = seconds / 60;
  return {
    style: styleName,
    nodes: wallet.nodes / minutes,
    credits: wallet.siphoned / minutes,
    speed: speedSum / ticks,
  };
}

const seconds = Number(process.argv[2]) || 300;
const speed = Number(process.argv[3]) || 350; // mid of the player's 120..620 band

// What one enemy kill pays, straight off the catalogue, so the last column
// stays true if the bounties are ever retuned.
const enemyBounty =
  CAR_TYPES.filter((t) => t.faction === ENEMY_FACTION && t.bounty > 0)
    .reduce((sum, t, _i, a) => sum + t.bounty / a.length, 0) || 1;

console.log(`\nCredit economy — ${seconds}s per style at ${speed} u/s, node value 5..25 CR, enemy bounty ${enemyBounty.toFixed(0)} CR\n`);
console.log("style        nodes/min   cr/min   kills-eq     speed");
for (const name of Object.keys(STYLES)) {
  const r = run(name, seconds, speed);
  console.log(
    `${r.style.padEnd(12)}${r.nodes.toFixed(2).padStart(9)}${r.credits.toFixed(1).padStart(9)}${(r.credits / enemyBounty).toFixed(2).padStart(11)}${r.speed.toFixed(0).padStart(10)}`
  );
}
console.log("");
