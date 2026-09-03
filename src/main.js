// Cybercruise — bootstrap + game loop.
// Phase 4: a neon player car driving an infinite curving highway through a
// parallax city, sharing the road with other traffic — and shooting at it.

import { createLoop } from "./engine/loop.js";
import { LOGICAL_W, LOGICAL_H, initViewport, applyTransform, snapToDevice, mirrorCanvas } from "./engine/viewport.js";
import * as present from "./engine/present.js";
import { initInput, isDown, consumePress } from "./engine/input.js";
import { initMouse } from "./engine/mouse.js";
import { clear, clearHud, glowText, vectorText } from "./engine/neon.js";
import { GREEN, GREEN_BRIGHT, GREEN_PALE, HAZARD, PLAYER, PLAYER_THRUST, SHIELD_FLICKER } from "./engine/palette.js";
import { Player, BOOST_EXPIRING, BOOST_FLICKER_RATE } from "./game/player.js";
import { Projectiles } from "./game/projectiles.js";
import { Shells } from "./game/shells.js";
import { Score } from "./game/score.js";
// Credits — the currency the upgrade shop spends (game/shop.js). Separate from
// Score on purpose; see wallet.js's own header for the whole argument.
import { Wallet } from "./game/wallet.js";
import { renderNodeHints, renderAwardMarks, renderUplink } from "./game/walletrender.js";
import { Traffic } from "./game/traffic.js";
import { Obstacles } from "./game/obstacles.js";
import { obstacleTypeById } from "./game/obstacletypes.js";
import { Pickups } from "./game/pickups.js";
import { pickupTypeById } from "./game/pickuptypes.js";
import { ENEMY_FACTION } from "./game/cartypes.js";
import { Explosions } from "./game/effects.js";
import { Disconnect } from "./game/disconnect.js";
import { JackIn } from "./game/jackin.js";
// The shopping interlude: the cargo drone that lifts the car off the road every
// SHOP_INTERVAL, and the storefront it delivers it to. See hauler.js's header
// for the three phases, shop.js's for the screen, and upgrades.js's for what is
// on the shelves and why none of it survives the run.
import { Hauler } from "./game/hauler.js";
import { createShop } from "./game/shop.js";
// What the shop SELLS, and the record of what this run has bought — see that
// file's header for why the tier ladder is scoped to one run, exactly as the
// credits paying for it are (CREDIT_STORE below).
import { Garage } from "./game/upgrades.js";
import { Loadout, laidPayloads, muzzleOffsets, lockSeconds, lockRange, lockLead } from "./game/weapons.js";
import { ShieldStorm } from "./game/shieldstorm.js";
import { Lock } from "./game/targeting.js";
import { createMenu } from "./game/menu.js";
// What an armed test row is WORTH — the rows themselves live on menu.js, this
// is only the figure EXTRA CASH pays out. See that file for the switch that
// removes both rows from a shipping build.
import { EXTRA_CASH_AMOUNT } from "./testoptions.js";
import { createMusic } from "./audio/synth.js";
import { PLAYER_FIRE_SOUND, ENEMY_FIRE_SOUND } from "./audio/weaponsfx.js";
import { PICKUP_SOUND } from "./audio/pickupsfx.js";
import { trackDisplayName } from "./audio/musictypes.js";
import { CONSOLE_SOUND } from "./audio/consolesfx.js";
import { MENU_SOUND } from "./audio/menusfx.js";
import * as road from "./game/road.js";
import * as scenery from "./game/scenery.js";
import * as drones from "./game/drones.js";
import * as links from "./game/links.js";
import * as sectors from "./game/sectors.js";
import { reseedWorld } from "./game/worldseed.js";
import * as events from "./game/events.js";
import * as gameConsole from "./engine/console.js";
import * as gutter from "./engine/gutter.js";
import * as telemetry from "./game/telemetry.js";
import { sectorIndex } from "./game/citygrid.js";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

// THE HUD LAYER (Phase 15c): a third canvas, plain 2D, transparent, sitting on
// top of the present canvas below — drawHud(), the menu's test rows and the
// shop's price list draw here instead of on `ctx`. See render()'s own header
// on the split rule (which canvas a new readout goes on and why) and
// engine/present.js's header for why this is a DOM layer rather than a second
// WebGL texture. Registered as a viewport mirror alongside the present canvas
// (below), so it is sized and scaled with the other two — but `initViewport`
// is still handed `canvas` (the 2D one) as the MEASURED element, because that
// is what establishes the cabinet's chrome size for gutter.js; adding a
// mirror does not change which element is measured.
const hud = document.getElementById("hud");
const hudCtx = hud.getContext("2d");

// The playfield is 600x800 FOREVER — a game constant, not a window measurement.
// Only the raster resolution behind it follows the screen; see
// engine/viewport.js for why the world's dimensions must not, and for what
// `scale` is. Every W/H below (and every module they are threaded into) keeps
// meaning exactly what it meant when the canvas element carried these numbers.
const W = LOGICAL_W;
const H = LOGICAL_H;

// Size the canvas to the window and keep it sized. The second argument fires
// when the RASTER scale moves and every pre-rasterised layer has to be rebuilt
// at the new device resolution — but there is deliberately nothing to do in it:
// the sprite cache compares the scale itself, and the road strips and floor grid
// carry it in their own cache keys. It stays here, empty, because this is the
// one place a reader will come looking to check that invalidation is handled.
//
// The third argument is the cabinet element, which the viewport measures to find
// the chrome around the canvas (bezel padding plus the hint bar) so the WHOLE
// frame stays inside the window, not just the playfield.
// The GPU present path (engine/present.js): the finished 2D frame uploaded to
// the WebGL2 canvas in front of this one and blitted back out. BEFORE
// initViewport, because it registers that canvas as a viewport mirror and the
// viewport's first sizing pass is what gives it a backing store.
//
// WEBGL2 IS REQUIRED AS OF PHASE 15D-I (see engine/gl/context.js's header for
// the reversal and why). `glReady` false means present.js has already shown
// the "WEBGL2 REQUIRED" notice and there is nothing left for this module to
// do except never start the loop — see the bottom of this file. `onLost`/
// `onRestored` are this module's own hooks into a context loss mid-run,
// layered on top of what present.js already does for one on its own (its
// header has the full design): they exist so the WORLD stops advancing while
// the GPU is down, which present.js has no way to do by itself, since it
// knows nothing about `state` or the fixed-step loop. See onGpuContextLost/
// onGpuContextRestored and the "gpulost" frozen state below.
const glReady = present.init(canvas, document.getElementById("present"), {
  onLost: onGpuContextLost,
  onRestored: onGpuContextRestored,
});

// THE HUD CANVAS, registered as a viewport mirror the same way present.init()
// registers the present canvas above (and for the same reason: BEFORE
// initViewport, so its first sizing pass gives this a backing store too,
// rather than leaving it at a canvas element's 300x150 default for its first
// frames). present.js has no reason to know this canvas exists — it never
// touches the GPU — so this is a plain mirrorCanvas() call here rather than a
// second present.init()-style entry point.
mirrorCanvas(hud);

initViewport(canvas, () => {}, document.getElementById("frame"));
const hint = document.getElementById("hint");

// The gutter panels (engine/gutter.js): the deck's log and status readout, in
// the screen either side of the cabinet on a window wider than 3:4. Handed the
// same cabinet element the viewport measures, because they hang off the box it
// produces — they measure it, they never influence it. Below MIN_GUTTER of
// spare width either side they simply never appear, and every line below is a
// no-op that costs a returned `false`.
gutter.initGutter(document.getElementById("frame"));

// The divert (see engine/console.js's setDivert header): while the gutter log is
// up, the in-canvas SYS LOG hands it everything except CRITICAL and shrinks to
// an alert plate, giving a quarter of the playfield's width back. Registered
// ONCE, here, rather than in newGame() alongside the audio subscriber — the
// answer is a fact about the browser window, not about the run, and console.js's
// reset() deliberately leaves it standing for exactly that reason.
gameConsole.setDivert(gutter.logVisible);

const MENU_HINT = "&uarr;/&darr; select &middot; SPACE/ENTER confirm";
const PAUSE_HINT = "&uarr;/&darr; select &middot; SPACE/ENTER confirm &middot; ESC resume";
const PLAY_HINT = "&larr;/&rarr; or A/D steer &middot; &uarr;/&darr; speed &middot; SPACE fire &middot; TAB weapon &middot; CTRL deploy &middot; ESC pause";
// The shop screen's own bar. The lift and lower sequences either side of it
// leave the bar EMPTY, the way "connecting" and "dying" do — there is nothing
// to press while the car is in the air.
const SHOP_HINT = "&uarr;/&darr; select &middot; SPACE/ENTER buy &middot; ESC undock";

initInput();
initMouse(canvas);

// Top-level game state. The menu owns the screen until START GAME/CONTINUE is
// picked, then main's own update/render take over. "menu" happens once, before
// the first game; ESC toggles "playing"/"paused" for the rest of the session —
// the same menu.js screen both times, see its header for how it tells them
// apart. "gameover" is that screen a third time; RESTART calls newGame().
//
// THE FROZEN STATES are "connecting", "dying", "lifting", "lowering" and
// "gpulost". They share one shape, and their handlers below only note what is
// unique to each:
//
//   THE WORLD IS DRAWN BUT NOT ADVANCED. render() runs its whole world path,
//   so the road, the traffic and the car stay visible exactly where they were;
//   nothing under "playing" runs, so nothing moves. Only the sequence itself
//   ticks.
//   THE SYS LOG STILL ANIMATES (engine/console.js) — it is presentation, not
//   world state, so lines have to keep sliding and fading. The exception is
//   "shopping", where the screen covers the world and there is no log to see.
//   INPUT IS DRAINED, not merely ignored. input.js holds an edge until
//   something consumes it, so a key pressed mid-sequence would otherwise sit
//   in `fresh` and be read by the NEXT screen the instant it opened — opening
//   a pause menu or firing a RESTART the player never asked for.
//
// What each one is: "connecting" runs game/jackin.js's boot and EVERY run
// starts there (START GAME from "menu", RESTART from "gameover" after
// newGame() has rebuilt the world it is about to reveal); only the AUDIO half
// of the jack-in is once-per-page, see the two call sites below. "dying" runs
// game/disconnect.js over the frozen frame the player died on. "lifting"/
// "lowering" are
// game/hauler.js's drone carrying the car off the road and back, with
// "shopping" (game/shop.js) between them, covering the world as "paused" does.
//
// "gpulost" IS THE ODD ONE OUT: every other frozen state is entered by a
// player action or a sequence finishing, on the tick that does it. This one is
// entered ASYNCHRONOUSLY, from present.js's onLost callback, which can fire
// between any two ticks regardless of what state was current — the whole
// reason WebGL2's context can be lost mid-run (engine/gl/context.js's header)
// is that it is a driver event, not a game one. onGpuContextLost/
// onGpuContextRestored below are what save and restore the state it
// interrupted; every other frozen state above always knows in advance what
// comes next.
//
// THE APPROACH IS NOT A STATE. The drone's arrival happens under "playing"
// with the world still live — see hauler.js's phase list. Only the grab
// freezes anything.
const menu = createMenu();
let state = "menu"; // "menu" | "connecting" | "playing" | "paused" | "dying" | "gameover"
                    //   | "lifting" | "shopping" | "lowering" | "gpulost"

// Which state to resume once the GPU context is restored — see
// onGpuContextLost/onGpuContextRestored below. Only meaningful while
// state === "gpulost"; null the rest of the time, including at module load,
// since a loss cannot arrive before present.init() below has run.
let gpuLostFrom = null;

// The edge-detector state for Phase 8 step 5's sector-transition audio (see
// the "playing" branch's own comment on sectorGlitching below) — declared up
// here alongside `state` rather than as per-run state, since sectors.js's
// own glitch timer already survives exactly one tick past a newGame() reset
// before self-correcting (sectors.reset() zeroes glitchTimer, so the very
// next "playing" tick reads glitching() as false regardless of what this was
// left at), so there is nothing here that needs its own reset.
let wasSectorGlitching = false;

// Phase 8's first slice: procedural synthwave music (src/audio/synth.js).
// `musicVolume`/`soundVolume` mirror menu.js's MUSIC and SOUND levels so
// setVolume()/setSfxVolume() only fire on an actual change rather than every
// frame the menu is open (that would retrigger their ramps 60x/sec — see
// setVolume).
const music = createMusic();
let musicVolume = menu.musicVolume();
let soundVolume = menu.soundVolume();

