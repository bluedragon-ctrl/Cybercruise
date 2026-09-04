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
// AMMUNITION. The default gun carries `Infinity` rounds, so the player is never
// left unable to shoot — which is what makes the special weapons a choice
// rather than a lifeline. Infinity needs no special case in the arithmetic
// (Infinity - 1 === Infinity); only the HUD does, hence `ammoText`.
//
// `ammo` IS THE MAGAZINE (the ceiling a refill tops up to), `startAmmo` is what
// is in it when a run begins, defaulting to full. The split exists because most
// of the catalogue is EARNED rather than issued: the tracker and the rocket
// both begin EMPTY. The player drives out with the cannon and the mines;
// everything else the road drops (pickuptypes.js) or the dock sells
// (upgrades.js). A magazine you went and got is spent differently from one you
// were handed, and it gives the shop's consumable shelf something to matter for
// on the first stop.
//
// WHAT THIS FILE DOES NOT DO: touch the world. `tryFire` answers one question —
// "may a shot be taken this instant?" — and the caller turns a yes into a
// bullet (projectiles.js, main.js). That split lets the enemy reuse the class
// without the player's input handling, and it is why game/armament.js can model
// a MINE LAYER as a Weapon: a rate of fire and a magazine is all one is, and
// what comes out at the far end is the caller's business.

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
//   SEEKING   the round holds NOTHING. It locks on to the nearest car ahead and
//             steers its offset across the lanes to meet it, at the capped rate
//             its `turnRate` names. Where a tracking round goes where you AIMED
//             it, a seeking round goes where the TARGET is — which is the whole
//             difference between the tracker and the rocket, and the reason the
//             two stopped being the same weapon at different numbers.
//
// projectiles.js implements all three; this constant is the whole difference
// between them at the catalogue level.
export const FLIGHT_STRAIGHT = "straight";
export const FLIGHT_TRACKING = "tracking";
export const FLIGHT_SEEKING = "seeking";

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
//   accel       OPTIONAL. World units/sec² the round gains along the line it
//               was fired, up to `topSpeed`. Omitted (or 0) means a
//               constant-speed round, exactly as every weapon was before this
//               field existed. A LOW muzzleSpeed against a HIGH accel is what
//               makes a launch read as a launch — see ROCKET
//   topSpeed    OPTIONAL, only read when accel is set (defaults to muzzleSpeed,
//               i.e. no burn). The relative speed the burn builds to
//   turnRate    OPTIONAL, only read for FLIGHT_SEEKING. Lateral units/sec the
//               round may steer toward what it has locked on to. This is the
//               weapon's whole difficulty knob: a big number is unmissable, a
//               small one can be out-driven by a car changing lanes
//   pierce      OPTIONAL. Extra bodies the round may punch through AFTER it
//               kills one — see projectiles.js's update(). Omitted (or 0) is
//               "one bullet, one car", which is every weapon here but TRACKER
//   flight      FLIGHT_STRAIGHT | FLIGHT_TRACKING | FLIGHT_SEEKING — see above
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
//   ammo        THE MAGAZINE: rounds this weapon can hold, and the ceiling
//               Weapon.refill will top up to. Infinity for the default gun
//   startAmmo   OPTIONAL. Rounds in hand when a run begins. Omitted means a
//               full magazine, which is how every weapon behaved before this
//               field existed; 0 is a weapon the player has to go and find
//               ammunition for before it is a weapon at all
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
    // Two hits kills the standard hostile (interceptor, 70 hull), one kills a
    // cycle, six are needed for a rig. Deliberately NOT a one-shot weapon
    // against anything that matters: the default gun is supposed to make the
    // heavier enemy types feel heavy, which is what leaves Phase 5's specials
    // something to be better at.
    damage: 41, // +20% over the original 34
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
    // THE SHOP CAN BOLT A SECOND BARREL ON — game/upgrades.js's TWIN CANNON.
    // Named HERE rather than branched on at the trigger, so "this weapon can
    // be paired" is a property of the weapon and main.js's fire branch stays
    // one call to muzzleOffsets() below however many weapons end up paired.
    twin: "twinCannon",
    // ABOUT HALF A LANE APART: wide enough that the two rounds read as two
    // separate lines running up the tarmac, narrow enough that a car the
    // player has lined up still eats both. A wider pair would quietly turn the
    // upgrade into "you now miss with half your shots".
    twinSpread: 20,
  },
  {
    id: "tracker",
    label: "TRACKER",
    // SUSTAINED LANE FIRE — a hose you walk up a curve, not a heavier cannon.
    // The burst fields below and `pierce` are what give it a verb of its own;
    // without them a tracking flight mode is invisible on a straight road. Its
    // value stays SITUATIONAL — the cannon is still the better tap-fire weapon —
    // but through a long curve this is the only thing that can rake a lane.
    damage: 22,
    // A 0.35s SPRAY, THEN A 0.6s REST. Eight rounds at 22 is 176 damage a cycle
    // against the cannon's ~256 over the same second — LOWER sustained damage,
    // deliberately, because the burst lands it all in one place at one moment and
    // pierce can multiply it across a line of cars. The machinery is the SMG's
    // (ENEMY_WEAPON_TYPES below), not a second burst implementation.
    interval: 0.6,       // rest between bursts
    burstCount: 8,       // rounds per burst
    burstInterval: 0.05, // seconds between rounds within a burst
    muzzleSpeed: 820,
    flight: FLIGHT_TRACKING,
    // PUNCHES THROUGH what it kills, up to two more bodies (projectiles.js's
    // update). This is the pay-off for the low per-round damage: fired up a
    // lane with three civilians nose to tail, one burst can take the lot,
    // which nothing else in the catalogue can do. It is NOT a way through the
    // heavy types — the round only continues if it actually killed, so a rig
    // (220 hull) stops it dead, and the rocket stays the answer to armour.
    pierce: 2,
    // FIFTEEN BURSTS WHEN FULL, sized for a "running dry and dropping back to
    // the cannon" arc rather than a magazine you can lean on...
    ammo: 120,
    // ...and NONE of them to begin with. The tracker is the first weapon the
    // player has to go and find: a lane-raking hose handed out at the start
    // would be the obvious answer to the opening minute of road, and the cannon
    // is supposed to be that. See the header's own note on the split.
    startAmmo: 0,
    color: PLAYER_THRUST,
    glow: PLAYER,
    length: 16,
    width: 4.5,
    // THE SHOP CAN TEACH THE TRACKER TO TRACK — upgrades.js's AUTOLOCK. THE
    // TRIGGER DESIGNATES: a pull with nothing designated picks one hostile
    // ahead at random (traffic.js's randomHostileAhead) and every round of that
    // burst steers to follow it instead of holding the lane. Holding the
    // trigger renews the same car; letting go drops it after `lockTime`.
    //
    // IT WAS THE HIT THAT DESIGNATED, and that is what this replaces. Earning
    // the lock by connecting sounded right and played dead: a car you have
    // already hit with round one of a burst is usually dead by round four, so
    // the designation kept arriving for a target that no longer needed it, and
    // the gun was still a lane hose in exactly the fights that were too fast
    // for it. Designating at the trigger is what makes the upgrade WORTH the
    // 350: it lets the player shoot a hostile that was never in their lane,
    // which is the one thing the cannon's infinite ammunition cannot buy.
    //
    // THE RIGHT UPGRADE FOR THIS GUN AND NO OTHER: the burst is already the
    // shape it needs (eight rounds already leave one muzzle together, so one
    // designation covers all of them and no new timing concept appears), and it
    // answers the tracker's real weakness — a lane hose is helpless against
    // anything not in its lane — without touching its damage, which is what
    // stops it becoming a better cannon.
    //
    // THE LANE RAKE SURVIVES IT with no special case: a locked car dead ahead
    // leaves `target.offset - s.offset` near zero, so the rounds fly the same
    // tracking line and `pierce` still punches down the row. The lock bends a
    // round only when the target is not in the lane already.
    lock: "autolock",
    // HOW LONG A DESIGNATION LASTS ONCE THE TRIGGER IS RELEASED. It must
    // outlive the rest between bursts (0.6s) or a held trigger would re-roll a
    // new car every burst, which is the one thing a random pick must not do.
    // 3.5s also holds the lock across a short pause to swerve, and still
    // expires soon enough that a car left alone stops being yours.
    lockTime: 3.5,
    // HOW FAR UP THE ROAD THE TRIGGER WILL REACH FOR A CAR. DERIVED, not
    // picked: the player sits at H * 0.62 (main.js), so 800 * 0.62 = 496 world
    // units of road are visible above them and 520 is that plus a little for
    // a car crossing the top edge. A longer reach would designate hostiles
    // offscreen — the reticle is the upgrade's only explanation (effects.js),
    // and brackets the player cannot see read as the burst bending for no
    // reason. Anything at all in view is fair game laterally; crossing the road
    // to reach it is what `lockLead` rations.
    lockRange: 520,
    // THE CEILING ON A LOCKED ROUND'S LATERAL SPEED — the whole balance of the
    // upgrade, and a CAP rather than a rate. projectiles.js works out what the
    // shot actually needs (the lateral gap divided by the time left to reach
    // the car) and spends only that, up to this.
    //
    // A FLAT RATE WAS THE FIRST VERSION AND IT WAS BACKWARDS. 150 units/sec is
    // whatever the flight time can pay for, and flight time COLLAPSES as the
    // target nears — a round closes at its own 820 relative to a car pacing the
    // player, so:
    //
    //   gap 520 (top of the screen)  0.63s of flight   95 units   1.3 lanes
    //   gap 350                      0.43s             64 units   0.9 lanes
    //   gap 143 (two car lengths)    0.17s             26 units   0.4 lanes
    //
    // The gun was weakest at point blank, which is the shot it should never
    // miss, and it could not reach past the next lane over from anywhere. What
    // a round needs is gap/time, and that is what it now takes.
    //
    // 500 IS AN ANGLE, not a distance: against ~1220 absolute it is a 22°
    // diagonal off the barrel, the steepest a round may leave at and still read
    // as a bullet rather than a homing drone. What it buys, at the 71.5-unit
    // lane width road.js sets:
    //
    //   ALL FOUR LANES from a gap of ~350 out — the top half of the screen
    //   ONE lane down to a gap of ~117 — close-range shots snap on
    //   and it still runs out. MEASURED against a car swerving a full lane away
    //   mid-flight: an outrider (steerSpeed 200) two lanes over escapes inside
    //   a gap of 450, a stocker (100) only inside 350, and NOTHING is hit
    //   across a lane from a gap of 70. That is the whole difference between
    //   "the rounds follow" and "the rounds cannot miss"
    //
    // IT EXCEEDS THE ROCKET'S OWN 390 AND THAT IS FINE. The rocket's claim was
    // never the turn rate: it HUNTS — it finds its own targets anywhere inside
    // 1100 units, re-acquires when one dies, reaches the air, and carries 98
    // damage and a splash. A tracer round is AIMED: it chases only what the
    // player designated, never re-acquires, and cannot touch anything flying.
    // Aimed fire arriving where it was pointed is not the seeker's job taken
    // away.
    lockLead: 500,
  },
  {
    id: "rocket",
    label: "ROCKET",
    // The heaviest hit in the catalogue and the slowest to reload — the one
    // round that matters, not a faster cannon. A FIRST PASS: retune against
    // real targets, not by dividing hull totals by this figure.
    //
    // One CONCRETE floor: a direct hit must one-shot the sedan (60 hull) with
    // room to spare, not tie it — a bare tie is one rounding bug away from the
    // rocket quietly ceasing to one-shot the lightest thing on the road.
    damage: 98, // +50% over the original 65
    // ~2.86 shots/sec — the slowest-firing of the three, but deliberately faster
    // than the round's OWN flight time across the screen. That relationship is
    // what matters, not the raw number: a reload slower than the flight means
    // only one rocket is ever visible at once, which defeats the point of
    // projectiles.js's dart render mode (see DART_BODY: "several can be in the
    // air at once"). This keeps two or more comfortably overlapping.
    interval: 0.35,
    // A LAUNCH, NOT A SHOT. It leaves the rail at less than half the cannon's
    // speed and then burns to well past it — so at point-blank range the rocket
    // is genuinely the WORST weapon in the catalogue (the cannon's round is
    // already there while this one is still lighting up), and at the far end of
    // the road it is the fastest thing the player owns. That trade is the
    // rocket's own, and it costs nothing to draw: projectiles.js's dart body
    // already has a burner on it.
    muzzleSpeed: 320,
    accel: 1500,
    topSpeed: 1200, // ~0.6s of burn to reach it, ~290 units of road spent doing so
    // SEEKING — the one weapon that goes where the TARGET is rather than where
    // it was aimed, which is what separates it from the tracker: the tracker
    // holds the lane you fired it up, this crosses lanes to meet a car trying
    // to leave. Fire-and-forget, and why the heavy round earns its magazine
    // despite being slow off the rail.
    //
    // Also why it will still make sense against the air content to come: a
    // target that changes lanes faster than anything on the tarmac is exactly
    // what a straight or lane-locked round cannot answer. The lock is opt-in
    // per body (projectiles.js's `seekable`), so those types will choose for
    // themselves — no change here when they land.
    flight: FLIGHT_SEEKING,
    // OUT-DRIVEABLE ON PURPOSE, and this is the weapon's difficulty knob. +50%
    // OVER THE ORIGINAL 260, so 390 lateral units/sec against the road's own
    // 71.5-unit lane width means the rocket crosses one lane in ~0.18s — a car
    // holding its line or drifting is still caught, and the margin against one
    // committing to a hard change the moment it sees the launch is now
    // noticeably tighter than the original figure left it. A seeker that could
    // not be dodged at all would make the rocket the only weapon worth
    // carrying, which is the ceiling this must stay under.
    turnRate: 390,
    // At ~2.86 shots/sec a full magazine empties in under 20s of held trigger —
    // "use it, don't lean on it", retimed to match the faster reload above.
    ammo: 50,
    // EMPTY AT THE START, like the tracker. The rocket is the heaviest hit in
    // the game and the answer to armour; a run that opened with fifty of them
    // would never have to learn what the cannon is for.
    startAmmo: 0,
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
    // Splash, and the ONLY splash the player can aim. The radius has to clear a
    // car's own length (the shortest in the catalogue is 54) or it never reaches
    // a second body and "clears a pack" is a comment rather than a mechanic. 90
    // reaches past the car it struck to the one alongside or behind it.
    //
    // WIDEST ON THE ROAD, HARDEST STILL NOT. This tops the obstacle catalogue's
    // radii (26-66, obstacletypes.js), because a hand-aimed warhead should
    // out-reach road furniture — but blastDamage stays under the mine's 150,
    // which obstacletypes.js calls the hardest hit anything on the road can deal.
    blastRadius: 90,
    blastDamage: 26,
    // THE SHOP CAN SELL A SECOND RAIL — game/upgrades.js's TWIN RACK. Same
    // field the cannon uses, but the pair is genuinely two seekers rather than
    // one round drawn twice: projectiles.js's seek() steers each one on its
    // own AND prefers a car the other rocket has not already locked, so a
    // press into a pack splits across two targets instead of double-killing
    // the nearest one.
    twin: "twinRocket",
    // WIDER THAN THE CANNON'S PAIR, because these two are meant to diverge.
    // They leave the rail far enough apart to start hunting different cars
    // rather than flying as one thick round with a seam down the middle.
    twinSpread: 34,
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
    // WHAT THE SPIKE MINES SPECIAL LAYS INSTEAD (upgrades.js's `spikeMines`).
    // A BIGGER PAYLOAD RATHER THAN A SECOND WEAPON, and that is the whole
    // lesson of the spike strip this replaced: the strip was a separate entry
    // in this catalogue with its own magazine, its own shop row, its own crate
    // and its own cursor on the deploy key, and asking a player mid-corner to
    // pick between two things dropped behind them with the same colour, the
    // same sound and the same key is a decision nobody made. An upgrade that
    // changes what the ONE deploy key puts down is the same tactical choice
    // with none of the bookkeeping: one magazine, one key, one crate, and the
    // player owns it or does not.
    //
    // THE MINE AND THE STRIP, LAID TOGETHER, not a third hazard that is both.
    // The mine is 26px of the 286px road and the strip is 171.6 — so the middle
    // is a kill and the way around it is a crawl, which is the geometry the
    // upgrade is bought for. Written as the two catalogue ids rather than as a
    // composite entry because that is honestly what goes on the road: two
    // objects, drawn, dodgeable, each doing exactly what its own entry already
    // says it does. See obstacles.js's drop(), which lays the set atomically.
    //
    // AN EARLIER VERSION SPRAYED THE SPIKES OFF THE MINE'S BLAST and is worth
    // recording, because the measurements are the argument against it: the
    // punctured span came to 158px against the strip's 171.6 — near enough the
    // same belt for 13.6px — but nothing was drawn for it and behaviours.js's
    // `hazardAhead` tests a hazard's own box, so cars dodged the 26px mine and
    // were punctured by something that had never been on screen. The width was
    // never the problem; the invisibility was.
    //
    // Resolved at the DROP (main.js), not here — the flag lives on the car
    // (player.specials), a weapon has no view of it, and a Loadout built before
    // the shop was visited must not have to be rebuilt after it.
    //
    // NAMED IN TWO FIELDS, exactly as `twin`/`twinSpread` and `lock`/`lockTime`
    // above are: `upgrade` is the SHELF FLAG (upgrades.js's `special`), and
    // test/specials.test.js walks this catalogue for those fields to prove
    // every flag sold is read and every flag read is sold. `upgradeLays` is
    // what the flag buys. A payload named without a flag is a hazard nothing can
    // reach, which is the failure that join exists to catch.
    upgrade: "spikeMines",
    upgradeLays: ["caltrop", "spikes"],
    // SIX SECONDS, THREE ROUNDS is the enemy's own layer (armament.js). The
    // player gets a much shorter rest and more than twice the magazine: a held
    // trigger there is an AI's rare tactical choice, but here it is a deliberate
    // press every time, so the tighter enemy rationing would read as broken
    // rather than scarce. The magazine, not the reload, is what rations this.
    // TWO A SECOND: a held trigger should read as laying a trail, not waiting
    // out a cooldown between taps. The magazine still rations this.
    interval: 0.5,
    // SIXTEEN IN THE MAGAZINE, EIGHT IN HAND. THE PLAYER'S ONLY DEPLOYABLE, and
    // the right one to be it: its whole behaviour — one hazard, dropped behind,
    // dodgeable — is legible the first time you use it. Issued at HALF the
    // magazine rather than full, so the dock's SET OF 4 (upgrades.js) is a real
    // top-up on the very first stop instead of a row with nothing to sell yet.
    ammo: 16,
    startAmmo: 8,
    // HUD-only below this line — a mine never flies, so length/width/flight/
    // muzzleSpeed/render/impact mean nothing here and main.js never reads them
    // for this weapon. color/glow still matter: the HUD readout (main.js's
    // drawHud) reads weapon.type.color for every weapon alike, mine included.
    color: PLAYER_THRUST,
    glow: PLAYER,
  },
];

