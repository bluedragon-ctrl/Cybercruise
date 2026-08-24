// The scoreboard — the one place that turns things that happen into points.
//
// TWO SOURCES, and they are deliberately different in character:
//
//   DISTANCE  the baseline. Points accrue simply for getting down the road, at
//             DISTANCE_POINTS per world unit, so a player who does nothing but
//             drive still watches a number go up. This is the metronome of the
//             score and it is never negative.
//   CARS      the judgement. Every destroyed car pays its type's `value`
//             (cartypes.js): positive for the enemy, negative for the city's own
//             traffic. This is the term the player has to think about, because
//             it is the only one that can go DOWN.
//
// WHO CALLS WHAT. Nothing in the game reaches in and adds to a total: main.js
// reports travel each tick, and traffic.js reports a car destroyed at the moment
// it detonates — including cars killed by a chain reaction the player only
// started. Whether a kill was "earned" is not asked; setting off a rig next to a
// bus queue is supposed to cost you.
//
// FLOOR. The total is NOT clamped at zero. An early massacre of civilians can
// put the player in the red, and the distance term is what digs them back out —
// that is the intended shape of the penalty, not an accident. (Phase 6's
// game-over/high-score work is where a floor, if ever wanted, belongs.)
//
// PRECISION. Distance is accumulated as a float and only floored when the total
// is read, so a slow player is not quietly rounded down to nothing every tick.

// Points per world unit travelled: ONE POINT PER 1000 UNITS. The player covers
// 120..620 units/sec (player.js), so the road pays roughly 7..37 points a
// minute.
//
// THE SHAPE is the only thing that matters here: KILLS DOMINATE. Driving is
// the trickle that rewards staying alive, and what the player does to the
// traffic is the score. The earlier 1-point-per-unit setting had it exactly
// backwards — a car was a quarter-second of driving, so nothing you did to
// the road could be seen in the number.
//
// No fixed ratio is pinned against `value` any more — cartypes.js now gives
// every type its own literal figure, on purpose, so a bus or a boss can be
// worth far more or less than an ordinary car without that being a scoring
// bug. Judge a retune by feel (does a kill still read as the headline event
// against a stretch of driving?), not by a formula tied to whichever type
// currently has the largest figure.
export const DISTANCE_POINTS = 0.001;

// How long a "+100" / "-100" award stays on the HUD after a kill.
const AWARD_FLASH = 1.2; // seconds

export class Score {
  constructor() {
    this.travelled = 0; // world units driven, float
    this.bonus = 0;     // sum of every destroyed car's value, integer
    this.kills = 0;     // enemy cars destroyed
    this.civilians = 0; // neutral cars destroyed

    // The last award, kept only so the HUD can flash it. Purely presentational —
    // nothing about the total depends on it.
    this.lastAward = 0;
    this.awardTimer = 0;
  }

  // The number the player sees.
  get points() {
    return Math.floor(this.travelled * DISTANCE_POINTS) + this.bonus;
  }

  // `units` of road covered since the last tick. Called by main.js with exactly
  // the amount `distance` grew by, so the score can never drift from the odometer.
  travel(units) {
    if (units > 0) this.travelled += units;
  }

  // A car has been destroyed. Takes the CAR_TYPES entry, so the scoreboard never
  // has to know what a faction is — the catalogue decides what a car is worth,
  // and a type with no `value` simply scores nothing.
  destroyed(type) {
    const value = type.value ?? 0;
    this.bonus += value;
    if (value >= 0) this.kills++;
    else this.civilians++;

    this.lastAward = value;
    this.awardTimer = AWARD_FLASH;
  }

  update(dt) {
    if (this.awardTimer > 0) this.awardTimer -= dt;
  }

  // 0..1 while an award is still worth drawing, 0 once it has faded.
  get awardAlpha() {
    return Math.max(0, this.awardTimer / AWARD_FLASH);
  }
}
