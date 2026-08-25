// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// The whole Phase 8 audio stack: voice limiter, catalogues, sustained voices, the mix pass and the music backends.
//
// Everything imported here is DOM-free at module scope, so the game's real
// modules load under plain Node.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CAR_TYPES, ENEMY_FACTION } from "../src/game/cartypes.js";
import {
  MIN_SPEED,
  MAX_SPEED,
  Player,
  SHIELD_EXPIRING as PLAYER_SHIELD_EXPIRING,
} from "../src/game/player.js";
import { centerXAt } from "../src/game/road.js";
import {
  HINT as CONSOLE_HINT,
  WARN as CONSOLE_WARN,
  CRITICAL as CONSOLE_CRITICAL,
  push as consolePush,
  onPush as consoleOnPush,
  reset as consoleReset,
} from "../src/engine/console.js";
import { CONSOLE_SOUND, CONSOLE_PITCH } from "../src/audio/consolesfx.js";
import { Score } from "../src/game/score.js";
import { Loadout, WEAPON_TYPES, ENEMY_WEAPON_TYPES } from "../src/game/weapons.js";
import { Explosions } from "../src/game/effects.js";
import { PICKUP_SHAPES } from "../src/game/pickupshapes.js";
import { PICKUP_TYPES, pickupTypeById } from "../src/game/pickuptypes.js";
import { Pickups } from "../src/game/pickups.js";
import {
  GLOBAL_VOICE_CAP,
  planVoiceRequest,
  commitVoice,
  DUCK_ATTACK,
  DUCK_RELEASE,
  planDuck,
  isStarted,
} from "../src/audio/context.js";
import { SOUND_TYPES, soundTypeById } from "../src/audio/soundtypes.js";
import { JACK_IN_DURATION } from "../src/audio/sfx.js";
import { PLAYER_FIRE_SOUND, ENEMY_FIRE_SOUND } from "../src/audio/weaponsfx.js";
import { PICKUP_SOUND } from "../src/audio/pickupsfx.js";
import { MENU_ACTIONS, MENU_SOUND } from "../src/audio/menusfx.js";
import { SUSTAINED_TYPES, sustainedTypeById } from "../src/audio/sustainedtypes.js";
import {
  planAcquire as sustainedPlanAcquire,
  planSetLevel as sustainedPlanSetLevel,
  planRelease as sustainedPlanRelease,
} from "../src/audio/sustained.js";
import {
  HULL_HISS_ON,
  HULL_HISS_OFF,
  HULL_HISS_PEAK,
  hullHissActive,
  hullHissLevel,
  DROPOUT_HULL_THRESHOLD,
  DROPOUT_MIN_INTERVAL,
  DROPOUT_MAX_INTERVAL,
  DROPOUT_MIN_HOLD,
  DROPOUT_MAX_HOLD,
  stepDropoutTimer,
  dropoutHoldSeconds,
  CRACKLE_HULL_THRESHOLD,
  CRACKLE_MIN_INTERVAL,
  CRACKLE_MAX_INTERVAL,
  stepCrackleTimer,
  shieldDroneLevel,
  SHIELD_DRONE_FADE_WINDOW,
  DREAD_RANGE_ON,
  DREAD_RANGE_OFF,
  DREAD_RATE_MIN,
  DREAD_RATE_MAX,
  dreadProximity,
  dreadPulseLevel,
  dreadPulseRate,
  dreadPulseActive,
} from "../src/audio/sustainedfx.js";
import {
  MUSIC_CUTOFF_MIN,
  MUSIC_CUTOFF_MAX,
  speedToMusicCutoff,
  MUSIC_CUTOFF_FLOOR,
  SECTOR_COLLAPSE_OFFSET,
  SECTOR_COLLAPSE_ATTACK,
  SECTOR_COLLAPSE_RELEASE,
  composeMusicCutoff,
  planSetMusicCutoff,
  planBeginSectorTransition,
  DISCONNECT_FADE,
} from "../src/audio/context.js";
import { chooseBackend, MUSIC_BACKEND_METHODS } from "../src/audio/synth.js";
import * as proceduralmusic from "../src/audio/proceduralmusic.js";
import * as trackmusic from "../src/audio/trackmusic.js";
import {
  shuffleOrder,
  nextIndex,
  shouldLoopSingleTrack,
  retainedTrackNames,
  nextPlayableIndex,
  runPreload,
} from "../src/audio/trackmusic.js";
import {
  MUSIC_DIR,
  MUSIC_LISTING_URL,
  TRACK_GAIN,
  TRACK_DECODE_SAMPLE_RATE,
  TRACK_DECODE_RATE_MIN,
  TRACK_DECODE_RATE_MAX,
  trackGainFor,
  trackDisplayName,
  validateMusicConfig,
} from "../src/audio/musictypes.js";
import { listMusicFiles, manifestPath, manifestContents } from "../tools/musicmanifest.js";
import "../src/audio/sustainedfx.js"; // side effect: registers every sustained voice's generator

// --- Phase 8 audio infrastructure: voice limiter + duck (context.js) --------
//
// Both are exercised through their PURE forms (planVoiceRequest/commitVoice,
// planDuck) rather than through context.js's stateful requestVoice()/duck()
// wrappers — those short-circuit to a no-op with no ctx (see context.js's
// header on why nothing here may touch an AudioContext), so testing the real
// decision logic means calling the pure functions directly with plain data,
// exactly as context.js's own header says they're built for.

function voiceRequest(over = {}) {
  return { id: "a", priority: 1, maxConcurrent: 3, minInterval: 0, ...over };
}

test("the voice limiter accepts requests until the global cap, then steals the lowest priority", () => {
  let active = [];
  const now = 0;
  // Fill the global cap with distinct ids (so no per-id cap ever fires) at a
  // range of priorities, lowest first.
  for (let i = 0; i < GLOBAL_VOICE_CAP; i++) {
    const result = planVoiceRequest(active, {}, voiceRequest({ id: `id${i}`, priority: i, maxConcurrent: 1 }), now);
    assert.equal(result.accepted, true, `voice ${i} should fit under the cap`);
    active = commitVoice(result.active, { id: `id${i}`, priority: i }, now, 10);
  }
  assert.equal(active.length, GLOBAL_VOICE_CAP);

  // One more, priority higher than the current lowest (id0, priority 0):
  // must be accepted by stealing id0, not by growing past the cap.
  const stealer = planVoiceRequest(active, {}, voiceRequest({ id: "newcomer", priority: 5, maxConcurrent: 1 }), now);
  assert.equal(stealer.accepted, true);
  // planVoiceRequest only decides and steals — it doesn't add the new voice
  // itself (see context.js's header on why that's commitVoice's job), so the
  // evicted slot shows up as a headcount one BELOW the cap until committed.
  assert.equal(stealer.active.length, GLOBAL_VOICE_CAP - 1, "stealing must free exactly the one slot the newcomer needs");
  assert.ok(!stealer.active.some((v) => v.id === "id0"), "the lowest-priority voice (id0) should have been evicted");

  const committed = commitVoice(stealer.active, { id: "newcomer", priority: 5 }, now, 10);
  assert.equal(committed.length, GLOBAL_VOICE_CAP, "after commitVoice, the cap is filled again with the newcomer in place of id0");
});

test("over the global cap, a request no more important than the lowest active voice is dropped, not stolen for", () => {
  let active = [];
  const now = 0;
  for (let i = 0; i < GLOBAL_VOICE_CAP; i++) {
    const result = planVoiceRequest(active, {}, voiceRequest({ id: `id${i}`, priority: 5, maxConcurrent: 1 }), now);
    active = commitVoice(result.active, { id: `id${i}`, priority: 5 }, now, 10);
  }
  // Tied with the lowest priority already active (all 5s) — must be dropped,
  // not steal one of them for itself.
  const tied = planVoiceRequest(active, {}, voiceRequest({ id: "newcomer", priority: 5, maxConcurrent: 1 }), now);
  assert.equal(tied.accepted, false);
  assert.equal(tied.active.length, GLOBAL_VOICE_CAP, "a dropped request must leave the active set untouched");

  // Strictly lower than everything active — same outcome.
  const lower = planVoiceRequest(active, {}, voiceRequest({ id: "newcomer", priority: 1, maxConcurrent: 1 }), now);
  assert.equal(lower.accepted, false);
});

