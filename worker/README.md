# Leaderboard worker

The shared top-10 board's server half — see `leaderboard-worker.js`'s own
header for the design (one KV key, one record per name, no anti-cheat). The
client half is `src/game/leaderboard.js`, `src/game/nameentry.js` and
`src/game/leaderboardrender.js`; see the root README's *Leaderboard* section
for how the two sides fit together.

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
| `GET /leaderboard` | current top 10, `[]` if the board is empty |
| `POST /leaderboard` `{name, score}` | submit a run; returns the updated top 10 |
