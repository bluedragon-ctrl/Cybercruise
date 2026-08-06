// The weapon catalogue — what the player and the enemy shoot with.
//
// Three things live here, and they are deliberately separate:
//
//   WEAPON_TYPES  pure DATA, exactly like cartypes.js: how hard a shot hits, how
//                 often it can be taken, how fast it flies, what it looks like.
//                 Adding a weapon is adding an entry. This is the PLAYER'S
//                 catalogue — see ENEMY_WEAPON_TYPES below for why the enemy's
//                 hardware is a second list rather than more entries in this one.
//   Weapon        the RUNTIME state of one weapon in one car's hands: its
//                 cooldown and its remaining ammunition. Two cars carrying the
//                 same type each get their own Weapon, and the type is shared.
//                 Carried by the player's Loadout and by every hostile car's
//                 Armament (game/armament.js) alike.
//
// AMMUNITION. The default gun carries `Infinity` rounds — the player is never
// left with no way to shoot at all, which is what makes the special weapons
// (Phase 5) a choice rather than a lifeline. Every other weapon will be finite,
// so the ammo bookkeeping is built in HERE from the start rather than bolted on:
// `tryFire` already spends a round, and an Infinity counter simply never runs
// down (Infinity - 1 === Infinity, so the arithmetic needs no special case —
// only the HUD does, which is why `ammoText` exists).
//
// WHAT THIS FILE DOES NOT DO: it never touches the world. `tryFire` answers one
// question — "may a shot be taken this instant?" — and the caller is what turns
// a yes into a bullet (see projectiles.js, main.js). That split is what lets the
// enemy reuse the same class without inheriting the player's input handling, and
// it is why game/armament.js can model a MINE LAYER as a Weapon too: a rate of
// fire and a magazine is all a mine layer is, and what comes out at the far end
// is the caller's business.

import { PLAYER, PLAYER_THRUST, ENEMY, ENEMY_THRUST, ROCKET, ROCKET_HOT } from "../engine/palette.js";

// HOW A BULLET FLIES. The road curves, so "straight ahead" and "up the lane" are
// two genuinely different shots, and which one a weapon takes is its defining
// trait rather than an engine detail:
//
//   STRAIGHT  the round holds the SCREEN LINE it was fired along and ignores the
//             road entirely. On a straight it is the obvious weapon; into a bend
//             it drifts across the lanes and eventually buries itself in the
//             barrier. What you point at is what you hit — including the wall.
//   TRACKING  the round holds its LATERAL OFFSET from the centre-line, so it
//             follows every curve the road takes and stays in the lane it was
//             fired up. It can shoot round a bend, which no straight shot can,
//             and it can never hit a barrier.
//
// projectiles.js implements both; this constant is the whole difference between
// them at the catalogue level.
export const FLIGHT_STRAIGHT = "straight";
export const FLIGHT_TRACKING = "tracking";