test("a request over its own maxConcurrent steals its id's oldest instance, not another id's", () => {
  let active = [];
  const now = 0;
  const req = voiceRequest({ id: "kick", priority: 1, maxConcurrent: 2 });
  // Two instances of "kick", staggered in time, plus one unrelated id that
  // must never be touched by kick's own per-id stealing.
  let result = planVoiceRequest(active, {}, req, 0);
  active = commitVoice(result.active, { id: "kick", priority: 1 }, 0, 10);
  result = planVoiceRequest(active, result.lastTrigger, req, 1);
  active = commitVoice(result.active, { id: "kick", priority: 1 }, 1, 10);
  active = commitVoice(active, { id: "other", priority: 1 }, 1, 10);
  assert.equal(active.filter((v) => v.id === "kick").length, 2);

  // A third "kick" is over its maxConcurrent of 2: must steal the OLDEST
  // kick (start: 0), leaving the second kick (start: 1) and "other" alone.
  const third = planVoiceRequest(active, {}, req, 2);
  assert.equal(third.accepted, true);
  const kicksLeft = third.active.filter((v) => v.id === "kick");
  assert.equal(kicksLeft.length, 1);
  assert.equal(kicksLeft[0].start, 1, "the OLDEST kick instance should have been stolen, not the newer one");
  assert.ok(third.active.some((v) => v.id === "other"), "an unrelated id must never be touched by another id's per-id cap");
});

test("minInterval drops a retrigger that arrives too soon, without touching the active set", () => {
  const req = voiceRequest({ id: "rapid", minInterval: 0.2 });
  const first = planVoiceRequest([], {}, req, 0);
  assert.equal(first.accepted, true);
  const active = commitVoice(first.active, { id: "rapid", priority: req.priority }, 0, 10);

  // 0.1s later — under the 0.2s minInterval — must be dropped.
  const tooSoon = planVoiceRequest(active, first.lastTrigger, req, 0.1);
  assert.equal(tooSoon.accepted, false);
  assert.equal(tooSoon.active.length, active.length, "a minInterval rejection must not alter the active set");

  // 0.2s later — right at the boundary — must be allowed again.
  const onTime = planVoiceRequest(active, first.lastTrigger, req, 0.2);
  assert.equal(onTime.accepted, true);
});

test("a voice's slot releases once its scheduled end time has passed, freeing it for a new request", () => {
  const req = voiceRequest({ id: "short", maxConcurrent: 1 });
  const first = planVoiceRequest([], {}, req, 0);
  const active = commitVoice(first.active, { id: "short", priority: req.priority }, 0, 1); // ends at t=1

  // Before it ends, a second instance is over the per-id cap and must steal it.
  const beforeEnd = planVoiceRequest(active, first.lastTrigger, req, 0.5);
  assert.equal(beforeEnd.active.some((v) => v.id === "short"), false, "the still-live voice should have been stolen");

  // After it ends (t=1.5 > end=1), the slot is already free — a new request
  // must be accepted WITHOUT stealing anything, because the expired voice is
  // simply gone from the active set.
  const afterEnd = planVoiceRequest(active, first.lastTrigger, req, 1.5);
  assert.equal(afterEnd.accepted, true);
  assert.equal(afterEnd.active.length, 0, "an expired voice must not still occupy a slot");
});

test("overlapping ducks take the maximum requested depth, never stack past it", () => {
  const first = planDuck([], 0.3, 0);
  assert.equal(first.target, 0.3);

  // A louder duck arrives while the first is still live: target must jump to
  // the louder one, not sum to 0.3 + 0.6.
  const louder = planDuck(first.active, 0.6, DUCK_ATTACK);
  assert.equal(louder.target, 0.6);

  // A quieter duck arrives while the louder one is still live: target must
  // stay at the louder 0.6, not drop to the new, smaller request.
  const quieter = planDuck(louder.active, 0.2, DUCK_ATTACK + 0.05);
  assert.equal(quieter.target, 0.6, "a quieter overlapping duck must not lower the still-active louder one");

  // Once every prior duck has fully released, a fresh request reflects only
  // itself.
  const afterAllReleased = planDuck(quieter.active, 0.1, DUCK_ATTACK + DUCK_RELEASE + 1);
  assert.equal(afterAllReleased.target, 0.1);
  assert.equal(afterAllReleased.active.length, 1, "expired duck records must not accumulate forever");
});

test("every SFX catalogue entry has all required fields, in range, and a registered generator", () => {
  assert.ok(SOUND_TYPES.length > 0);
  for (const entry of SOUND_TYPES) {
    assert.equal(typeof entry.id, "string");
    assert.equal(typeof entry.generator, "function", `${entry.id} must have had its generator registered by sfx.js`);
    assert.equal(typeof entry.gain, "number");
    assert.ok(entry.gain >= 0 && entry.gain <= 1, `${entry.id}'s gain must be in 0..1`);
    assert.ok(entry.duck >= 0 && entry.duck <= 1, `${entry.id}'s duck must be in 0..1`);
    assert.ok(entry.delaySend >= 0 && entry.delaySend <= 1, `${entry.id}'s delaySend must be in 0..1`);
    assert.ok(Number.isInteger(entry.priority) && entry.priority >= 0, `${entry.id}'s priority must be a non-negative integer`);
    assert.ok(Number.isInteger(entry.maxConcurrent) && entry.maxConcurrent >= 1, `${entry.id}'s maxConcurrent must be >= 1`);
    assert.ok(entry.minInterval >= 0, `${entry.id}'s minInterval must be >= 0`);
    assert.equal(soundTypeById(entry.id), entry, "soundTypeById must resolve back to the same entry");
  }
});

test("every SFX catalogue id is unique", () => {
  const ids = SOUND_TYPES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "a duplicate id would let one entry silently shadow another in soundTypeById");
});

// --- Phase 8 step 2: combat sounds — data and wiring, not Web Audio --------
//
// audio/weaponsfx.js is the ONE place a weapons.js catalogue id is mapped to
// the combat sound it plays (see main.js's fireShot/dropMine and the fire
// block in update()). These tests are the guard the task's own brief asks
// for: a future weapon added to WEAPON_TYPES or ENEMY_WEAPON_TYPES with no
// matching entry here would otherwise fire silently, with nothing to say so
// until someone happened to notice in the browser.

test("PLAYER_FIRE_SOUND covers every WEAPON_TYPES id, with no orphaned keys, and every mapped id is a real sound", () => {
  for (const w of WEAPON_TYPES) {
    assert.ok(w.id in PLAYER_FIRE_SOUND, `WEAPON_TYPES entry "${w.id}" has no entry in PLAYER_FIRE_SOUND`);
    assert.ok(
      soundTypeById(PLAYER_FIRE_SOUND[w.id]),
      `PLAYER_FIRE_SOUND["${w.id}"] points at "${PLAYER_FIRE_SOUND[w.id]}", which isn't in SOUND_TYPES`,
    );
  }
  for (const id of Object.keys(PLAYER_FIRE_SOUND)) {
    assert.ok(WEAPON_TYPES.some((w) => w.id === id), `PLAYER_FIRE_SOUND["${id}"] has no matching WEAPON_TYPES entry — an orphan`);
  }
});

test("ENEMY_FIRE_SOUND covers every ENEMY_WEAPON_TYPES id, with no orphaned keys, and every mapped id is a real sound", () => {
  for (const w of ENEMY_WEAPON_TYPES) {
    assert.ok(w.id in ENEMY_FIRE_SOUND, `ENEMY_WEAPON_TYPES entry "${w.id}" has no entry in ENEMY_FIRE_SOUND`);
    assert.ok(
      soundTypeById(ENEMY_FIRE_SOUND[w.id]),
      `ENEMY_FIRE_SOUND["${w.id}"] points at "${ENEMY_FIRE_SOUND[w.id]}", which isn't in SOUND_TYPES`,
    );
  }
  for (const id of Object.keys(ENEMY_FIRE_SOUND)) {
    assert.ok(ENEMY_WEAPON_TYPES.some((w) => w.id === id), `ENEMY_FIRE_SOUND["${id}"] has no matching ENEMY_WEAPON_TYPES entry — an orphan`);
  }
});

test("the kill_enemy/kill_neutral sound split (main.js's onCarDestroyed, value>=0) agrees with score.js's own enemy/civilian classification", () => {
  // score.js's Score.destroyed() classifies purely on `value >= 0` — see its
  // own header: "the scoreboard never asks what faction a car belonged to".
  // main.js's onCarDestroyed mirrors that exact rule rather than reading
  // car.type.faction, on purpose (see its own comment) — so what this test
  // actually guards is that faction and value can never quietly diverge
  // in cartypes.js, which is the one way that mirrored rule could start
  // picking the wrong sound.
  for (const type of CAR_TYPES) {
    const isEnemy = type.faction === ENEMY_FACTION;
    const scoresAsKill = (type.value ?? 0) >= 0;
    assert.equal(
      scoresAsKill, isEnemy,
      `${type.id}: faction is ${type.faction} but value ${type.value} would play the ${scoresAsKill ? "kill_enemy" : "kill_neutral"} sound`,
    );
  }
});

// --- Phase 8 step 3: damage/pickups/shield audio — the sustained lifecycle -
//
// audio/sustained.js's own header explains the pure/stateful split this
// leans on: plan*() functions are plain data in, plain data out, so the
// REGISTRY's own rules (idempotent acquire, ramp-on-change, release reuses
// rather than rebuilds) can be exercised here with no AudioContext at all —
// exactly the same reason context.js's planDuck()/planVoiceRequest() are
// tested that way above, rather than through duck()/requestVoice()
// themselves (which short-circuit to a no-op with no ctx).

