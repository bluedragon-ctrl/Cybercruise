// Generates assets/music/tracks.json — the static listing of the soundtrack
// that src/audio/trackmusic.js plays through.
//
// WHY A GENERATED FILE RATHER THAN A SERVER ENDPOINT. A browser cannot
// enumerate a directory over HTTP, so trackmusic.js has to be told what's in
// assets/music/ somehow. This used to be a live endpoint in tools/serve.js
// (GET /api/music, reading the directory per request), which worked only for
// as long as the game was exclusively played through that one Node server.
// The game is published as a STATIC SITE (GitHub Pages, itch.io) where no
// such endpoint can exist: the fetch would 404 and synth.js would silently
// fall back to procedural music with the committed tracks sitting unplayed.
// A committed manifest is served as an ordinary file by every host including
// tools/serve.js, so development and production now run the exact same code
// path — there is no "worked locally, broken live" gap left to fall into.
//
// THE COST is that the manifest can go stale: drop a track into the
// directory and this has to be re-run (`npm run music`) or the game won't
// see it. That failure is caught rather than lived with — test/audio.test.js
// asserts the committed manifest matches the committed directory, so a
// forgotten regeneration fails `npm test` instead of failing silently in
// front of a player.
//
// Usage:  node tools/musicmanifest.js        (writes assets/music/tracks.json)

import { readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MUSIC_DIR, MUSIC_LISTING_URL } from '../src/audio/musictypes.js';

// The repository root — this file lives in tools/, so go up one level.
const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

/**
 * Every playable track in `dir`, as `[{ name, size }]` sorted by name.
 *
 * Only `.ogg` is listed — see assets/music/README.md on why Ogg Vorbis
 * specifically. Non-files (a stray subdirectory) are skipped rather than
 * recursed into: the listing describes one flat directory, and a nested
 * path would break trackUrl()'s single-filename encoding in trackmusic.js.
 * A missing directory is an empty list rather than a throw, so a fresh
 * checkout with no audio in it regenerates cleanly instead of erroring.
 *
 * Exported (and unit-tested) separately from the file writing below so the
 * tests can exercise the listing rules against a temp directory without
 * writing a manifest anywhere.
 */
export async function listMusicFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const tracks = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.ogg') continue;
    const info = await stat(path.join(dir, entry.name));
    tracks.push({ name: entry.name, size: info.size });
  }
  // Sorted by code unit, NOT localeCompare: this listing is committed, so it
  // has to come out byte-identical on every machine that regenerates it or
  // the staleness test fails for whoever's locale differs from the last
  // person's. That is not hypothetical — under Czech collation "ch" is a
  // single letter that sorts after "h", which alone reorders this project's
  // own tracks (chase.ogg after halo.ogg). Playback order isn't at stake
  // either way; trackmusic.js's shuffle owns that.
  tracks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return tracks;
}

/** The manifest's absolute path, derived from the same constants the game reads. */
export function manifestPath(root = ROOT) {
  return path.join(root, MUSIC_DIR, path.basename(MUSIC_LISTING_URL));
}

/** The exact bytes the manifest should contain for `tracks` — one place, so the
 *  generator and the staleness test can't disagree about formatting. */
export function manifestContents(tracks) {
  return JSON.stringify(tracks, null, 2) + '\n';
}

/** Regenerate the manifest from the directory's current contents. */
export async function writeManifest(root = ROOT) {
  const tracks = await listMusicFiles(path.join(root, MUSIC_DIR));
  await writeFile(manifestPath(root), manifestContents(tracks), 'utf8');
  return tracks;
}

// Run as a script (not when imported by a test): regenerate and report.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const tracks = await writeManifest();
  const total = tracks.reduce((sum, t) => sum + t.size, 0);
  console.log(`${path.relative(ROOT, manifestPath())}: ${tracks.length} track(s), ${(total / 1e6).toFixed(1)} MB`);
  for (const t of tracks) console.log(`  ${t.name}`);
}