// WHICH HAZARDS A LAYER ACTUALLY PUTS DOWN, given the specials block off the car
// (Player.applyUpgrades). An array of OBSTACLE_TYPES ids — EMPTY for a weapon
// that lays nothing at all, so every caller walks the same shape rather than
// branching on a null.
//
// HERE RATHER THAN AT THE CALL SITE (main.js's deploy branch, the only caller)
// because the rule belongs to the catalogue that states it: `upgrade` and
// `upgradeLays` are fields on a weapon entry, and reading them is this file's
// business. It also makes the rule testable — main.js touches the DOM at module
// scope and no test can import it, which is exactly how a one-line resolution
// goes unchecked.
//
// RESOLVED PER DROP, not once. The flag can turn on mid-run at a dock, and the
// Loadout is built long before the shop is ever visited.
export function laidPayloads(type, specials) {
  if (!type?.payload) return [];
  const { upgrade, upgradeLays, payload } = type;
  return upgrade && upgradeLays?.length && specials?.[upgrade] ? upgradeLays : [payload];
}

// The default loadout: what the player starts every run holding.
const DEFAULT_WEAPON = WEAPON_TYPES[0];

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
    // DELIBERATELY CONSERVATIVE. The player has 100 hull and no way to repair
    // it, so what decides whether being shot at is pressure or a countdown is
    // not this hit — it is how much hull the WHOLE ROAD takes per minute, which
    // is a product of these two numbers and of HOW OFTEN A GUN BEARS.
    //
    // Measured over twelve simulated minutes: ~19 shots a minute across the whole
    // road, well over a third of them missing. Missing is correct — a car that
    // shoots only when it cannot miss is a car that never shoots.
    //
    // Retune by MEASURING the road, never by dividing 100 by the damage. The
    // single-gun figure is asserted in test/combat.test.js only as a sanity
    // band, not as the design target.
    damage: 5,
    interval: 1.5,
    // FASTER THAN ANYTHING ON THE ROAD CAN DRIVE, WITH ONE DELIBERATE
    // EXCEPTION (the cycle tops out at 730 — cartypes.js). A bullet's
    // absolute speed is the shooter's plus this, or MINUS this when it is
    // fired rearward at a player sitting behind (projectiles.js's `dir`), and
    // a rearward shot only travels backwards while this exceeds the
    // shooter's own speed. THE OUTRIDER (800, cartypes.js) clears it and so
    // cannot be shot in the back — see its own entry for why that's the
    // design, not a gap: it sweeps past rather than chasing, so the player's
    // window is alongside or ahead, same as any other pass.
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
    // SAME CEILING AS THE BLASTER, for the same reason — see its own note,
    // outrider included.
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
  {
    id: "twinMissile",
    label: "TWIN MISSILE",
    // The delta's gun (armament.js's `twinRocketeer` profile) — the SAME round
    // as MISSILE above, fired in a pair every reload rather than one at a
    // time. A SEPARATE entry rather than `twin: true` bolted onto `missile`
    // itself, because that field is shared BY REFERENCE with the interceptor
    // and the gunship (both name `rocketeer`, armament.js's `ROCKETEER`) —
    // pairing it there would quietly double their fire too.
    //
    // SAME PER-ROUND WEIGHT, NOT A WEAKER ROUND SPLIT IN TWO — the same
    // reasoning as the player's own TWIN RACK (see `rocket` above's `twin`
    // note): a pairing that halved the damage to keep the total the same
    // would sell nothing, it would just be one missile with a wider hitbox.
    // The delta's own `cartypes.js` entry pays for this in hull instead —
    // lower than the interceptor's, so the extra output comes with the car
    // being faster to kill, not with each round pulling its punch.
    damage: 24,
    interval: 4,
    muzzleSpeed: 680,
    flight: FLIGHT_TRACKING,
    ammo: Infinity,
    color: ENEMY,
    glow: ENEMY_THRUST,
    length: 15,
    width: 5,
    render: "dart",
    impact: "fireball",
    // UNCONDITIONAL — see muzzleOffsets' own header for why `true` (rather
    // than a string naming a shop special) is what makes an enemy weapon
    // always fire paired.
    twin: true,
    // NARROWER THAN THE PLAYER'S OWN 34: these hold their lane rather than
    // hunting (TRACKING, not SEEKING — see the FLIGHT_* constants above), so
    // there is no "two seekers splitting a pack" to buy room for, only "read
    // as two rounds, not one fat one" — the same floor the cannon's 20 sets
    // for a lighter pair. Comfortably under a lane (65px, road.js) either way.
    twinSpread: 26,
  },
  {
    id: "turretSmg",
    label: "SMG",
    // The bunker trailer's own gun (armament.js's `bunker` profile) — the SAME
    // burst-fire spray as SMG above, minus its `forwardOnly` restriction.
    //
    // A SEPARATE ENTRY RATHER THAN A FLAG READ DIFFERENTLY, for the reason
    // TWIN MISSILE above already gives: `smg` is shared BY REFERENCE with the
    // stocker's GUNNER profile (armament.js), so dropping `forwardOnly` there
    // would let the stocker fire back over its own shoulder too. This car
    // needs the opposite of what the stocker's tactic needs: `outrun`
    // (behaviours.js) holds station AHEAD of the player and fires BACK down
    // the road at it — exactly the shot REARGUARD's own note (armament.js)
    // says the plain SMG cannot take, which is why the outrunner carries the
    // blaster instead. This entry is what lets a second front-holding boss
    // carry the burst weapon anyway, without touching the stocker's.
    damage: 4,
    interval: 1.3,
    burstCount: 5,
    burstInterval: 0.09,
    muzzleSpeed: 760,
    flight: FLIGHT_STRAIGHT,
    aimSlack: 45,
    ammo: Infinity,
    color: ENEMY,
    glow: ENEMY_THRUST,
    length: 10,
    width: 3,
    // NO forwardOnly — the whole point of this entry. Fires forward or back,
    // exactly like the plain blaster REARGUARD carries.
  },
  {
    id: "twinSmg",
    label: "SMG",
    // The skirted barge's own gun (armament.js's `barge` profile) — TURRET
    // SMG above, fired as a pair. A SEPARATE ENTRY rather than `twin` bolted
    // onto that one, for the reason TWIN MISSILE's own note gives: TURRET SMG
    // is shared by reference with nothing today, but stating the field on a
    // copy rather than on the shared original is what keeps it that way — a
    // second type naming `turretSmg` later must not silently fire in pairs.
    damage: 4,
    interval: 1.3,
    burstCount: 5,
    burstInterval: 0.09,
    muzzleSpeed: 760,
    flight: FLIGHT_STRAIGHT,
    aimSlack: 45,
    ammo: Infinity,
    color: ENEMY,
    glow: ENEMY_THRUST,
    length: 10,
    width: 3,
    // UNCONDITIONAL, like TWIN MISSILE's own — an enemy owns no shop
    // specials, so `true` rather than a flag name is what makes a hostile
    // weapon always fire paired (see muzzleOffsets' own header).
    twin: true,
    // A THIRD WIDER THAN THE PLAYER'S OWN CANNON PAIR (20): this hull holds
    // the player's exact lane (cartypes.js's `roadMargin`) rather than a
    // fixed line the player can already read, so the two streams need to
    // read as two separate lines to dodge BETWEEN rather than as one fat
    // spray — comfortably under half a lane (35.75px, road.js's LANE_WIDTH)
    // either way.
    twinSpread: 30,
  },
];