test("Player's onDamage callback reports a real hull loss as (hp, false)", () => {
  const calls = [];
  const player = new Player(0, 0, (hp, deflected) => calls.push({ hp, deflected }));
  player.damage(25);
  assert.deepEqual(calls, [{ hp: 25, deflected: false }]);
});

test("Player's onDamage callback reports a shield deflection as (hp, true), and no hull is lost", () => {
  const calls = [];
  const player = new Player(0, 0, (hp, deflected) => calls.push({ hp, deflected }));
  player.activateShield(2);
  player.damage(9999);
  assert.deepEqual(calls, [{ hp: 9999, deflected: true }]);
  assert.equal(player.health, player.maxHealth);
});

test("Player's onDamage callback never fires for a non-positive hp — nothing happened, nothing to report", () => {
  const calls = [];
  const player = new Player(0, 0, (hp, deflected) => calls.push({ hp, deflected }));
  player.damage(0);
  player.damage(-5);
  assert.deepEqual(calls, []);
});

test("Pickups calls onCollect with the collected pickup type, exactly once per crate", () => {
  const explosions = new Explosions();
  const collected = [];
  const pickups = new Pickups(explosions, (type) => collected.push(type));
  const player = new Player(300, 496);
  const loadout = new Loadout();

  const type = pickupTypeById("fix");
  const [w, h] = PICKUP_SHAPES[type.shape].size;
  const worldY = 500;
  pickups.list.push({ type, worldY, offset: 0, alive: true, age: 0, pulsePhase: 0, w, h });

  const world = { player, distance: worldY, W: 600, H: 800, loadout };
  player.x = centerXAt(worldY, world.W);
  pickups.update(1 / 60, world);

  assert.deepEqual(collected, [type]);
});

test("acquiring a sustained id is idempotent — a second acquire is a true no-op, not just an equal one", () => {
  const first = sustainedPlanAcquire({}, "hull_hiss");
  const second = sustainedPlanAcquire(first, "hull_hiss");
  assert.equal(second, first, "re-acquiring an already-tracked id must return the SAME reference — nothing rebuilt");
});

test("release then acquire reuses the same registry entry rather than rebuilding it", () => {
  let state = sustainedPlanAcquire({}, "shield_drone");
  state = sustainedPlanSetLevel(state, "shield_drone", 0.12).state;

  const released = sustainedPlanRelease(state, "shield_drone").state;
  assert.ok("shield_drone" in released, "release must not remove the tracked voice — same graph, gain ramped to zero");
  assert.equal(released.shield_drone.level, 0);

  const reacquired = sustainedPlanAcquire(released, "shield_drone");
  assert.equal(reacquired, released, "re-acquiring a released id must be a no-op — the SAME entry, not a fresh one");
});

test("setLevel only reports a change when the requested value actually differs — 'ramp on change, not every frame'", () => {
  let state = sustainedPlanAcquire({}, "hull_hiss");
  const first = sustainedPlanSetLevel(state, "hull_hiss", 0.05);
  assert.equal(first.changed, true);
  state = first.state;

  // Same value again — as a per-frame poller (updateHullHiss) would send on
  // every tick the hull fraction hasn't moved.
  const repeat = sustainedPlanSetLevel(state, "hull_hiss", 0.05);
  assert.equal(repeat.changed, false, "an unchanged target must not report a change to ramp toward");
  assert.equal(repeat.state, state, "an unchanged target must return the SAME state reference");

  const moved = sustainedPlanSetLevel(state, "hull_hiss", 0.06);
  assert.equal(moved.changed, true);
});

test("releasing an already-silent voice is a no-op — idempotent in both directions", () => {
  let state = sustainedPlanAcquire({}, "wall_scrape");
  const first = sustainedPlanRelease(state, "wall_scrape");
  assert.equal(first.changed, false, "releasing a voice that was never raised above 0 must not report a change");
  const second = sustainedPlanRelease(first.state, "wall_scrape");
  assert.equal(second.changed, false);
});

test("sustained voices have no cap — acquiring more ids than the one-shot GLOBAL_VOICE_CAP never drops any", () => {
  // Contrast with the one-shot voice limiter tested above: there is no
  // priority, no maxConcurrent, no stealing anywhere in planAcquire — this
  // is the architectural guarantee that a sustained voice can never be
  // evicted the way a one-shot can (sustained.js's own header: "a hiss that
  // gets evicted mid-firefight... is a bug that would be very hard to
  // notice"). GLOBAL_VOICE_CAP+5 is an arbitrary count comfortably over the
  // one-shot cap — the real catalogue only ever has 3.
  let state = {};
  const ids = Array.from({ length: GLOBAL_VOICE_CAP + 5 }, (_, i) => `voice${i}`);
  for (const id of ids) state = sustainedPlanAcquire(state, id);
  assert.equal(Object.keys(state).length, ids.length, "every sustained id must be tracked — nothing stolen or dropped");
});

// --- Phase 8 step 3: hull_hiss's own level curve ----------------------------

test("hull_hiss is silent above its threshold, and the curve is monotonic and bounded below it", () => {
  let last = -1;
  for (let frac = 0; frac <= 1; frac += 0.01) {
    const level = hullHissLevel(frac);
    assert.ok(level >= 0 && level <= HULL_HISS_PEAK, `hullHissLevel(${frac.toFixed(2)}) = ${level} is outside [0, HULL_HISS_PEAK]`);
    if (frac >= HULL_HISS_ON) {
      assert.equal(level, 0, `hullHissLevel(${frac.toFixed(2)}) must be silent at/above HULL_HISS_ON`);
    }
  }
  // Monotonic: level must never rise as hull fraction rises (i.e. as damage
  // heals) across the whole domain, not just above the threshold.
  for (let frac = 0; frac <= 1; frac += 0.01) {
    const level = hullHissLevel(frac);
    assert.ok(level <= last + 1e-9 || last === -1, `hullHissLevel is not monotonic: frac=${frac.toFixed(2)} gave ${level}, previous (lower frac) gave ${last}`);
    last = level;
  }
});

test("hull_hiss's curve hits the documented endpoints exactly", () => {
  assert.equal(hullHissLevel(HULL_HISS_ON), 0, "level must be exactly 0 right at the threshold");
  assert.equal(hullHissLevel(0), HULL_HISS_PEAK, "level must reach exactly HULL_HISS_PEAK at 0% hull");
  assert.equal(hullHissLevel(1), 0, "level at full hull must be 0");
});

test("hull_hiss hysteresis: once ON it stays on past HULL_HISS_ON, and only switches off past HULL_HISS_OFF", () => {
  assert.ok(HULL_HISS_OFF > HULL_HISS_ON, "the off-threshold must sit ABOVE the on-threshold, or there is no hysteresis band at all");

  // Starting inactive: switches on only at/below HULL_HISS_ON.
  assert.equal(hullHissActive(HULL_HISS_ON + 0.001, false), false);
  assert.equal(hullHissActive(HULL_HISS_ON, false), true);
  assert.equal(hullHissActive(0, false), true);

  // Starting active: STAYS on all the way up through the gap between the two
  // thresholds — this is the whole point of the hysteresis band.
  assert.equal(hullHissActive(HULL_HISS_ON + 0.01, true), true, "must not flutter off inside the hysteresis gap");
  assert.equal(hullHissActive(HULL_HISS_OFF - 0.001, true), true);
  assert.equal(hullHissActive(HULL_HISS_OFF, true), false, "must switch off once it reaches HULL_HISS_OFF");
  assert.equal(hullHissActive(1, true), false);
});

test("a car scraping the player across the 60% edge cannot flutter the hiss on/off — a hysteresis walk never toggles twice in a row the same way", () => {
  // Simulates hull ticking back and forth across HULL_HISS_ON by a small
  // step (as repeated WALL_DAMAGE ticks might) and checks the active state
  // never oscillates on every single step — it should take a real crossing
  // of the FAR threshold to flip back.
  let active = false;
  let flips = 0;
  const walk = [0.61, 0.59, 0.61, 0.59, 0.61, 0.60, 0.605, 0.595, 0.61];
  for (const frac of walk) {
    const next = hullHissActive(frac, active);
    if (next !== active) flips++;
    active = next;
  }
  assert.ok(flips <= 1, `hiss toggled ${flips} times walking back and forth across HULL_HISS_ON — hysteresis isn't holding`);
});

// --- Phase 8 step 3: dropout/crackle scheduling -----------------------------

test("the dropout timer never fires while inactive, however long it runs", () => {
  let timer = DROPOUT_MIN_INTERVAL;
  let fired = 0;
  for (let i = 0; i < 100000; i++) {
    const step = stepDropoutTimer(timer, 1 / 60, false);
    timer = step.timer;
    if (step.fired) fired++;
  }
  assert.equal(fired, 0, "an inactive (hull >= DROPOUT_HULL_THRESHOLD) dropout timer must never fire");
});