// Push the menu's levels into the engine, but ONLY where they actually moved.
// Called from every state that leaves the menu's sliders reachable (menu,
// paused, gameover) — it was three copies of this pair of ifs before, one per
// state, which is three places to remember the "only on a change" rule.
function syncVolumes() {
  if (menu.musicVolume() !== musicVolume) {
    musicVolume = menu.musicVolume();
    music.setVolume(musicVolume);
  }
  if (menu.soundVolume() !== soundVolume) {
    soundVolume = menu.soundVolume();
    music.setSfxVolume(soundVolume);
  }
}

// One menu tick, with the SFX every menu-driven state owes it — see
// audio/menusfx.js for why this table and not menu.js decides which id each
// gesture plays. The three callers (menu, paused, gameover) differ only in
// what they do with `confirmed`, which is why that is all this returns.
function tickMenu() {
  const menuResult = menu.update(W);
  if (menuResult.moved) music.play(MENU_SOUND.move);
  if (menuResult.soundAdjusted || menuResult.toggled) music.play(MENU_SOUND.adjust);
  return menuResult.confirmed;
}

// The AudioContext must exist before the menu's SOUND/MUSIC sliders can
// preview anything (menu_adjust), which happens well before START GAME — so
// the bus graph is built on the FIRST keydown of any kind (synth.js's
// startContext()). `{ once: true }` means an untouched page never creates a
// context; context.js's start() is independently idempotent anyway.
// music.jackIn() below is the separate once-only call that starts the music
// SCHEDULER — see its comment for why the two stay split.
window.addEventListener("keydown", () => music.startContext(), { once: true });

// The death sequence (game/disconnect.js). One instance, reused across
// restarts via reset() — see newGame() below — the same way `menu` itself is
// one instance reused for start/pause/gameover.
const disconnect = new Disconnect();

// The START GAME sequence (game/jackin.js) — disconnect's opposite number, and
// owned here the same way: one instance, reset() from newGame(), triggered
// from the one place its event happens (the menu's confirm, below).
const jackin = new JackIn();

// CREDITS DO NOT PERSIST BETWEEN RUNS — YET. wallet.js has a working, tested,
// localStorage-backed bank; this one null holds it off. The Wallet's `store`
// is injectable, null reads as "no storage", and everything downstream already
// behaves with a bank that is always 0 (wallet.js's storage()).
//
// WHY OFF: a localStorage bank belongs to ONE BROWSER ON ONE MACHINE, with
// nothing tying it to a player. Until the game keeps per-player records
// (README's Phase 13), a persisted balance is not progress the player owns —
// it is progress they lose by switching device. Money that dies with the run
// makes an honest promise: what you earn this run is what the shop can spend.
//
// TURNING IT ON is this line — pass a real store. Nothing else changes, which
// is why the switch sits at the injection seam rather than in the money code.
const CREDIT_STORE = null;

// The shopping interlude's two halves, owned exactly the way `disconnect` and
// `jackin` above are: one instance each, reset() from newGame(), never rebuilt.
// The hauler needs the canvas height to know how far off the top of the frame
// it has to carry the car; the shop screen holds only its cursor and the
// receipts for the visit in progress, both of which SHOULD outlive a single
// dock and are cleared per run by its own reset() from newGame().
const hauler = new Hauler(H);
const shop = createShop();

// WHAT A STAGED EVENT MAY HAND OFF TO. game/events.js schedules every staged
// moment on the road; most are cars and hazards it places itself, but a
// `handoff` is an encounter whose body some other module owns. The director
// names a HANDLER, never a module, so it never learns a cargo drone exists —
// the wiring lives here, like every other cross-system connection in this file.
//
// `fire` starts it; `live` tells the director the encounter is still running,
// which holds every other event off for the whole shop visit rather than just
// the tick it began. That is the entire interface — hauler.js's phases, its
// frozen lift and its timeline stay its own.
const EVENT_HANDLERS = {
  shop: {
    fire: () => hauler.approach(player.x, player.y),
    live: () => hauler.phase !== "idle",
  },
};

// Everything below is PER-RUN state: it all gets torn down and rebuilt by
// newGame(), so it's declared with `let` rather than `const` even though
// nothing outside newGame() ever reassigns it directly. The functions that
// close over these bindings (onCarDestroyed, fireShot, dropMine) are defined
// ONCE, below, and keep working across a restart because a closure reads the
// current value of an outer `let` at call time, not the value it had when the
// closure was created.
let player;
let score;
let wallet;
let explosions;
let obstacles;
let pickups;
let traffic;
let shots;
let enemyShots;
let shells;
let loadout;
// The upgrade tiers bought this run. Per-run like everything else in this
// block, and rebuilt by newGame() rather than reset in place: a Garage is
// nothing but counters, so a fresh one IS the reset.
let garage;
// The SHIELD STORM's discharge clock (game/shieldstorm.js). Built ONCE at module
// load rather than per run, and reset by newGame() alongside every other screen
// — it holds a countdown and a scratch array, nothing that belongs to a
// particular car, and the upgrade that switches it on lives in the garage above.
const shieldStorm = new ShieldStorm();
// Which car the player's tracer rounds are chasing (game/targeting.js's
// AUTOLOCK). Built once like the storm above, but reset in TWO places rather
// than one: newGame() for a fresh run, and respawnWorld() because that rebuilds
// Traffic wholesale and every car reference this could be holding dies with it.
const lock = new Lock();
// How far we've driven, in world units. Grows with speed and drives
// everything that scrolls (road curve, lane dashes) — see road.js for the
// screen<->world coordinate model. Declared up here, ahead of newGame(),
// because newGame() zeroes it and runs once at module load below.
let distance = 0;

// Chance a destroyed HOSTILE car leaves a FIX crate where it died. CIVILIANS
// NEVER DO — a buff dropped by killing an innocent bystander would reward
// the exact kill score.js already fines the player for (see cartypes.js's
// NERVE section and score.js's own civilian penalty). This is a straight
// coin-weighted roll, not gated by anything else on the road.
const ENEMY_FIX_DROP_CHANCE = 0.2;
function onCarDestroyed(car) {
  score.destroyed(car.type);
  // Money, alongside the points, off the SAME catalogue entry and the same
  // event — but a separate field (`bounty`, cartypes.js) and a separate total,
  // so a type can be worth points and no money at all (see wallet.js).
  // The wreck's own position rides along so the payout can be shown WHERE IT
  // HAPPENED, not just in the HUD corner — with a chain reaction taking three
  // cars in one tick, the corner alone can't say which of them paid.
  wallet.destroyed(car.type, car.worldY, car.offset);
  // Mirrors score.js's OWN enemy/civilian split (`value >= 0` is a kill,
  // negative is a fine) rather than reading car.type.faction directly here
  // — score.js's header is explicit that scoring "never asks what faction a
  // car belonged to", and this sound is standing in for exactly that
  // judgement. Reading faction instead would risk the sound and the score
  // disagreeing the day a type's value and faction ever diverge.
  music.play((car.type.value ?? 0) >= 0 ? "kill_enemy" : "kill_neutral");
  if (car.type.faction === ENEMY_FACTION && Math.random() < ENEMY_FIX_DROP_CHANCE) {
    pickups.drop(pickupTypeById("fix"), car.worldY, car.offset);
  }
}

// A road obstacle (roadblock or mine, any family — obstacles.js's detonate())
// has broken. No score, unlike onCarDestroyed above — furniture pays out
// nothing — so this exists purely to give obstacles.js's onDestroyed hook
// somewhere to report to, the same reasoning Traffic's own onDestroyed gets
// wired to onCarDestroyed just above.
function onObstacleDestroyed() {
  music.play("kill_obstacle");
}

// Phase 8 step 3's audio hook onto player.js's ONE damage funnel — see
// Player's own constructor comment. `deflected` is true when the shield ate
// the hit (player.js's damage() early-return guard); false is a real hull
// loss, from ANY source (bullets, blast, ramming, wall-scrape all end up
// here — see collisions.js's PlayerBody.damage/obstacles.js's playerBox.damage).
function onPlayerDamage(hp, deflected) {
  if (deflected) {
    music.play("shield_deflect");
    return;
  }
  // Intensity relative to the WHOLE hull, not to this one hit's own size
  // against itself — a wall-scrape tick and a full rocket impact both funnel
  // through here, and the stutter should read louder for whichever one
  // actually cost more of it.
  const intensity = Math.min(1, hp / player.maxHealth);
  music.play("player_hit", { intensity });
}

// Phase 8 step 3's audio hook onto pickups.js's ONE place a crate is ever
// actually applied — see Pickups' own constructor comment.
function onPickupCollected(type) {
  music.play(PICKUP_SOUND[type.kind]);
}

// The audio hook onto engine/console.js's subscriber seam (onPush). Registered
// in newGame(), not at module scope: every other audio hook here is handed to a
// per-run object's constructor, but console.js's reset() clears its subscriber,
// so this one must be re-registered per run. See console.js's onPush() header
// for why the wiring lives in main.js at all.
//
// TWO LISTENERS OFF ONE SEAM, fanned out here rather than by growing
// console.js's `subscriber` into a list. The seam has had one consumer for its
// whole life and the second is in this same file — an array would be more
// machinery than the two lines it saves, and would move "what listens to the
// log" out of the file that answers every other wiring question.
//
// The gutter gets the line VERBATIM apart from telemetry.js's prefix: the same
// log shown where there is room, not a second commentary. What keeps it from
// being a duplicate is that the in-canvas panel stops drawing most of it while
// the gutter is up (see setDivert above).
function onConsolePush(text, severity) {
  music.play(CONSOLE_SOUND[severity]);
  const line = telemetry.eventLine(text, severity);
  gutter.pushLog(line.text, line.tone);
}

// What the rig panel's FEED row reports, kept current by onTrackChange below.
// Page-scoped, not per-run: the track backend only ever starts once per page
// (synth.js's jackIn() header) and keeps playing across restarts, so zeroing
// this in newGame() would blank a row describing something still audible.
let currentTrack = "STANDBY";

// The deck reporting its own audio feed — synth.js's onTrackChange facade over
// trackmusic.js's subscriber seam. Registered ONCE, right after `music` exists,
// unlike onConsolePush above: nothing resets that subscriber per run, and the
// track backend starts once per page life, so one subscription covers every
// handoff for the session.
//
// Composing the SYS LOG line is main.js's job for the same reason CONSOLE_SOUND
// is: the fiction (links.js's "//"-joined register) belongs with the module
// that owns every other console line's wording, not the audio layer.
//
// Never fires before a run is underway — trackmusic.js only invokes its
// subscriber from playIndex(), which nothing reaches before jackIn().
function onTrackChange(name) {
  // Also parked for the rig panel's FEED row, which reports what is playing
  // continuously rather than only at the moment it changed. Read off the same
  // notification instead of asking the audio engine every sample: the answer
  // only ever moves when this fires, so polling for it would be a per-sample
  // question with a per-track answer.
  currentTrack = trackDisplayName(name);
  gameConsole.push(`AUDIO FEED // ${currentTrack}`, gameConsole.HINT);
}
music.onTrackChange(onTrackChange);

// Scratch target list for bullets: cars AND obstacles in one flat array, so a
// shot resolves against whichever it actually crosses first regardless of
// which system owns it (see projectiles.js's firstHit). Reused every tick
// rather than rebuilt, same as Traffic.bodies — and reused across restarts
// too, since it's rebuilt from scratch inside update() every "playing" tick
// regardless of which `traffic`/`obstacles` instance is current.
const shotTargets = [];

// The same idea for the boss's shells, and a SEPARATE list because the contents
// genuinely differ: a blast hits everything on the road, the player's own body
// included, where a bullet pool is deliberately resolved against one side only
// (see the note on enemyShots in respawnWorld). Reusing shotTargets and pushing
// the player onto it would quietly put the player in the path of their own
// cannon fire.
const shellTargets = [];

// Scratch for the per-shot options projectiles.js's spawn() takes — what this
// round chases, and how fast it may cross the road to. REUSED rather than built
// per shot, for
// the same reason the array above is: the trigger is pulled several times a
// second forever, and spawn() reads and copies every field immediately without
// keeping the object (see its own note saying so).
const SHOT_OPTS = { target: null, lead: 0 };

