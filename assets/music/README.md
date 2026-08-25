# assets/music/

Drop recorded soundtrack files here, then run:

```
npm run music
```

That regenerates `tracks.json`, the manifest `src/audio/trackmusic.js` fetches
to find out what it can play. No code change needed — but the manifest step
is not optional, and `npm test` fails if you skip it (see below).

## Format

**Ogg Vorbis (`.ogg`), quality ~5-6.** That's the one format `trackmusic.js`
is built and tested against.

If a file you're adding is actually an MP3 with a `.ogg` extension slapped on
it, re-export it properly rather than relying on the game to cope: MP3
encoder padding puts a few dozen milliseconds of silence at the head and tail
of every file, which is inaudible in most players but becomes a real, audible
gap here — between playlist tracks, and (worse) on every loop of a directory
that only has one file, where `trackmusic.js` relies on
`AudioBufferSourceNode.loop = true` for a seamless repeat. A clean Vorbis
export doesn't have this problem.

## Naming

Filenames can contain spaces, parentheses, apostrophes — anything a normal
download might have. `trackmusic.js` percent-encodes each filename before
fetching it and `tools/serve.js` decodes it again server-side, so this isn't
something you need to sanitize by hand.

## Tuning a track's level

If a specific file plays too loud or too quiet relative to the others (or
relative to the procedural backend), add an entry to `TRACK_OVERRIDES` in
`src/audio/musictypes.js` — no need to re-export the audio itself just to
trim its gain.

## Why the tracks are committed, and why the listing is generated

The audio ships with the game. It's part of what a player receives from
GitHub Pages or itch.io, not a local convenience, so it lives in the
repository like everything else the browser loads. Ogg Vorbis at q5-6 keeps
a track to a few MB; the whole soundtrack should stay well inside the ~50MB
of repo that static hosting is comfortable with. `.wav` and `.mp3` remain
ignored by this directory's `.gitignore` — an accidental few-hundred-MB WAV
in git history is not something you can cleanly undo.

Only commit tracks you wrote, generated, or hold a license for that permits
redistribution. Publishing puts them up for public download, and git history
keeps them even after a delete.

`tracks.json` is generated rather than hand-edited, and static rather than a
server endpoint, because a browser cannot enumerate a directory over HTTP and
a static host has nowhere to run the code that would. It used to be a live
`GET /api/music` in `tools/serve.js`, which worked locally and silently fell
back to procedural music everywhere the game was actually published. See
`tools/musicmanifest.js` for the full reasoning.

The one cost is staleness: a track that's in this directory but not in
`tracks.json` will never play. `test/audio.test.js` compares the two, so
forgetting `npm run music` fails the test suite rather than quietly shipping
a missing track.