test("the dropout timer's average interval, run continuously active, lands inside its documented [min, max] range", () => {
  let timer = DROPOUT_MIN_INTERVAL;
  let fired = 0;
  const dt = 1 / 60;
  const totalSeconds = 20000; // long enough for a stable average across many events
  for (let t = 0; t < totalSeconds; t += dt) {
    const step = stepDropoutTimer(timer, dt, true);
    timer = step.timer;
    if (step.fired) fired++;
  }
  const avgInterval = totalSeconds / fired;
  assert.ok(
    avgInterval >= DROPOUT_MIN_INTERVAL && avgInterval <= DROPOUT_MAX_INTERVAL,
    `average dropout interval ${avgInterval.toFixed(2)}s is outside [${DROPOUT_MIN_INTERVAL}, ${DROPOUT_MAX_INTERVAL}]`,
  );
});

test("dropoutHoldSeconds always stays within its documented 30-60ms range", () => {
  for (let i = 0; i < 10000; i++) {
    const hold = dropoutHoldSeconds();
    assert.ok(hold >= DROPOUT_MIN_HOLD && hold <= DROPOUT_MAX_HOLD, `dropout hold ${hold} outside [${DROPOUT_MIN_HOLD}, ${DROPOUT_MAX_HOLD}]`);
  }
});

test("the crackle timer never fires while inactive, however long it runs", () => {
  let timer = CRACKLE_MIN_INTERVAL;
  let fired = 0;
  for (let i = 0; i < 100000; i++) {
    const step = stepCrackleTimer(timer, 1 / 60, false);
    timer = step.timer;
    if (step.fired) fired++;
  }
  assert.equal(fired, 0, "an inactive (hull >= CRACKLE_HULL_THRESHOLD) crackle timer must never fire");
});

test("the crackle rate, run continuously active, reads as 'a few per second' — bounded well clear of a metronome or a wall of noise", () => {
  let timer = CRACKLE_MIN_INTERVAL;
  let fired = 0;
  const dt = 1 / 60;
  const totalSeconds = 5000;
  for (let t = 0; t < totalSeconds; t += dt) {
    const step = stepCrackleTimer(timer, dt, true);
    timer = step.timer;
    if (step.fired) fired++;
  }
  const rate = fired / totalSeconds;
  // The clustering bias (see stepCrackleTimer's own header) pulls the mean
  // interval below the base [CRACKLE_MIN_INTERVAL, CRACKLE_MAX_INTERVAL]
  // spread, so the bound here is generous rather than derived from those
  // two constants alone — this is a "sane order of magnitude" check, not a
  // tight pin.
  assert.ok(rate >= 1 && rate <= 10, `crackle rate ${rate.toFixed(2)}/s is not "a few per second"`);
});

test("crackle scheduling is frozen, not reset, while inactive — no burst of events on re-entry", () => {
  // Count down close to firing, then go inactive for a long stretch, then
  // reactivate: the very next active step must fire at most once (whatever
  // was left on the clock), never a backlog of events for the time spent
  // inactive.
  const step = stepCrackleTimer(0, 0, true); // timer already at 0 — fires immediately
  assert.ok(step.fired);
  const armedTimer = step.timer;

  // Long inactive stretch — timer must not move at all.
  const stillInactive = stepCrackleTimer(armedTimer, 1000, false);
  assert.equal(stillInactive.timer, armedTimer, "an inactive timer must not count down at all");
  assert.equal(stillInactive.fired, false);

  // Reactivating with the SAME dt budget it was frozen at must fire at most once.
  const reactivated = stepCrackleTimer(stillInactive.timer, 0.001, true);
  assert.equal(typeof reactivated.fired, "boolean");
});

// --- Phase 8 step 3: shield_drone's fade curve ------------------------------

test("shield_drone is silent once expired, holds at peak with time to spare, and fades linearly across its own window", () => {
  const peak = 0.2;
  const window = 1.5;
  assert.equal(shieldDroneLevel(0, peak, window), 0);
  assert.equal(shieldDroneLevel(-1, peak, window), 0, "an already-expired shield must never report a positive level");
  assert.equal(shieldDroneLevel(window, peak, window), peak);
  assert.equal(shieldDroneLevel(window * 5, peak, window), peak, "well before the fade window, level must hold at peak, not keep climbing");
  assert.ok(Math.abs(shieldDroneLevel(window / 2, peak, window) - peak / 2) < 1e-9, "the fade must be linear across its own window");
});

test("SHIELD_DRONE_FADE_WINDOW reuses player.js's own SHIELD_EXPIRING rather than a second, driftable number", () => {
  assert.equal(SHIELD_DRONE_FADE_WINDOW, PLAYER_SHIELD_EXPIRING / 2);
});

// --- Phase 8 step 3: catalogues ---------------------------------------------

test("every SUSTAINED_TYPES entry has an id and a registered generator", () => {
  assert.ok(SUSTAINED_TYPES.length > 0);
  for (const entry of SUSTAINED_TYPES) {
    assert.equal(typeof entry.id, "string");
    assert.equal(typeof entry.generator, "function", `${entry.id} must have had its generator registered by sustainedfx.js`);
    assert.equal(sustainedTypeById(entry.id), entry, "sustainedTypeById must resolve back to the same entry");
  }
  const ids = SUSTAINED_TYPES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "a duplicate sustained id would let one entry silently shadow another");
});

test("PICKUP_SOUND covers every kind in pickuptypes.js, with no orphaned keys, and every mapped id is a real sound", () => {
  const kinds = new Set(PICKUP_TYPES.map((t) => t.kind));
  for (const kind of kinds) {
    assert.ok(kind in PICKUP_SOUND, `pickup kind "${kind}" has no entry in PICKUP_SOUND`);
    assert.ok(soundTypeById(PICKUP_SOUND[kind]), `PICKUP_SOUND["${kind}"] points at "${PICKUP_SOUND[kind]}", which isn't in SOUND_TYPES`);
  }
  for (const kind of Object.keys(PICKUP_SOUND)) {
    assert.ok(kinds.has(kind), `PICKUP_SOUND["${kind}"] has no matching pickuptypes.js kind — an orphan`);
  }
});

test("player_hit's intensity scaling stays inside sane bounds at both ends of opts.intensity", () => {
  // sfx.js's generatePlayerHit isn't exported (its shaping is internal, same
  // as every other one-shot generator) — but the catalogue entry it's
  // registered against must still exist, self-duck (duck: 0, see its own
  // comment), and be in the combat/damage priority tier alongside the kills.
  const entry = soundTypeById("player_hit");
  assert.equal(entry.duck, 0, "player_hit must self-duck via opts.intensity, not a static catalogue duck");
  assert.ok(entry.priority >= 6, "a real hull loss should sit at or above the player's own weapons tier");
});

// --- Phase 8 step 4: console log ticks --------------------------------------

test("CONSOLE_SOUND/CONSOLE_PITCH cover exactly HINT/WARN/CRITICAL, with no orphans, and pitch strictly descends with severity", () => {
  const severities = [CONSOLE_HINT, CONSOLE_WARN, CONSOLE_CRITICAL];
  for (const s of severities) {
    assert.ok(s in CONSOLE_SOUND, `severity "${s}" has no entry in CONSOLE_SOUND`);
    assert.ok(soundTypeById(CONSOLE_SOUND[s]), `CONSOLE_SOUND["${s}"] points at "${CONSOLE_SOUND[s]}", which isn't in SOUND_TYPES`);
    assert.ok(s in CONSOLE_PITCH, `severity "${s}" has no entry in CONSOLE_PITCH`);
  }
  for (const key of Object.keys(CONSOLE_SOUND)) {
    assert.ok(severities.includes(key), `CONSOLE_SOUND["${key}"] has no matching console.js severity — an orphan`);
  }
  for (const key of Object.keys(CONSOLE_PITCH)) {
    assert.ok(severities.includes(key), `CONSOLE_PITCH["${key}"] has no matching console.js severity — an orphan`);
  }
  assert.ok(
    CONSOLE_PITCH[CONSOLE_HINT] > CONSOLE_PITCH[CONSOLE_WARN] &&
      CONSOLE_PITCH[CONSOLE_WARN] > CONSOLE_PITCH[CONSOLE_CRITICAL],
    "pitch must strictly descend HINT > WARN > CRITICAL — lower reads as worse, per the design brief",
  );
});

test("console.js's onPush() fires the subscriber exactly once per push, with the pushed text and severity", () => {
  consoleReset();
  const calls = [];
  consoleOnPush((text, severity) => calls.push({ text, severity }));
  consolePush("hello", CONSOLE_WARN);
  consolePush("again", CONSOLE_HINT);
  assert.deepEqual(calls, [
    { text: "hello", severity: CONSOLE_WARN },
    { text: "again", severity: CONSOLE_HINT },
  ]);
  consoleReset();
});

test("registering a second subscriber replaces the first — never stacks two callbacks on one push", () => {
  consoleReset();
  let aCalls = 0;
  let bCalls = 0;
  consoleOnPush(() => aCalls++);
  consoleOnPush(() => bCalls++);
  consolePush("x", CONSOLE_HINT);
  assert.equal(aCalls, 0, "the first subscriber must have been replaced, not left running alongside the second");
  assert.equal(bCalls, 1);
  consoleReset();
});

