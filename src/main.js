// Cybercruise — bootstrap + game loop.
// Phase 4: a neon player car driving an infinite curving highway through a
// parallax city, sharing the road with other traffic — and shooting at it.

import { createLoop } from "./engine/loop.js";
import { LOGICAL_W, LOGICAL_H, initViewport, applyTransform, snapToDevice } from "./engine/viewport.js";
import { initInput, isDown, consumePress } from "./engine/input.js";
import { initMouse } from "./engine/mouse.js";
import { clear, glowText } from "./engine/neon.js";
import { GREEN, GREEN_BRIGHT, GREEN_PALE, HAZARD, PLAYER, PLAYER_THRUST, SHIELD_FLICKER } from "./engine/palette.js";
import { Player, BOOST_EXPIRING, BOOST_FLICKER_RATE } from "./game/player.js";
import { Projectiles } from "./game/projectiles.js";
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
import { Loadout, muzzleOffsets, shotLock, lockTurnRate } from "./game/weapons.js";
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
import * as events from "./game/events.js";
import * as gameConsole from "./engine/console.js";
import * as gutter from "./engine/gutter.js";
import * as telemetry from "./game/telemetry.js";
import { sectorIndex } from "./game/citygrid.js";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

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
const PLAY_HINT = "&larr;/&rarr; or A/D steer &middot; &uarr;/&darr; speed &middot; SPACE fire &middot; TAB weapon &middot; CTRL deploy &middot; E select &middot; ESC pause";
// The shop screen's own bar. The lift and lower sequences either side of it
// leave the bar EMPTY, the way "connecting" and "dying" do — there is nothing
// to press while the car is in the air.
const SHOP_HINT = "&uarr;/&darr; select &middot; SPACE/ENTER buy &middot; ESC undock";

initInput();
initMouse(canvas);

// Top-level game state: the menu owns the screen until START GAME/CONTINUE is
// picked, then main's own update/render (unchanged below) take over. "menu"
// only ever happens once, before the very first game; ESC toggles "playing"
// to "paused" and back for the rest of the session — same menu.js screen
// both times, see its header for how it tells the two apart.
//
// "connecting" is the run of the game/jackin.js boot sequence, and it is
// "dying"'s exact mirror in every respect: the world is fully built and drawn
// every frame, but frozen — nothing under "playing" runs — while the raster
// boot resolves over the top of it. EVERY run starts here: START GAME enters
// it from "menu", RESTART enters it from "gameover" (right after newGame()
// rebuilds the world it is about to reveal). Only the AUDIO half of the
// jack-in stays once-per-page — see the two call sites below.
//
// "dying" is the run of the game/disconnect.js death sequence (see the check
// at the bottom of the "playing" branch below): the world is frozen — nothing
// under "playing" runs — but still drawn, under the glitching car, for the
// beat the sequence takes. "gameover" is menu.js's screen a third time, once
// that beat is over; confirming its RESTART row calls newGame() and drops
// straight back into "playing", the same way CONTINUE drops out of "paused".
// "lifting", "shopping" and "lowering" are the shopping interlude, and the
// first and third are "connecting" and "dying" all over again: the world is
// fully built and drawn every frame but frozen — nothing under "playing" runs —
// while game/hauler.js's cargo drone carries the car off the road and, later,
// brings it back. "shopping" is the screen between them (game/shop.js), which
// covers the world entirely the way "paused" does.
//
// THE APPROACH IS NOT A STATE. The drone's arrival happens under "playing"
// with the world still live, on purpose — see hauler.js's phase list. Only the
// grab itself freezes anything.
const menu = createMenu();
let state = "menu"; // "menu" | "connecting" | "playing" | "paused" | "dying" | "gameover"
                    //   | "lifting" | "shopping" | "lowering"

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

