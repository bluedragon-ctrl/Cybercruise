// Maps a weapons.js catalogue id (WEAPON_TYPES or ENEMY_WEAPON_TYPES) to the
// audio/soundtypes.js id its discharge/use should play. The ONE place that
// decision lives, so a new weapon added to weapons.js needs one new entry
// here rather than a branch grown at main.js's fire/deploy call sites — and
// so test/audio.test.js can assert every weapon has a sound (and no
// mapping points at an id nobody carries) without touching main.js at all.
//
// TWO TABLES, because the two catalogues are answering different questions.
//
// PLAYER_FIRE_SOUND covers every entry in WEAPON_TYPES, including the mine
// even though laying one isn't "firing" in any sense main.js's own fire
// branch means — it routes through main.js's dropMine call site instead and
// gets the mine_placed acknowledgement tone. That tone is keyed to the
// WEAPON, so the SPIKE MINES upgrade (upgrades.js) changing what the mine
// lays does not change how the console confirms the drop: what the road does
// afterwards is the tell, not the keypress. The three guns (cannon, tracker,
// rocket) each get their OWN id, echoing the
// design brief's point that a capacitor discharge is not one sound — the
// player's own arsenal is told apart by TIMBRE, weapon by weapon.
//
// ENEMY_FIRE_SOUND covers every entry in ENEMY_WEAPON_TYPES and
// deliberately collapses all of them onto ONE id (fire_enemy) — the
// opposite choice from the player's table, and also from the design brief:
// separating PLAYER from ENEMY fire is what timbre is spent on (see
// sfx.js's generateFireEnemy), not separating one hostile gun from another.
// The player only ever needs to know "was that aimed at me", never which
// specific hostile weapon it came from.

export const PLAYER_FIRE_SOUND = {
  cannon: "fire_blaster",
  tracker: "fire_tracker",
  rocket: "fire_rocket",
  mine: "mine_placed",
};

export const ENEMY_FIRE_SOUND = {
  blaster: "fire_enemy",
  smg: "fire_enemy",
  missile: "fire_enemy",
  twinMissile: "fire_enemy",
};
