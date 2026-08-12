// Maps engine/console.js's push() severity to the audio/soundtypes.js id (and
// the pitch that id's generator should ring) its tick should play. Mirrors
// audio/pickupsfx.js's shape exactly: a small table keyed by an imported
// constant from the module that owns the concept being mapped, rather than a
// literal string repeated in two files that could quietly drift apart.
//
// TWO TABLES, KEPT TOGETHER, because they are two views of the SAME severity
// -> id relationship: CONSOLE_SOUND is what main.js's subscriber callback
// reads (see console.js's own onPush() header for why that wiring lives in
// main.js, not here or in console.js), and CONSOLE_PITCH is what sfx.js's
// generateConsoleTick reads to build the three registered generators — see
// that function's own comment for why sharing this table (rather than
// hard-coding 140/110/95 a second time inside sfx.js) is what keeps the id a
// severity maps to and the pitch that id actually rings from ever drifting
// apart.
//
// THREE SEPARATE ids, not one id taking a severity option. soundtypes.js's
// own entries for these three carry independent gain/priority (a CRITICAL
// line is allowed to survive voice contention a beat longer than a HINT —
// see that file's own comment), which a single parameterised id can't
// express through that table the way every other multi-variant sound in the
// catalogue (fire_blaster vs. fire_rocket vs. fire_tracker, say) already
// doesn't either.
//
// LOWER READS AS WORSE — 140Hz for HINT down to 95Hz for CRITICAL — the
// INVERSE of the usual "higher pitch = more urgent" alarm convention. See
// soundtypes.js's own console_* entries for the full reasoning: this reads
// as dread settling in rather than an alarm ratcheting up, which is the
// register the whole soundtrack (proceduralmusic.js's own progression that
// deliberately never resolves) already works in.
import { HINT, WARN, CRITICAL } from "../engine/console.js";

export const CONSOLE_SOUND = {
  [HINT]: "console_hint",
  [WARN]: "console_warn",
  [CRITICAL]: "console_critical",
};

export const CONSOLE_PITCH = {
  [HINT]: 140,
  [WARN]: 110,
  [CRITICAL]: 95,
};