// --- What the shop's SPECIALS do to a trigger pull ---------------------------
//
// The four one-off upgrades (game/upgrades.js's SPECIALS) are OWNERSHIP FLAGS
// and nothing else — a `specials` block of booleans, handed to the player by
// Player.applyUpgrades and read from here. Two of them change what comes out of
// a barrel, and both are resolved by the pair of functions below rather than by
// a branch at the trigger, for the same reason weaponsfx.js's tables exist:
// main.js's fire branch should not grow a case per upgrade.
//
// THE WEAPON NAMES ITS OWN SPECIAL (`twin`, `lock` above), so a flag is only
// ever consulted against the gun that advertises it. Buying TWIN CANNON cannot
// accidentally pair the rocket, and neither function needs to know a weapon id.

// The lateral offsets, relative to the muzzle, this trigger pull puts a round
// at: one dead centre ordinarily, a symmetric PAIR when the weapon fires two.
//
// `type.twin` is TWO DIFFERENT THINGS depending on its type, and both read
// through this one function so armament.js's `shoot()` never has to know
// which: a STRING names a shop SPECIAL (upgrades.js) and the pair is gated on
// the player owning it (`specials[type.twin]`) — the player's TWIN CANNON and
// TWIN RACK. `true` is unconditional — a fixed part of the kit, nothing to
// buy — which is how an enemy weapon pairs (armament.js's `twinRocketeer`):
// there is no player-specials block to gate an enemy round against, and there
// should not be one, since a hostile's loadout is not a purchase.
//
// Returns a SHARED, FROZEN array rather than building one — the trigger is
// pulled several times a second forever, and projectiles.js's own "NO
// ALLOCATION" rule reaches the muzzle as well as the pool. Two live weapons
// with the same spread share one array and neither writes to it.
const SINGLE_MUZZLE = Object.freeze([0]);
const twinMuzzles = new Map(); // spread -> frozen [-spread/2, +spread/2]

