# assets/music/

Drop recorded soundtrack files here — no code change needed. `tools/serve.js`'s
`GET /api/music` endpoint lists whatever's in this directory at request time,
and `src/audio/trackmusic.js` plays through the list it gets back.

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

## Why nothing is committed here by default

This repository has no build step or asset pipeline, and everything else in
it is source code — no binary much larger than a sprite sheet exists
anywhere in the history. Music files are a few MB each, so they're excluded
via this directory's own `.gitignore` (see the PR that introduced this
directory for the discussion of whether that should change).
