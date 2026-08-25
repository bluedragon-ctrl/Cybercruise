# The cross-file invariant suite

## Why it exists

Cybercruise tunes itself through numbers that live in one file but constrain
another: the traffic catalogue is pinned to the player's speed band, the
follower's braking rule is sized against the widest closing speed that band can
produce, and the sprite-cache budget is a product of the catalogue's length and
the wheel-frame count. Every one of those is carefully explained in a comment —
and **a comment cannot fail**. Retuning one number in `cartypes.js` could
quietly invalidate a paragraph in `behaviours.js`, and the road would start
rear-ending itself with nothing to say so.

So these are deliberately **not** unit tests of behaviour. They are assertions
of the arithmetic the comments claim, placed so that changing a tuning number
either keeps the claim true or fails here with the relation spelled out.

## Running them

```
npm test
```

which is `node --test test/`. Node 20's runner has no glob support, so the
directory form is what works on every platform — a `test/*.test.js` script
depends on POSIX shell expansion and finds nothing under `cmd.exe`.

Everything the suite imports is DOM-free at module scope — `spritecache.js`
only touches `document` inside `getSprite`, and `input.js` only reads `window`
as a default argument — so the game's real modules load under plain Node.

## The files

These were one 5,400-line `invariants.test.js` until the sections it was
already divided into became separate files. Splitting changed no test: the set
of test names is identical either way.

| file | covers |
| --- | --- |
| `road-and-caches.test.js` | the speed band, the sprite-cache budget, road geometry, the strip cache |
| `city-floor.test.js` | the lot grid, distinguished nodes, materialisation, traffic dots, drones, links and pings, sectors |
| `combat.test.js` | ramming physics, tick ordering, distance gating, scoring, the weapon catalogue |
| `hazards.test.js` | road obstacles and their placement, driving profiles, enemy armament, exotic rounds, pickups |
| `audio.test.js` | the voice limiter and duck, the sound catalogues, sustained voices, the mix pass, the music backends |
| `economy.test.js` | credits, the link that is the one way a node is taken, the dish that reports it |

The `car-editor-*.test.js` files are ordinary unit tests of `tools/car-editor/`
rather than part of this suite.

## What does not live under `test/`

Fixtures shared by more than one file are in `test-support/fixtures.js`. Node's
runner treats *every* `.js` file under a directory named `test` as a test file,
including one that only exports helpers — which would then be reported as an
extra passing "test" containing no assertions. Keeping shared fixtures outside
that directory means `node --test test/` scans only real test files.