test("the unsubscribe function onPush() returns removes exactly that subscriber", () => {
  consoleReset();
  let calls = 0;
  const unsub = consoleOnPush(() => calls++);
  unsub();
  consolePush("x", CONSOLE_HINT);
  assert.equal(calls, 0, "push() must not call an unsubscribed callback");
  consoleReset();
});

test("reset() clears the subscriber — nothing fires on a push after reset() unless re-registered", () => {
  consoleReset();
  let calls = 0;
  consoleOnPush(() => calls++);
  consoleReset();
  consolePush("x", CONSOLE_HINT);
  assert.equal(calls, 0, "a subscriber registered before reset() must not survive it");
});

// --- Phase 8 step 4: dread_pulse's threat curve -----------------------------

test("dread_pulse's proximity curve is 0 with no hostile in range, clamped to [0,1], and monotonic as the gap closes", () => {
  assert.equal(dreadProximity(Infinity), 0, "no hostile at all (an infinite gap) must report zero proximity");
  assert.equal(dreadProximity(DREAD_RANGE_ON), 0, "proximity must be exactly 0 right at the edge of the threat range");
  assert.equal(dreadProximity(0), 1, "proximity must reach exactly 1 at zero gap");

  let last = -1;
  for (let gap = DREAD_RANGE_ON + 200; gap >= 0; gap -= 5) {
    const p = dreadProximity(gap);
    assert.ok(p >= 0 && p <= 1, `dreadProximity(${gap}) = ${p} outside [0,1]`);
    assert.ok(p >= last - 1e-9, `dreadProximity is not monotonic as gap shrinks: gap=${gap} gave ${p}, previous (larger gap) gave ${last}`);
    last = p;
  }
  assert.ok(
    dreadPulseLevel(0) > dreadPulseLevel(DREAD_RANGE_ON / 2),
    "level must read higher right on the player's tail than mid-range",
  );
});

test("dread_pulse hysteresis: once ON it stays on past DREAD_RANGE_ON, only switches off past DREAD_RANGE_OFF, and `closing` gates it outright", () => {
  assert.ok(DREAD_RANGE_OFF > DREAD_RANGE_ON, "the off-threshold must sit ABOVE the on-threshold, or there is no hysteresis band at all");

  // A hostile that isn't closing never activates the pulse, whatever the gap
  // — and it switches an already-active pulse off outright, no hysteresis.
  assert.equal(dreadPulseActive(0, false, false), false);
  assert.equal(dreadPulseActive(0, false, true), false, "closing must gate the pulse off outright even if it was already active");

  // Starting inactive: switches on only at/below DREAD_RANGE_ON, while closing.
  assert.equal(dreadPulseActive(DREAD_RANGE_ON + 1, true, false), false);
  assert.equal(dreadPulseActive(DREAD_RANGE_ON, true, false), true);

  // Starting active: STAYS on all the way through the gap between the two
  // thresholds — the whole point of the hysteresis band.
  assert.equal(dreadPulseActive(DREAD_RANGE_ON + 10, true, true), true, "must not flutter off inside the hysteresis gap");
  assert.equal(dreadPulseActive(DREAD_RANGE_OFF - 1, true, true), true);
  assert.equal(dreadPulseActive(DREAD_RANGE_OFF, true, true), false, "must switch off once it reaches DREAD_RANGE_OFF");
});

test("dreadPulseRate is bounded at both ends across the full input range, and rises as the gap closes", () => {
  for (let gap = -100; gap <= DREAD_RANGE_ON + 500; gap += 10) {
    const rate = dreadPulseRate(gap);
    assert.ok(
      rate >= DREAD_RATE_MIN - 1e-9 && rate <= DREAD_RATE_MAX + 1e-9,
      `dreadPulseRate(${gap}) = ${rate} outside [${DREAD_RATE_MIN}, ${DREAD_RATE_MAX}]`,
    );
  }
  assert.equal(dreadPulseRate(DREAD_RANGE_ON), DREAD_RATE_MIN, "rate must be exactly the minimum at the edge of the threat range");
  assert.equal(dreadPulseRate(0), DREAD_RATE_MAX, "rate must be exactly the maximum right on the player's tail");
  assert.ok(dreadPulseRate(50) > dreadPulseRate(400), "rate must rise as the gap closes");
});

// --- Phase 8 step 4: speed-linked music filter ------------------------------

test("speedToMusicCutoff stays inside [MUSIC_CUTOFF_MIN, MUSIC_CUTOFF_MAX] for every input, including 0 and MAX_SPEED", () => {
  for (const speed of [-1000, 0, MIN_SPEED - 50, MIN_SPEED, 260, MAX_SPEED, MAX_SPEED + 1000]) {
    const cutoff = speedToMusicCutoff(speed);
    assert.ok(
      cutoff >= MUSIC_CUTOFF_MIN && cutoff <= MUSIC_CUTOFF_MAX,
      `speedToMusicCutoff(${speed}) = ${cutoff} outside [${MUSIC_CUTOFF_MIN}, ${MUSIC_CUTOFF_MAX}]`,
    );
  }
  assert.equal(speedToMusicCutoff(MIN_SPEED), MUSIC_CUTOFF_MIN, "must hit the floor exactly at MIN_SPEED");
  assert.equal(speedToMusicCutoff(MAX_SPEED), MUSIC_CUTOFF_MAX, "must hit the ceiling exactly at MAX_SPEED");
  assert.ok(speedToMusicCutoff(MAX_SPEED) > speedToMusicCutoff(MIN_SPEED), "faster must never read duller than slower");
});

// --- Phase 8 step 5: menu, transitions and the mix pass ---------------------
//
// PROBLEM 1 (context starts on the first keypress, not START GAME) is wired
// entirely in main.js — a `window.addEventListener("keydown", ..., { once:
// true })` — which touches `document`/`window` at import time and so can't
// be imported here (see this file's own header on why main.js itself is
// never one of the modules under test). What CAN be verified in Node is the
// contract that listener relies on: nothing anywhere in the audio module
// graph ever creates an AudioContext merely by being imported. If it did,
// isStarted() would already read true by this point in the suite, having
// imported every audio/*.js module above with no browser `window` in sight —
// and every no-ctx short-circuit this whole file already exercises (duck(),
// requestVoice(), setMusicCutoff(), ...) would have thrown instead of
// quietly no-op'ing the moment any of those ran.

test("importing the whole audio module graph never creates an AudioContext on its own", () => {
  assert.equal(isStarted(), false, "a page loaded and left untouched must never end up with a live AudioContext");
});

// PROBLEM 2: cutoff composition. See context.js's own "Cutoff composition"
// section for the full design — base (speed) x offset (sector transition),
// composed by ONE pair of functions so the two can never fight over
// musicFilter.frequency the way two independent rampers to the same
// AudioParam would.

test("composeMusicCutoff(base, 1) reproduces the base exactly — a released offset must have NO effect", () => {
  for (const base of [MUSIC_CUTOFF_MIN, 1500, MUSIC_CUTOFF_MAX]) {
    assert.equal(composeMusicCutoff(base, 1), base);
  }
});

test("composeMusicCutoff stays sane (never below MUSIC_CUTOFF_FLOOR, never above the base) across the full base x offset space", () => {
  for (let base = MUSIC_CUTOFF_MIN; base <= MUSIC_CUTOFF_MAX; base += 100) {
    for (let offset = SECTOR_COLLAPSE_OFFSET; offset <= 1; offset += 0.05) {
      const composed = composeMusicCutoff(base, offset);
      assert.ok(composed >= MUSIC_CUTOFF_FLOOR, `composeMusicCutoff(${base}, ${offset}) = ${composed} fell below MUSIC_CUTOFF_FLOOR`);
      assert.ok(composed <= base, `composeMusicCutoff(${base}, ${offset}) = ${composed} exceeded its own base — an offset in (0,1] must never brighten it`);
    }
  }
  // The collapse offset itself is deliberately allowed to land BELOW
  // MUSIC_CUTOFF_MIN (see context.js's own header on why this does NOT
  // reuse the speed mapping's own clamp) — confirm it actually does, at
  // least at the darkest base the speed mapping ever produces, or the
  // "reads as darker than the music ever gets in ordinary play" design
  // goal silently stops being true.
  assert.ok(
    composeMusicCutoff(MUSIC_CUTOFF_MIN, SECTOR_COLLAPSE_OFFSET) < MUSIC_CUTOFF_MIN,
    "the sector collapse must be able to go below the speed mapping's own floor",
  );
});

function cutoffState(over = {}) {
  return { cutoffBase: MUSIC_CUTOFF_MAX, lastCutoffTarget: null, transitionEndTime: 0, ...over };
}

