// The SUSTAINED-voice catalogue — mirrors soundtypes.js's shape (an id, and a
// `generator` filled in later by registerGenerator, so this file and its
// generators — audio/sustainedfx.js — never have to import each other
// directly; see soundtypes.js's own header for why that split exists) but
// deliberately much smaller: three fixed voices, not a catalogue meant to
// keep growing toward thirty.
//
// WHY THIS ISN'T JUST THREE MORE SOUND_TYPES ENTRIES. Every SOUND_TYPES
// entry flows through sfx.js's play(): request a voice-limiter slot, build,
// report a duration, forget. A sustained voice has no duration — it is
// acquired once and lives for the page's whole life (see audio/sustained.js's
// own header) — so it carries none of soundtypes.js's mixing fields
// (gain/duck/delaySend/priority/maxConcurrent/minInterval): a sustained
// voice's level is driven continuously, every frame, by its own
// update*() function in sustainedfx.js, not read off a static catalogue
// number, and it never competes for context.js's one-shot voice limiter at
// all. Folding it into SOUND_TYPES would mean every consumer of that table
// (the limiter, the gallery's one-shot click handler) has to special-case
// entries that don't behave like the other thirty. Two lifecycles, two
// catalogues.

export const SUSTAINED_TYPES = [
  {
    id: "hull_hiss",
    generator: null, // filled in by sustainedfx.js's registerGenerator("hull_hiss", ...)
    label: "HULL HISS",
  },
  {
    id: "shield_drone",
    generator: null,
    label: "SHIELD DRONE",
  },
  {
    id: "wall_scrape",
    generator: null,
    label: "WALL SCRAPE",
  },
  {
    id: "dread_pulse",
    generator: null, // filled in by sustainedfx.js's registerGenerator("dread_pulse", ...)
    label: "DREAD PULSE",
  },
];

// Mirrors soundtypes.js's soundTypeById exactly.
export function sustainedTypeById(id) {
  return SUSTAINED_TYPES.find((t) => t.id === id) ?? null;
}

// Mirrors soundtypes.js's registerGenerator exactly — called once per voice
// by sustainedfx.js as it defines each one's graph-builder.
export function registerGenerator(id, fn) {
  const entry = sustainedTypeById(id);
  if (entry) entry.generator = fn;
}