export function muzzleOffsets(type, specials = null) {
  if (!type.twin) return SINGLE_MUZZLE;
  if (typeof type.twin === "string" && !specials?.[type.twin]) return SINGLE_MUZZLE;
  const spread = type.twinSpread ?? 20;
  let pair = twinMuzzles.get(spread);
  if (!pair) {
    pair = Object.freeze([-spread / 2, spread / 2]);
    twinMuzzles.set(spread, pair);
  }
  return pair;
}

// Does pulling this trigger designate a car, and for how long does the
// designation hold? Seconds, or 0 for every weapon and every unowned upgrade —
// and 0 is also the "do not go looking for a target at all" answer main.js
// tests, so an unowned upgrade costs the trigger one comparison and nothing
// else.
export function lockSeconds(type, specials = null) {
  if (!type.lock || !specials || !specials[type.lock]) return 0;
  return type.lockTime ?? 0;
}

// How far ahead of the player that trigger will look for one (see `lockRange`
// on the TRACKER). Same 0-when-unowned rule, so the two are read as a pair.
export function lockRange(type, specials = null) {
  if (!type.lock || !specials || !specials[type.lock]) return 0;
  return type.lockRange ?? 0;
}

// The fastest a round from this weapon may travel sideways to reach the car the
// player designated. 0 means "this round does not chase" — either the weapon
// has no lock upgrade or it has not been bought, and in both cases the round
// flies exactly as it always did.
//
// SEPARATE FROM `turnRate`, which is the rocket's own constant seeking rate and
// belongs to the flight mode. The two are not the same quantity: a rocket
// steers at its rate the whole way in, while this is only a CEILING on what a
// locked round spends on the lead it was fired with — see the TRACKER entry
// and projectiles.js's steer.
export function lockLead(type, specials = null) {
  if (!type.lock || !specials || !specials[type.lock]) return 0;
  return type.lockLead ?? 0;
}