test("planSetMusicCutoff suppresses the write while a transition is live, but still tracks the freshest base", () => {
  const state = cutoffState({ transitionEndTime: 5 });
  const plan = planSetMusicCutoff(state, 1200, 2); // now (2) is before transitionEndTime (5)
  assert.equal(plan.write, false, "a speed update mid-transition must not touch the AudioParam");
  assert.equal(plan.state.cutoffBase, 1200, "the new base must still be remembered for whenever the transition releases");
  assert.equal(plan.state.transitionEndTime, 5, "the transition's own end time must be untouched by a suppressed write");
});

test("planSetMusicCutoff resumes writing once the transition has ended, using whatever base was tracked during it", () => {
  // Two suppressed updates during the transition (as main.js would send one
  // per "playing" tick), then one arriving after transitionEndTime — only
  // the last should actually write, and it should write the LATEST base.
  let state = cutoffState({ transitionEndTime: 5 });
  state = planSetMusicCutoff(state, 1100, 2).state;
  state = planSetMusicCutoff(state, 1300, 4).state;
  const after = planSetMusicCutoff(state, 1300, 6); // same value as the last tracked base, but now is PAST transitionEndTime
  assert.equal(after.write, true, "the first update after the transition ends must write, even if the value hasn't changed since the last SUPPRESSED update");
  assert.equal(after.target, 1300);
});

test("planSetMusicCutoff is a plain no-op when the target already matches and no transition is in the way — unchanged from before the transition system existed", () => {
  const state = cutoffState({ cutoffBase: 1800, lastCutoffTarget: 1800, transitionEndTime: 0 });
  const plan = planSetMusicCutoff(state, 1800, 10);
  assert.equal(plan.write, false);
  assert.equal(plan.state, state, "an unchanged target with no transition must return the SAME state reference, mirroring sustained.js's own setLevel dedupe");
});

test("planBeginSectorTransition captures the CURRENT base as its reopen target and schedules the collapse/reopen window ATTACK+RELEASE seconds out", () => {
  const state = cutoffState({ cutoffBase: 2000 });
  const now = 10;
  const plan = planBeginSectorTransition(state, now);
  assert.equal(plan.reopenTarget, 2000, "the reopen must return to the base as it was AT THE MOMENT the crossing fired");
  assert.equal(plan.collapseTarget, composeMusicCutoff(2000, SECTOR_COLLAPSE_OFFSET));
  assert.equal(plan.collapseAt, now + SECTOR_COLLAPSE_ATTACK);
  assert.equal(plan.transitionEndTime, now + SECTOR_COLLAPSE_ATTACK + SECTOR_COLLAPSE_RELEASE);
  assert.equal(plan.state.transitionEndTime, plan.transitionEndTime, "the returned state must track the same end time the caller schedules the reopen ramp against");
  assert.equal(plan.state.lastCutoffTarget, 2000, "starting a transition must also settle lastCutoffTarget at the base, so a post-transition setMusicCutoff() for that exact value is correctly treated as already-applied");
});

test("a speed update mid-transition does not cancel the transition — composing the two end to end", () => {
  // The scenario the whole composition scheme exists for: a crossing begins
  // a transition, a speed update arrives mid-flight (must be suppressed,
  // not cancel anything), and once the transition's own window has elapsed
  // the next speed update writes cleanly again.
  let state = cutoffState({ cutoffBase: 1600 });
  const begin = planBeginSectorTransition(state, 0);
  state = begin.state;
  assert.equal(state.transitionEndTime, SECTOR_COLLAPSE_ATTACK + SECTOR_COLLAPSE_RELEASE);

  const midTransition = planSetMusicCutoff(state, 1900, SECTOR_COLLAPSE_ATTACK); // a speed change right as the collapse leg ends
  assert.equal(midTransition.write, false, "still inside the transition window — must be suppressed");
  state = midTransition.state;

  const afterTransition = planSetMusicCutoff(state, 1900, SECTOR_COLLAPSE_ATTACK + SECTOR_COLLAPSE_RELEASE + 0.01);
  assert.equal(afterTransition.write, true, "once the transition's own window has elapsed, the next update must write normally");
  assert.equal(afterTransition.target, 1900, "and it must write the LATEST base tracked during the transition, not whatever the base was when the transition began");
});

test("SECTOR_COLLAPSE_ATTACK/RELEASE match the design brief's own ~300ms collapse / ~1.5s reopen", () => {
  assert.ok(SECTOR_COLLAPSE_ATTACK > 0.1 && SECTOR_COLLAPSE_ATTACK < 0.6, `SECTOR_COLLAPSE_ATTACK ${SECTOR_COLLAPSE_ATTACK} is not close to the brief's ~300ms`);
  assert.ok(SECTOR_COLLAPSE_RELEASE > 1 && SECTOR_COLLAPSE_RELEASE < 2.2, `SECTOR_COLLAPSE_RELEASE ${SECTOR_COLLAPSE_RELEASE} is not close to the brief's ~1.5s`);
});

// jack_in's own duration and the music scheduler's start-time offset are the
// SAME number by construction (synth.js's jackIn(): `music.start(JACK_IN_DURATION)`)
// rather than two literals that could drift — see that function's own
// header. What's left to guard in Node is just that the shared constant
// itself is still a sane figure near the design brief's own "~1.5s".
test("JACK_IN_DURATION is a sane figure near the design brief's own ~1.5s", () => {
  assert.ok(JACK_IN_DURATION > 1 && JACK_IN_DURATION < 2, `JACK_IN_DURATION ${JACK_IN_DURATION} is not close to ~1.5s`);
});

test("DISCONNECT_FADE is a short, sane head start ahead of the disconnect SFX's own static", () => {
  assert.ok(DISCONNECT_FADE > 0 && DISCONNECT_FADE < 1, `DISCONNECT_FADE ${DISCONNECT_FADE} should be a brief head start, not a long fade`);
});

// The menu action -> sound id map (audio/menusfx.js). Mirrors
// PLAYER_FIRE_SOUND/ENEMY_FIRE_SOUND's own coverage tests above, except the
// "catalogue" being covered (MENU_ACTIONS) is hand-written rather than
// derived from another file's own list — see menusfx.js's own header for why.

test("MENU_SOUND covers exactly MENU_ACTIONS, with no orphaned keys, and every mapped id is a real sound", () => {
  for (const action of MENU_ACTIONS) {
    assert.ok(action in MENU_SOUND, `menu action "${action}" has no entry in MENU_SOUND`);
    assert.ok(soundTypeById(MENU_SOUND[action]), `MENU_SOUND["${action}"] points at "${MENU_SOUND[action]}", which isn't in SOUND_TYPES`);
  }
  const actions = new Set(MENU_ACTIONS);
  for (const key of Object.keys(MENU_SOUND)) {
    assert.ok(actions.has(key), `MENU_SOUND["${key}"] has no matching MENU_ACTIONS entry — an orphan`);
  }
  assert.equal(Object.keys(MENU_SOUND).length, MENU_ACTIONS.length, "MENU_SOUND must cover MENU_ACTIONS exactly, one entry each");
});

// --- The music track backend (audio/trackmusic.js, audio/musictypes.js, ---
// --- audio/synth.js's backend selection, tools/serve.js's listing) --------
//
// Nothing below touches a real fetch, AudioContext or decodeAudioData —
// those don't exist under plain Node (see the project's own testing
// guidance: "measure with headless Node sims; browser import() serves
// stale modules"). What's tested is exactly what CAN be exercised without
// them: the pure playlist/shuffle/failure logic, runPreload()'s async
// control flow driven with fake fetch/decode functions, the backend-choice
// decision, and tools/serve.js's listing endpoint against a throwaway
// fixture directory. Real playback (a track actually decoding and sounding,
// disturb()'s bend, gapless single-track looping) was verified by hand
// against assets/music/under_chrome.ogg — see the PR description.

// A small seeded PRNG (mulberry32) so shuffleOrder's tests are
// deterministic and reproducible — Math.random() itself is never used in a
// test, only as shuffleOrder's own production default.
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("shuffleOrder returns a permutation — every track appears exactly once, for several seeds", () => {
  const names = ["a.ogg", "b.ogg", "c.ogg", "d.ogg", "e.ogg"];
  for (const seed of [1, 2, 42, 1000]) {
    const order = shuffleOrder(names, seededRng(seed));
    assert.deepEqual([...order].sort(), [...names].sort(), `seed ${seed} did not produce a permutation of the input`);
  }
});

test("shuffleOrder does not mutate its input array", () => {
  const names = ["a.ogg", "b.ogg", "c.ogg"];
  const copy = [...names];
  shuffleOrder(names, seededRng(7));
  assert.deepEqual(names, copy);
});

test("nextIndex wraps from the last entry back to 0, and is 0 for an empty order", () => {
  assert.equal(nextIndex(["a", "b", "c"], 2), 0);
  assert.equal(nextIndex(["a", "b", "c"], 0), 1);
  assert.equal(nextIndex([], 0), 0);
});

