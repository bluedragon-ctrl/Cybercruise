// THE TARGET LOCK — which car the player's tracer rounds are currently chasing.
//
// One car at a time, designated by a hit and held for a few seconds
// (game/upgrades.js's AUTOLOCK, weapons.js's `lock` on the tracker). Rounds
// fired while a lock is live are handed it at the muzzle and steer to follow it
// instead of holding the lane they were fired up — see projectiles.js.
//
// WHY IT IS ITS OWN THING RATHER THAN A FIELD ON THE PLAYER. A lock is a
// reference to a TRAFFIC CAR, and player.js does not know traffic exists — it
// is handed a road width and its own input and that is the whole of its world.
// Putting a car on the player would be the first time anything in that file
// pointed at something on the road, which is a boundary worth more than the one
// small class it costs. Same reasoning game/shieldstorm.js gives.
//
// WHY IT IS NOT A FLAG ON THE CAR EITHER, which is how the marking upgrade this
// replaced worked. Exactly ONE car can be locked, so "am I the locked one" is a
// single reference, not a property of every car on the road. Held here, the two
// can never disagree; held per-car, "the lock" would be a search, and clearing
// it would mean walking the traffic list to find whatever was stale.
//
// IT HOLDS A CAR IT DOES NOT OWN, and never keeps one alive: `car` re-checks
// `alive` on every read, and update() drops a dead or expired target outright,
// so a wreck cannot be chased and a retired car cannot be leaked. main.js's
// respawnWorld() rebuilds Traffic wholesale, so it clears this too — every car
// reference in it is stale the moment that happens.

export class Lock {
  constructor() {
    this.target = null; // the designated car, or null
    this.time = 0;      // seconds of designation left
  }

  // Between runs, and on every world rebuild — see the header.
  reset() {
    this.target = null;
    this.time = 0;
  }

  // The live target, or null. A GETTER rather than the raw field, because a
  // locked car can be destroyed at any point in a tick by something that has no
  // idea this exists (another weapon, a mine, a ram) and every reader wants the
  // same answer about it.
  get car() {
    if (!this.target || !this.target.alive || this.time <= 0) return null;
    return this.target;
  }

  // Designate `car` for `seconds`. REPLACES whatever was locked rather than
  // refusing — the newest thing the player actually shot is the thing they mean,
  // and a lock that could not be moved would leave them hosing a car they had
  // stopped caring about. Re-hitting the car already locked simply renews it,
  // which is what keeps a lock alive through sustained fire.
  acquire(car, seconds) {
    if (!car || !car.alive) return false;
    this.target = car;
    this.time = seconds;
    return true;
  }

  // Run the clock down and drop anything no longer worth holding. Cleared
  // COMPLETELY rather than left to expire on its own, so nothing downstream has
  // to re-test `alive` on a reference this already knows is finished.
  update(dt) {
    if (!this.target) return;
    if (!this.target.alive) {
      this.reset();
      return;
    }
    this.time -= dt;
    if (this.time <= 0) this.reset();
  }
}
