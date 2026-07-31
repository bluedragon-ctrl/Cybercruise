# Cybercruise

A retro **80s neon wireframe** browser game in vanilla JavaScript, inspired by the
1983 arcade classic **Spy Hunter**. Drive a car along an infinite curving neon
highway, weave through friendly and enemy traffic, and blast enemies with a
selection of switchable weapons.

## Play

The game uses native ES modules, so it must be served over HTTP (not opened as a
`file://`). On Windows, double-click **`play.bat`** in the project root — it
serves the folder and opens the game in your browser. It takes an optional port:
`play.bat 8080`.

Otherwise any static file server will do — from the project root:

```bash
python -m http.server 5173
```

Then open <http://localhost:5173>.

Cybercruise is developed across several machines, and not all of them have
python on PATH (on Windows, a bare `python` may hit the Microsoft Store alias
stub rather than a real interpreter). Equivalent one-liners:

```bash
npx --yes serve -l 5173 .
```

```bash
php -S localhost:5173
```

Two things to watch if you roll your own server: `.js` must be sent as
`text/javascript` or the browser refuses the modules, and resolve the document
root to an absolute path before the containment check — comparing request paths
against a relative root rejects everything as a 403.

`.claude/launch.json` (used by Claude Code's preview tooling) starts the python
variant. If python isn't available on your machine, point it at whichever server
you use locally — but please don't commit that switch, since python works for
most of the machines this is developed on.

### Asset gallery

A static showcase of the neon assets (cars, buildings, palette) for iterating on
visuals without running the game lives at <http://localhost:5173/demo.html>. Add
a sprite in `src/game/sprites.js`, then register a cell in `src/demo/gallery.js`.

### Controls

| Key | Action |
| --- | --- |
| ←/→ or A/D | Steer |
| ↑/↓ | Accelerate / brake |
| Space | Fire (later phase) |
| Shift / Q | Swap weapon (later phase) |

## Tech

- Vanilla JS + HTML5 Canvas 2D — no framework, no build step
- Native ES modules
- Web Audio API for procedural wavesynth music & SFX (later phase)

### Rendering performance

Canvas 2D's `ctx.shadowBlur` is what makes the neon look, and it is also by far
the most expensive thing the renderer can do — its cost scales with the shadow's
**bounding-box area**, not with the complexity of the shape. Before this was
addressed, glow accounted for ~80% of frame time (5.05ms → 1.01ms with
`shadowBlur` forced to 0) and grew linearly with every object on screen.

Two rules keep that from coming back as more visuals land:

1. **Anything drawn per-frame per-entity goes through the sprite cache.** Use
   `drawCarCached` / `drawBuildingVariant` (`src/game/sprites.js`), or add a
   wrapper built on `src/engine/spritecache.js`. Cache keys must be bounded —
   quantise continuous parameters rather than keying on raw floats. The raw
   `drawCar` / `drawBuilding` stay pure for the asset gallery and for building
   cache entries.
2. **Never put `shadowBlur` on a path that spans much of the canvas.** Use
   `neonStroke` (`src/engine/neon.js`), which strokes a path several times at
   decreasing width instead. One full-height barrier: 865µs shadowed vs 217µs
   layered.

Current cost is ~1.9ms/frame at 600×800, and **flat in object count** (1.79ms at
1 car, 1.86ms at 48) — so entities are effectively free and the remaining budget
is governed by screen area. Note that budget assumes 480k pixels: going
fullscreen 1080p is 4.3x the area, and glow cost scales with it.

Still open: the world scroll doesn't interpolate (`main.js` passes raw
`distance` to render while the player interpolates `x`), which judders on
120/144Hz displays; and the city has no culling, which will matter for Phase 7.

## Project layout

```
index.html          canvas + module entry
css/style.css       page + CRT frame styling
src/
  main.js           bootstrap + game loop
  engine/           loop, input, neon draw helpers
  game/             player, road, traffic, weapons, ... (built per phase)
  audio/            wavesynth synth (later phase)
```

## Development roadmap

Work lands via Pull Requests, one phase at a time; each phase leaves the game
playable.

- [x] **Phase 0** — Skeleton: neon car steering over a scrolling grid
- [ ] **Phase 1** — Road: infinite curving highway + barriers
- [ ] **Phase 2** — Surroundings A: simplified box buildings along the road
- [ ] **Phase 3** — Traffic: neutral/enemy cars, ramming physics
- [ ] **Phase 4** — Combat: shooting, explosions, enemy AI (shoot / mines)
- [ ] **Phase 5** — Weapons: multiple weapons + swap pickups
- [ ] **Phase 6** — Score/states: scoring, penalties, game-over, difficulty ramp
- [ ] **Phase 7** — Surroundings B: richer lit / parallax city
- [ ] **Phase 8** — Audio & juice: wavesynth music, SFX, screen shake, scanlines
- [ ] **Phase 9** — Polish: balance, high scores, performance
