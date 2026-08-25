// Minimal static file server for Cybercruise.
//
// The game is native ES modules, so it cannot run from a file:// path — it needs
// a real HTTP origin. This uses only Node built-ins on purpose: the project has
// zero dependencies, and shelling out to `npx http-server` made starting the game
// depend on a working npm install (a missing %APPDATA%\npm broke play.bat outright).
//
// Also serves ONE small JSON API, GET /api/music (see listMusicFiles() below):
// the browser has no way to enumerate a directory over plain static HTTP, and
// trackmusic.js (src/audio/) needs to know what's actually in assets/music/
// before it can play any of it. Everything else stays static file serving.
//
// Usage:  node tools/serve.js [port]      (default 5173)
//
// THE PORT CAN ALSO COME FROM THE ENVIRONMENT, and the order below is the whole
// rule: an explicit argument wins (that is what `play.bat 8080` is), then $PORT,
// then the default. $PORT exists for a launcher that assigns one — Claude Code's
// preview tooling hands the server a free port that way when 5173 is already
// taken, which it often is when the game is being served from more than one
// worktree at once. Neither of the other two callers is affected: an argument
// still beats it, and nothing sets $PORT by accident.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MUSIC_DIR, MUSIC_LISTING_URL } from '../src/audio/musictypes.js';

const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 5173;

// Serve the repository root — this file lives in tools/, so go up one level.
const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// Only the types the game actually loads; anything else is sent as a byte stream.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Decode a request URL down to a pathname, or null on a malformed escape. */
function decodePathname(requestUrl) {
  try {
    return decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
}

/** Map a decoded pathname to a file inside ROOT, or null if it escapes the root. */
function resolveTarget(pathname) {
  // path.join normalises away any ../ segments; the prefix check then rejects
  // anything that still points outside the served directory.
  const target = path.join(ROOT, pathname);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  return target;
}

// Lists the .ogg files directly inside `dir` (no recursion — trackmusic.js
// has no use for a nested taxonomy) as {name, size} pairs, exported for the
// invariant tests to drive against a throwaway fixture directory. Sorted by
// name for a stable response across requests — readdir's own order is
// filesystem-dependent, and trackmusic.js's shuffle (not this endpoint) is
// what's supposed to own playback order, not incidental directory order.
//
// A MISSING DIRECTORY RETURNS AN EMPTY LIST, never an error — see
// musictypes.js's own header: nothing has necessarily been dropped into
// assets/music/ yet (it isn't committed to the repo — see that directory's
// own README), and trackmusic.js's fallback to the procedural backend
// depends on this endpoint answering cleanly either way rather than a 404
// or 500 it would have to special-case.
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
  tracks.sort((a, b) => a.name.localeCompare(b.name));
  return tracks;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

async function sendMusicListing(req, res) {
  const tracks = await listMusicFiles(path.join(ROOT, MUSIC_DIR));
  const body = JSON.stringify(tracks);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  };
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  const pathname = decodePathname(req.url);
  if (pathname === null) return send(res, 400, 'Bad Request');

  // Exact-match routing only — anything that isn't precisely this string
  // (including a traversal attempt like /api/music/../secret) falls through
  // to the static file branch below, which already guards ROOT on its own.
  // MUSIC_DIR itself is never attacker-influenced (a fixed constant from
  // musictypes.js, not derived from the request), so there is no second
  // traversal surface here to guard beyond resolveTarget's own.
  if (pathname === MUSIC_LISTING_URL) return sendMusicListing(req, res);

  // No HTTP Range support: every track fetch trackmusic.js makes is
  // immediately handed whole to AudioContext.decodeAudioData(), which
  // requires a COMPLETE encoded file — there is no partial-buffer decode
  // API to stream into, so partial-content responses would have nothing
  // useful to serve them to. Revisit only if a future consumer needs to
  // seek within a track without decoding the whole thing first (an
  // <audio> element, say) — trackmusic.js today is not that consumer.
  let target = resolveTarget(pathname);
  if (target === null) return send(res, 400, 'Bad Request');

  try {
    let info = await stat(target);
    // Directory requests serve index.html, matching how the game is opened.
    if (info.isDirectory()) {
      target = path.join(target, 'index.html');
      info = await stat(target);
    }

    // no-store keeps a reload from replaying stale modules while editing source.
    const headers = {
      'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    };

    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      return res.end();
    }

    res.writeHead(200, headers);
    createReadStream(target).pipe(res);
  } catch {
    send(res, 404, 'Not Found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — is another server running?`);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});

// Only auto-start when run directly (`node tools/serve.js`, as play.bat
// does) — not when this module is imported, which would otherwise bind a
// real socket as a side effect of importing. Mirrors tools/car-editor/
// server.js's own isMainModule guard, added here so test/serve.test.js can
// import listMusicFiles()/the server itself and drive them directly.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMainModule) {
  server.listen(PORT, () => {
    console.log(`Serving ${ROOT} on http://localhost:${PORT}/  (Ctrl+C to stop)`);
  });
}

export { server, ROOT };