// Reused every tick rather than rebuilt, same as shotTargets — but its ONE
// entry (Traffic's PlayerBody, already the player expressed as something with
// { worldY, offset, w, h, alive, damage }, the exact target interface
// projectiles.js documents) has to be re-pointed at the new Traffic's
// PlayerBody whenever newGame() builds one, since nothing else touches this
// array on a "playing" tick to do that for it.
const enemyTargets = [];

// (Re)builds every per-run system fresh: called once below for the initial
// game, and again from the "gameover" screen's RESTART row. Everything it
// touches is declared `let` above for exactly this reason.
// EVERYTHING ON THE ROAD, torn down and rebuilt. Called by newGame() below for
// a fresh run, and on its own by a shop visit — the cargo drone flies the
// player somewhere, so the traffic, hazards and crates it left behind are not
// waiting where it dropped them (see updateShopping's own comment).
//
// WHAT IT DELIBERATELY LEAVES ALONE is the whole point of it being separate
// from newGame(): the player (hull, speed, shield, lane), the score, the
// wallet, the loadout and `distance` all survive it untouched. A shop visit
// interrupts the run; it does not restart it.
function respawnWorld() {
  // One explosion pool shared by traffic (car wrecks) and the road obstacles
  // (mine blasts, roadblock rubble) — see effects.js's Explosions header and
  // game/obstacles.js for why they must not each get their own.
  explosions = new Explosions();
  obstacles = new Obstacles(explosions, onObstacleDestroyed);
  // Buff crates — shares the same explosion pool for their own "collected"
  // burst (effects.js's drawCollectBurst), same reasoning as obstacles above.
  // Constructed BEFORE traffic so onCarDestroyed can close over it.
  // onPickupCollected is Phase 8 step 3's audio hook — see its own comment.
  pickups = new Pickups(explosions, onPickupCollected);
  traffic = new Traffic(onCarDestroyed, explosions);
  // Re-pointed every rebuild, not just on a new run: `traffic` is a NEW object
  // now, so the slot still holding the old one's playerBody would be aiming
  // every hostile round on the road at a body nothing updates any more.
  enemyTargets[0] = traffic.playerBody;
  // Shares the explosion pool above, so a rocket's fireball (weapons.js's
  // ROCKET, effects.js's drawFireballBurst) competes for the same slot budget
  // as every other detonation on the road — see projectiles.js's `impact`.
  shots = new Projectiles(explosions);
  // A tracer round that connects DESIGNATES what it hit (weapons.js's
  // AUTOLOCK). Re-attached on every rebuild for the same reason
  // enemyTargets[0] is re-pointed above: `shots` is a NEW pool now, and the
  // old one's callback would be wired to nothing that still runs.
  //
  // ...and the lock itself is CLEARED here, because respawnWorld() throws away
  // the Traffic that owned every car it could be holding. A lock carried across
  // a shop visit would be aimed at a car that no longer exists on a road that
  // no longer exists.
  lock.reset();
  // HOSTILE FIRE GETS ITS OWN POOL, and the reason is targeting rather than
  // bookkeeping. projectiles.js resolves one pool against one list of
  // targets — "WHO CAN BE HIT is the CALLER'S choice" — so two pools is how a
  // bullet knows whose side it is on, with no notion of a faction anywhere in
  // that file.
  //
  // Enemy rounds are resolved against the PLAYER ALONE: they pass through
  // traffic and through road hazards untouched. That is deliberate and it is
  // score.js's doing — the scoreboard pays out however a car died, so a
  // civilian shot by an enemy would fine the player for a kill they had no
  // part in, exactly the oddity cartypes.js's NERVE section already had to
  // design mines around. The same goes for a hostile round setting off a
  // mine.
  enemyShots = new Projectiles(explosions);
  // THE BOSS'S ARTILLERY (game/shells.js). A third pool rather than a mode on
  // the hostile one above, for the reason that file opens with: a shell is not
  // a bullet, it is an impact with a fuse on it, and it shares none of the
  // flight, the swept hit test or the retirement bounds.
  //
  // Rebuilt with everything else here, which is also what empties it: a shop
  // visit throws the world away, and a shell still ticking down over a road
  // that no longer exists would land on the new one.
  shells = new Shells(explosions);
}

function newGame() {
  distance = 0;
  // THE CITY THIS RUN HAPPENS IN, drawn first because everything below is built
  // to drive through it. A fresh seed each time, so the buildings, the nodes and
  // their callsigns and prices, the sector names and the drone lanes are this
  // run's rather than the same city every player has always seen — see
  // game/worldseed.js. Deliberately NOT in respawnWorld(): a shop visit calls
  // that too, and the city must not change while the player is still driving
  // through it.
  reseedWorld();
  // Player sits around mid-screen (Spy Hunter framing) so traffic catching up
  // from behind is visible below before it draws level. onPlayerDamage is
  // Phase 8 step 3's audio hook — see its own comment above.
  player = new Player(W / 2, H * 0.62, onPlayerDamage);
  // The scoreboard, and the wiring that feeds it: traffic reports every car
  // that blows up, main.js reports the road covered (see update). Traffic
  // itself knows nothing about points — see score.js.
  score = new Score();
  // The wallet, built WITHOUT a backing store — so credits live and die with
  // one run. See CREDIT_STORE above for why, and for the one line that turns
  // the persisted bank back on.
  wallet = new Wallet(CREDIT_STORE);
  // Everything ON the road — see respawnWorld() below, which a shop visit also
  // calls on its own to hand the player back a clear stretch of tarmac.
  respawnWorld();
  // The guns. The player holds a Loadout (each weapon's cooldown and ammo —
  // weapons.js); the world holds the shots the Loadout puts in the air, and
  // those are respawnWorld()'s, not this line's. NOT rebuilt by a shop visit:
  // ammo and the selected weapon are the player's, and are exactly the kind of
  // progress an interlude must not quietly take away.
  loadout = new Loadout();
  // Empty: a fresh run starts on a stock car. The player is built above with
  // the same base figures this agrees with, so there is nothing to apply yet —
  // the first applyUpgrades() call comes from the first purchase.
  garage = new Garage();
  // The storm's own clock, for the same reason the shop's cursor is cleared
  // just below: nothing about the last run's state has any business ticking
  // into this one.
  shieldStorm.reset();
  // respawnWorld() above has already cleared this; done again here so "a fresh
  // run starts with nothing designated" is stated where every other per-run
  // reset is, rather than being a side effect of the world being built.
  lock.reset();
  hauler.reset();
  // The shop's own cursor and this-visit receipts, for the same reason every
  // other per-run screen is reset here.
  shop.reset();
  disconnect.reset();
  jackin.reset();
  gameConsole.reset();
  // Re-registered every newGame(), never stacked — reset() just cleared it
  // (see console.js's own onPush() header for why), and onPush() itself
  // would simply overwrite a second registration even if this ran twice in
  // a row, so there is no way for this to end up with two callbacks firing
  // per push.
  gameConsole.onPush(onConsolePush);
  // The gutter's own per-run state, reset for the same reason every screen
  // above is: the previous run's death rattle has no business sitting in the
  // log while a fresh car is being assembled, and telemetry's "t+" clock has to
  // start over or it stops meaning uptime. resetLog() blanks the row pool
  // WITHOUT rebuilding it — see its header on why that distinction matters.
  telemetry.reset();
  gutter.resetLog();
  links.reset();
  sectors.reset();
  // The staged-event director's own per-run state: the roll beat, the
  // cooldowns and — since it took the job over from hauler.js — which shop
  // milestones this run has already spent. See game/events.js.
  events.reset();
  // Every per-run audio concern that must not leak into a fresh run: the
  // sustained voices (shield_drone/wall_scrape/dread_pulse), a sector-transition
  // filter collapse still mid-flight, and the music bus's own disconnect
  // fade — see synth.js's own resetForNewRun() header for why all three are
  // bundled into this one call. A silent no-op before music.startContext()
  // has ever run (the very first newGame() call, at module load), same
  // contract every audio entry point here has.
  music.resetForNewRun();
  // The test rows, applied to the car and wallet this function just built —
  // see applyTestOptions() for why it also runs every tick.
  cashGranted = false;
  applyTestOptions();
}

// --- The test options, applied ---------------------------------------------
//
// menu.js REPORTS which rows are armed and nothing more (its own header: it
// never touches the world); turning that into a car that cannot be hurt and a
// wallet that can afford the top of the shop is main.js's job, exactly like
// every other piece of wiring between a screen and the world here.
//
// RUN EVERY TICK rather than once at newGame(), because both rows can be
// flipped from the PAUSE screen mid-run and from the START screen before
// newGame() has any idea what the player chose — a per-tick reconcile is the
// only version of this with no "but what if they toggle it there" hole in it,
// and it costs two comparisons.

// Whether the wallet has already been paid for the CURRENT arming of EXTRA
// CASH. Cleared by newGame() for a fresh run, and by switching the row off —
// so switching it off and on again pays a second float, which is what a test
// that has just spent the first one actually wants.
let cashGranted = false;

function applyTestOptions() {
  player.invulnerable = menu.invulnerable();

  if (!menu.extraCash()) {
    cashGranted = false;
    return;
  }
  if (cashGranted) return;
  cashGranted = true;
  // Through award(), not by writing the balance: it is the one path that keeps
  // `earned` and the HUD's flash in step (wallet.js), and the flash is welcome
  // here — it is the confirmation that the cheat actually fired.
  wallet.award(EXTRA_CASH_AMOUNT);
}

newGame();

// --- The two things a hostile car may do to the world ------------------------
//
// Handed to traffic on the world view each tick, so behaviours.js and
// game/armament.js can put a bullet or a mine into the world without importing
// either system — the same shape of wiring as Traffic's `onDestroyed` callback,
// which is what keeps traffic.js from ever knowing what a point is.

// A round leaves `car`'s muzzle: its nose when firing up the road, its tail when
// firing back down it at a player who is behind.
function fireShot(car, type, dir) {
  enemyShots.spawn(car.worldY + dir * (car.h / 2), car.offset, car.speed, type, W, dir);
  // Every hostile gun collapses onto one sound id — see audio/weaponsfx.js's
  // ENEMY_FIRE_SOUND for why (timbre tells player fire from enemy fire; it
  // doesn't need to tell one hostile gun from another).
  music.play(ENEMY_FIRE_SOUND[type.id]);
}

// A shell is lobbed at a PLACE. Unlike fireShot and dropMine this takes no car
// at all, and that is the point: by the time armament.js calls this it has
// already decided where the round lands (see its fireBarrage), and nothing
// downstream cares which battery threw it. Returns nothing — a shell cannot be
// refused, because there is no road to have room for it until it arrives.
function fireShell(worldY, offset, fuse, radius, damage) {
  shells.fire(worldY, offset, fuse, radius, damage);
  music.play("mine_placed");
}

// A mine is laid immediately behind `car`. Returns whether the road had room —
// see obstacles.js's drop(), which owns the placement and the budget.
function dropMine(car, type) {
  // `true` — a hostile layer spends the hostile half of the laid budget, which
  // is what stops the player's own drops from disarming the road (obstacles.js's
  // MAX_LAID_PLAYER / MAX_LAID_HOSTILE).
  const placed = obstacles.drop(type, car, true);
  // Only on an actual placement — a drop the road had no room for spends
  // nothing (see armament.js's layMine), so it should confirm nothing either.
  if (placed) music.play("mine_placed");
  return placed;
}

// The fixed-step tick. Each game state owns a function below and the dispatch
// stays here, so the shape of the state machine is visible in one screen
// instead of being spelled out as six sequential early-return branches inside
// one 400-line function.
// How often the rig panel's readouts are resampled, in seconds.
//
// FOUR TIMES A SECOND, NOT SIXTY. The panel is DOM, and the gutter design
// rests on it never repainting on the game's clock. 4Hz is below what anyone
// can read and out of the frame budget entirely. gutter.setStatus() diffs on
// top of this, so it is the CEILING on DOM writes, not the rate: a parked car
// in the menu resamples four times a second and writes nothing.
const RIG_SAMPLE = 0.25;
let rigDue = 0;

// A free-running clock in seconds, advanced every tick whatever the state is.
// The HUD's own idle animations hang off it — anything that has to breathe
// without a game-side phase of its own to read (the SHIELD CHARGED tell in
// drawHud, which by definition has no running timer behind it).
let hudClock = 0;

