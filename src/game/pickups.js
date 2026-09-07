// Buff pickups — crates that spawn on the road and grant the player an
// instant effect on contact (an ammo refill, a heal, or a shield). Same shape
// of job as obstacles.js, considerably simpler: a pickup never moves, never
// damages anyone, and only the PLAYER can trigger it — traffic drives straight
// through one with no reaction. A buff is a reward the game is offering the
// player specifically, not a hazard shared traffic has any reason to avoid or
// was ever taught to (behaviours.js's avoidHazards never sees this list).
//
// WHY NOT OBSTACLES.JS'S PLACEMENT MACHINERY. Obstacles.js earns its passage
// rule and cluster-avoidance because a hazard that seals the road is a bug —
// see its own header, "the one thing a spawn may never do is close the road".
// A pickup blocks nothing (contact with it costs nobody any speed), so none
// of that applies: a crate can be dropped anywhere across the tarmac with a
// plain random offset. That is also exactly what this pass was asked for —
// let the five buffs spawn randomly first; a fairness/placement pass on top
// is a later refinement, not a prerequisite.
//
// SPAWNING AND TUNING NUMBERS BELOW ARE A FIRST PASS, same caveat every other
// freshly-landed catalogue in this codebase carries: retune once there is
// real road time to measure the buffs against, not by guessing.
//
// ---------------------------------------------------------------------------
// SALVAGE IS THE ONE THING HERE THAT IS NOT SPAWNED. A husk is placed at the
// distance a real run actually ended at (game/salvage.js holds the set,
// worker/salvage.js the storage), so its position is DATA, not a roll — which
// is why pickuptypes.js's salvage entry carries `placed` and can never come
// out of pickPickupType at all.
//
// A CURSOR, NOT A SCAN. The set is distance-ordered and the player only ever
// moves forward, so the placement check is "has the head of the list come
// inside the spawn horizon yet" — O(1) a frame, against a list that can hold a
// thousand husks. `adopt()` below is what re-points it when the run-start
// fetch lands mid-run, which it routinely does: leaderboard.js's GET is fired
// by newGame() and not awaited, so the first fraction of a second of a run is
// driven against the local ledger alone and the remote set arrives underneath
// it. That is safe precisely because the cursor is re-derived from the
// player's own distance rather than remembered as an index.
//
// A HUSK IGNORES MAX_PICKUPS, which is a budget for the random spawner and
// exists so buff crates stay a trickle. Salvage is not a trickle the game
// chose — it is a record of what happened on that stretch of road, and
// thinning it to fit a crate budget would silently delete other players'
// deaths. What bounds it instead is the per-band cap in worker/salvage.js,
// applied where the data is written rather than where it is drawn.

import { drawPickupShape, PICKUP_SHAPES } from "./pickupshapes.js";
import {
  pickPickupType,
  pickupTypeById,
  applyPickup,
  AMMO,
  HEAL,
  SHIELD,
  BOOST,
  CASH,
} from "./pickuptypes.js";
import { SALVAGE_SIZE } from "./salvageshape.js";
import { drawSalvageCached } from "./sprites.js";
import { centerXAt, cameraX, headingAt, ROAD_HALF_WIDTH } from "./road.js";
import { overlaps } from "./collisions.js";
import * as gameConsole from "../engine/console.js";

// The console line a crate's kind reads as (engine/console.js) — always a
// HINT, never a warning, since a pickup is only ever good news.
//
// Read BEFORE the crate is applied, and handed the player, because the two
// buffs say different things depending on what is already running: a shield
// or an overdrive taken mid-buff EXTENDS it (player.js's chargeShield and
// activateBoost) rather than arming or starting one, and a line that claimed
// otherwise would be the only place telling the player they wasted a crate.
// What a husk pays whoever loots it: its own run's credits times the
// catalogue's rate. Zero for every other pickup, and zero for a husk left by a
// run that ended broke — which is a real outcome and reads correctly, since
// the console line then says so rather than promising money that isn't there.
function payout(p) {
  if (p.type.kind !== CASH || !p.record) return 0;
  return Math.max(0, Math.round((p.record.credits ?? 0) * p.type.rate));
}

function pickupMessage(type, player, amount = 0) {
  switch (type.kind) {
    case CASH:
      return amount > 0 ? `SALVAGE +${amount}CR` : "SALVAGE STRIPPED";
    case AMMO:
      return `${type.label} +${type.amount}`;
    case HEAL:
      return `HULL REPAIRED +${type.amount}`;
    case SHIELD:
      return player.shieldTime > 0
        ? `SHIELD EXTENDED +${type.duration}s`
        : `SHIELD CHARGED ${type.duration}s`;
    case BOOST:
      // The one line that has to carry BOTH of its type's numbers — see
      // pickuptypes.js's BOOST entry on why an overdrive is meaningless
      // without the pair.
      return player.boostTime > 0
        ? `OVERDRIVE EXTENDED +${type.duration}s`
        : `OVERDRIVE +${type.amount} ${type.duration}s`;
    default:
      return type.label;
  }
}