// Fields:
//   id          stable key (save data, pickup tables, debugging)
//   label       HUD caption
//   damage      hull removed by one hit. For scale, the catalogue in cartypes.js
//               runs from the cycle's 25 hull to the rig's 220, and the player
//               has 100
//   interval    seconds between shots — the reciprocal of the fire rate.
//               Doubles as the REST between bursts for a weapon that names
//               burstCount below, rather than the gap between every round
//   burstCount  OPTIONAL. Rounds fired back to back before `interval`'s rest
//               applies — omitted (or 0) means a plain single-shot weapon,
//               every round `interval` apart, exactly as before this field
//               existed
//   burstInterval  seconds between rounds WITHIN a burst. Only read when
//               burstCount is set; a fast number here against a slower
//               `interval` is what makes a burst read as a spray followed by
//               a pause rather than just a faster steady stream
//   muzzleSpeed how fast the shot leaves the car, world units/sec RELATIVE TO
//               THE SHOOTER. A bullet's absolute speed is the shooter's speed
//               plus this, so firing while flat out doesn't leave your own
//               rounds hanging in front of you
//   flight      FLIGHT_STRAIGHT | FLIGHT_TRACKING — see above
//   forwardOnly OPTIONAL, hostile guns only (armament.js's shoot()). When
//               true, the gun never takes the rearward shot at a target
//               behind the shooter — there is no dir -1 for it, only "no
//               shot". Omitted means either direction is fair game, exactly
//               as before this field existed
//   aimSlack    OPTIONAL, hostile guns only (armament.js's shoot(), which
//               calls this the default GUN_AIM_SLACK when omitted). How far
//               off the target's own line this gun will still fire — a
//               bigger number is a more reckless gun, willing to spray at a
//               target it isn't cleanly lined up on rather than only firing
//               on a sure hit
//   ammo        rounds carried. Infinity for the default gun
//   color/glow  bullet body and its trail
//   length/width  the bullet's drawn size AND its hit box, world units
//   render      how projectiles.js draws it. Omitted = "tracer", the batched
//               straight line every weapon above used until now. "dart" is the
//               rocket's own small discrete body — see ROCKET below and
//               projectiles.js's DART_BODY note for why it isn't a tracer.
//   impact      what happens where the round stops. Omitted = "spark", the
//               small cross every weapon above used until now. "fireball"
//               routes the hit through the shared Explosions pool instead — see
//               ROCKET below and effects.js's drawFireballBurst.
//   blastRadius/blastDamage  optional splash: everything else alive within
//               blastRadius of where the round stopped also takes damage,
//               falling off linearly to nothing at the rim — peak at the box
//               edge, not the centre, and NOT applied to whatever the round
//               directly struck (that already took the full `damage` above).
//               The exact formula Traffic.blast() and Obstacles.blast() use
//               for a dying car or a mine, at a third setting rather than a
//               fourth mechanic — see projectiles.js's detonate(). Omitted (or
//               zero) means a hit only ever costs the one thing it struck,
//               which is every weapon here except ROCKET.
export const WEAPON_TYPES = [
  {
    id: "cannon",
    label: "CANNON",
    // Three hits kills the standard hostile (interceptor, 70 hull), one kills a
    // cycle, seven are needed for a rig. Deliberately NOT a one-shot weapon
    // against anything that matters: the default gun is supposed to make the
    // heavier enemy types feel heavy, which is what leaves Phase 5's specials
    // something to be better at.
    damage: 34,
    interval: 0.16, // ~6 shots/sec — fast enough to feel automatic
    muzzleSpeed: 900,
    // The default gun shoots where the car is POINTED, which on a bend is not
    // where the road goes. That limitation is the reason the tracker below is
    // worth carrying, so it must never be softened here.
    flight: FLIGHT_STRAIGHT,
    ammo: Infinity,
    color: PLAYER,
    glow: PLAYER_THRUST,
    length: 14,
    width: 4,
  },
  {
    id: "tracker",
    label: "TRACKER",
    // Hits harder and slower than the cannon, and every round follows the road
    // round the bend. Its value is entirely SITUATIONAL: on a straight it is a
    // worse cannon, and through a long curve it is the only thing that can
    // reach the car ahead at all.
    damage: 45,
    interval: 0.24, // ~4 shots/sec
    muzzleSpeed: 820,
    flight: FLIGHT_TRACKING,
    // FINITE, and there is nowhere to refill it until the Phase 5 pickups land:
    // 60 rounds is roughly fifteen seconds of held trigger. Running dry and
    // dropping back to the cannon is the intended arc for now, not a bug.
    ammo: 60,
    color: PLAYER_THRUST,
    glow: PLAYER,
    length: 16,
    width: 4.5,
  },
  {
    id: "rocket",
    label: "ROCKET",
    // The heaviest hit in the catalogue and the slowest to reload — a rocket is
    // meant to feel like the one round that actually matters, not a faster
    // cannon. Numbers here are a FIRST PASS, same caveat as the blaster's:
    // retune once the upcoming attack content gives it real targets to be
    // measured against, not by dividing hull totals by this figure.
    //
    // One CONCRETE floor for that first pass: a direct hit must one-shot the
    // sedan (60 hull, cartypes.js) with room to spare, not just tie it exactly
    // — a bare tie is one falling-off-by-a-fraction bug away from the rocket
    // quietly stopping being a one-shot weapon against the lightest thing on
    // the road.
    damage: 65,
    // ~2.86 shots/sec — still the slowest-firing of the three (cannon ~6.25,
    // tracker ~4.17), but faster than the round's OWN flight time across the
    // screen (~0.7s at this muzzleSpeed from the player's muzzle). That
    // relationship is what actually matters here, not the raw number: at the
    // original 0.8s a rocket had already crossed off-screen by the time the
    // next one fired, so however long you held the trigger only one was ever
    // visible at once — which defeats the point of projectiles.js's dart
    // render mode existing at all (see DART_BODY there: "several can be in
    // the air at once"). This keeps two or more comfortably overlapping.
    interval: 0.35,
    // Slower off the rail than the cannon or tracker — it is a heavier round,
    // not a faster one, and STRAIGHT flight (below) means the player is
    // already choosing to aim rather than to curve round a bend with it.
    muzzleSpeed: 700,
    flight: FLIGHT_STRAIGHT,
    // FINITE — at ~2.86 shots/sec this empties in under 20s of held trigger,
    // same "use it, don't lean on it" intent as before, just retimed to match
    // the faster reload above.
    ammo: 50,
    color: ROCKET,
    glow: ROCKET_HOT,
    length: 16,
    width: 6,
    // A small discrete dart, not a tracer line — see projectiles.js's DART_BODY.
    // Several can be in the air at once, so it stays a cheap fixed-size glyph
    // rather than a line stretched back to the muzzle.
    render: "dart",
    // Detonates into a fireball (effects.js's drawFireballBurst) instead of the
    // ordinary spark — the one true fire-coloured explosion in the game.
    impact: "fireball",
    // Splash: whatever else is standing near the impact takes damage too, not
    // just whatever the round directly struck. Radius sits mid-table against
    // the obstacle catalogue's (26-66) and stays DELIBERATELY under the mine's
    // 30 — obstacletypes.js calls that "the single hardest hit anything on the
    // road can deal", and a hand-fired weapon topping it would quietly make
    // that claim false.
    blastRadius: 44,
    blastDamage: 20,
  },
  {
    id: "mine",
    label: "MINE",
    // A LAYER, not a gun — see game/armament.js's own MINE_LAYER, which this
    // mirrors field for field: a rate of fire and a magazine is all a mine
    // layer needs from the Weapon runtime above, and `payload` (an
    // OBSTACLE_TYPES id, not a bullet) is the one field this catalogue
    // otherwise never uses. main.js reads it to tell a mine drop apart from a
    // shot: `tryFire` only spends the round, what comes out the far end
    // (projectiles.js's spawn vs. obstacles.js's drop) is the caller's
    // business, exactly as the header above says.
    //
    // payload is the SAME hazard the enemy's own mine layer lays, not a second,
    // cosmetically distinct one — obstacleshapes.js is explicit that an
    // obstacle's colour is fixed by its role rather than who owns it ("an amber
    // mine or a red pylon would break the two-family read"). A mine reads as a
    // mine, whoever laid it.
    payload: "caltrop",
    // SIX SECONDS, THREE ROUNDS is the enemy's own layer (armament.js). The
    // player gets a much shorter rest and two more rounds: a held trigger
    // there is an AI's rare tactical choice, but here it is a deliberate
    // press every time, so the tighter enemy rationing would read as broken
    // rather than scarce. CUT FROM AN INITIAL 3s, THEN 1.5s — the magazine
    // (5 rounds) was already the thing rationing how often a player lays
    // mines in a chase; the reload no longer needed to do that job too. FIRST
    // PASS, like the rocket's own numbers above — retune once there is real
    // road time to measure it against.
    interval: 1,
    ammo: 5,
    // HUD-only below this line — a mine never flies, so length/width/flight/
    // muzzleSpeed/render/impact mean nothing here and main.js never reads them
    // for this weapon. color/glow still matter: the HUD readout (main.js's
    // drawHud) reads weapon.type.color for every weapon alike, mine included.
    color: PLAYER_THRUST,
    glow: PLAYER,
  },
];