// How each game state reads on the deck. ONE table for both columns, so the
// ten states can never be listed twice and drift apart.
//
//   link  the state machine's vocabulary, TRANSLATED. The raw state name would
//         leak an implementation detail into the fiction, and half of them
//         ("lifting", "lowering") describe a crane rather than a connection.
//   mode  which VOICE the deck talks in — a coarser question, nine states to
//         three voices, drawing the line at "is the world actually running".
//         telemetry.js's routine pool is road strips, lot lookups and nav
//         vectors, and printing those over a menu or a wreck describes
//         something that is not happening. "connecting" is idle for the same
//         reason: the world is frozen, and jackin.js's scripted boot beats
//         should own the log for that stretch rather than compete with filler.
const DECK_STATE = {
  menu:       { link: "STANDBY",     mode: "idle" },
  connecting: { link: "HANDSHAKE",   mode: "idle" },
  playing:    { link: "ACTIVE",      mode: "live" },
  paused:     { link: "HELD",        mode: "idle" },
  dying:      { link: "SIGNAL LOST", mode: "down" },
  gameover:   { link: "OFFLINE",     mode: "down" },
  lifting:    { link: "DOCKING",     mode: "idle" },
  shopping:   { link: "DOCKED",      mode: "idle" },
  lowering:   { link: "UNDOCKING",   mode: "idle" },
  gpulost:    { link: "GPU DROPPED", mode: "idle" },
};
const DECK_STATE_FALLBACK = DECK_STATE.menu;

// Bytes to a human string, for the BUFFER readout.
//
// performance.memory is CHROME-ONLY and non-standard, so this degrades: no
// reading prints "n/a". Worth having anyway — Chrome is where this is
// developed, and a heap figure climbing across a long run is the one leak
// signal this game could plausibly produce (the sprite cache and the road
// strips both grow with `scale`).
function heapText() {
  const mem = performance.memory;
  if (!mem || !mem.usedJSHeapSize) return "n/a";
  return `${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB`;
}

function deckSnapshot() {
  const hullPct = Math.max(0, Math.round((player.health / player.maxHealth) * 100));
  // The same floorDist -> sectorIndex lookup sectors.js does, and deliberately
  // the same one rather than a cached copy of what it last announced: it is a
  // PURE FUNCTION of distance (see citygrid.js), so asking again costs nothing
  // and cannot drift out of step with the palette the floor is actually using.
  const sector = sectors.sectorName(sectorIndex(scenery.floorDist(distance)));

  // The measured half. engine/loop.js is the only place the real frame figures
  // exist (the timestep is fixed, so `dt` down here is a constant and says
  // nothing about how the frame went) — see its own stats() header.
  const frame = loop.stats();
  const fps = Math.round(frame.fps);
  // "Packet loss" is the shortfall against 60, which is what the game is
  // budgeted for. Fiction and diagnostic in the same number: 8% loss and "the
  // game is running at 55fps" are the same sentence.
  const loss = fps ? Math.max(0, Math.round(((60 - fps) / 60) * 100)) : 0;
  // Everything the world currently has SPAWNED. A real entity count, and the
  // README's claim that frame cost is FLAT in it is exactly the kind of thing a
  // playtester can now watch hold or fail live.
  //
  // The three spawned lists only. The city floor, the drones and the conduits
  // are pure functions of position rather than object lists (see drones.js's
  // droneField and links.js's conduitField) — there is nothing there to count,
  // and inventing a number for it would break the one property that makes this
  // row worth reading.
  const entities = traffic.cars.length + obstacles.list.length + pickups.list.length;

  const deck = DECK_STATE[state] ?? DECK_STATE_FALLBACK;

  return {
    mode: deck.mode,
    link: deck.link,
    fps,
    loss,
    frameMs: frame.workMs.toFixed(1),
    peakMs: frame.worstMs.toFixed(1),
    heap: heapText(),
    entities,
    // Flavour derived from the two real numbers either side of it, so it moves
    // when they do rather than drifting on its own clock.
    kbps: Math.round(entities * 1.7 + fps * 3.1),
    sector,
    // DIST_UNITS, matching the HUD's own DIST readout rather than raw world
    // units — two readouts of the same thing that disagreed would be worse than
    // one.
    dist: Math.floor(distance / road.DIST_UNITS),
    strip: Math.floor(distance / 128),
    speed: Math.round(player.speed),
    hullPct,
    credits: wallet.credits,
    points: score.points,
    weapon: loadout.current ? loadout.current.type.label : "NONE",
    feed: currentTrack,
  };
}

// The deck's own tick: the gutter log's filler chatter and the rig panel's
// readouts.
//
// Runs ABOVE the state machine, not inside a branch of it, and that is the
// point — the deck is up whenever the page is. The menu, the shop and the death
// sequence all keep it talking, at the idle rate telemetry.js's interval()
// gives a stopped car, so the screen never has a dead frame around a live game.
// It reads state rather than being driven by it.
//
// Cheap enough to be unconditional: when the gutter panels are hidden (a narrow
// window) pushLog and setStatus both return immediately, and the only cost left
// is this snapshot — a handful of arithmetic on values already in hand.
function updateDeck(dt) {
  hudClock += dt;
  const snap = deckSnapshot();
  telemetry.update(dt, snap, gutter.pushLog);
  rigDue -= dt;
  if (rigDue <= 0) {
    rigDue = RIG_SAMPLE;
    gutter.setStatus(telemetry.statusRows(snap));
  }
}

function update(dt) {
  updateDeck(dt);
  // Before the state switch, so a row toggled on the pause screen is live on
  // the very next playing tick — see applyTestOptions()'s own header.
  applyTestOptions();
  switch (state) {
    case "menu": return updateMenu();
    case "paused": return updatePaused();
    case "connecting": return updateConnecting(dt);
    case "dying": return updateDying(dt);
    case "gameover": return updateGameOver();
    case "lifting": return updateLifting(dt);
    case "shopping": return updateShopping();
    case "lowering": return updateLowering(dt);
    case "gpulost": return updateGpuLost(dt);
    default: return updatePlaying(dt);
  }
}

// present.js's onLost/onRestored, wired at the top of this file into
// present.init(). A loss can arrive on any tick regardless of `state` — see
// the "gpulost" note in the state machine header above — so unlike every other
// state transition in this file, these two are not called from inside
// update()'s own switch.
function onGpuContextLost() {
  // Never overwritten by a second loss arriving before a restore: present.js's
  // own `live` flag already makes a second onLost from an already-dead context
  // impossible (gl/context.js only fires it once per context), so this is
  // reached at most once per outage.
  gpuLostFrom = state;
  state = "gpulost";
}

function onGpuContextRestored() {
  // gpuLostFrom is only ever null before the first loss of the session (see
  // its own declaration) — by the time this fires, onGpuContextLost has
  // already run and set it to whatever "gpulost" interrupted.
  state = gpuLostFrom;
  gpuLostFrom = null;
}

function updateMenu() {
  // START GAME gets jack_in INSTEAD of the plain confirm tone — see
  // music.jackIn() for why the two never both fire for one confirm.
  if (tickMenu()) {
    // Into game/jackin.js's boot, NOT straight into "playing". The hint bar
    // stays empty for its duration: there is nothing to steer yet.
    state = "connecting";
    hint.innerHTML = "";
    // The confirming keypress doubles as the user gesture AudioContext
    // creation needs (synth.js), though in practice the FIRST keypress of the
    // session has usually built it already (the startContext() listener
    // above). jackIn() plays the descending riser and starts the music
    // scheduler timed to land its first downbeat as the riser ends. ONCE PER
    // PAGE, unlike the visual sequence below, which RESTART runs again.
    music.jackIn();
    jackin.trigger();
  }
  // The MUSIC/SOUND rows can only have moved on the tick just above.
  syncVolumes();
}

function updatePaused() {
  // ESC resumes directly, without going through CONTINUE — the same key that
  // opened pause closes it. A fresh consumePress, so this never fires on the
  // very keypress that opened it.
  if (consumePress("pause")) {
    state = "playing";
    hint.innerHTML = PLAY_HINT;
    // Backing out WITHOUT confirming a row — the one place menu_back plays.
    music.play(MENU_SOUND.back);
    return;
  }
  if (tickMenu()) {
    state = "playing";
    hint.innerHTML = PLAY_HINT;
    // CONTINUE gets a plain confirm tone, not jack_in: the music never stopped
    // while paused (the scheduler never stops — proceduralmusic.js), and
    // jack_in is reserved for the one moment the scheduler actually starts.
    music.play(MENU_SOUND.confirm);
  }
  syncVolumes();
}

function updateConnecting(dt) {

  // A FROZEN STATE — see `state` above for the shape all four share. The world
  // sits where newGame() put it until the feed is up.
  jackin.update(dt);
  gameConsole.update(dt);
  // Only "pause" is drained: nothing is steerable yet, so nothing else is read.
  consumePress("pause");
  if (jackin.done) {
    state = "playing";
    hint.innerHTML = PLAY_HINT;
  }
}

function updateDying(dt) {

  // A FROZEN STATE — see `state` above. Everything sits where it was the
  // instant the hull hit zero; only the death sequence advances.
  disconnect.update(dt);
  // "fire" is the one drained here, because it is HELD (isDown) rather than
  // edge-consumed while shooting: a player still mashing it as the car
  // glitches out would have that press read as "gameover"'s confirm, firing
  // RESTART before they had seen the screen.
  consumePress("fire");
  if (disconnect.done) {
    state = "gameover";
    menu.open("gameover");
    hint.innerHTML = MENU_HINT;
  }
}

function updateGameOver() {
  // Same screen and interaction as "paused" — RESTART is row 0's label here
  // (menu.js's ROW0_LABEL) where CONTINUE is there — but it starts a fresh run
  // instead of resuming a frozen one.
  if (tickMenu()) {
    // newGame() FIRST: it resets the jack-in and clears the SYS LOG, so the
    // boot lines pushed below belong to the new run instead of being wiped.
    newGame();
    // RESTART jacks in again. The game-over screen has just told the player
    // the deck is REACQUIRING SIGNAL (disconnect.js's readout), so cutting
    // straight to a moving road would leave that sentence unanswered.
    state = "connecting";
    hint.innerHTML = "";
    jackin.trigger();
    // Plain confirm tone, as CONTINUE gets: the scheduler is already running,
    // so the boot plays over music that never stopped, with no riser. The
    // riser and the backend start are once-per-page (synth.js's jackIn()).
    music.play(MENU_SOUND.confirm);
  }
  syncVolumes();
}

// THE FROZEN HALVES of the shopping interlude — see `state` above for the
// shape all four frozen states share. The drone does its work over a world
// that is drawn but not advancing.
//
// `player.x` is handed to hauler.update() so the drone keeps tracking the
// car's lane; the car has stopped, so this is the smoothing finishing its
// converge on a value that no longer changes (hauler.js's update()).
function updateLifting(dt) {
  hauler.update(dt, player.x);
  gameConsole.update(dt);
  // Both drained, or a key pressed while the car is in the air is read as the
  // shop screen's undock the instant it opens — skipping a screen unseen.
  consumePress("pause");
  consumePress("fire");
  if (hauler.done) {
    state = "shopping";
    hint.innerHTML = SHOP_HINT;
  }
}

function updateShopping() {
  // The SYS LOG is frozen too here, unlike the two sequences either side of it:
  // the shop covers the world completely (see render()), so there is no console
  // on screen for an animation to be visible in.
  // The shop does its own buying — it has the wallet, the car, the guns and the
  // garage, and purchase() (game/upgrades.js) is what moves money between them.
  // main.js's job is the two things shop.js deliberately cannot do: play a tone
  // for what happened, and change state when the player is done.
  const action = shop.update(wallet, player, loadout, garage);
  if (action === "move") music.play(MENU_SOUND.move);
  else if (action === "buy") music.play(MENU_SOUND.confirm);
  // menu_back for a refusal. There is no "deny" tone in the menu set
  // (audio/menusfx.js's MENU_ACTIONS is exactly four), and inventing one for
  // this screen alone would be a fifth sound the rest of the game never uses —
  // "back" already reads as a press that did not go through.
  else if (action === "deny") music.play(MENU_SOUND.back);
  if (action !== "undock") return;

  // THE ROAD IS REBUILT BEFORE THE RETURN TRIP, not after it — so the lowering
  // sequence descends onto the clear tarmac the player is about to be driving
  // on, rather than showing them the old traffic for a beat and then swapping
  // it out under the car. See respawnWorld() for what this does and does not
  // touch.
  respawnWorld();
  hauler.lower(player.x, player.y);
  state = "lowering";
  hint.innerHTML = "";
  // Same plain confirm tone CONTINUE and RESTART get: undocking is leaving a
  // screen, not a ceremony of its own.
  music.play(MENU_SOUND.confirm);
}

