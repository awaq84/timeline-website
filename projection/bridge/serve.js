/* serve.js — static server + live audio feed, no dependencies.
 *
 * Spawns miccap (which holds the microphone permission) and republishes its
 * band levels to the page as Server-Sent Events at /audio. SSE rather than a
 * WebSocket because the data only flows one way and EventSource needs no
 * handshake, no framing and no library.
 *
 * Serving the site from the same process keeps everything on one origin, so
 * there is nothing to configure in the page.
 *
 *   node bridge/serve.js [port]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.argv[2] || 8092);
const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(__dirname, 'miccap');

const clients = new Set();
let latest = { level: 0, bass: 0, mid: 0, treble: 0 };
let capOk = false;
let capErr = null;
let capWatch = null;

/* ---------- capture ---------- */
function startCapture() {
  if (!fs.existsSync(BIN)) {
    capErr = 'miccap not built — run: swiftc -O -o bridge/miccap bridge/miccap.swift';
    console.error('[bridge]', capErr);
    return;
  }
  const p = spawn(BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });

  let buf = '';
  p.stdout.on('data', chunk => {
    buf += chunk;
    // The tool emits one JSON object per line; a chunk may split a line.
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        latest = JSON.parse(line);
        capOk = true;
        const payload = `data: ${line}\n\n`;
        for (const res of clients) res.write(payload);
      } catch { /* partial or malformed line; skip */ }
    }
  });

  p.stderr.on('data', d => {
    const s = String(d).trim();
    console.error('[miccap]', s);
    if (/denied/i.test(s)) capErr = s;
  });

  /* Watchdog for a silently stalled capture.
   *
   * AVAudioEngine keeps the process alive but stops firing its tap when the
   * default input device changes or the machine wakes from sleep. The frames
   * keep arriving as exact zeros, so nothing looks broken from outside — the
   * bridge reports ok, the page stays connected, and every band reads zero
   * forever. Only an exact-zero run is treated as a stall; a genuinely silent
   * room still produces small non-zero noise. */
  let zeroRun = 0;
  const ZERO_LIMIT = 240;            // ~4s of frames at the tap's rate
  capWatch = setInterval(() => {
    if (latest.level === 0 && latest.bass === 0 && latest.mid === 0) zeroRun++;
    else zeroRun = 0;
    if (zeroRun > ZERO_LIMIT) {
      console.error('[bridge] capture stalled (all-zero) — restarting miccap');
      zeroRun = 0;
      try { p.kill('SIGKILL'); } catch {}
    }
  }, 250);

  p.on('exit', code => {
    clearInterval(capWatch);
    capOk = false;
    console.error('[bridge] miccap exited', code, '— retrying in 3s');
    setTimeout(startCapture, 3000);
  });
}

/* ---------- http ---------- */
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/audio') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(latest)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  /* Diagnostics sink. The page posts its own health here so it can be read
   * from the server log — the only way to see what a browser I cannot inspect
   * is actually doing. */
  if (url.pathname === '/diag' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4000) req.destroy(); });
    req.on('end', () => {
      console.log('[diag] ' + body.slice(0, 2000));
      res.writeHead(204).end();
    });
    return;
  }

  if (url.pathname === '/audio-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: capOk, error: capErr, clients: clients.size }));
    return;
  }

  // Static files, always uncached — this is a live-editing setup.
  let p = path.join(ROOT, decodeURIComponent(url.pathname));
  if (url.pathname === '/' || url.pathname === '') p = path.join(ROOT, 'index.html');
  if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }

  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] http://localhost:${PORT}/   (audio feed at /audio)`);
  startCapture();
});