// The default loadout: what the player starts every run holding.
export const DEFAULT_WEAPON = WEAPON_TYPES[0];

// --- Hostile hardware --------------------------------------------------------
//
// A SEPARATE LIST, and that separation is the whole point of it. `WEAPON_TYPES`
// above is the PLAYER'S catalogue: `Loadout` defaults to it, TAB cycles through
// it, and the Phase 5 pickups will roll out of it. Anything put in that array is
// therefore something the player can end up holding — so the enemy's gun cannot
// live there without turning up in the player's hands the first time they drive
// over a crate.
//
// Nothing else about it is special. Same fields, same `Weapon` runtime, same
// bullets out of the same projectiles.js pool code. Which catalogue an entry
// sits in is the only thing that says who carries it.
export const ENEMY_WEAPON_TYPES = [
  {
    id: "blaster",
    label: "BLASTER",
    // DELIBERATELY CONSERVATIVE, AND NOT YET THE FINAL SETTING. The player has
    // 100 hull and no way to repair it, so what decides whether being shot at is
    // pressure or a countdown is not this hit — it is how much hull the WHOLE
    // ROAD takes per minute, and that is a product of these two numbers and of
    // HOW OFTEN A GUN BEARS.
    //
    // The second half of that product does not exist yet. The hostile tactics
    // (behaviours.js) still borrow their driving from `overtake`, so a hostile
    // lines up on the player by coincidence — it is passing, not aiming. Once
    // `pursue` and `block` genuinely tail the player, guns will bear far more
    // often and this pair is what absorbs it. So it is set low on purpose and
    // MUST be re-measured then, against the tactics rather than against traffic
    // flowing past.
    //
    // Measured meanwhile, over twelve simulated minutes with the tactics as they
    // stand: ~19 shots a minute across the whole road, well over a third of them
    // missing. Missing is correct — a car that shoots only when it cannot miss
    // is a car that never shoots.
    //
    // Retune by MEASURING the road, never by dividing 100 by the damage. The
    // single-gun figure is asserted in test/invariants.test.js only as a sanity
    // band, not as the design target.
    damage: 5,
    interval: 1.5,
    // FASTER THAN ANYTHING ON THE ROAD CAN DRIVE (the cycle tops out at 730 —
    // cartypes.js). A bullet's absolute speed is the shooter's plus this, or
    // MINUS this when it is fired rearward at a player sitting behind
    // (projectiles.js's `dir`), and a rearward shot only travels backwards while
    // this exceeds the shooter's own speed. Drop it below the catalogue's
    // ceiling and the quickest hostiles quietly stop being able to shoot behind
    // them at all. Asserted in test/invariants.test.js.
    muzzleSpeed: 760,
    // TRACKING, unlike the player's default gun. Two reasons, both about the
    // player rather than about the enemy: a hostile round that drifted into the
    // barrier through every bend would make curves a free ride, and a shot that
    // holds its lane is one the player can read and steer out of. The dodge is
    // supposed to be lateral, not geometric.
    flight: FLIGHT_TRACKING,
    // INFINITE. An enemy that ran dry would simply stop being dangerous with
    // nothing on screen to explain why — the player would read it as the AI
    // losing interest. Rationing is the mine layer's job (game/armament.js),
    // where a drop is rare enough to be an event worth counting.
    ammo: Infinity,
    color: ENEMY,
    glow: ENEMY_THRUST,
    length: 12,
    width: 4,
  },
  {
    id: "smg",
    label: "SMG",
    // The stocker's own gun (armament.js's `gunner` profile) — a spray
    // rather than a single well-aimed round. Lower per-hit damage than the
    // blaster, made up for by rounds landing five at a time: the burst
    // fields below (burstCount/burstInterval) are what turn this into a
    // 0.36s spray followed by a 1.3s rest instead of a steady drip.
    //
    // SAME ORDER OF MAGNITUDE as the blaster over a full burst-plus-rest
    // cycle (20 hull a cycle here against ~5 there per interval), not tuned
    // finer than that — see the blaster's own note above on why this is
    // measured against the road, not against the player's hull directly.
    damage: 4,
    interval: 1.3,       // rest between bursts
    burstCount: 5,        // rounds per burst
    burstInterval: 0.09,  // seconds between rounds within a burst
    // SAME CEILING AS THE BLASTER, for the same reason — see its own note:
    // has to clear the fastest cruise on the road (the cycle's 730) or the
    // quickest hostiles lose the ability to fire behind them.
    muzzleSpeed: 760,
    // STRAIGHT, not tracking, like the player's own default gun — the
    // stocker aims exactly where it's pointed rather than curving its rounds
    // to follow the lane. Reads as a rawer, more mechanical spray than the
    // blaster's homing tracer, and it's the flight the `forwardOnly` note
    // just below is describing: what you're pointed at is what you hit.
    flight: FLIGHT_STRAIGHT,
    // NEVER FIRED BACKWARD. See armament.js's shoot() — a gun with this set
    // simply does not take the rearward shot, whatever the relative position
    // happens to read as for one tick. The stocker's whole tactic (`trail`,
    // behaviours.js) already keeps it behind its target, so this is a
    // guarantee rather than something the driving is trusted to maintain on
    // its own.
    forwardOnly: true,
    // RECKLESS, well beyond the blaster's tight 8: a spray that only fired on
    // a clean lineup wouldn't read as one. Matches MINE_AIM (armament.js) —
    // "about two thirds of a lane" — the same figure the mine layer already
    // uses for "close enough to be a real threat, not a warning shot".
    aimSlack: 45,
    ammo: Infinity,
    color: ENEMY,
    glow: ENEMY_THRUST,
    // Smaller than the blaster's round, so a spray of them reads as
    // lighter fire rather than the same bullet coming out faster.
    length: 10,
    width: 3,
  },
  {
    id: "missile",
    label: "MISSILE",
    // The interceptor's gun (armament.js's `rocketeer` profile) — one heavy,
    // well-aimed round on a long reload, in place of the blaster's steady
    // drip. It is the standard hostile's own answer to the player's ROCKET
    // pickup above: same dart body, same fireball, but in the enemy's own
    // colours and without the splash — see the next note for why.
    //
    // NO blastRadius/blastDamage, and that is not an oversight: main.js
    // resolves every hostile round against the PLAYER ALONE (`enemyTargets`),
    // and projectiles.js's detonate() excludes whatever the round directly
    // struck from its own splash sweep — so a splash radius here would have
    // nothing left in range to hit. The weight of this weapon is the raw
    // `damage` below and the long `interval`, not a wider blast.
    //
    // TUNED AGAINST THE SAME FLOOR the blaster's own comment names: one of
    // these must not empty the player's 100 hull in under ~15s on its own
    // (100 / 24 * 4 = 16.7s). A FIRST PASS, same caveat as the blaster's —
    // retune once behaviours.js's `pursue` has been measured over real road
    // time, not by dividing hull totals by this figure.
    damage: 24,
    interval: 4, // the slowest reload of anything on the road, player's own
                 // rocket included (0.35) — this is fired by an AI that never
                 // stops chasing, not by a held trigger
    // Comfortably under the blaster's 760, so a launch reads as visibly
    // slower and heavier — but still well clear of GUN_CLOSING(200) against
    // the road's own speed band in either direction, so it never fires a
    // round that can't catch anything (see armament.js's shoot()).
    muzzleSpeed: 680,
    // TRACKING, like the blaster — an enemy round that drifted into the
    // barrier through every bend would make curves a free ride, and this is
    // the one enemy weapon meant to feel unmissable if you hold your line.
    flight: FLIGHT_TRACKING,
    // INFINITE, like the blaster — an enemy weapon running dry would read as
    // the AI losing interest, not as a threat spent. Rationing this one is
    // the long `interval` above, not the magazine.
    ammo: Infinity,
    color: ENEMY,
    glow: ENEMY_THRUST,
    // Between the blaster's 12/4 and the player's rocket's 16/6 — a heavier
    // round than the standard gun, without the visual noise of it being
    // physically identical to the player's own.
    length: 15,
    width: 5,
    render: "dart",
    impact: "fireball",
  },
];