function updateLowering(dt) {
  hauler.update(dt, player.x);
  gameConsole.update(dt);
  consumePress("pause");
  consumePress("fire");
  if (hauler.done) {
    // THE DRONE GOES IDLE HERE, and the order matters: `done` is derived from
    // the phase, so this is the one moment the sequence can be retired — after
    // it has been read, and before the next tick asks whether the shop
    // encounter is still running. Without it the hauler sits in "lower"
    // forever, and game/events.js (which reads `phase !== "idle"` as that
    // encounter's `live`) keeps the road standing down at the shop entry's
    // zero density for the rest of the run.
    hauler.settle();
    state = "playing";
    hint.innerHTML = PLAY_HINT;
  }
}

// The one frozen state entered off the player's own action or a sequence
// finishing — see the "gpulost" note in the state machine header above. There
// is no `done` condition to poll here: onGpuContextRestored (wired into
// present.init() at the top of this file) is what leaves it, asynchronously,
// whenever the browser actually fires `webglcontextrestored`. Until then this
// tick does nothing but keep the console's own clock honest and drain input,
// the same as every other frozen state.
function updateGpuLost(dt) {
  gameConsole.update(dt);
  consumePress("pause");
  consumePress("fire");
}

function updatePlaying(dt) {
  if (consumePress("pause")) {
    state = "paused";
    menu.open("pause");
    hint.innerHTML = PAUSE_HINT;
    return; // frozen the instant ESC is pressed — no world update this tick
  }

  // The floor's traffic dots are the one thing on it that depends on time
  // rather than position alone (see scenery.js's own header) — advanced here,
  // on the fixed step, alongside every other per-run system, so they freeze
  // exactly when "playing" stops rather than drifting on a clock of their own.
  scenery.update(dt);
  gameConsole.update(dt);

  // Road edges at the player's own row (worldY === distance there), used to keep
  // the car on the tarmac and to trigger barrier-scrape damage.
  const edges = road.edgesAt(distance, W);
  player.update(dt, { left: edges.left, right: edges.right });

  // Score the road covered from the SAME step that moves the world, so the
  // odometer and the distance term of the score can never disagree.
  const travelled = player.speed * dt;
  distance += travelled;
  score.travel(travelled);
  score.update(dt);
  // The wallet has no distance term at all (wallet.js's header) — this only
  // ages its own HUD flash, on the same tick the scoreboard ages its.
  wallet.update(dt);

  // The console voice for Phase 7e's nodes (game/links.js): re-derives which
  // node, if any, is currently mid-ping among the ones on screen and pushes
  // one SYS LOG line the moment that changes. Reads scenery.js's own clock
  // (see links.js's header) and this tick's just-updated `distance`/
  // `player.y`, the same pair render() will use a moment later.
  links.announce(scenery.clock, distance, player.y, W, H);

  // SIPHONING (Phase 11 groundwork): the same nodes the log is talking about
  // pay CREDITS when the player drives up alongside one while it pings — which
  // is what finally gives the city floor's nodes a use beyond atmosphere. The
  // node list is built here, once, and handed in: links.announce above and
  // links.render below each derive their own (they are one cheap row walk),
  // but the wallet's rule needs the nodes AND the player's position together,
  // so the walk that feeds it belongs at the call site that has both.
  const nodes = scenery.visibleNodes(scenery.floorDist(distance), player.y, W, H);
  wallet.harvest(dt, scenery.clock, nodes, player, distance, W);
  // ...and, ONCE a run, a SYS LOG line saying what those markers on the floor
  // mean, the first time one is actually within reach. Asked here rather than
  // inside harvest() because it is about a node the player has NOT collected —
  // it fires on the approach, which is the only moment the advice is useful.
  wallet.hint(scenery.clock, wallet.hints(scenery.clock, nodes, player, distance, W).length > 0);

  // Phase 7f's sectors: re-derives which sector this tick's distance falls
  // in, re-points palette.js's live bindings at it (every tick, not only on
  // a crossing — see sectors.js's own header), and on an actual crossing
  // kicks off the rescan glitch and its own SYS LOG line. Before render()
  // reads any of that, same ordering links.announce() above relies on.
  sectors.update(dt, scenery.clock, distance);

  // Phase 8 step 5's sector-transition audio: sectors.js exposes only
  // glitching() (a level, "is a rescan live right now"), with no edge of its
  // own to hook — per its own header and the design brief, audio stays OUT
  // of sectors.js entirely, main.js wires it, same as every other system
  // here. So this is the edge detector, the same "an edge needs memory"
  // pattern sectors.js's own lastSector/links.js's own lastAnnouncedId
  // already use, just kept here instead: a crossing is the tick glitching()
  // goes from false to true. music.triggerSectorTransition() fires the gong
  // (soundtypes.js's sector_shift) and the musicFilter collapse/reopen
  // (context.js's beginSectorTransition) together — see its own comment —
  // so the audio hiccups on the exact same tick the visual rescan does.
  const sectorGlitching = sectors.glitching();
  if (sectorGlitching && !wasSectorGlitching) music.triggerSectorTransition();
  wasSectorGlitching = sectorGlitching;

  // THE STAGED MOMENTS — gangs, blockades, the road narrowing, a set-piece at a
  // milestone, and the shopping interlude — all decided in one place
  // (game/events.js), sitting beside the sector edge above because they are the
  // same kind of thing: something that happens at a point on the odometer and
  // then has to remember it did.
  //
  // THE SHOP VISIT USED TO BE ITS OWN TRIGGER HERE, hauler.crossedMilestone(),
  // and it fired blind — it could and did close the drone's jaws over the top of
  // whatever else was happening. Now it is one entry in the same catalogue as
  // the rest, so the director can hold it (never drop it) until the road is
  // clear. See eventtypes.js's `shop` entry.
  //
  // Runs on the JUST-UPDATED distance, like every other consumer this tick, and
  // BEFORE obstacles.update()/traffic.update() below, so anything staged goes
  // through the ordinary collision, detonation and retire pipeline in the same
  // tick it appeared.
  events.update(scenery.clock, {
    distance, player, W, H, traffic, obstacles,
  }, EVENT_HANDLERS);

  // ...and the approach ITSELF runs here, under "playing", with the whole world
  // still live around it — that is the entire point of the phase (hauler.js's
  // header). The player keeps driving, steering and shooting while the drone
  // comes down; only the grab at the end of it freezes anything.
  hauler.update(dt, player.x);
  if (hauler.grabbed) {
    // NOTHING IS BANKED HERE, deliberately. Committing the run's earnings at
    // the grab would make sense if there were a bank to commit them TO — it
    // was how an earlier draft of this handed the shop a settled balance. With
    // credits scoped to a single run (see CREDIT_STORE above) there is no such
    // bank: bank() would only move the money from `earned` to a `banked` that
    // dies with the same run, and the one thing it WOULD change is
    // lastRunEarnings, which would then quote the last leg instead of the run
    // on the game-over screen. The shop spends wallet.credits directly, which
    // is the same money either way.
    hauler.lift();
    state = "lifting";
    // Nothing is steerable from here until the car is back on the road.
    hint.innerHTML = "";
    // The gong sectors already spend on a crossing — a grab is punctuation of
    // exactly that size, and it costs no new sound type. A voice of its own is
    // work for the phase that gives the shop content.
    music.play("sector_shift");
    return; // frozen the instant the jaws close — no further world update this
            // tick, the same early-out the ESC branch at the top of this
            // function takes
  }

  // Phase 8 step 3's sustained voices, polled every "playing" tick — see
  // sustainedfx.js's own header on why these are POLLED (not pushed from a
  // damage/pickup event): they just mirror whatever player state already
  // says right now.
  music.updateWallScrape(player.hitWall);
  music.updateShieldDrone(player.shieldTime);
  // Speed-linked music filter (audio/context.js's musicFilter) — polled the
  // same way as the three sustained voices above, off player.speed directly
  // rather than anything traffic-related.
  music.updateMusicCutoff(player.speed);

  // Shooting, BEFORE traffic: a bullet that kills a car this tick leaves that
  // car dead when traffic.update runs, so it detonates and scores in the same
  // frame it was hit rather than a frame later.
  // TAB cycles the loadout — GUNS ONLY (Loadout.next() skips the mine layer on
  // purpose, see weapons.js). Edge-triggered (consumePress, not isDown) so
  // holding the key selects one weapon rather than riffling through them
  // every frame.
  if (consumePress("swap")) {
    loadout.next();
    music.play("weapon_swap");
  }

  // The target lock's own clock (game/targeting.js), run BEFORE the trigger
  // below so a burst fired this tick sees a designation that is current — and
  // so a lock whose car died to anything at all last tick is already gone
  // rather than being handed to eight more rounds.
  lock.update(dt);

  loadout.update(dt);
  const weapon = loadout.current;
  if (isDown("fire") && weapon.ready && weapon.tryFire()) {
    // The muzzle is the car's nose, in road coordinates — the player's screen x
    // re-based on the centre-line, exactly as collisions.js does it. What the
    // bullet does with it from here is the weapon's flight mode's business.
    const centerX = road.centerXAt(distance, W);
    // ONE PULL, ONE OR MORE ROUNDS — muzzleOffsets is the whole of what the
    // TWIN CANNON and TWIN RACK specials do at the trigger (weapons.js); a
    // stock car gets back a single [0].
    //
    // THE ROUNDS SHARE THE COOLDOWN AND THE ROUND: tryFire has already been
    // called once, so a paired weapon fires twice the metal for the same rate
    // and the same ammunition. That IS the upgrade — a pairing that burned two
    // rounds a press would sell the player nothing but a louder magazine.
    const muzzles = muzzleOffsets(weapon.type, player.specials);
    // AUTOLOCK — THE TRIGGER DESIGNATES (weapons.js's TRACKER, game/targeting.js).
    // A pull renews whatever is already locked and otherwise picks one hostile
    // ahead at random; either way the whole burst is handed the same car, and
    // every weapon the upgrade was not bought for gets 0 here and skips the
    // block entirely.
    //
    // RENEWING RATHER THAN RE-ROLLING is what keeps a random pick playable: a
    // held trigger stays on the car it chose for as long as it is being shot
    // at, and only a lock left to expire (lockTime after the last pull) puts
    // the next pull back in the lottery.
    //
    // A pick that finds nothing leaves the lock empty — acquire(null) is a
    // no-op — and the burst flies as a stock tracker burst does.
    const seconds = lockSeconds(weapon.type, player.specials);
    if (seconds > 0) {
      lock.acquire(lock.car ?? traffic.randomHostileAhead(lockRange(weapon.type, player.specials)), seconds);
    }
    // Read HERE, at the muzzle, not mid-flight, so a round chases the car that
    // was designated when it was FIRED — rounds re-checking in the air would
    // swing the whole burst the moment the player designated something else.
    SHOT_OPTS.target = seconds > 0 ? lock.car : null;
    SHOT_OPTS.lead = lockLead(weapon.type, player.specials);
    for (const dx of muzzles) {
      shots.spawn(distance + player.h / 2, player.x - centerX + dx, player.speed, weapon.type, W, 1, SHOT_OPTS);
    }
    music.play(PLAYER_FIRE_SOUND[weapon.type.id]);
    // WAS THAT THE LAST ROUND? Then the loadout hands over the next loaded gun
    // by itself (weapons.js's settle), sounding the same swap TAB would have.
    // The alternative is the player finding out by pulling a dead trigger in
    // the middle of a fight, which is a punishment for firing the shot they
    // were meant to fire.
    if (loadout.settle()) music.play("weapon_swap");
  } else if (isDown("fire") && weapon.empty) {
    // A refusal, not a shot — the trigger is held against an empty magazine.
    // isDown never edge-triggers the way consumePress does, so it's
    // soundtypes.js's own minInterval on "dry_fire" that turns a held key
    // into one refusal rather than sixty (see that entry's own comment).
    music.play("dry_fire");
  }

  // CTRL lays whichever deployable is selected, independent of whichever gun
  // is currently selected — no more tabbing onto the mine layer to drop one
  // and back to a gun afterwards. Mirrors armament.js's own layMine: the drop
  // is attempted BEFORE the round is spent, so a mine the road had no room for
  // (obstacles.js's laid budget) costs the player nothing.
  const deployable = loadout.deployable;
  if (deployable && isDown("mine") && deployable.ready) {
    const centerX = road.centerXAt(distance, W);
    // The player, expressed as a body in road coordinates, is exactly what
    // obstacles.js's drop() wants — worldY/offset/h, the same shape a car
    // satisfies without an adapter.
    const body = { worldY: distance, offset: player.x - centerX, h: player.h };
    // WHICH HAZARDS, decided at the drop rather than carried on the weapon: the
    // SPIKE MINES special (upgrades.js) turns the mine into a mine AND a strip,
    // and the flag it sets lives on the CAR (Player.applyUpgrades). The rule
    // itself is weapons.js's — see laidPayloads — so a Loadout built before the
    // dock and a car upgraded at it never have to agree about anything.
    //
    // ALL OF THE SET OR NONE, which drop() enforces: half a pair is the player
    // spending a round on something they did not buy.
    const laid = laidPayloads(deployable.type, player.specials).map(obstacleTypeById);
    if (obstacles.drop(laid, body)) {
      deployable.tryFire();
      music.play(PLAYER_FIRE_SOUND[deployable.type.id]);
      // Same rule as the gun above: the drop that empties the last mine selects
      // whatever else is still loaded, so CTRL keeps working rather than going
      // quiet on a spent layer.
      if (loadout.settle()) music.play("weapon_swap");
    }
  }
  // SHIELD STORM (game/shieldstorm.js), with the player's other offensive work
  // and for the same tick-order reason the gunfire above gives: a car the storm
  // kills this tick must be dead before traffic.update()'s own detonate sweep
  // runs, or its wreck and its bounty arrive a frame late.
  //
  // Handed the player in ROAD coordinates — the same re-basing the muzzle uses
  // — rather than traffic's PlayerBody, which has not been synced for this tick
  // yet at this point in the frame.
  if (shieldStorm.update(
    dt, player, distance, player.x - road.centerXAt(distance, W), traffic.cars, explosions,
  ) > 0) {
    // The shield eating a hit and the shield throwing one both sound like the
    // shield doing its job, which is why this borrows shield_deflect rather
    // than spending a new voice on it (audio/soundtypes.js). Its own
    // minInterval and the storm's half-second cadence keep it a punctuation
    // mark rather than a drone.
    music.play("shield_deflect");
  }

  // Traffic cars and road obstacles are both fair game for the PLAYER'S gunfire
  // — one flat list, built fresh each tick into the reused scratch array, so a
  // shot stops at whichever it actually crosses first (see projectiles.js's
  // firstHit). Hostile fire is resolved separately, after traffic — see below.
  shotTargets.length = 0;
  for (const car of traffic.cars) shotTargets.push(car);
  for (const o of obstacles.list) shotTargets.push(o);
  shots.update(dt, shotTargets, { distance, playerY: player.y, W, H });

  // Obstacles run BEFORE traffic, on the same principle main.js already uses
  // for bullets: anything an obstacle kills this tick (a car caught in a mine
  // blast) must still be picked up by traffic.update()'s own detonate() sweep
  // in the SAME tick, not a tick late — see game/obstacles.js's header.
  const world = {
    player, distance, W, H,
    cars: traffic.cars,
    obstacles: obstacles.list,
    // The hostile weapons' way into the world — see above, and the contract at
    // the top of game/behaviours.js.
    fireShot,
    dropMine,
    fireShell,
  };
  obstacles.update(dt, world);

  // retire() REPLACES obstacles.list with a filtered array, so re-point the
  // world at the live one before traffic reads it — a stale reference would
  // have the car behaviours steering around hazards that no longer exist.
  world.obstacles = obstacles.list;

  // Traffic runs on the UPDATED distance, so a car spawned this tick lands
  // relative to where the player actually is now. The object handed over becomes
  // the view of the world the car behaviours get (behaviours.js). Note the
  // player is NOT read-only here: traffic resolves ramming for every car and the
  // player together, which can shove and damage the player (collisions.js).
  traffic.update(dt, world);

  // Phase 8 step 4's "dread_pulse" — polled AFTER traffic.update(), so
  // tailThreat() reads this tick's own car positions rather than last
  // tick's, exactly the way the sustained voices above read this tick's
  // just-updated hull/shield/wall state. See traffic.js's own tailThreat()
  // header for what it returns and why the query lives there.
  music.updateDreadPulse(dt, traffic.tailThreat());

  // Hostile fire resolves AFTER traffic, not before it like the player's. Two
  // reasons, and they point the same way: the rounds fired during traffic.update
  // this tick get to move and land in the tick they were fired, and the
  // PlayerBody they are tested against has just been synced to where the player
  // actually is now rather than to where it was at the top of the frame.
  enemyShots.update(dt, enemyTargets, { distance, playerY: player.y, W, H });

  // The barrage, resolved LAST of the damage sources and against EVERYTHING on
  // the road — the player, the traffic and the hazards alike, which is the one
  // way this differs from the hostile bullets above. Indirect fire is not
  // careful (see shells.js): a shell that lands on the boss's own escort kills
  // the escort, and a player who baits one into a knot of cars has earned that.
  // Last, so a shell fired during traffic.update this tick still gets its fuse
  // ticked in the tick it was fired.
  shellTargets.length = 0;
  shellTargets.push(traffic.playerBody);
  for (const car of traffic.cars) shellTargets.push(car);
  for (const o of obstacles.list) shellTargets.push(o);
  shells.update(dt, shellTargets);

  // Buff crates. Independent of everything above — a pickup never fights,
  // shoves or blocks anything — so it needs none of the tick-order care
  // bullets and obstacles do; it only has to see where the player ended up
  // this tick, which is already final by this point.
  pickups.update(dt, { player, distance, W, H, loadout });

  // The hull check runs LAST, after every damage source above (wall-scrape in
  // player.update, ramming and blast in traffic.update, mines and bullets)
  // has had its shot at the player this tick — so wherever health actually
  // hit zero, this is the one place that notices. `state` flips to "dying"
  // and nothing under "playing" runs again until newGame() resets it.
  if (player.health <= 0) {
    state = "dying";
    // BANK THE RUN AT THE MOMENT OF DEATH, not when the game-over screen opens
    // a couple of seconds later: a player who closes the tab while the
    // disconnect sequence plays out has still finished their run, and should
    // still keep what they earned. Idempotent, and nothing under "playing"
    // runs again to earn more (see the branch this sits in).
    wallet.bank();
    disconnect.trigger();
    // UNCONDITIONAL, deliberately — this call does TWO things (see synth.js's
    // playDisconnect()): it plays the static AND fades the music bus into the
    // hole the static is supposed to land in. Gating it on soundVolume used to
    // suppress both, so a player with SOUND at 0 and MUSIC at 100 heard the
    // music carry on at full level straight through their own death. The SFX
    // half needs no gate of its own anyway: sfxGain already sits at
    // soundVolume, so a muted SOUND slider makes the static inaudible without
    // anything here having to know that.
    music.playDisconnect();
    hint.innerHTML = "";
  }
}