// One weapon, as carried by one car.
export class Weapon {
  constructor(type = DEFAULT_WEAPON) {
    this.type = type;
    this.cooldown = 0;   // seconds until the next shot is allowed
    // What is IN it, which is not necessarily what it HOLDS — see the header's
    // note on the split. Nullish coalescing rather than a truthiness test on
    // purpose: startAmmo 0 is the whole point of the field, and a falsy check
    // would read it as "unset" and hand the player a full magazine.
    this.ammo = type.startAmmo ?? type.ammo;
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

  // Add rounds, capped at the MAGAZINE — `type.ammo`, which is the ceiling an
  // ammo pickup (game/pickuptypes.js) or a dock purchase (game/upgrades.js) can
  // fill to, and is NOT necessarily what the weapon started the run holding (see
  // the header's note on `startAmmo`). Because the cap IS the magazine, "sell
  // the whole magazine" and "top it right up" are the same act however much was
  // left in it — which is what the shop's layer rows rely on.
  //
  // A no-op on the default gun (Infinity stays Infinity).
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
// A CYCLE ONLY EVER LANDS ON SOMETHING LOADED. Selecting an empty magazine
// costs a keypress, shows "0" and refuses to fire, so every TAB through a
// mostly-spent catalogue was a press that did nothing. Both cycles skip empties,
// and the HUD already agreed — main.js lists only loaded guns plus what's held.
//
// THE MAGAZINE, NOT THE COOLDOWN, IS THE FILTER: a weapon merely COOLING is
// still the one you meant to have out and fires again in a moment; one with no
// rounds waits on a pickup or the dock.
//
// WHERE NOTHING IS LOADED THE CURSOR STAYS PUT — a no-op rather than a jump to
// an arbitrary empty slot, so the HUD keeps reading the last chosen weapon. The
// gun cycle reaches that only in a catalogue with no infinite gun (the player's
// always has the cannon); the deployable cycle reaches it on the last mine.
//
// RUNNING DRY MOVES THE CURSOR ITSELF: `settle()` is called after a shot is
// spent, so the round that empties a magazine hands over the next loaded weapon
// instead of leaving the player to find out by pulling a dead trigger.
//
// Cooldowns run for the WHOLE loadout, not just the weapon in hand (see
// update), so swapping cannot dodge a slow weapon's fire rate.
//
// TWO CURSORS, ONE CYCLE KEY, split by what a weapon PUTS INTO THE WORLD rather
// than by a flag: anything with a `payload` is a LAYER, everything else is a GUN
// on TAB's cycle. The cursors are INDEPENDENT — laying a mine must never disturb
// which gun is in hand, which is why the deploy key is its own.
//
// ONLY THE GUNS CYCLE. The layer cursor exists and moves — settle() runs it, and
// `deployable` is what the deploy key fires — but nothing CYCLES it, because the
// player carries exactly one layer and a key that selects between one thing is a
// key that does nothing. There was a second deployable (a spike strip) and its
// own E to switch, and it went for the reason the mine's `upgradeLays` now
// records: two things dropped behind you on the same key, in the same colour,
// with the same sound is a choice nobody makes at speed. What replaced it
// changes what the ONE key lays. A genuinely second layer would need its cycle
// back — `#step(this.deployIndex, isLoadedLayer)`, the same walk settle() below
// already makes — but it should have to argue for itself first.
//
// What each cursor will land on. Free functions rather than methods because
// they are about ONE weapon and nothing else about the loadout — see #step.
const isLoadedGun = (w) => !w.type.payload && !w.empty;
const isLoadedLayer = (w) => !!w.type.payload && !w.empty;

export class Loadout {
  constructor(types = WEAPON_TYPES) {
    this.weapons = types.map((t) => new Weapon(t));
    this.index = 0;
    // First LOADED layer in the catalogue, falling back to the first layer of
    // any kind and finally to -1 when there are none. Not 0: index 0 is a gun,
    // and a `deployable` that silently returned the cannon would let the deploy
    // key fire it. The fallback is what keeps a catalogue whose layers all
    // start empty (see startAmmo) showing one on the HUD rather than nothing;
    // the player's own mine is issued half full, so it is the enemy's Armament
    // that reaches for it.
    this.deployIndex = this.weapons.findIndex(isLoadedLayer);
    if (this.deployIndex < 0) this.deployIndex = this.weapons.findIndex((w) => w.type.payload);
  }

  get current() {
    return this.weapons[this.index];
  }

  // The layer selected right now, or null if the loadout carries none. Null
  // rather than a throw: a catalogue with no layer in it is a legitimate
  // loadout (the enemy's Armament builds one), and every caller already has to
  // handle "nothing to deploy" for the frame before one is picked up.
  get deployable() {
    return this.deployIndex >= 0 ? this.weapons[this.deployIndex] : null;
  }

  // Look up a carried weapon by its catalogue id, not its position — used by
  // an ammo pickup (game/pickuptypes.js), which names what it refills rather
  // than an index that would break the day the catalogue is reordered.
  get(id) {
    return this.weapons.find((w) => w.type.id === id) ?? null;
  }

  // GUNS ONLY, AND LOADED ONES. The mine (type.payload set — see WEAPON_TYPES
  // above) is skipped here on purpose: it has its own key (main.js's "mine"
  // action) rather than a slot in this cycle, so a player laying one is never
  // forced to tab away from whatever gun they had and back again afterwards.
  // Empty guns are skipped for the reason in the header.
  next() {
    const idx = this.#step(this.index, isLoadedGun);
    if (idx >= 0) this.index = idx;
    return this.current;
  }

  // THE AUTOMATIC HALF OF THE SAME RULE. Called by whatever just spent a round
  // (main.js): if the weapon in hand or the selected layer has just run dry,
  // move that cursor on to the next loaded one of its own kind. Returns whether
  // anything actually moved, so the caller can sound the swap it would have
  // sounded had the player pressed the key themselves.
  //
  // BOTH CURSORS, ONE CALL, because "what did I just empty" is not something
  // the caller should have to say: a cursor that is not sitting on an empty
  // weapon is left exactly where it is, so asking about both costs nothing and
  // there is one method to remember rather than two.
  settle() {
    let moved = false;
    if (this.current?.empty) {
      const idx = this.#step(this.index, isLoadedGun);
      if (idx >= 0) {
        this.index = idx;
        moved = true;
      }
    }
    if (this.deployable?.empty) {
      const idx = this.#step(this.deployIndex, isLoadedLayer);
      if (idx >= 0) {
        this.deployIndex = idx;
        moved = true;
      }
    }
    return moved;
  }

  // The first weapon after `from` that `wants` accepts, wrapping, or -1 if
  // there is none. `from` itself is tried LAST rather than skipped, so a cycle
  // with exactly one acceptable weapon in it stays on that weapon instead of
  // reporting nothing.
  #step(from, wants) {
    const n = this.weapons.length;
    for (let i = 1; i <= n; i++) {
      const idx = (from + i) % n;
      if (wants(this.weapons[idx])) return idx;
    }
    return -1;
  }

  update(dt) {
    for (const w of this.weapons) w.update(dt);
  }
}