// One weapon, as carried by one car.
export class Weapon {
  constructor(type = DEFAULT_WEAPON) {
    this.type = type;
    this.cooldown = 0;   // seconds until the next shot is allowed
    this.ammo = type.ammo;
    // Rounds left in the burst IN PROGRESS. 0 means "none" — either this
    // weapon doesn't burst at all (type.burstCount unset) or the last one
    // just finished and the next tryFire starts a fresh one. See tryFire.
    this.burstLeft = 0;
  }

  get empty() {
    return this.ammo <= 0;
  }

  // Ready to fire RIGHT NOW — the trigger being held is the caller's business.
  get ready() {
    return this.cooldown <= 0 && !this.empty;
  }

  update(dt) {
    if (this.cooldown > 0) this.cooldown -= dt;
  }

  // Spend a shot if one is available. Returns whether it was: the caller fires a
  // bullet on true and does nothing on false, so a held trigger against an empty
  // or cooling weapon costs nothing and makes no noise.
  tryFire() {
    if (!this.ready) return false;
    // BURST WEAPONS COOL DOWN DIFFERENTLY MID-BURST. Every other round uses
    // burstInterval (fast) rather than interval (the rest AFTER a burst) —
    // `burstLeft` hitting 0 is what decides which one applies next, whether
    // that's because this shot started a fresh burst or finished one.
    if (this.type.burstCount) {
      if (this.burstLeft <= 0) this.burstLeft = this.type.burstCount;
      this.burstLeft -= 1;
      this.cooldown = this.burstLeft > 0 ? this.type.burstInterval : this.type.interval;
    } else {
      this.cooldown = this.type.interval;
    }
    this.ammo -= 1; // Infinity stays Infinity
    return true;
  }