// THE HUD, drawn onto `hudCtx` (Phase 15c) — see render()'s own header for the
// canvas split this is half of. Every draw in this function used to share the
// world canvas with everything bloom sees; none of it does any more, which is
// why BLOOM_THRESHOLD/BLOOM_EXPOSURE (engine/present.js) could finally be
// tuned for the world alone. glowText's own shadowBlur is untouched and still
// does the glowing here — it was never the thing 15d-ii banned (that was
// shadowBlur on canvas-spanning paths and cached sprites); on a canvas bloom
// never reads, it is the ONLY source of glow, exactly as it always was for
// HUD text specifically.
function drawHud() {
  glowText(hudCtx, "CYBERCRUISE", 12, 12, GREEN, 18, "left", 12);

  // Score gets the biggest readout on screen — it's the thing being played for.
  // A small "SCORE" header (same device HULL uses over the health bar, below)
  // names the number, and the number itself is bold on top of its own glow so
  // it still reads as the HUD's centrepiece next to DIST/SPD's plain instrument
  // readouts.
  glowText(hudCtx, "SCORE", W - 12, 8, GREEN_PALE, 11, "right", 6);
  glowText(hudCtx, `${score.points}`, W - 12, 20, GREEN_BRIGHT, 22, "right", 14, true);

  // The last kill's award, fading out under the total, so the player can see
  // WHY the number jumped — red for a fine, green for a bounty. Presentation
  // only: the total above has already banked it.
  const alpha = score.awardAlpha;
  if (alpha > 0) {
    const award = score.lastAward;
    const text = `${award >= 0 ? "+" : ""}${award}`;
    hudCtx.save();
    hudCtx.globalAlpha = alpha;
    glowText(hudCtx, text, W - 12, 48, award >= 0 ? GREEN_BRIGHT : HAZARD, 16, "right", 10);
    hudCtx.restore();
  }

  // Shown in DIST_UNITS, not raw world units — see road.js. The same scale the
  // catalogues' `minDistance` gates are written in, so a player who sees DIST 100
  // is seeing exactly the moment the enemy is allowed on the road.
  glowText(hudCtx, `DIST ${Math.floor(distance / road.DIST_UNITS)}`, W - 12, 70, GREEN_PALE, 13, "right");
  // SPD carries the OVERDRIVE buff (game/pickuptypes.js's BOOST) rather than
  // getting its own readout, and it is the right line for it: the buff's whole
  // effect is this number, so the countdown belongs where the player is already
  // looking to see it. The whole row goes thruster-magenta while it runs — the
  // car's own plume colour, matching what the crate's glyph promised — and
  // flickers through its last second on the same clock the shield readout below
  // uses, so the two buffs expire in the same visual language.
  //
  // The line is RIGHT-ALIGNED, so the extra text grows leftward into empty
  // screen and nothing else in this top-right stack has to move for it.
  const boosted = player.boostTime > 0;
  const boostExpiring = boosted && player.boostTime < BOOST_EXPIRING
    && Math.sin(player.boostPhase * BOOST_FLICKER_RATE) > 0;
  glowText(
    hudCtx,
    boosted
      ? `SPD ${Math.round(player.speed)}  +${player.boost} ${player.boostTime.toFixed(1)}s`
      : `SPD ${Math.round(player.speed)}`,
    W - 12, 88,
    boostExpiring ? SHIELD_FLICKER : boosted ? PLAYER_THRUST : GREEN_PALE,
    13, "right", boosted ? 8 : 0,
  );

  // CREDITS: the wallet's total — this run's earnings on top of whatever
  // earlier runs banked, i.e. exactly what the shop has to spend at the next
  // stop. An instrument readout like DIST/SPD rather than a second
  // centrepiece: the score is still the thing being played for, and money is
  // a fact about the run, not the point of it.
  //
  // GREEN, not gold. Amber and red are FACTION colours in this game
  // (palette.js's header) — a yellow number in the HUD corner would read as
  // "neutral car" to the same half-second glance the whole colour discipline
  // exists to protect. The `CR` label does the work a colour would.
  glowText(hudCtx, `CR ${wallet.credits}`, W - 12, 106, GREEN_PALE, 13, "right");

  // The last payout, fading under the total, same device the score's own
  // award uses above — and deliberately on its own line rather than sharing
  // the score's, since one kill can flash BOTH (points and credits) and two
  // numbers landing on top of each other would be unreadable. A fine shows
  // what was actually taken, which is not always what the car was worth (see
  // Wallet.award: a fine can only empty the run, never overdraw it).
  const credAlpha = wallet.awardAlpha;
  if (credAlpha > 0 && wallet.lastAward !== 0) {
    const cr = wallet.lastAward;
    hudCtx.save();
    hudCtx.globalAlpha = credAlpha;
    glowText(hudCtx, `${cr >= 0 ? "+" : ""}${cr}CR`, W - 12, 124, cr >= 0 ? GREEN_BRIGHT : HAZARD, 13, "right", 8);
    hudCtx.restore();
  }

  const weapon = loadout.current;

  // Health bar (bottom-left): green draining to red as damage mounts. Lifted
  // 16px off the very bottom edge (rather than H - 24) to leave room for the
  // MINE readout below it — see the bottom of this function.
  const bx = 12;
  const by = H - 40;
  const bw = 140;
  const bh = 10;
  const frac = player.health / player.maxHealth;
  const hue = 120 * frac; // 120=green -> 0=red

  // Weapon list, stacked above the hull bar: every GUN still carrying a
  // round, so the player can see what TAB's next press actually gets them
  // before pressing it, instead of discovering an empty magazine after
  // cycling onto it blind — plus the weapon actually in hand always, even at
  // 0 ammo (shown HAZARD red), since "still selected, still shown, won't
  // fire" is the one thing about it that never stops being true (see
  // Loadout's own header). One shared spot rather than the current weapon's
  // own line PLUS a separate switcher elsewhere, so there is exactly one
  // place on screen that answers "what am I on and what else could I be".
  // MINE stays out of this stack — it's not a TAB destination (Loadout.
  // next() skips any weapon with a payload) and keeps its own line, right-
  // aligned to the bar, same as before.
  const weaponRows = loadout.weapons.filter((w) => !w.type.payload && (w === weapon || !w.empty));
  let wy = by - 36 - (weaponRows.length - 1) * 18;

  // Backdrop for the whole cluster (weapon stack, HULL, MINE): the world
  // keeps scrolling underneath, and a bright building or a car passing right
  // behind the text can wash out even the glow. A flat translucent panel —
  // no border, nothing else neon about it — reads as a HUD plate the text
  // sits on rather than another glowing game element competing with it.
  hudCtx.save();
  hudCtx.fillStyle = "rgba(0,0,0,0.55)";
  hudCtx.fillRect(bx - 8, wy - 10, bw + 18, by + bh + 6 + 16 - (wy - 10));
  hudCtx.restore();

  for (const w of weaponRows) {
    const current = w === weapon;
    glowText(
      hudCtx,
      `${current ? "> " : "  "}${w.type.label} ${w.ammoText}`,
      bx,
      wy,
      w.empty ? HAZARD : w.type.color,
      current ? 14 : 12,
      "left",
      current ? 10 : 4,
    );
    wy += 18;
  }

  glowText(hudCtx, "HULL", bx, by - 16, GREEN_PALE, 12, "left", 6);

  // SHIELD, only while active — same "about to lose it" flicker the halo
  // around the car gives in its last second (player.js's renderShield),
  // read off the same clock so the HUD and the car agree on when that is.
  if (player.shieldTime > 0) {
    const expiring = player.shieldTime < 1 && Math.sin(player.shieldPhase * 26) > 0;
    glowText(
      hudCtx, `SHIELD ${player.shieldTime.toFixed(1)}s`, bx + bw, by - 16,
      expiring ? SHIELD_FLICKER : PLAYER, 12, "right", 8,
    );
  } else if (player.shieldCharge > 0) {
    // ...and, in the same slot, the ARMED state: a shield crate no longer
    // starts a clock (player.js's chargeShield), so without a tell here the
    // player would have no way to know they are carrying one. Breathes
    // instead of counting down — there is nothing running to count — at the
    // shield halo's own pulse rate so the HUD reads as the same system.
    // The banked figure is printed too, not just implied: chargeShield
    // stacks (player.js), so a player who has driven over two or three crates
    // needs to see that the bank actually grew, not just that something is
    // armed.
    //
    // SAME "SHIELD <n>s" WORDING AS THE RUNNING STATE ABOVE, not "SHIELD
    // CHARGED <n>s": this readout is right-aligned into the same row as the
    // HULL label on the left, and the longer string ran into it. The breath
    // is what distinguishes armed from running — steady text counts down, a
    // pulsing one is waiting for a hit.
    const breath = (Math.sin(hudClock * 4.2) + 1) / 2; // player.js's SHIELD_PULSE_RATE
    hudCtx.save();
    hudCtx.globalAlpha = 0.55 + 0.45 * breath;
    glowText(hudCtx, `SHIELD ${player.shieldCharge.toFixed(1)}s`, bx + bw, by - 16, PLAYER, 12, "right", 8);
    hudCtx.restore();
  }

  // Empty track.
  hudCtx.save();
  hudCtx.strokeStyle = "rgba(120,255,180,0.4)";
  hudCtx.lineWidth = 1;
  hudCtx.strokeRect(bx, by, bw, bh);
  hudCtx.restore();
  // Filled portion.
  if (frac > 0) {
    hudCtx.save();
    const c = `hsl(${hue}, 100%, 55%)`;
    hudCtx.fillStyle = c;
    hudCtx.shadowColor = c;
    hudCtx.shadowBlur = 10;
    hudCtx.fillRect(bx + 1, by + 1, (bw - 2) * frac, bh - 2);
    hudCtx.restore();
  }

  // THE SELECTED DEPLOYABLE, below the hull bar rather than sharing a row with
  // the weapon stack's cramped bottom line — its own keys (CTRL to lay, E to
  // cycle) and its own magazine, kept out of the TAB cycle above (weapons.js's
  // Loadout.next()), so it gets a permanent readout of its own rather than
  // only showing up when it happens to be the weapon in hand. Reads its LABEL
  // off the weapon rather than printing "MINE", so a second deployable needs
  // no change here. Coloured like the HULL label above it (GREEN_PALE) rather
  // than its own bullet colour — the weapon stack is where "what colour is
  // loaded" matters, this is just another gauge alongside the hull bar.
  const deployable = loadout.deployable;
  if (deployable) {
    glowText(
      hudCtx, `${deployable.type.label} ${deployable.ammoText}`,
      bx, by + bh + 6, GREEN_PALE, 13, "left", 8,
    );
  }

  gameConsole.render(hudCtx, W, H);
}

