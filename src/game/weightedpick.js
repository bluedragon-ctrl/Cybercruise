// The one weighted draw behind every "which type spawns next?" decision:
// cartypes.js's pickCarType, obstacletypes.js's pickObstacleType and
// pickuptypes.js's pickPickupType were three character-for-character copies of
// the loop below before this file existed.
//
// WHAT STAYS PER-CATALOGUE is the ELIGIBILITY RULE, which genuinely differs and
// must not be folded in here: cars additionally honour cartypes.js's FOCUS
// override, obstacles rule out `laidOnly` entries, and pickups compare against
// the RAW odometer where the other two scale by road.js's DIST_UNITS. Each
// caller keeps its own predicate and hands it in.
//
// REWEIGHTED, NOT RE-ROLLED. Ineligible entries are left out of the total
// rather than redrawn until something sticks, so an early road where only two
// of a dozen types have unlocked still costs exactly one roll.

// Pick one entry of `list` at random in proportion to its `weight`, considering
// only entries `isEligible` accepts. Returns null when nothing is eligible or
// the eligible weights sum to zero — callers read that as "nothing is unlocked
// yet", which is a normal state on the opening metres of a run, not an error.
export function pickWeighted(list, isEligible) {
  let total = 0;
  for (const entry of list) {
    if (isEligible(entry)) total += entry.weight;
  }
  if (total <= 0) return null;

  let roll = Math.random() * total;

  // `last` is the float-dust guard, and it is the reason this is worth having
  // in ONE place: summing the weights and then subtracting them back off does
  // not necessarily reach exactly zero, so the final `roll <= 0` can fail on
  // the last eligible entry by an ulp. Falling back to the last entry SEEN
  // (never to null) is what keeps a caller from having to handle a spurious
  // "nothing unlocked" once in a few million draws.
  let last = null;
  for (const entry of list) {
    if (!isEligible(entry)) continue;
    last = entry;
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return last;
}
