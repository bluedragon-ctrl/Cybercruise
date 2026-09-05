# Run worker

One Worker, one KV namespace, two features that fire at the same two moments in
a run's life:

- **the shared top-10 board** — `leaderboard-worker.js`'s own header has the
  design (one KV key holding the whole array, one record per name, no
  anti-cheat). Client half: `src/game/leaderboard.js`, `src/game/nameentry.js`,
  `src/game/leaderboardrender.js`.
- **salvage** — the husks runs leave on the road. `salvage.js`'s header has that
  design (one KV key *per* husk, payload in KV metadata, per-band cap, TTL) and
  why it is laid out the opposite way to the board. Client half:
  `src/game/salvage.js`.

See the root README's *Leaderboard* and *Credits* sections for how the sides fit
together. The endpoint path is still `/leaderboard`; renaming it would break
every deployed client for a tidier URL.

## Deploy

```bash
cd worker
npx wrangler login      # once, opens a browser
npx wrangler deploy
```

`wrangler.toml`'s KV namespace `id` has to point at a real namespace before
this will work — create one with `npx wrangler kv namespace create LEADERBOARD`
(or via the Cloudflare dashboard) and paste the id it prints into
`wrangler.toml`.

`deploy` prints a `*.workers.dev` URL. Paste it into `WORKER_URL` at the top
of `src/game/leaderboard.js` — that's the only place the client needs to know
it.

## Endpoints

| | |
| --- | --- |
| `GET /leaderboard` | `{board, salvage}` — the current top 10 and every husk on the road |
| `POST /leaderboard` | one run's whole report; returns `{board}` only if it changed the board |

`POST` takes three independent, all-optional fields — `{name, score}`,
`salvage: {distance, offset, credits, name?}`, and `collected: [id]` — and
applies whichever are present. A body carrying none of them is a `400`.
`collected` holds the KV keys of husks this run looted, which is the only thing
a request can ask to *delete*; `salvage.js`'s `sanitizeCollected()` is what
stops one naming the board's own key.

**Deploy the site before the worker.** `GET` used to answer with the bare board
array and now answers `{board, salvage}`. `src/game/leaderboard.js` accepts
both shapes, so a new client works against the old worker (no salvage, board
fine); an old client against the new worker would not.