// Phase 8 step 5, PROBLEM 1: the AudioContext has to exist before the menu's
// own SOUND/MUSIC sliders can preview anything (menu_adjust), which happens
// well before START GAME is ever confirmed — so this builds the bus graph on
// the very FIRST keydown of any kind, anywhere, rather than waiting for that
// confirm (see synth.js's own startContext() header for the full reasoning).
// `{ once: true }` removes this listener after it fires, so a page loaded
// and left untouched never creates a context (nothing ever calls this), and
// a second keypress simply finds nothing left registered — belt and braces
// alongside context.js's own start(), which is independently idempotent
// (`if (ctx) return`) regardless. music.jackIn() (below, on START GAME's own
// confirm) is the separate, still-once-only call that starts the music
// SCHEDULER — see its own comment for why the two stay split.
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
// localStorage-backed bank (loadBanked/saveBanked, and the whole "banked
// survives into the next run" half of test/economy.test.js), and this one null
// is what holds it switched off: the Wallet's `store` is injectable, a null
// store reads as "no storage", and everything downstream of that already
// behaves correctly with a bank that is always 0 (see wallet.js's storage()
// comment, which was written for the browser-with-storage-disabled case and
// covers this one unchanged).
//
// WHY OFF. A bank in localStorage is a bank on ONE BROWSER ON ONE MACHINE,
// with nothing tying it to a player. Until the game has accounts and keeps
// records per player (README's Phase 13, the online server), a persisted
// balance is not progress the player owns — it is progress they lose by
// switching device or clearing site data, and that nobody can carry anywhere.
// Money that lives and dies with a single run makes an honest promise instead:
// what you earn this run is what the shop has to spend this run.
//
// TURNING IT BACK ON is this line, once player records exist: pass a real
// store — localStorage, or whatever the server hands back for a signed-in
// player. Nothing else in main.js or wallet.js has to change, which is exactly
// why the switch is here at the injection seam rather than carved through the
// money code.
const CREDIT_STORE = null;

// The shopping interlude's two halves, owned exactly the way `disconnect` and
// `jackin` above are: one instance each, reset() from newGame(), never rebuilt.
// The hauler needs the canvas height to know how far off the top of the frame
// it has to carry the car; the shop screen holds only its cursor and the
// receipts for the visit in progress, both of which SHOULD outlive a single
// dock and are cleared per run by its own reset() from newGame().
const hauler = new Hauler(H);
const shop = createShop();

// WHAT A STAGED EVENT IS ALLOWED TO HAND OFF TO. game/events.js schedules every
// staged moment on the road, but most of them are cars and hazards it puts down
// itself; a `handoff` is the other kind — an encounter whose body is a sequence
// some other module already owns. The director names a HANDLER, never a module,
// so it never learns that a cargo drone exists: the wiring lives here, the same
// way every other cross-system connection in this file does (the sector gong
// below, traffic's onDestroyed, the hostile fireShot/dropMine hooks).
//
// `fire` starts it; `live` is how the director knows the encounter is still
// running, which is what holds every other event off for the whole of a shop
// visit rather than just the tick it began. Between them they are the entire
// interface — hauler.js's phases, its frozen lift and its timeline stay its own.
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
  // through here, and the stutter (and the music's own disturb() below) should
  // read louder for whichever one actually cost more of it.
  const intensity = Math.min(1, hp / player.maxHealth);
  music.play("player_hit", { intensity });
  // The MUSIC's own transient seam (synth.js's disturb(), forwarded to
  // whichever backend is currently playing) — a SEPARATE call, deliberately
  // not folded into player_hit's own envelope: hull_hiss
  // (audio/sustainedfx.js, driven from the update loop below) is the
  // PERSISTENT degradation layer; this is the momentary shudder on the hit
  // itself. Running both at full strength on the same event would say the
  // same thing twice — see proceduralmusic.js's own disturb() header (and
  // trackmusic.js's, for the same effect applied to a recorded track).
  music.disturb(intensity);
}

// Phase 8 step 3's audio hook onto pickups.js's ONE place a crate is ever
// actually applied — see Pickups' own constructor comment.
function onPickupCollected(type) {
  music.play(PICKUP_SOUND[type.kind]);
}

// Phase 8 step 4's audio hook onto engine/console.js's subscriber seam
// (onPush) — registered below, in newGame(), rather than here at module
// scope. Every OTHER audio hook in this file (onCarDestroyed,
// onPlayerDamage, onPickupCollected above) is handed to a per-run object's
// constructor and never needs re-wiring; this one is different because
// console.js's own reset() deliberately clears its subscriber (see that
// function's own comment on why), so newGame() has to re-register it every
// time, the same way it re-registers everything else PER-RUN below. See
// console.js's own onPush() header for why the wiring lives here at all
// rather than inside console.js.
// Two listeners off one seam, fanned out HERE rather than by growing
// console.js's `subscriber` into a list. The seam has had exactly one consumer
// for its whole life and the second one is in this same file — a subscriber
// array would be more machinery than the two lines it saves, and it would move
// the question of "what listens to the log" out of the one file that already
// answers every other wiring question in this game.
//
// The gutter gets the line VERBATIM apart from telemetry.js's own prefix: it is
// the same log, shown somewhere with room for it, not a second commentary. What
// makes it a bigger log rather than a duplicate one is that the in-canvas panel
// stops drawing most of it while the gutter is up (see setDivert above).
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

