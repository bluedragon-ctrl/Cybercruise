# Cybercruise

A retro **80s neon wireframe** browser game in vanilla JavaScript, inspired by the
1983 arcade classic **Spy Hunter**. Drive a car along an infinite curving neon
highway, weave through friendly and enemy traffic, and blast enemies with a
selection of switchable weapons.

## Play

The game uses native ES modules, so it must be served over HTTP (not opened as a
`file://`). From the project root:

```bash
python -m http.server 5173
```

Then open <http://localhost:5173>.

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