// Resolved once: the salvage entry is never rolled, so every husk on the road
// shares this one catalogue entry and only its `record` differs.
const SALVAGE_TYPE = pickupTypeById("salvage");

const SPAWN_INTERVAL = 5; // seconds between spawn attempts
const MAX_PICKUPS = 3; // live crates at once
// World units past the screen's top edge a crate appears at — same order as
// traffic's own SPAWN_MARGIN (120, traffic.js), since nothing needs advance
// warning of a pickup the way behaviours.js's hazard dodge needs of a hazard.
const SPAWN_MARGIN = 150;
const RETIRE_MARGIN = 250; // ...and how far past the bottom before it's dropped
const DRAW_MARGIN = 40; // px past the screen edge still worth drawing
// rad/sec the reticle breathes at — distinct from (and slower than) the
// mine's own 7 (obstacles.js's PULSE_RATE) so a pickup never reads as a
// hazard blinking.
const PULSE_RATE = 2.2;

// One crate on the road. `record` is the salvage husk's own `{id, credits,
// name?, mine?}` and is null for every buff crate — see SALVAGE above for why
// exactly one pickup carries per-instance state.
class Pickup {
  constructor(type, worldY, offset, record = null) {
    this.type = type;
    this.record = record;
    this.worldY = worldY; // fixed for life — pickups do not move
    this.offset = offset;
    this.alive = true;
    // Seconds live. Drives the reticle's own pulse AND, for SHIELD, the
    // spinning tick on its glyph (pickupshapes.js's drawShieldGlyph) — one
    // clock for both rather than tracking pulse and animation phase apart.
    this.age = 0;
    // Random phase so several live crates don't breathe in lockstep — the
    // same reasoning RoadObstacle gives its own pulsePhase.
    this.pulsePhase = Math.random() * Math.PI * 2;
  }

  get w() {
    return PICKUP_SHAPES[this.type.shape].size[0];
  }

  get h() {
    return PICKUP_SHAPES[this.type.shape].size[1];
  }
}

export class Pickups {
  // `onCollect` is optional: `(type) => void`, called once per crate actually
  // collected, with its pickuptypes.js entry — mirrors traffic.js's own
  // onDestroyed/obstacles.js's onDestroyed callback shape, for the same
  // reason: this file stays ignorant of the audio engine (see the Phase 8
  // design brief's own rule) while still giving main.js a hook onto the one
  // place a crate is ever actually applied.
  constructor(explosions, onCollect) {
    this.explosions = explosions; // shared with Traffic/Obstacles — see effects.js
    this.onCollect = onCollect;
    this.list = [];
    this.spawnTimer = SPAWN_INTERVAL;
    // The salvage set this run is driving through, and how far into it the
    // cursor has walked — see SALVAGE above. `salvageSet` is held by identity
    // so a set replaced mid-run is noticed without comparing contents.
    this.salvageSet = null;
    this.salvageAt = 0;
  }

  // Re-point the cursor at `set`, skipping everything already behind the
  // player. Called whenever the set the world hands us is not the one we were
  // walking — which is once at run start, and once more when the fetch lands.
  adoptSalvage(set, distance) {
    this.salvageSet = set;
    this.salvageAt = 0;
    while (this.salvageAt < set.length && set[this.salvageAt].distance < distance) {
      this.salvageAt++;
    }
  }

  // Place every husk that has come inside the spawn horizon since last frame.
  placeSalvage({ salvage, distance, player }) {
    const set = salvage ?? [];
    if (set !== this.salvageSet) this.adoptSalvage(set, distance);

    const horizon = distance + player.y + SPAWN_MARGIN;
    while (this.salvageAt < set.length && set[this.salvageAt].distance <= horizon) {
      const record = set[this.salvageAt++];
      // Clamped to the tarmac rather than dropped if it lands outside it: an
      // offset from another run was recorded against the same road half-width
      // this one uses, so an out-of-range value means a corrupt or forged
      // record, and the honest response to "somebody died just off the road"
      // is still a husk on the road.
      const half = ROAD_HALF_WIDTH - SALVAGE_SIZE[0] / 2;
      const offset = Math.max(-half, Math.min(half, record.offset ?? 0));
      this.list.push(new Pickup(SALVAGE_TYPE, record.distance, offset, record));
    }
  }

