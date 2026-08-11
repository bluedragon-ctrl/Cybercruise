// Minimal static file server for Cybercruise.
//
// The game is native ES modules, so it cannot run from a file:// path — it needs
// a real HTTP origin. This uses only Node built-ins on purpose: the project has
// zero dependencies, and shelling out to `npx http-server` made starting the game
// depend on a working npm install (a missing %APPDATA%\npm broke play.bat outright).
//
// Usage:  node tools/serve.js [port]      (default 5173)

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PORT = Number(process.argv[2]) || 5173;

// Serve the repository root — this file lives in tools/, so go up one level.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/** Map a request URL to a file inside ROOT, or null if it escapes the root. */
function resolveTarget(requestUrl) {
  // Strip query/hash, then decode %20 and friends. A malformed escape is a 400.
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }

  // path.join normalises away any ../ segments; the prefix check then rejects
  // anything that still points outside the served directory.
  const target = path.join(ROOT, pathname);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  return target;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  let target = resolveTarget(req.url);
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

server.listen(PORT, () => {
  console.log(`Serving ${ROOT} on http://localhost:${PORT}/  (Ctrl+C to stop)`);
});