// The deck reporting its own audio feed — synth.js's own onTrackChange
// facade, forwarding trackmusic.js's subscriber seam (see that file's
// header). Registered ONCE, below, right after `music` exists, unlike
// onConsolePush just above: there is no per-run reset to survive here
// (trackmusic.js's subscriber isn't touched by newGame() or
// gameConsole.reset()), and the track backend itself only ever starts once
// per page life (synth.js's jackIn() header) — one subscription made now
// covers the first track and every later handoff for the rest of the
// session. Composing the actual SYS LOG line is main.js's job, not
// trackmusic.js's or synth.js's, for the same reason CONSOLE_SOUND above
// lives here rather than in console.js: the fiction (matching links.js's
// own "//"-joined register) belongs with the module that already owns every
// other console line's wording, not buried in the audio layer.
//
// Never fires before a run is underway: trackmusic.js only ever invokes its
// subscriber from playIndex(), which nothing reaches before jackIn() commits
// to the track backend (see trackmusic.js's own comment on that call site) —
// so there's no way for this to write into a SYS LOG the player isn't even
// looking at yet.
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

// Scratch for the per-shot options projectiles.js's spawn() takes — what this
// round designates, and what it chases. REUSED rather than built per shot, for
// the same reason the array above is: the trigger is pulled several times a
// second forever, and spawn() reads and copies every field immediately without
// keeping the object (see its own note saying so).
const SHOT_OPTS = { lockOn: 0, target: null, turnRate: 0 };

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
  shots.onLock = (car, seconds) => lock.acquire(car, seconds);
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
}