test("a shuffled order never repeats the previous track on wrap, for more than one file", () => {
  // The structural guarantee nextIndex()'s own header claims: order[last]
  // and order[0] are two different elements of the same permutation, so
  // cycling past the end can never immediately replay what just finished.
  const names = ["a.ogg", "b.ogg", "c.ogg", "d.ogg"];
  for (const seed of [3, 11, 99, 4242]) {
    const order = shuffleOrder(names, seededRng(seed));
    const wrapIndex = nextIndex(order, order.length - 1);
    assert.equal(wrapIndex, 0);
    assert.notEqual(order[order.length - 1], order[wrapIndex], `seed ${seed}: wrap must not repeat the previous track`);
  }
});

test("shouldLoopSingleTrack is true only for a single-file directory", () => {
  assert.equal(shouldLoopSingleTrack(["only.ogg"]), true);
  assert.equal(shouldLoopSingleTrack(["a.ogg", "b.ogg"]), false);
  assert.equal(shouldLoopSingleTrack([]), false);
});

test("retainedTrackNames keeps only the current track decoded, and only the next one compressed", () => {
  // The asymmetry IS the memory fix: decoded PCM is tens of MB per track, the
  // compressed bytes a few. Holding the stream-ahead decoded (as this used to)
  // doubled the soundtrack's footprint for the entire length of every track.
  assert.deepEqual(retainedTrackNames("a.ogg", "b.ogg"), {
    decoded: new Set(["a.ogg"]),
    encoded: new Set(["b.ogg"]),
  });
});

test("retainedTrackNames drops a null next without disturbing the current track", () => {
  // A single-track directory, or every other track already failed — there is
  // nothing worth prefetching, but the track that's sounding must still be kept.
  assert.deepEqual(retainedTrackNames("a.ogg", null), {
    decoded: new Set(["a.ogg"]),
    encoded: new Set(),
  });
});

test("retainedTrackNames retains nothing at all before anything is playing", () => {
  // order[index] is undefined until the listing has settled — evictStale()
  // must treat that as "keep nothing", never as a name to hold on to.
  assert.deepEqual(retainedTrackNames(undefined, null), {
    decoded: new Set(),
    encoded: new Set(),
  });
});

test("the two retained sets never name the same track", () => {
  // A track cannot be both the one playing and the one queued behind it; if it
  // ever were, evictStale() would keep a decoded copy AND a compressed one of
  // the same audio — paying twice for the thing this exists to stop paying
  // twice for.
  const keep = retainedTrackNames("a.ogg", "b.ogg");
  for (const name of keep.decoded) {
    assert.ok(!keep.encoded.has(name), `${name} is retained in both caches at once`);
  }
});

test("nextPlayableIndex finds the first non-failed track at or after fromIndex, wrapping", () => {
  const order = ["a.ogg", "b.ogg", "c.ogg", "d.ogg"];
  assert.equal(nextPlayableIndex(order, 0, new Set()), 0, "an empty failed set — the starting index itself is playable");
  assert.equal(nextPlayableIndex(order, 0, new Set(["a.ogg"])), 1, "skips the failed entry at fromIndex");
  assert.equal(nextPlayableIndex(order, 2, new Set(["c.ogg", "d.ogg"])), 0, "wraps past the end of the order");
});

test("nextPlayableIndex returns null once every track has failed", () => {
  const order = ["a.ogg", "b.ogg"];
  assert.equal(nextPlayableIndex(order, 0, new Set(["a.ogg", "b.ogg"])), null);
});

test("nextPlayableIndex returns null for an empty order regardless of fromIndex", () => {
  assert.equal(nextPlayableIndex([], 0, new Set()), null);
});

test("runPreload falls back to an empty, not-ready result when the listing fetch throws", async () => {
  const result = await runPreload({
    fetchListing: async () => { throw new Error("network down"); },
    decodeTrack: async () => { throw new Error("should never be called"); },
  });
  assert.deepEqual(result, { order: [], firstTrackReady: false });
});

test("runPreload falls back to an empty, not-ready result for an empty directory listing", async () => {
  const result = await runPreload({
    fetchListing: async () => [],
    decodeTrack: async () => { throw new Error("should never be called"); },
  });
  assert.deepEqual(result, { order: [], firstTrackReady: false });
});

test("runPreload falls back to an empty, not-ready result for a malformed (non-array) listing", async () => {
  const result = await runPreload({
    fetchListing: async () => ({ oops: "not an array" }),
    decodeTrack: async () => { throw new Error("should never be called"); },
  });
  assert.deepEqual(result, { order: [], firstTrackReady: false });
});

test("runPreload builds a shuffled order and reports NOT ready when the first track fails to decode", async () => {
  const listing = [{ name: "a.ogg", size: 10 }, { name: "b.ogg", size: 20 }];
  const result = await runPreload({
    fetchListing: async () => listing,
    decodeTrack: async () => { throw new Error("corrupt file"); },
    rng: seededRng(5),
  });
  assert.equal(result.firstTrackReady, false, "a decode failure on the first track must not report ready");
  assert.deepEqual([...result.order].sort(), ["a.ogg", "b.ogg"], "the order is still built from the listing even though decoding failed");
});

test("runPreload reports ready once the first track decodes successfully", async () => {
  const listing = [{ name: "a.ogg", size: 10 }, { name: "b.ogg", size: 20 }, { name: "c.ogg", size: 30 }];
  const decoded = [];
  const result = await runPreload({
    fetchListing: async () => listing,
    decodeTrack: async (name) => { decoded.push(name); },
    rng: seededRng(5),
  });
  assert.equal(result.firstTrackReady, true);
  assert.equal(decoded.length, 1, "only the FIRST track is decoded during preload — see the module header on streaming one ahead, never the whole directory");
  assert.equal(decoded[0], result.order[0]);
});

test("runPreload's onOrderReady fires synchronously, before decodeTrack is awaited", async () => {
  // This ordering is what keeps trackmusic.js's own preload() correct — see
  // its header on why decodeAndCache()'s evictStale() (which reads module
  // state set by onOrderReady) must never run against a stale order.
  const events = [];
  await runPreload({
    fetchListing: async () => [{ name: "a.ogg", size: 1 }],
    onOrderReady: () => events.push("order"),
    decodeTrack: async () => { events.push("decode"); },
  });
  assert.deepEqual(events, ["order", "decode"]);
});