// THE CANVAS SPLIT (Phase 15c). Two 2D contexts feed render(): `ctx` (the
// world canvas, uploaded to the GPU and bloomed — engine/present.js) and
// `hudCtx` (the HUD canvas, a separate DOM layer painted on top, never
// bloomed — see index.html and css/style.css's `#hud`). THE RULE FOR WHICH A
// NEW DRAW GOES ON:
//
//   `ctx`     world geometry, and any display text with no live HUD to cover
//             that gains from bloom — the menu's title/subtitle/rows, the
//             shop's title and credit total, gameover's FINAL SCORE. Large,
//             sparse, meant to glow.
//   `hudCtx`  dense per-frame readouts (drawHud() and gameConsole's SYS LOG),
//             the menu's test-row checkboxes and footer, the shop's entire
//             price list — anything the same size class as HUD text, which
//             is exactly what bridges letters together under a threshold
//             tuned for the world (see README's "Rendering the halo"). ALSO
//             anything that must GUARANTEE it covers the HUD during a
//             transition (disconnect/jackin/hauler's renderOverlay calls,
//             below) — once the HUD is a separate layer, only canvas order
//             can guarantee that, not draw order within one canvas.
//
// sectors.renderGlitch is the one exception either way: it `drawImage()`s the
// frame so far back onto itself and MUST keep pointing at the world canvas
// element regardless of this rule, since a glitch tear sampling the
// (transparent, mostly-empty) HUD canvas instead would draw nothing.
// game/jackin.js's boot used to be a second such exception and is not any more
// — it draws nothing on either canvas but its readout now (Phase 15e-i).
//
// AND THERE IS NOW A THIRD SURFACE THAT IS NOT A CANVAS AT ALL: the feed block
// (engine/present.js's `feed`, filled by describeFeed() at the bottom of this
// file). The jack-in and the disconnect are drawn by a fragment pass over the
// finished world canvas, so they are neither of the two rows above — they are
// described rather than drawn, and what they describe cannot touch `hudCtx` by
// construction, which is what keeps their readouts sharp while everything else
// fails.
function render(alpha) {
  // Reinstalled every frame, not once at startup: any assignment to
  // canvas.width/height (which a resize does) resets the context state
  // wholesale, transform included. Both contexts get this — the HUD canvas is
  // a mirrored viewport surface (see its declaration above) and its backing
  // store resizes exactly when the world canvas's does.
  applyTransform(ctx);
  clear(ctx);
  applyTransform(hudCtx);
  // Transparent, not opaque like clear() above — the HUD has to let the
  // bloomed world canvas show through everywhere it isn't drawing a readout.
  // Cleared unconditionally, before the state switch below, the same way the
  // world canvas is: every branch populates it differently (or not at all),
  // and a menu screen that left last frame's in-game HUD numbers on this
  // layer would show them bleeding through the title screen.
  clearHud(hudCtx);

  // "gameover" reuses the exact same full-screen menu as "menu"/"paused" (see
  // menu.js's header) — the frozen wreck behind it from "dying" is gone the
  // instant the screen takes over, the same way "paused" already covers the
  // world rather than showing it through the menu.
  if (state === "menu" || state === "paused" || state === "gameover") {
    menu.render(ctx, hudCtx, W, H);
    // menu.js never touches the world (see its header) — the final score is
    // world state, so it's main.js's job to draw it, not menu.open()'s to
    // have been handed it. Placed above the RECONNECT row rather than fighting
    // menu.js's own layout for space inside it. On `ctx`: same size class as
    // the menu's own rows, and there is no live HUD on this screen to cover.
    // IN VECTOR TYPE (engine/vectorfont.js), like every other line on this
    // screen: these two sit between the menu's subtitle and its rows, so
    // leaving them in Courier would have made the gameover screen the one
    // place in the game where the two faces are read against each other.
    if (state === "gameover") {
      vectorText(ctx, `FINAL SCORE ${score.points}`, W / 2, 296, GREEN_BRIGHT, 17, "center", 1.8, 0.22);
      // What the run was worth in CREDITS. Reads lastRunEarnings rather than
      // `earned`, which the death-time bank() has already zeroed by the time
      // this screen exists — see Wallet.bank().
      //
      // NO "BANK" HALF ANY MORE: this line used to quote the running total
      // alongside, and that total is now always exactly this run's earnings
      // (see CREDIT_STORE) — the same number printed twice under two labels,
      // the second of which promised a persistence the game no longer claims.
      // The word comes back with the balance, when players have records to
      // hold one.
      vectorText(ctx, `CREDITS EARNED ${wallet.lastRunEarnings}`, W / 2, 326, GREEN_PALE, 12, "center", 1.3, 0.3);
    }
    return;
  }

  // The shop (game/shop.js) covers the world entirely, exactly as the menu
  // above does and for the same reason: the car is not on the road at all
  // while this is up, so there is no world worth showing behind it. Handed the
  // wallet and the garage to READ; both were already moved by update() above,
  // which is the only place on that screen money changes hands.
  if (state === "shopping") {
    // WHICH STOP THIS IS. The counter behind it used to be hauler.js's own
    // `milestone`; it moved into the event director with the rest of the
    // scheduling, so the number is asked of game/events.js now.
    shop.render(ctx, hudCtx, W, H, wallet, events.milestoneCount("shop"), garage, player, loadout);
    return;
  }

  // THE CAMERA IS QUANTISED TO WHOLE PIXELS, once, here, and the rounded value
  // is what every layer below is drawn against.
  //
  // Two of those layers are now blitted from pre-rendered canvases (the road's
  // strip cache in road.js, the floor grid's tile in scenery.js), and a blit is
  // only pixel-exact on an integer offset — at a fractional one the browser
  // resamples and the neon softens. Rounding ONCE rather than per-layer is what
  // matters: every entity derives its screen row from `playerY - (worldY - d)`,
  // so a single shared `d` keeps the cars welded to the road they are driving on,
  // where per-layer rounding would let them shear apart by up to a pixel.
  //
  // The cost is that the world advances in whole-pixel steps. At the 4-10px/frame
  // the speed band produces, that is invisible.
  //
  // NOT the simulation's `distance` — only the value rendering reads. The
  // odometer and the distance term of the score run off the real float (see
  // update), and rounding that would slowly bleed travelled road away.
  // snapToDevice, not Math.round: the tile blits have to land on whole DEVICE
  // pixels, and at a fractional render scale a whole LOGICAL pixel is not one.
  // See engine/viewport.js's SCALE_STEP. At scale 1 this IS Math.round.
  const camY = snapToDevice(distance);

  // THE DESYNC SHAKE IS NOT APPLIED HERE ANY MORE, as of Phase 15e-i. While
  // "dying", game/disconnect.js's shake() offsets the WHOLE feed — a feed
  // losing sync, not a physical jolt (see its header) — and this block used to
  // be a ctx.translate by it, carefully placed so the HUD and the CONNECTION
  // LOST readout stayed outside. It is a UV offset in the present pass now
  // (engine/present.js's `feed`), which gets the same exclusion structurally:
  // the pass cannot reach the HUD canvas at all. The save/restore pair stays,
  // because hauler.js's lift and the layers below still nest inside it.
  ctx.save();

  // Lower city floor first (parallax, behind everything), then the elevated road
  // ribbon paints an opaque surface over it, then the player on top. The floor
  // runs on its own half-speed clock and rounds it itself — see scenery.render.
  scenery.render(ctx, camY, player.y, W, H);
  // Links and pings (Phase 7e): ground-plane annotation on the nodes
  // scenery.render() just drew, so it draws immediately after that layer and
  // before the sky band (drones) or the road's own opaque foreground.
  links.render(ctx, camY, player.y, W, H);
  // The money markers over those same nodes: what a live node is worth, and
  // whether the car is close enough to be taking it (game/wallet.js). Ground-
  // plane annotation like the conduits and pings it draws over, so it sits in
  // the same layer and is covered by the road's own opaque surface — a node
  // the road is hiding is one that pays nothing anyway, and the marker
  // disappearing under the tarmac says exactly that.
  // Gathered once and kept: the same list feeds the floor's own markers here
  // and the link's dish drawn on the car further down, and walking the floor
  // twice for two views of one fact would be paying for it twice.
  let floorNodes = null;
  if (state !== "menu") {
    floorNodes = scenery.visibleNodes(scenery.floorDist(camY), player.y, W, H);
    // The wallet decides WHAT is worth a marker (hints, a pure rule about money
    // and reach); walletrender.js turns that into ink. Same split for the
    // receipts below, which read wallet.marks directly.
    renderNodeHints(ctx, wallet.hints(scenery.clock, floorNodes, player, camY, W));
    renderAwardMarks(ctx, wallet.marks, player, camY, W);
  }
  // Air traffic (Phase 7c): between the floor and the road, so it draws after
  // the whole scenery layer (grid, buildings, floor traffic) and before the
  // road ribbon paints its own opaque foreground over everything below it.
  drones.render(ctx, camY, player.y, W, H);
  // Phase 7f: the road recolours with the same sector the floor below it
  // does — computed here, once, off the SAME camY every other layer this
  // frame uses (via scenery.js's own floorDist — see its header), and handed
  // to road.js as a plain parameter rather than an import (road.js can't
  // import scenery.js — see its own render() header on the import cycle that
  // opens).
  const roadSector = scenery.currentSector(scenery.floorDist(camY));
  road.render(ctx, camY, player.y, W, H, roadSector);
  // Obstacles before traffic, so a car passing over one is never hidden
  // underneath it; traffic before the player, so the player's car is never
  // hidden under one. Traffic draws the shared explosion pool last (car
  // wrecks, mine blasts and roadblock rubble alike), so a blast is never drawn
  // under something still driving through it — see traffic.js's render.
  obstacles.render(ctx, camY, player.y, W, H);
  // Pickups alongside obstacles, before traffic — so a car driving over one
  // is never hidden underneath it, same reasoning obstacles.render gets above.
  pickups.render(ctx, camY, player.y, W, H);
  // THE SHELL MARKS, under the traffic and under the player: this is paint on
  // the tarmac rather than an object above it, so a car driving over its own
  // impact point covers the mark — which is exactly the moment the player most
  // needs to feel it. See shells.js's render.
  shells.render(ctx, camY, player.y, W, H);
  traffic.render(ctx, camY, player.y, W, H, alpha, lock);
  // Bullets over the traffic they're flying at, under the player's own car.
  // Hostile rounds draw with them and in the enemy's own red (weapons.js), so
  // which way a tracer is going is never a question the player has to work out.
  shots.render(ctx, camY, player.y, W, H);
  enemyShots.render(ctx, camY, player.y, W, H);
  // The player sits at worldY === distance, so that is where its heading comes
  // from — it leans into a bend along with the traffic around it. Read at camY,
  // like everything else drawn this frame, so the car's lean matches the bend of
  // the road actually on screen. WHILE "DYING" THE CAR IS NOT DRAWN AT ALL,
  // and as of 15e-i nothing is drawn in its place either: game/disconnect.js
  // has no world-canvas draw left (see its header). The car vanishing on the
  // killing frame IS the hit, and what the present pass then pulls apart is
  // the frozen world it left behind.
  if (state !== "dying") {
    // THE CAR RIDES THE DRONE, and this one translate is the whole of how. The
    // hauler owns the motion but not the car (see its header on why): it hands
    // back a screen-space y offset, and player.render() below draws exactly the
    // car it always draws — thruster, damage flash, shield and all — just
    // somewhere else. Zero on the road and through the whole approach, so on
    // the overwhelming majority of frames this is a translate by nothing.
    const lift = hauler.carOffsetY();
    ctx.save();
    ctx.translate(0, lift);
    player.render(ctx, alpha, road.headingAt(camY));
    ctx.restore();
    // The link's dish, on the car and aimed at the node it is draining, with
    // the link drawn between the two (game/wallet.js). AFTER the car, so the
    // dish reads as bolted to it rather than buried under it — and only in the
    // branch where there IS a car, since a dish on a wreck would be the HUD
    // reporting on a link that died with it. Draws nothing unless a hold is
    // actually running, and shares the car's interpolated x so the two never
    // drift apart between logic steps.
    //
    // NOT while the car is off the road: a siphon link is a dish on the car
    // aimed at a node on the city floor, and the geometry stops meaning
    // anything the moment the car is hanging under a drone thirty metres above
    // it. `lift` is exactly the "is the car still on the tarmac" test, and it
    // is already computed above.
    if (floorNodes && lift === 0) {
      renderUplink(ctx, scenery.clock, wallet.linkGeometry(floorNodes, player, player.renderX(alpha)));
    }
  }

  // THE AIR, over the bullets and over the player's own car. traffic.render
  // above drew only what is ON the road; this is the second half of that split,
  // and the gap between the two calls — bullets, then the player — is the whole
  // altitude cue. A tracer drawn OVER a gunship reads as a hit that did not
  // register; drawn under it, the same tracer reads as passing beneath it,
  // which is what is actually happening. See Traffic.render's own note.
  //
  // OUTSIDE the lift block above, unlike the player's car: an encounter in the
  // sky has nothing to do with whether the player is currently being carried
  // off to the shop, and a gunship that vanished for the duration of a lift
  // would be the frame going wrong rather than the fiction.
  traffic.renderAir(ctx, camY, player.y, W, H, alpha, lock);

  // THE CARGO DRONE, last of everything in the world block — above the car,
  // which is what the CLAW LIFTER's open middle is designed to survive
  // (bossshapes.js), and inside the block so it rides the same frozen scene the
  // car does. Draws nothing at all while idle, which is every frame outside an
  // interlude.
  hauler.render(ctx);
  ctx.restore();

  // Phase 7f's rescan glitch: a full-screen tear over the just-composited
  // world (road, traffic, the player's own car), UNDER the HUD — the deck's
  // video feed hiccups, its chrome doesn't, the same world/chrome split every
  // transition in this file draws on. Costs one comparison and returns when no
  // crossing is currently live — see sectors.js's own renderGlitch header.
  //
  // STILL CANVAS2D, DELIBERATELY, now that the two connection sequences are
  // not. A sector crossing is an event in the WORLD — the deck retuning to a
  // different part of the city — not a change in the connection itself, and
  // moving it into the feed pass would say the opposite. It draws before the
  // pass runs, so during a boot or a death (which can overlap: the crossing
  // fires on distance, the sequences on player state) its torn bands are
  // content the feed pass then resolves or drops like any other pixels, which
  // is the right nesting of the two fictions rather than two glitches arguing.
  sectors.renderGlitch(ctx, canvas, W, H);

  // PHASE 8'S START GAME BOOT NO LONGER DRAWS ANYTHING HERE. game/jackin.js
  // used to own a raster sweep, a band-tear loop and a whole-scene chromatic
  // split on this canvas, all of them drawImage()s of the frame back onto
  // itself; 15e-i moved every one of them into the present pass, which does the
  // same job per-pixel and does it to a frame this function has finished with.
  // What is left of the boot is a beat table (jackin.js) and a readout on
  // `hudCtx` (below). The world/chrome split sectors.renderGlitch above still
  // draws on is unchanged and still 2D — a sector crossing is an event in the
  // world, not a change in the connection, and it stays where it is.

  drawHud();
  // ALL THREE OVERLAYS BELOW DRAW ON `hudCtx`, ABOVE THE HUD LAYER ITSELF —
  // re-derived for Phase 15c's split rather than carried over from the old
  // single-canvas order. The original reason ("a cut the HUD shows straight
  // through is not covered") used to hold by DRAW ORDER: these three ran
  // after drawHud() on the one shared canvas. That ordering trick stops
  // working once the HUD is a separate layer painted on top — a readout drawn
  // on `ctx` (the world canvas, underneath) could never cover something on
  // `hudCtx` however it is sequenced, so guaranteeing the cover now means
  // being ON `hudCtx`, last. The trade is that these three lose bloom's halo;
  // they keep glowText's own shadowBlur regardless of which canvas they're
  // on, so none of them go dark — see drawHud()'s own header.
  if (state === "dying") disconnect.renderOverlay(hudCtx, W, H);
  // The readout reports on the feed, so it must not tear along with it — see
  // the block comment above for why "above the HUD" is now a canvas choice.
  if (state === "connecting") jackin.renderOverlay(hudCtx, W, H);
  // The hand-over flash at each end of the shopping interlude. Its full-
  // screen white rect is the one of the three where "must cover the HUD" was
  // never a close call — a flash meant to cover a cut that left a corner of
  // the HUD showing through would read as a bug, not a lighter touch. Returns
  // immediately when idle or mid-sequence — see hauler.js's renderOverlay.
  hauler.renderOverlay(hudCtx, W, H);
}

