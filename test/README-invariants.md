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

which is `node --test "test/*.test.js"` — the pattern **quoted**, so it reaches
the runner unexpanded and Node globs it itself. That is the one form that works
on every platform: `cmd.exe` does not expand globs at all, and quoting stops a
POSIX shell expanding it either, so both hand the runner the same string.

The directory form `node --test test/` is what this ran until Node 24, which
turned `--test`'s positional arguments into glob patterns — and a bare directory
matches no glob, so the runner tried to EXECUTE `test` as a module and the whole
suite failed to start before a single assertion ran. Node's own glob support
landed in Node 21, and Node 20 is out of maintenance, so nothing here still
needs the directory form the way it did.

`tools/car-editor/` gates its pull request on this same suite and is unaffected
either way: it lists the test files by reading the directory and passes them
one by one, which has no version-dependent expansion behind it at all. See
`testFiles()` in its `server.js` for why it was written that way.

Everything the suite imports is DOM-free at module scope — `spritecache.js`
only touches `document` inside `getSprite`, and `input.js` only reads `window`
as a default argument — so the game's real modules load under plain Node.

## The files

These were one 5,400-line `invariants.test.js` until the sections it was
already divided into became separate files. Splitting changed no test: the set
of test names is identical either way. What has been added since is a new file
per system rather than a new section in an old one.

| file | covers |
| --- | --- |
| `road-and-caches.test.js` | the speed band, the sprite-cache budget, road geometry, the strip cache |
| `city-floor.test.js` | the lot grid, distinguished nodes, materialisation, traffic dots, drones, links and pings, sectors |
| `combat.test.js` | ramming physics, tick ordering, distance gating, scoring, the weapon catalogue |
| `hazards.test.js` | road obstacles and their placement, driving profiles, enemy armament, exotic rounds, pickups |
| `audio.test.js` | the voice limiter and duck, the sound catalogues, sustained voices, the mix pass, the music backends |
| `economy.test.js` | credits, the link that is the one way a node is taken, the dish that reports it |
| `shop.test.js` | the upgrade catalogue, the tier ladder, and what a purchase moves |
| `shop-screen.test.js` | the storefront: its cursor, the action string main.js drives on, and what it draws |
| `specials.test.js` | the specials shelf, and both directions of the bare string joining a sold flag to the system that reads it |
| `events.test.js` | the event catalogue's gating, the formations' geometry, and the director's two promises: a staged encounter can never seal the road, and a shop visit is only ever late |
| `gutter.test.js` | `telemetry.js`'s line composition and emission pacing, and `console.js`'s divert mode |
| `test-options.test.js` | the two cheat rows, and the claim that switching one off in `testoptions.js` is the whole removal |

The `car-editor-*.test.js` files are ordinary unit tests of `tools/car-editor/`
rather than part of this suite.

## What does not live under `test/`

Fixtures shared by more than one file are in `test-support/fixtures.js`. Node's
runner treats *every* `.js` file under a directory named `test` as a test file,
including one that only exports helpers — which would then be reported as an
extra passing "test" containing no assertions. Keeping shared fixtures outside
that directory means the glob above matches only real test files.
