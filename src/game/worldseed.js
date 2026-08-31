// The one number this run's city is generated FROM.
//
// The city floor is a pure function of position — citygrid.js's plots and lots,
// links.js's conduits, callsigns and node prices, sectors.js's names,
// drones.js's flight lanes. That is what makes it infinite and free: nothing is
// generated as the player drives, nothing is freed behind them, and no module
// down there keeps state. The price of it was that the answer never depended on
// anything but position, so it was THE SAME CITY EVERY RUN — the same buildings
// on the same lots, the same nodes at the same intersections, the same names
// read out at the same distances, for every run and every player. A run had no
// place of its own.
//
// This gives it one without giving up the pure-function property, by salting
// the position each roll hashes with a number fixed once per run. WITHIN a run
// nothing changes: a lot answers the same the tenth time it is asked as the
// first, materialisation and the sprite caches still see a stable world, and the
// floor still needs no state. BETWEEN runs the whole city moves.
//
// ONLY THE SALT IS SHARED, NOT THE HASH. Four files keep their own three-line
// copy of the sin-hash, deliberately — see sectors.js's own note on why (a
// shared utility module would be one more file to open to follow what is,
// everywhere it is used, a three-line PRNG). That reasoning is untouched and
// those copies stay. What genuinely cannot be duplicated is the SALT: four
// independently drawn seeds would let the buildings move while the callsigns
// naming them stayed put, which is one world made of four. Exactly one number
// lives here and the four hashes read it.
//
// EACH FILE SALTS INSIDE ITS OWN hash(), not at its seed functions. The seed
// functions are the obvious place — they are already where each file's own seed
// space is documented — but there are ten of them across the four files and a
// roll added later would be salted only if someone remembered to. At the hash it
// is structural: a new roll in a world file is in this run's world by default.
// It is safe there because every hash() call in those four files is a world
// roll, and because a shared salt never collides — the offsets those call sites
// already pass (`seed * 1.7` vs `seed * 3.1`, `seed + 1` vs `seed + 2`) stay
// just as distinct after the same number is added to all of them.
//
// DEFAULTS TO 0, WHICH IS THE CITY THAT SHIPPED BEFORE THIS FILE EXISTED, since
// the salt is added and zero is a no-op. Nothing draws a random seed until
// main.js's newGame() asks for one. That is what keeps the invariant suite
// reproducible — test/city-floor.test.js's measured lot fractions are seed-0
// numbers, and a world bug found at some other seed is reachable again by
// seeding it back rather than by re-rolling until it returns.

// Six digits. Small enough to be read off a deck and typed back in, and it
// changes nothing about the precision the sin-hash has left: a lot-row seed in
// citygrid.js already reaches ~5e7 a few thousand units into a run, so at most
// 1e6 on top of that is not a change of magnitude.
const SEED_RANGE = 1_000_000;

let seed = 0;

export function worldSeed() {
  return seed;
}

// Called with no argument from main.js's newGame() for a fresh city, and with an
// explicit value by the test suite (and by anything that later lets a player
// replay a seed they liked). Returns the seed it settled on, so a caller that
// wants to show it does not have to ask twice.
export function reseedWorld(value = Math.floor(Math.random() * SEED_RANGE)) {
  seed = value;
  return seed;
}