// THE PRESENT STEP (engine/present.js): the finished 2D frame uploaded as a
// texture, run through the chain, and blitted out through the WebGL2 canvas in
// front of it. Two calls now rather than one — see describeFeed() below for the
// rule that replaced Phase 15's original "no game module knows the GPU path
// exists", which 15e-i had to break and which is still true of everything under
// src/game/. present() returns immediately while
// `state === "gpulost"` (present.js's own `live` flag is what makes this a
// no-op, not a branch here) — the drawing buffer simply is not touched for as
// long as the outage lasts, which is fine, because the #gl-notice overlay
// (present.js's showNotice) is covering it for exactly as long.
//
// WRAPPED AROUND render() RATHER THAN WRITTEN AT ITS TAIL, and that is not
// tidiness. render() returns early on the two full-screen states that cover the
// world outright — the menu (and pause, and gameover) and the shop — so a
// present written at the bottom of the function would be skipped on exactly the
// screens where nothing else is moving either. The result is not a stale frame
// but a BLACK one: the GL drawing buffer is cleared after every composite, so a
// frame that does not redraw it shows nothing at all. Here there is no branch it
// can fall out of.
// DESCRIBE THE FEED, then present. This is the ONE place in the codebase that
// knows a shader is being driven by a game sequence, and it is here for the
// reason every other cross-module wiring decision in this file is: main.js
// already owns both sequence instances and already owns the state machine that
// says which of them is running, so nothing has to be invented to answer the
// question. game/jackin.js and game/disconnect.js import nothing from the
// engine's GL side and never will — see engine/present.js's `feed` for the full
// rule, which replaced Phase 15's original "no module under src/game/ knows the
// GPU path exists".
//
// EXACTLY ONE OF THE TWO CAN BE RUNNING, because "connecting" and "dying" are
// different states (see `state` above), so there is no combining to do here —
// the first one that reports work wins and the other is not asked. 15e-iv adds
// a hull-driven source on the same fields, and THAT one does combine; when it
// lands, this is where the max is taken.
//
// `level` 0 IS THE COMMON CASE AND MEANS THE PASS IS NOT RUN AT ALL — not run
// with zeroed uniforms. Every frame outside these two sequences (the road, the
// menu, the shop, the game-over screen, and the held beat after a death) leaves
// present() doing exactly what it did before this phase, byte for byte.
function describeFeed() {
  present.feed.level =
    (state === "connecting" && jackin.feed(present.feed)) ||
    (state === "dying" && disconnect.feed(present.feed))
      ? 1
      : 0;
}

const loop = createLoop(update, (alpha) => {
  render(alpha);
  describeFeed();
  present.present();
});
// GLREADY FALSE MEANS NO WEBGL2 AT ALL — present.js has already shown the
// fatal "WEBGL2 REQUIRED" notice (see the `glReady` comment above), and
// WebGL2 is required to run the game at all now (engine/gl/context.js's
// header), so there is nothing left to do but leave the loop stopped. Every
// object built above it — the menu, the player, the whole per-run state — sits
// unused rather than being built conditionally, since none of it costs
// anything left idle and skipping construction here would be a second "is GL
// up" branch to keep in sync with this one.
if (glReady) loop.start();