function newGame() {
  distance = 0;
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
  // sustained voices (hull_hiss/shield_drone/wall_scrape), a sector-transition
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

// A mine is laid immediately behind `car`. Returns whether the road had room —
// see obstacles.js's drop(), which owns the placement and the budget.
function dropMine(car, type) {
  const placed = obstacles.drop(type, car);
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
// FOUR TIMES A SECOND, NOT SIXTY. The panel is DOM, and the one rule the whole
// gutter design rests on is that it never repaints on the game's clock — a
// per-frame write of nine values would put a steady text repaint next to the
// canvas forever, to show numbers nobody can read changing faster than 4Hz
// anyway. Fast enough that the panel never looks frozen, slow enough that it is
// not in the frame budget at all. gutter.setStatus() then diffs on top of this,
// so the sample rate is the CEILING on DOM writes, not the actual rate: a parked
// car in the menu resamples four times a second and writes nothing.
const RIG_SAMPLE = 0.25;
let rigDue = 0;

// A free-running clock in seconds, advanced every tick whatever the state is.
// The HUD's own idle animations hang off it — anything that has to breathe
// without a game-side phase of its own to read (the SHIELD CHARGED tell in
// drawHud, which by definition has no running timer behind it).
let hudClock = 0;

// What the deck knows about itself this instant, in the shape game/telemetry.js
// wants. Assembled here because main.js is the only module that holds all of it
// — the player, the wallet, the score, the odometer and the state machine live
// at this level and nowhere below it.
//
// `link` is the state machine's own vocabulary, translated. Reporting the raw
// state name would leak an implementation detail into the fiction, and half of
// them ("lifting", "lowering") describe a crane rather than a connection.
const LINK_STATE = {
  menu: "STANDBY",
  connecting: "HANDSHAKE",
  playing: "ACTIVE",
  paused: "HELD",
  dying: "SIGNAL LOST",
  gameover: "OFFLINE",
  lifting: "DOCKING",
  shopping: "DOCKED",
  lowering: "UNDOCKING",
};

// Which VOICE the deck talks in, which is a coarser question than which state
// the game is in — nine states, three voices.
//
// The distinction the map exists to draw is "is the world actually running":
// telemetry.js's routine pool is all road strips, lot lookups and nav vectors,
// and printing those over a menu or a wreck describes something that is not
// happening. "connecting" is idle rather than live on the same principle — the
// world is built but frozen, and jackin.js's own scripted boot beats should own
// the log for that stretch rather than compete with filler about traffic.
const DECK_MODE = {
  menu: "idle",
  connecting: "idle",
  playing: "live",
  paused: "idle",
  dying: "down",
  gameover: "down",
  lifting: "idle",
  shopping: "idle",
  lowering: "idle",
};

// Bytes to a human string, for the BUFFER readout.
//
// performance.memory is CHROME-ONLY and non-standard, so this is written to
// degrade rather than to be relied on: no reading means the row prints "n/a" and
// the log's buffer line quietly says the same. Worth having anyway — the browser
// this is developed and played in is the one that reports it, and a heap figure
// climbing across a long run is the one leak signal this game could plausibly
// produce (the sprite cache and the road strips both grow with `scale`).
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

  return {
    mode: DECK_MODE[state] ?? "idle",
    link: LINK_STATE[state] ?? "STANDBY",
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
    default: return updatePlaying(dt);
  }
}

function updateMenu() {

  const menuResult = menu.update(W);
  // Phase 8 step 5's menu SFX — see audio/menusfx.js's own header for why
  // this table, not menu.js itself, decides which id each gesture plays.
  // "confirm" is handled separately below: START GAME gets jack_in
  // instead of the plain menu_confirm tone (see music.jackIn()'s own
  // comment for why the two never both fire for the same confirm).
  if (menuResult.moved) music.play(MENU_SOUND.move);
  if (menuResult.soundAdjusted || menuResult.toggled) music.play(MENU_SOUND.adjust);
  if (menuResult.confirmed) {
    // Into game/jackin.js's boot sequence, NOT straight into "playing" — see
    // the `state` comment above. The hint bar stays empty for its duration,
    // the same way it does while "dying": there is nothing to steer yet.
    state = "connecting";
    hint.innerHTML = "";
    // THE START GAME transition. The keypress that just confirmed this
    // row is also the user gesture AudioContext creation needs — see
    // synth.js's header — though in practice the context has usually
    // already been built by the FIRST keypress of the session (see the
    // startContext() listener above), START GAME just being the common
    // case where that happens to be the very same press. jackIn() plays
    // the descending riser and starts the music scheduler timed to land
    // its first downbeat right as the riser ends — see its own comment.
    // ONCE PER PAGE, unlike the visual sequence on the line below, which
    // RESTART runs again (see the "gameover" branch).
    music.jackIn();
    jackin.trigger(player.x, player.y, player.w, player.h);
  }
  // The MUSIC/SOUND rows can only have moved on the update() call just above.
  syncVolumes();
}

function updatePaused() {

  // ESC again resumes directly, without going through CONTINUE — the same
  // key that opened the pause screen closes it. A fresh consumePress each
  // time, so this never fires on the very keypress that just opened pause.
  if (consumePress("pause")) {
    state = "playing";
    hint.innerHTML = PLAY_HINT;
    // Backing out of the menu WITHOUT confirming a row — the one place
    // menu_back plays; see audio/menusfx.js's own header.
    music.play(MENU_SOUND.back);
    return;
  }
  const menuResult = menu.update(W);
  if (menuResult.moved) music.play(MENU_SOUND.move);
  if (menuResult.soundAdjusted || menuResult.toggled) music.play(MENU_SOUND.adjust);
  if (menuResult.confirmed) {
    state = "playing";
    hint.innerHTML = PLAY_HINT;
    // CONTINUE resumes a run whose music has been playing the whole
    // time it was paused (the scheduler never stops — see proceduralmusic.js's own
    // header) — a plain confirm tone, not jack_in, which is reserved for
    // the one moment the scheduler itself actually starts.
    music.play(MENU_SOUND.confirm);
  }
  syncVolumes();
}

function updateConnecting(dt) {

  // "dying" in reverse, and frozen for the same reason: the world is built
  // and drawn (render() runs its whole world path below) but nothing under
  // "playing" advances it, so the road, the traffic and the player's car all
  // sit exactly where newGame() put them until the feed is up.
  jackin.update(dt);
  // The SYS LOG's own animation, though — the boot lines jackin.update()
  // just pushed have to slide and fade like any other line, so this ONE
  // system keeps ticking while everything else is held. It is presentation,
  // not world state (engine/console.js).
  gameConsole.update(dt);
  // Drained every tick for exactly the reason the "dying" branch drains
  // "fire": input.js holds an edge until something consumes it, so an ESC
  // pressed during the boot would otherwise sit in `fresh` and open the
  // pause menu on the first real gameplay tick, a screen the player never
  // asked for. Nothing is steerable yet, so nothing else is read.
  consumePress("pause");
  if (jackin.done) {
    state = "playing";
    hint.innerHTML = PLAY_HINT;
  }
}

function updateDying(dt) {

  // The world is frozen — nothing below this branch runs, so the road,
  // traffic and the player's own last position all just sit exactly where
  // they were the instant the hull hit zero (render() still draws them
  // every frame; it's only update() that has stopped moving them). Only the
  // death sequence itself advances.
  disconnect.update(dt);
  // Drained every tick, not just the one the sequence ends on: "fire" is
  // held down (isDown, see the weapon check under "playing") rather than
  // edge-consumed while shooting, so a press mid-sequence — the player
  // still mashing fire as the car glitches out — would otherwise sit in
  // input.js's `fresh` set until "gameover" opens below and consumePress
  // reads it as THAT screen's confirm, instantly firing RESTART before the
  // player has even seen it. Input is already ignored while "dying" (see
  // the branch's own header comment); this just makes "fire" ignored too,
  // instead of silently queuing itself for the next screen.
  consumePress("fire");
  if (disconnect.done) {
    state = "gameover";
    menu.open("gameover");
    hint.innerHTML = MENU_HINT;
  }
}

function updateGameOver() {

  // Same screen, same interaction as "paused" above — RESTART is row 0's
  // label here (menu.js's ROW0_LABEL) the way CONTINUE is there — except
  // confirming it starts a fresh run instead of resuming a frozen one.
  const menuResult = menu.update(W);
  if (menuResult.moved) music.play(MENU_SOUND.move);
  if (menuResult.soundAdjusted || menuResult.toggled) music.play(MENU_SOUND.adjust);
  if (menuResult.confirmed) {
    newGame();
    // RESTART jacks in again, exactly like START GAME did — a run always
    // begins with the rig coming up, and the game-over screen the player is
    // confirming from has just told them the deck is REACQUIRING SIGNAL
    // (game/disconnect.js's own readout), so cutting straight to a moving
    // road would leave that sentence unanswered. newGame() FIRST: it resets
    // this sequence and clears the SYS LOG, so the boot lines pushed from
    // here on belong to the new run rather than being wiped by it.
    state = "connecting";
    hint.innerHTML = "";
    jackin.trigger(player.x, player.y, player.w, player.h);
    // RESTART — same plain confirm tone as CONTINUE (see its own comment
    // above): the scheduler is already running, this is just resuming the
    // GAME, not the deck jacking in a second time. So the boot above plays
    // over music that never stopped, with no riser of its own — the riser
    // and the backend start are once-per-page (synth.js's jackIn()).
    music.play(MENU_SOUND.confirm);
  }
  syncVolumes();
}

// THE FROZEN HALVES of the shopping interlude, and they are updateConnecting()
// almost line for line — same freeze, same reasons, same two exceptions. The
// world is built and drawn (render() runs its whole world path) but nothing
// under "playing" advances it, so the road, the traffic and the car all sit
// where they were while the drone does its work over the top.
//
// `player.x` is handed to hauler.update() so the drone keeps tracking the lane
// the car is in — the car is not moving any more, so this is really just the
// smoothing finishing its converge on a value that has stopped changing (see
// hauler.js's update()).
function updateLifting(dt) {
  hauler.update(dt, player.x);
  // The SYS LOG's own animation, the one system that keeps ticking through a
  // freeze because it is presentation rather than world state — updateConnecting
  // and updateDying make the same exception for the same reason.
  gameConsole.update(dt);
  // Drained every tick, exactly as the boot and death sequences drain theirs:
  // input.js holds an edge until something consumes it, so a key pressed while
  // the car is in the air would otherwise sit in `fresh` and be read as the
  // shop screen's own undock the instant it opened — skipping a screen the
  // player never saw. Nothing is steerable here, so nothing else is read.
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
  // sustainedfx.js's own header on why this is POLLED (not pushed from a
  // damage/pickup event): the hiss has to fall when healing too, and the
  // shield/wall voices just mirror whatever player state already says right
  // now. After sectors.update() above, so sectors.glitching() reflects THIS
  // tick's own crossing rather than last tick's leftover decay.
  music.updateHullHiss(dt, player.health / player.maxHealth, sectors.glitching());
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
    // ONE PULL, ONE OR MORE ROUNDS. muzzleOffsets is the whole of what the TWIN
    // CANNON and TWIN RACK specials do at the trigger (weapons.js): a stock car
    // gets back a single [0] and this loop runs once, exactly as the single
    // spawn call here always did.
    //
    // THE ROUNDS SHARE THE COOLDOWN AND THE ROUND, deliberately: tryFire above
    // has already been called once, so a paired weapon fires twice as much
    // metal for the same rate of fire and the same ammunition. That IS the
    // upgrade — pairing a weapon that then burned two rounds a press would be
    // selling the player nothing but a louder magazine.
    const muzzles = muzzleOffsets(weapon.type, player.specials);
    // AUTOLOCK, both halves of it: what this round will designate if it
    // connects, and what it should chase if something is designated already.
    // Both are 0/null for every weapon the player has not bought it for, which
    // is the case that costs projectiles.js nothing.
    //
    // The lock is read HERE, at the muzzle, rather than looked up mid-flight —
    // so a round chases the car that was designated when it was FIRED. A burst
    // whose rounds re-checked in the air would swing mid-flight the moment the
    // player designated something else, which is not what "the rest of the
    // burst follows" means to anyone watching it.
    SHOT_OPTS.lockOn = shotLock(weapon.type, player.specials);
    SHOT_OPTS.target = SHOT_OPTS.lockOn > 0 ? lock.car : null;
    SHOT_OPTS.turnRate = lockTurnRate(weapon.type, player.specials);
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

  // E cycles the DEPLOYABLES — the layers, on their own cursor, so picking a
  // different thing to drop never disturbs which gun is in hand (weapons.js's
  // Loadout). Edge-triggered like TAB, and a no-op while the mine is the only
  // layer carried.
  if (consumePress("deploy")) {
    loadout.nextDeployable();
    music.play("weapon_swap");
  }

  // CTRL lays whichever deployable is selected, independent of whichever gun
  // is currently selected — no more tabbing onto the mine layer to drop one
  // and back to a gun afterwards. Mirrors armament.js's own layMine: the drop
  // is attempted BEFORE the round is spent, so a mine the road had no room for
  // (obstacles.js's MAX_LAID) costs the player nothing.
  const deployable = loadout.deployable;
  if (deployable && isDown("mine") && deployable.ready) {
    const centerX = road.centerXAt(distance, W);
    // The player, expressed as a body in road coordinates, is exactly what
    // obstacles.js's drop() wants — worldY/offset/h, the same shape a car
    // satisfies without an adapter.
    const body = { worldY: distance, offset: player.x - centerX, h: player.h };
    if (obstacles.drop(obstacleTypeById(deployable.type.payload), body)) {
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
    disconnect.trigger(player.x, player.y, player.w, player.h);
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


function drawHud() {
  glowText(ctx, "CYBERCRUISE", 12, 12, GREEN, 18, "left", 12);

  // Score gets the biggest readout on screen — it's the thing being played for.
  // A small "SCORE" header (same device HULL uses over the health bar, below)
  // names the number, and the number itself is bold on top of its own glow so
  // it still reads as the HUD's centrepiece next to DIST/SPD's plain instrument
  // readouts.
  glowText(ctx, "SCORE", W - 12, 8, GREEN_PALE, 11, "right", 6);
  glowText(ctx, `${score.points}`, W - 12, 20, GREEN_BRIGHT, 22, "right", 14, true);

  // The last kill's award, fading out under the total, so the player can see
  // WHY the number jumped — red for a fine, green for a bounty. Presentation
  // only: the total above has already banked it.
  const alpha = score.awardAlpha;
  if (alpha > 0) {
    const award = score.lastAward;
    const text = `${award >= 0 ? "+" : ""}${award}`;
    ctx.save();
    ctx.globalAlpha = alpha;
    glowText(ctx, text, W - 12, 48, award >= 0 ? GREEN_BRIGHT : HAZARD, 16, "right", 10);
    ctx.restore();
  }

  // Shown in DIST_UNITS, not raw world units — see road.js. The same scale the
  // catalogues' `minDistance` gates are written in, so a player who sees DIST 100
  // is seeing exactly the moment the enemy is allowed on the road.
  glowText(ctx, `DIST ${Math.floor(distance / road.DIST_UNITS)}`, W - 12, 70, GREEN_PALE, 13, "right");
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
    ctx,
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
  glowText(ctx, `CR ${wallet.credits}`, W - 12, 106, GREEN_PALE, 13, "right");

  // The last payout, fading under the total, same device the score's own
  // award uses above — and deliberately on its own line rather than sharing
  // the score's, since one kill can flash BOTH (points and credits) and two
  // numbers landing on top of each other would be unreadable. A fine shows
  // what was actually taken, which is not always what the car was worth (see
  // Wallet.award: a fine can only empty the run, never overdraw it).
  const credAlpha = wallet.awardAlpha;
  if (credAlpha > 0 && wallet.lastAward !== 0) {
    const cr = wallet.lastAward;
    ctx.save();
    ctx.globalAlpha = credAlpha;
    glowText(ctx, `${cr >= 0 ? "+" : ""}${cr}CR`, W - 12, 124, cr >= 0 ? GREEN_BRIGHT : HAZARD, 13, "right", 8);
    ctx.restore();
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
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(bx - 8, wy - 10, bw + 18, by + bh + 6 + 16 - (wy - 10));
  ctx.restore();

  for (const w of weaponRows) {
    const current = w === weapon;
    glowText(
      ctx,
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

  glowText(ctx, "HULL", bx, by - 16, GREEN_PALE, 12, "left", 6);

  // SHIELD, only while active — same "about to lose it" flicker the halo
  // around the car gives in its last second (player.js's renderShield),
  // read off the same clock so the HUD and the car agree on when that is.
  if (player.shieldTime > 0) {
    const expiring = player.shieldTime < 1 && Math.sin(player.shieldPhase * 26) > 0;
    glowText(
      ctx, `SHIELD ${player.shieldTime.toFixed(1)}s`, bx + bw, by - 16,
      expiring ? SHIELD_FLICKER : PLAYER, 12, "right", 8,
    );
  } else if (player.shieldCharge > 0) {
    // ...and, in the same slot, the ARMED state: a shield crate no longer
    // starts a clock (player.js's chargeShield), so without a tell here the
    // player would have no way to know they are carrying one. Breathes
    // instead of counting down — there is nothing running to count — at the
    // shield halo's own pulse rate so the HUD reads as the same system.
    // The banked figure is now printed too, not just implied: chargeShield
    // stacks (player.js), so a player who has driven over two or three crates
    // needs to see that the bank actually grew, not just that something is
    // armed.
    const breath = (Math.sin(hudClock * 4.2) + 1) / 2; // player.js's SHIELD_PULSE_RATE
    ctx.save();
    ctx.globalAlpha = 0.55 + 0.45 * breath;
    glowText(ctx, `SHIELD CHARGED ${player.shieldCharge.toFixed(1)}s`, bx + bw, by - 16, PLAYER, 12, "right", 8);
    ctx.restore();
  }

  // Empty track.
  ctx.save();
  ctx.strokeStyle = "rgba(120,255,180,0.4)";
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.restore();
  // Filled portion.
  if (frac > 0) {
    ctx.save();
    const c = `hsl(${hue}, 100%, 55%)`;
    ctx.fillStyle = c;
    ctx.shadowColor = c;
    ctx.shadowBlur = 10;
    ctx.fillRect(bx + 1, by + 1, (bw - 2) * frac, bh - 2);
    ctx.restore();
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
      ctx, `${deployable.type.label} ${deployable.ammoText}`,
      bx, by + bh + 6, GREEN_PALE, 13, "left", 8,
    );
  }

  gameConsole.render(ctx, W, H);
}

function render(alpha) {
  // Reinstalled every frame, not once at startup: any assignment to
  // canvas.width/height (which a resize does) resets the context state
  // wholesale, transform included.
  applyTransform(ctx);
  clear(ctx);

  // "gameover" reuses the exact same full-screen menu as "menu"/"paused" (see
  // menu.js's header) — the frozen wreck behind it from "dying" is gone the
  // instant the screen takes over, the same way "paused" already covers the
  // world rather than showing it through the menu.
  if (state === "menu" || state === "paused" || state === "gameover") {
    menu.render(ctx, W, H);
    // menu.js never touches the world (see its header) — the final score is
    // world state, so it's main.js's job to draw it, not menu.open()'s to
    // have been handed it. Placed above the RESTART row rather than fighting
    // menu.js's own layout for space inside it.
    if (state === "gameover") {
      glowText(ctx, `FINAL SCORE ${score.points}`, W / 2, 350, GREEN_BRIGHT, 18, "center", 10);
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
      glowText(ctx, `CREDITS EARNED ${wallet.lastRunEarnings}`, W / 2, 376, GREEN_PALE, 13, "center", 8);
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
    shop.render(ctx, W, H, wallet, events.milestoneCount("shop"), garage, player, loadout);
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

  // While "dying", game/disconnect.js's shake() desyncs the WHOLE scene by a
  // screen-space offset — a feed losing sync, not a physical jolt (see its
  // header) — so everything from the floor grid to the glitching car itself
  // is drawn inside this translate, and only this translate. drawHud() and
  // disconnect's own CONNECTION LOST readout come after ctx.restore() below,
  // deliberately outside it, so the two things reporting the desync don't
  // themselves desync.
  ctx.save();
  if (state === "dying") {
    const [sx, sy] = disconnect.shake();
    ctx.translate(sx, sy);
  }

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
  traffic.render(ctx, camY, player.y, W, H, alpha, lock);
  // Bullets over the traffic they're flying at, under the player's own car.
  // Hostile rounds draw with them and in the enemy's own red (weapons.js), so
  // which way a tracer is going is never a question the player has to work out.
  shots.render(ctx, camY, player.y, W, H);
  enemyShots.render(ctx, camY, player.y, W, H);
  // The player sits at worldY === distance, so that is where its heading comes
  // from — it leans into a bend along with the traffic around it. Read at camY,
  // like everything else drawn this frame, so the car's lean matches the bend of
  // the road actually on screen. While "dying", the disconnect sequence draws
  // in the player's place instead — see game/disconnect.js's render().
  if (state === "dying") disconnect.render(ctx, W, H);
  else if (state === "connecting" && !jackin.carSolid) jackin.renderCar(ctx);
  else {
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

  // THE DRONE, last of everything in the world block — above the car, which is
  // what the CLAW LIFTER's open middle is designed to survive (bossshapes.js),
  // and inside the block so it rides the same frozen scene the car does. Draws
  // nothing at all while idle, which is every frame outside an interlude.
  hauler.render(ctx);
  ctx.restore();

  // Phase 7f's rescan glitch: a full-screen tear over the just-composited
  // world (road, traffic, the player's own car), UNDER the HUD — the deck's
  // video feed hiccups, its chrome doesn't, the same split "dying"'s shake
  // above already draws on (world inside the translate, HUD outside it).
  // Costs one comparison and returns when no crossing is currently live —
  // see sectors.js's own renderGlitch header.
  sectors.renderGlitch(ctx, canvas, W, H);

  // Phase 8's START GAME boot (game/jackin.js): the raster sweep, the tearing
  // and the chromatic split, over the just-composited world and the car
  // assembling inside it, UNDER the HUD — the same world/chrome split
  // sectors.renderGlitch above and "dying"'s shake already draw on. Takes the
  // canvas element as well as the context because, like the rescan glitch, it
  // draws the frame so far back onto itself.
  if (state === "connecting") jackin.render(ctx, canvas, W, H);

  drawHud();
  if (state === "dying") disconnect.renderOverlay(ctx, W, H);
  // Above the HUD, like disconnect's CONNECTION LOST — the readout reports on
  // the feed, so it must not tear along with it.
  if (state === "connecting") jackin.renderOverlay(ctx, W, H);
  // The hand-over flash at each end of the shopping interlude, above the HUD
  // for the same reason jackin's readout is: it is covering a CUT, and a cut
  // the HUD shows straight through is not covered. Returns immediately when
  // idle or mid-sequence — see hauler.js's renderOverlay.
  hauler.renderOverlay(ctx, W, H);
}

const loop = createLoop(update, render);
loop.start();