  // `world` = { player, distance, W, H, loadout, wallet, salvage }. `loadout`
  // is the player's Loadout (weapons.js) — the one thing an ammo pickup needs
  // that `player` itself doesn't carry — and `wallet`/`salvage` are the two a
  // husk needs for the same reason: one to pay, one to place.
  update(dt, world) {
    const { player, distance, W, loadout, wallet } = world;
    const centerX = centerXAt(distance, W);

    // The player expressed as a body in road coordinates, exactly as
    // obstacles.js's own playerBox does it, but read-only: a pickup never
    // shoves or damages anything, so there is no need for a `damage` accessor.
    const playerBox = {
      worldY: distance,
      offset: player.x - centerX,
      w: player.w,
      h: player.h,
    };

    for (const p of this.list) {
      if (!p.alive) continue;
      p.age += dt;
      if (overlaps(p, playerBox)) {
        const amount = payout(p);
        const message = pickupMessage(p.type, player, amount); // before, so it can see what was running
        applyPickup(p.type, player, loadout, wallet, amount);
        // The floating `+NCR` every other payout on the road already gets —
        // wallet.js's own "road" mark, anchored in world coordinates so it
        // stays over the husk while the road scrolls and bends under it.
        if (amount > 0 && wallet) {
          wallet.mark({ kind: "road", worldY: p.worldY, offset: p.offset, value: amount });
        }
        gameConsole.push(message, gameConsole.HINT);
        // Every crate bursts in the player's own cyan, whichever buff it was —
        // see effects.js's drawCollectBurst header for why the burst answers
        // "that was mine" rather than "that was a rocket refill".
        this.explosions.spawnCollect(p.worldY, p.offset);
        // The record rides along so main.js can tell salvage.js which husk is
        // gone — a claim it batches into the one POST this run makes. Null for
        // every buff crate, which is what keeps the existing audio hook (the
        // callback's original and only other job) unchanged.
        if (this.onCollect) this.onCollect(p.type, p.record);
        p.alive = false;
      }
    }

    // AFTER contact and BEFORE retire: a husk placed this frame is one the
    // player cannot already be touching (it enters a full screen ahead), and
    // running it before retire means a husk placed at a distance the player has
    // somehow already passed is dropped the same frame instead of lingering.
    this.placeSalvage(world);
    this.retire(world);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = SPAWN_INTERVAL;
      if (this.list.length < MAX_PICKUPS) this.spawn(world);
    }
  }

  // Drop crates that have fallen behind, or that were just collected. Unlike
  // traffic there is no "ahead" bound to check — a pickup is always spawned
  // ahead of the player and can only ever fall behind.
  retire({ distance, player, H }) {
    const behind = distance - (H - player.y) - RETIRE_MARGIN;
    this.list = this.list.filter((p) => p.alive && p.worldY > behind);
  }

  // Introduce one crate just off the top of the screen, at a plain random
  // offset across the tarmac — see the header for why this needs none of
  // obstacles.js's fairness machinery.
  spawn({ distance, player }) {
    const type = pickPickupType(distance);
    if (!type) return; // nothing unlocked yet (pickuptypes.js's minDistance)

    const worldY = distance + player.y + SPAWN_MARGIN;
    const half = ROAD_HALF_WIDTH - PICKUP_SHAPES[type.shape].size[0] / 2;
    const offset = (Math.random() * 2 - 1) * half;
    this.list.push(new Pickup(type, worldY, offset));
  }

  // Place one crate immediately at (worldY, offset) — for a drop the GAME
  // decided rather than the random road spawner (currently: a destroyed
  // hostile's chance to leave a FIX crate where it died, main.js).
  //
  // NO SEPARATE BUDGET, unlike obstacles.js's own drop() for a laid mine.
  // That one needs its laid budget because a live car can lay a mine every few
  // seconds for as long as it survives — a repeating source that could carpet
  // the road. A death drop is self-limiting by construction: a car can only
  // die once, so the rate this can possibly fire at is already bounded by how
  // fast hostiles can be killed, nowhere near enough to flood MAX_PICKUPS.
  drop(type, worldY, offset) {
    if (!type) return;
    this.list.push(new Pickup(type, worldY, offset));
  }

  // No lateral interpolation, for the same reason obstacles skip it: a
  // pickup's offset never changes after spawn.
  render(ctx, distance, playerY, W, H) {
    const camX = cameraX(distance);
    for (const p of this.list) {
      const sy = playerY - (p.worldY - distance);
      if (sy < -DRAW_MARGIN || sy > H + DRAW_MARGIN) continue;

      // World x to screen x — see road.js's header on the two spaces.
      const sx = centerXAt(p.worldY, W) + p.offset - camX;
      // A husk goes through the sprite cache and the buff crates do not — see
      // sprites.js's drawSalvageCached on why exactly one pickup is worth a
      // cache entry. It also takes no `pulse`: the reticle breathes because it
      // is a live target lock, and the whole read of a husk is that it isn't.
      if (p.type.kind === CASH) {
        drawSalvageCached(ctx, sx, sy, {
          angle: headingAt(p.worldY),
          name: p.record?.name ?? null,
        });
        continue;
      }
      // Bright-biased (0.7 floor, not 0 like the mine's own pulse) so the
      // reticle reads as "live" the whole time rather than fading in and out
      // — a target lock breathing, not a hazard blinking.
      const pulse = 0.7 + 0.3 * Math.sin(p.age * PULSE_RATE + p.pulsePhase);
      drawPickupShape(ctx, sx, sy, p.type.shape, pulse, p.age, headingAt(p.worldY));
    }
  }
}
