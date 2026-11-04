// Test helpers: start Vinyl's server, drive real Chrome over the DevTools protocol, and answer
// every outside request (YouTube, titles, lyrics, fonts) with local stand-ins so tests are
// fast, repeatable and work offline / on CI.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE_YT = readFileSync(path.join(HERE, 'fake-youtube.js'), 'utf8');
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==';
const FAKE_QR = 'window.qrcode=function(){return{addData:function(){},make:function(){},createDataURL:function(){return "data:image/gif;base64,R0lGODlhAQABAAAAACw="}}};';

/* ---------------- server ---------------- */
export async function startServer(extraEnv = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(port), VINYL_HTTPS: '0', VINYL_CONFIG: path.join(HERE, 'no-config.json'), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    const url = `http://localhost:${port}`;
    for (let i = 0; i < 50; i++) {
      if (proc.exitCode !== null) break;
      try { if ((await fetch(url + '/healthz')).ok) return { url, port, proc, log: () => out, stop: () => proc.kill() }; } catch { /* not up yet */ }
      await sleep(100);
    }
    proc.kill();
    if (!/busy/.test(out)) throw new Error('server did not start:\n' + out);
  }
  throw new Error('no free port');
}

/* ---------------- tiny SSE client for API tests ---------------- */
export function sse(url) {
  const events = [];
  const waiters = [];
  const ctrl = new AbortController();
  const ready = fetch(url, { signal: ctrl.signal }).then(async (res) => {
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw Object.assign(new Error(j.error || res.status), { status: res.status, body: j }); }
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
            if (!ev || data === undefined) continue;
            const item = { event: ev, data: JSON.parse(data) };
            events.push(item);
            for (const w of [...waiters]) if (w.test(item)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(item); }
          }
        }
      } catch { /* closed */ }
    })();
    return res;
  });
  return {
    ready, events,
    next(event, test = () => true, timeout = 5000) {
      const hit = events.find((e) => e.event === event && test(e.data) && !e.used);
      if (hit) { hit.used = true; return Promise.resolve(hit.data); }
      return new Promise((resolve, reject) => {
        const w = { test: (e) => e.event === event && test(e.data), resolve: (e) => { e.used = true; clearTimeout(t); resolve(e.data); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timed out waiting for "${event}"`)); }, timeout);
        waiters.push(w);
      });
    },
    close: () => ctrl.abort(),
  };
}
export async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/* ---------------- Chrome ---------------- */
function findChrome() {
  const list = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const found = list.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH.');
  return found;
}

// Responses for outside requests. `lyrics` may be set per page: { synced: '[00:01.00] ...' }.
function stubFor(url, page) {
  const u = new URL(url);
  const js = (body) => ({ code: 200, type: 'text/javascript', body });
  const json = (obj, code = 200) => ({ code, type: 'application/json', body: JSON.stringify(obj) });
  if (u.hostname === 'www.youtube.com' && u.pathname === '/iframe_api') return js(FAKE_YT);
  if (u.hostname === 'www.youtube.com' && u.pathname === '/oembed' || u.hostname === 'noembed.com') {
    const target = new URL(u.searchParams.get('url') || 'https://x/');
    const v = target.searchParams.get('v'), list = target.searchParams.get('list');
    return json(v ? { title: `Song ${v}`, author_name: 'Fake Artist - Topic' } : { title: `Playlist ${list}`, author_name: 'Someone' });
  }
  if (u.hostname === 'i.ytimg.com' || u.hostname.endsWith('scdn.co')) return { code: 200, type: 'image/png', body: Buffer.from(PNG_1PX, 'base64'), raw: true };
  if (u.hostname === 'lrclib.net') {
    if (!page.lyrics) return json({ message: 'not found' }, 404);
    if (u.pathname === '/api/get') return json({ syncedLyrics: page.lyrics.synced, plainLyrics: page.lyrics.plain || '', duration: page.lyrics.duration || 180 });
    return json([]);
  }
  if (u.hostname === 'cdnjs.cloudflare.com' && /qrcode/.test(u.pathname)) return js(FAKE_QR);
  if (u.hostname === 'fonts.googleapis.com') return { code: 200, type: 'text/css', body: '' };
  if (u.pathname.endsWith('/sw.js')) return { code: 404, type: 'text/plain', body: '' }; // no offline cache in tests
  return null;
}

// Start Chrome and connect to it. A cold CI machine can take a while to start the first Chrome,
// so wait up to 30 seconds, and try once more with a fresh port and profile if it doesn't come up.
async function launchChrome(name, width, height, fakeMedia) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const port = 9300 + Math.floor(Math.random() * 600);
    const dir = mkdtempSync(path.join(tmpdir(), `vinyl-${name}-`));
    const args = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, `--window-size=${width},${height}`,
      '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      ...(fakeMedia ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] : []),
      ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), 'about:blank'];
    const proc = spawn(findChrome(), args, { stdio: 'ignore' });
    const end = Date.now() + 30000;
    while (Date.now() < end && proc.exitCode === null) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        const p = list.find((t) => t.type === 'page');
        if (p) return { proc, dir, ws: new WebSocket(p.webSocketDebuggerUrl) };
      } catch { /* starting */ }
      await sleep(200);
    }
    proc.kill();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  throw new Error('Chrome did not start');
}

export async function browser({ name = 'b', width = 1280, height = 860, fakeMedia = false } = {}) {
  const { proc, dir, ws } = await launchChrome(name, width, height, fakeMedia);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0;
  const pending = new Map(), errors = [];
  const page = { errors, lyrics: null };
  const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description?.split('\n')[0] || d.params.exceptionDetails.text);
    if (d.method === 'Fetch.requestPaused') {
      const { requestId, request } = d.params;
      const s = stubFor(request.url, page);
      if (!s) { send('Fetch.failRequest', { requestId, errorReason: 'Failed' }); return; }
      const body = s.raw ? s.body.toString('base64') : Buffer.from(s.body).toString('base64');
      send('Fetch.fulfillRequest', { requestId, responseCode: s.code, body,
        responseHeaders: [{ name: 'Content-Type', value: s.type }, { name: 'Access-Control-Allow-Origin', value: '*' }] });
    }
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  // Outside services get a local answer (or fail fast); Vinyl's own server goes straight through.
  if (!process.env.NO_STUBS) await send('Fetch.enable', { patterns: [
    '*://www.youtube.com/*', '*://noembed.com/*', '*://i.ytimg.com/*', '*://*.scdn.co/*', '*://lrclib.net/*',
    '*://cdnjs.cloudflare.com/*', '*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*', '*://accounts.google.com/*',
    '*://sdk.scdn.co/*', '*://api.spotify.com/*', '*/sw.js',
  ].map((urlPattern) => ({ urlPattern, requestStage: 'Request' })) });

  Object.assign(page, {
    send,
    async ev(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error('page error: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
      return r.result?.result?.value;
    },
    async open(url) {
      await send('Page.navigate', { url });
      await page.waitFor('typeof ytReady !== "undefined" && ytReady && helperReady', 15000);
    },
    async waitFor(expr, timeout = 8000, every = 100) {
      const end = Date.now() + timeout;
      let last;
      while (Date.now() < end) {
        try { last = await page.ev(expr); if (last) return last; } catch (e) { last = e.message; }
        await sleep(every);
      }
      throw new Error(`timed out waiting for: ${expr} (last: ${JSON.stringify(last)})`);
    },
    async mouse(type, x, y) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    },
    async key(type, key) {
      await send('Input.dispatchKeyEvent', { type, key, code: `Key${key.toUpperCase()}`, text: type === 'keyDown' ? key : undefined });
    },
    async close() {
      try { ws.close(); } catch { /* ignore */ }
      proc.kill();
      await sleep(300);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* chrome may still hold files */ }
    },
  });
  return page;
}
