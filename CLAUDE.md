# Cybercruise — working notes

Vanilla JS, Canvas 2D, native ES modules. **No build step, no dependencies, no
framework.** Adding any of the three is a decision to raise, not a detail to
slip in.

**The reasoning lives in the module headers.** `README.md` is a map over them —
what each system is, what is load-bearing about it, which file to open — and it
is kept true: if a change makes a paragraph in it wrong, the paragraph is part of
the change. Detail belongs in the header next to the code it explains, not copied
into the README. What follows is only the things that cause real damage when they
are not known up front, each with the section that explains it.

## Running it

| | |
| --- | --- |
| play | `npm run serve`, or `play.bat` on Windows — never `file://` |
| test | `npm test` (686 assertions; `node --test "test/*.test.js"`, pattern quoted so Node globs it) |
| driving profiles | `npm run sim`, and `node tools/drivesim.js 300 60` for an actual tuning decision |
| economy | `npm run econ` |
| balance numbers | `tools/car-editor/` — a browser UI over essentially every tuned constant |
| assets | `demo.html` |

## Rules that break things quietly

- **Anything drawn per-frame per-entity goes through the sprite cache**, and
  nothing puts `shadowBlur` on a canvas-spanning path. Glow cost scales with
  bounding-box AREA. → README, *Rendering performance*.
- **The camera is quantised to whole device pixels and rounded once**, in
  `main.js`, for every layer. Round per-layer, or interpolate, and both cache
  layers resample — the road visibly smears. Never round the simulation's
  `distance`. → README, *Rendering performance* and *Display scaling*.
- **`scale` moves in eighths because 8 is the gcd of 128, 600, 800 and 512.**
  Change any of those four and recompute it. → README, *Display scaling*.
- **The playfield is 600x800 forever.** The window moves the raster, not the
  world. → README, *Display scaling*.
- **Ship `cartypes.js`'s `FOCUS` empty.** A focused catalogue fails the gating
  invariants with a much worse error message than the one test that catches it.
- **Balance numbers live in catalogues, not in code.** `cartypes.js`,
  `obstacletypes.js`, `pickuptypes.js`, `weapons.js`, `upgrades.js`,
  `eventtypes.js` are data; the systems over them own no numbers. A new car,
  hazard, pickup or encounter should be a catalogue entry and nothing else.
- **Driving profiles are shared** — the van and the bus both drive `hauler`, and
  anything naming none falls back to `commuter`. A profile edit reaches every
  type naming it. → README, *Driving profiles*.
- **A comment cannot fail, so the arithmetic in comments is asserted.**
  `test/` is a cross-file invariant suite, not unit tests of behaviour: it
  exists because a tuning number in one file constrains a paragraph in another.
  Retuning something and finding a test red usually means the comment is now
  wrong, not the test. → `test/README-invariants.md`.

## Conventions

- Comments explain **why**, and are the design record. A new module gets a header
  saying what decision it embodies and what would go wrong without it, including
  the approaches tried and rejected. **State each decision once, in the one place
  it belongs, as briefly as the reasoning allows**, and cross-reference it from
  anywhere else that needs it — the same rule the README follows over the module
  headers. Compress freely; delete a decision only when it has stopped being
  true.
  Specifically, and these are the habits that inflated the files before:
  - **No counterfactuals.** The record is what the code does and why, not an
    inventory of what it doesn't. Drop "rather than X", "exactly as it did
    before this field existed", "which is not what anyone would expect" where
    the sentence already stands without them. Keep the contrast only where the
    rejected option is one somebody has actually proposed.
  - **Say it once, then reference.** Where several call sites share a rationale,
    write it at the definition and point at it (see `state` in `main.js`, which
    the four frozen-state handlers refer to).
  - **No restating the next line.** A comment naming the function below it is
    costing context and buying nothing.
  - Field tables and derivations of tuned numbers are the highest-value comments
    in the repo. Keep them; it is the prose around them that shrinks.
- Work lands as one PR per coherent change. Each one leaves the game playable.
- Rejected approaches are written down with their measurements — in the module
  header, or the design doc if they span several — rather than deleted. Several
  have been re-proposed by someone who did not have the record.
- `docs/superpowers/specs/` holds design reasoning in the tense it was written
  in; a banner at the top of each says what shipped. The source wins where they
  disagree.
