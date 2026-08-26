// Maps a pickuptypes.js KIND (AMMO/HEAL/SHIELD/BOOST) to the audio/soundtypes.js id
// its collection should play. The ONE place that decision lives, mirroring
// audio/weaponsfx.js exactly (same reasoning, same shape): a future pickup
// KIND added to pickuptypes.js with no entry here would otherwise collect
// silently, with nothing to say so until someone happened to notice in the
// browser — see test/audio.test.js's own coverage test for the guard.
//
// KEYED BY KIND, NOT BY id. pickuptypes.js's seven entries collapse onto just
// four kinds (AMMO/HEAL/SHIELD/BOOST — see that file's own header), and the
// design brief is explicit that the pickup sounds are told apart by
// what they DO (a refill, a heal, a shield, an overdrive), not by which of
// the four AMMO
// entries fired — rocket ammo and mine ammo both read as "pickup_ammo". If a
// later pass wants per-weapon ammo pickup sounds, that's a switch to keying
// on `type.id` instead; nothing else about this file's shape would need to
// change.
import { AMMO, HEAL, SHIELD, BOOST } from "../game/pickuptypes.js";

export const PICKUP_SOUND = {
  [AMMO]: "pickup_ammo",
  [HEAL]: "pickup_heal",
  [SHIELD]: "pickup_shield",
  [BOOST]: "pickup_boost",
};