// The bug this whole mechanism exists to fix: a listing with tracks must be
// reported SETTLED (and therefore, via trackmusic.js's isAvailable(),
// available) before the first track's decode has resolved — decode can take
// as long as it likes here (never resolving, standing in for "still
// decoding" at the moment jackIn() asks) and onListingSettled must already
// have fired regardless. This is the pure-logic proof of the third state
// synth.js's chooseBackend() now has to resolve to "track" for — see the
// chooseBackend tests below for that half of it.
test("runPreload's onListingSettled fires as soon as the listing resolves, without waiting for decodeTrack", async () => {
  const events = [];
  let releaseDecode;
  const pendingDecode = new Promise((resolve) => {
    releaseDecode = resolve;
  });
  const preloadPromise = runPreload({
    fetchListing: async () => [{ name: "a.ogg", size: 1 }],
    onListingSettled: (order) => events.push(`settled:${order.length}`),
    decodeTrack: async () => {
      events.push("decode-start");
      await pendingDecode;
      events.push("decode-end");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0)); // flush microtasks up to decodeTrack's own first await, without resolving it
  assert.deepEqual(events, ["settled:1", "decode-start"], "the listing must be reported settled while the decode is still pending");
  releaseDecode();
  await preloadPromise;
  assert.deepEqual(events, ["settled:1", "decode-start", "decode-end"]);
});

test("runPreload's onListingSettled fires on the failure and empty-listing paths too, with an empty order", async () => {
  const failureEvents = [];
  await runPreload({
    fetchListing: async () => { throw new Error("network down"); },
    onListingSettled: (order) => failureEvents.push(order),
    decodeTrack: async () => { throw new Error("should never be called"); },
  });
  assert.deepEqual(failureEvents, [[]]);

  const emptyEvents = [];
  await runPreload({
    fetchListing: async () => [],
    onListingSettled: (order) => emptyEvents.push(order),
    decodeTrack: async () => { throw new Error("should never be called"); },
  });
  assert.deepEqual(emptyEvents, [[]]);
});

// --- musictypes.js -----------------------------------------------------

test("validateMusicConfig accepts the shipped configuration as-is", () => {
  assert.deepEqual(validateMusicConfig(), []);
});

test("validateMusicConfig rejects a TRACK_GAIN outside 0..1", () => {
  const errors = validateMusicConfig({ trackGain: 1.5 });
  assert.ok(errors.some((e) => e.includes("TRACK_GAIN")), `expected a TRACK_GAIN error, got: ${errors}`);
});

test("validateMusicConfig rejects an empty MUSIC_DIR", () => {
  const errors = validateMusicConfig({ musicDir: "" });
  assert.ok(errors.some((e) => e.includes("MUSIC_DIR")), `expected a MUSIC_DIR error, got: ${errors}`);
});

test("validateMusicConfig rejects a root-absolute MUSIC_LISTING_URL", () => {
  // Root-absolute is the mistake worth catching now that the game is
  // published under a subdirectory — see the MUSIC_DIR comment in
  // musictypes.js for what it breaks.
  const errors = validateMusicConfig({ listingUrl: "/api/music" });
  assert.ok(errors.some((e) => e.includes("MUSIC_LISTING_URL")), `expected a MUSIC_LISTING_URL error, got: ${errors}`);
});

test("validateMusicConfig rejects a root-absolute MUSIC_DIR", () => {
  const errors = validateMusicConfig({ musicDir: "/assets/music" });
  assert.ok(errors.some((e) => e.includes("MUSIC_DIR")), `expected a MUSIC_DIR error, got: ${errors}`);
});

test("TRACK_DECODE_SAMPLE_RATE is in range AND actually below a normal output rate", () => {
  // The range check alone would pass for 48000, which is exactly the value
  // that saves nothing — decoding at the output rate is what this constant
  // exists to avoid. See musictypes.js for the measured footprint.
  assert.ok(TRACK_DECODE_SAMPLE_RATE >= TRACK_DECODE_RATE_MIN);
  assert.ok(TRACK_DECODE_SAMPLE_RATE <= TRACK_DECODE_RATE_MAX);
  assert.ok(
    TRACK_DECODE_SAMPLE_RATE < 44100,
    `TRACK_DECODE_SAMPLE_RATE ${TRACK_DECODE_SAMPLE_RATE} saves no memory at or above the output rate`,
  );
});

test("validateMusicConfig rejects a decode sample rate outside the useful range", () => {
  for (const rate of [TRACK_DECODE_RATE_MIN - 1, TRACK_DECODE_RATE_MAX + 1, 0, -24000, NaN]) {
    const errors = validateMusicConfig({ decodeSampleRate: rate });
    assert.ok(
      errors.some((e) => e.includes("TRACK_DECODE_SAMPLE_RATE")),
      `expected a TRACK_DECODE_SAMPLE_RATE error for ${rate}, got: ${errors}`,
    );
  }
});

test("validateMusicConfig accepts the decode rate at both ends of its range", () => {
  for (const rate of [TRACK_DECODE_RATE_MIN, TRACK_DECODE_RATE_MAX]) {
    assert.deepEqual(validateMusicConfig({ decodeSampleRate: rate }), [], `rate ${rate} should be accepted`);
  }
});

test("validateMusicConfig rejects an out-of-range per-track override", () => {
  const errors = validateMusicConfig({ overrides: { "loud.ogg": { gain: 3 } } });
  assert.ok(errors.some((e) => e.includes("loud.ogg")), `expected a TRACK_OVERRIDES error naming the offending file, got: ${errors}`);
});

test("trackGainFor uses a per-track override when present, else the blanket TRACK_GAIN", () => {
  assert.equal(trackGainFor("nonexistent-track.ogg"), TRACK_GAIN);
});

test("trackDisplayName strips the extension, reads underscores as word breaks, and upper-cases the result", () => {
  assert.equal(trackDisplayName("under_chrome.ogg"), "UNDER CHROME");
  assert.equal(trackDisplayName("a_long_track_name.ogg"), "A LONG TRACK NAME");
});

test("trackDisplayName falls back to the derived name for a track with no TRACK_OVERRIDES title", () => {
  assert.equal(trackDisplayName("nonexistent-track.ogg"), "NONEXISTENT-TRACK");
});

// --- Backend selection (audio/synth.js) ---------------------------------

test("chooseBackend picks track when available, procedural when not, before anything is frozen", () => {
  assert.equal(chooseBackend(null, true), "track");
  assert.equal(chooseBackend(null, false), "procedural");
});

// The bug fix, made explicit at the pure-decision layer: chooseBackend()'s
// second argument is now trackmusic.js's isAvailable() (a soundtrack
// EXISTS, per the listing), not isReady() (a track has actually finished
// decoding). "Available but not yet decoded" is exactly the state a player
// who presses START GAME promptly used to lose the race in — the listing
// has come back with tracks, but the first one is still mid-decode. That
// state passes `available: true` here (chooseBackend has no notion of
// decode progress at all — it only ever sees the boolean its caller
// computed), so it must resolve to "track", same as a fully-decoded track
// would. See runPreload's own "onListingSettled fires... without waiting
// for decodeTrack" test above for where that boolean actually comes from
// in production.
test("chooseBackend resolves to track for the available-but-not-decoded state, not just the fully-ready one", () => {
  assert.equal(chooseBackend(null, true), "track", "a listing with tracks must win over the procedural loop even before the first buffer has decoded");
});

test("chooseBackend never changes an already-frozen choice, even if availability flips", () => {
  assert.equal(chooseBackend("procedural", true), "procedural", "a run that already committed to procedural must not jump to track mid-run");
  assert.equal(chooseBackend("track", false), "track", "a run that already committed to track must not fall back mid-run");
});

test("both music backends implement the same interface synth.js relies on", () => {
  for (const name of MUSIC_BACKEND_METHODS) {
    assert.equal(typeof proceduralmusic[name], "function", `proceduralmusic.js is missing "${name}"`);
    assert.equal(typeof trackmusic[name], "function", `trackmusic.js is missing "${name}"`);
  }
});

// --- tools/musicmanifest.js's generated track listing --------------------

test("listMusicFiles returns only .ogg files, sorted, with sizes — including a spaced filename", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cybercruise-music-"));
  try {
    await writeFile(path.join(dir, "b_track.ogg"), Buffer.alloc(100));
    await writeFile(path.join(dir, "a track (live).ogg"), Buffer.alloc(50));
    await writeFile(path.join(dir, "notes.txt"), "not audio");
    await writeFile(path.join(dir, "sample.wav"), Buffer.alloc(10)); // a real format, just not the one this endpoint lists — see musictypes.js's header on why Ogg Vorbis specifically
    const tracks = await listMusicFiles(dir);
    assert.deepEqual(tracks, [
      { name: "a track (live).ogg", size: 50 },
      { name: "b_track.ogg", size: 100 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listMusicFiles ignores subdirectories (no recursion)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cybercruise-music-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(dir, "nested"));
    await writeFile(path.join(dir, "nested", "hidden.ogg"), Buffer.alloc(5));
    await writeFile(path.join(dir, "top.ogg"), Buffer.alloc(5));
    const tracks = await listMusicFiles(dir);
    assert.deepEqual(tracks, [{ name: "top.ogg", size: 5 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listMusicFiles returns an empty list for a missing directory rather than throwing", async () => {
  const missing = path.join(tmpdir(), "cybercruise-music-does-not-exist-" + Date.now());
  await assert.doesNotReject(async () => {
    const tracks = await listMusicFiles(missing);
    assert.deepEqual(tracks, []);
  });
});

test("MUSIC_DIR and MUSIC_LISTING_URL are both non-empty and RELATIVE", () => {
  // The leading-slash check is the one that keeps the published game's music
  // working: a root-absolute path resolves against the domain root, which on
  // a GitHub Pages project site (/Cybercruise/) is outside the site entirely
  // and 404s every track. See musictypes.js's MUSIC_DIR comment.
  assert.ok(MUSIC_DIR.length > 0);
  assert.ok(!MUSIC_DIR.startsWith("/"), `MUSIC_DIR must be relative, got "${MUSIC_DIR}"`);
  assert.ok(MUSIC_LISTING_URL.length > 0);
  assert.ok(!MUSIC_LISTING_URL.startsWith("/"), `MUSIC_LISTING_URL must be relative, got "${MUSIC_LISTING_URL}"`);
});

test("listMusicFiles sorts by code unit, not by the machine's locale", async () => {
  // A committed manifest has to regenerate byte-identically everywhere. Czech
  // collation treats "ch" as one letter sorting after "h", so localeCompare
  // would order these three differently depending on who ran the generator —
  // and the staleness test below would then fail on their checkout.
  const dir = await mkdtemp(path.join(tmpdir(), "cybercruise-music-"));
  try {
    for (const name of ["halo.ogg", "chase.ogg", "city.ogg"]) {
      await writeFile(path.join(dir, name), Buffer.alloc(1));
    }
    const tracks = await listMusicFiles(dir);
    assert.deepEqual(
      tracks.map((t) => t.name),
      ["chase.ogg", "city.ogg", "halo.ogg"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the committed manifest matches what's actually in assets/music/", async () => {
  // The whole cost of trading the old live endpoint for a static file is that
  // the file can go stale — drop in a track, forget `npm run music`, and the
  // game silently never plays it. This is what turns that into a test failure
  // instead of a bug a player finds. Fix by running: npm run music
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = manifestPath(repoRoot);
  const onDisk = await readFile(manifest, "utf8");
  const expected = manifestContents(await listMusicFiles(path.join(repoRoot, MUSIC_DIR)));
  assert.equal(onDisk, expected, `${path.relative(repoRoot, manifest)} is stale — run: npm run music`);
});