  // Add rounds, capped at the catalogue's OWN starting figure — there is no
  // separate "max ammo" field, so `type.ammo` doubles as both the weapon's
  // starting magazine and the ceiling an ammo pickup (game/pickuptypes.js) can
  // top it back up to. A no-op on the default gun (Infinity stays Infinity).
  refill(amount) {
    if (amount <= 0) return;
    this.ammo = Math.min(this.type.ammo, this.ammo + amount);
  }

  // HUD caption. The infinite gun reads as a symbol rather than as a number,
  // because "999" invites the player to watch it.
  get ammoText() {
    return this.ammo === Infinity ? "∞" : `${Math.max(0, Math.floor(this.ammo))}`;
  }
}

// Everything a car is carrying, and which of it is in hand.
//
// SWAPPING NEVER FAILS, including onto an empty weapon. The alternative — skip
// what has no ammo — means the same key does different things depending on
// state, and the player has no way to see what they are about to get. An empty
// weapon selects, shows "0", and refuses to fire; TAB again moves on.
//
// Cooldowns run for the WHOLE loadout, not just the weapon in hand (see
// update), so swapping cannot be used to dodge a slow weapon's fire rate by
// flicking away and back.
export class Loadout {
  constructor(types = WEAPON_TYPES) {
    this.weapons = types.map((t) => new Weapon(t));
    this.index = 0;
  }

  get current() {
    return this.weapons[this.index];
  }

  // Look up a carried weapon by its catalogue id, not its position — used by
  // an ammo pickup (game/pickuptypes.js), which names what it refills rather
  // than an index that would break the day the catalogue is reordered.
  get(id) {
    return this.weapons.find((w) => w.type.id === id) ?? null;
  }

  // GUNS ONLY. A layer (type.payload set — the mine, see WEAPON_TYPES above)
  // is skipped here on purpose: it has its own key now (main.js's "mine"
  // action) rather than a slot in this cycle, so a player laying one is never
  // forced to tab away from whatever gun they had and back again afterwards.
  next() {
    const n = this.weapons.length;
    for (let i = 1; i <= n; i++) {
      const idx = (this.index + i) % n;
      if (!this.weapons[idx].type.payload) {
        this.index = idx;
        break;
      }
    }
    return this.current;
  }

  update(dt) {
    for (const w of this.weapons) w.update(dt);
  }
}
