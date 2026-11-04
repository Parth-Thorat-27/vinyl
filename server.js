// Tiny zero-dependency server for Vinyl.
//  - Serves ./public on every network interface so phones/tablets on the same Wi-Fi can open it.
//  - Relays private listening rooms (Server-Sent Events down, small POSTs up).
//  - Optionally opens a temporary public https link with Cloudflare's free "quick tunnel"
//    (needs cloudflared installed) so friends outside your Wi-Fi can join a room.
//   node server.js            -> port 7733
//   set PORT=3000 && node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 7733;
const ROOT = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// YouTube refuses to play embeds on pages served from a bare IP address ("This video is
// unavailable"), so phones get a hostname instead: sslip.io is a free public DNS name that
// simply points back at the IP inside it (192-168-0-5.sslip.io -> 192.168.0.5).
// The PC's own .local name and the raw IP are listed as fallbacks.
function lanIps() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal && !i.address.startsWith('169.254.'))
    .map((i) => i.address);
}
function lanUrls() {
  const ips = lanIps();
  if (!ips.length) return [];
  return [
    ...ips.map((ip) => `http://${ip.replace(/\./g, '-')}.sslip.io:${PORT}`),
    `http://${os.hostname().toLowerCase()}.local:${PORT}`,
    ...ips.map((ip) => `http://${ip}:${PORT}`),
  ];
}

/* A request is "from this PC" only if it hits a loopback address directly,
   not through the Cloudflare tunnel (which also connects from 127.0.0.1). */
function isLocalAdmin(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  const ip = req.socket.remoteAddress || '';
  return ['localhost', '127.0.0.1', '[::1]'].includes(host)
    && /^(::1|127\.|::ffff:127\.)/.test(ip)
    && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];
}
const viaTunnel = (req) => !!req.headers['cf-connecting-ip'] || /trycloudflare\.com$/.test((req.headers.host || '').replace(/:\d+$/, ''));

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const rid = (n) => crypto.randomBytes(n).toString('base64url');
const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

/* ---------------- listening rooms ---------------- */
const rooms = new Map(); // id -> room
const MAX_ROOMS = 50, MAX_MEMBERS = 30, HOST_GRACE_MS = 3 * 60 * 1000;

function memberList(room) {
  return [...room.members.values()].map((m) => ({ id: m.id, name: m.name, host: m.id === room.hostClient, online: m.streams.size > 0, voice: m.voice || null }))
    .filter((m) => m.online || m.host);
}
function emit(m, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of m.streams) res.write(msg);
}
function broadcast(room, event, data, except) {
  for (const m of room.members.values()) if (m.id !== except) emit(m, event, data);
}
function closeRoom(room, reason) {
  broadcast(room, 'closed', { reason });
  for (const m of room.members.values()) for (const res of m.streams) res.end();
  clearTimeout(room.hostTimer);
  rooms.delete(room.id);
}
function settingsOf(room) { return { name: room.name, locked: room.locked, allowControl: room.allowControl, allowAdd: room.allowAdd }; }

async function handleRooms(req, res, parts) {
  // POST /api/rooms  -> create
  if (parts.length === 0 && req.method === 'POST') {
    if (rooms.size >= MAX_ROOMS) return sendJson(res, 503, { error: 'Too many rooms open on this server.' });
    const body = await readBody(req);
    const room = {
      id: rid(16), hostToken: rid(24), hostClient: clean(body.client, 40) || rid(8),
      name: clean(body.name, 60) || 'Listening room',
      locked: false, allowControl: false, allowAdd: true, state: null, chat: [], members: new Map(), banned: new Set(), hostTimer: null,
    };
    rooms.set(room.id, room);
    // Close rooms whose host never connects.
    room.hostTimer = setTimeout(() => { if (!room.members.get(room.hostClient)?.streams.size) closeRoom(room, 'The host left.'); }, HOST_GRACE_MS);
    return sendJson(res, 200, { room: room.id, hostToken: room.hostToken, name: room.name });
  }
  const room = rooms.get(parts[0]);
  if (!room) return sendJson(res, 404, { error: 'This room has ended or the link is wrong.' });

  // GET /api/rooms/:id  -> peek (for the join screen)
  if (parts.length === 1 && req.method === 'GET') {
    const host = room.members.get(room.hostClient);
    return sendJson(res, 200, { name: room.name, host: host?.name || 'Host', listeners: memberList(room).length, locked: room.locked });
  }

  // GET /api/rooms/:id/events?client=&name=&host=  -> SSE stream
  if (parts[1] === 'events' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const client = clean(q.get('client'), 40), name = clean(q.get('name'), 30) || 'Listener';
    const isHost = q.get('host') === room.hostToken;
    if (!client) return sendJson(res, 400, { error: 'missing client' });
    if (isHost && client !== room.hostClient) room.hostClient = client;
    if (!isHost && client === room.hostClient) return sendJson(res, 403, { error: 'forbidden' });
    let m = room.members.get(client);
    if (!isHost && room.banned.has(client)) return sendJson(res, 403, { error: 'The host removed you from this room.' });
    if (!m && !isHost && room.locked) return sendJson(res, 403, { error: 'The host has locked this room.' });
    if (!m && room.members.size >= MAX_MEMBERS) return sendJson(res, 403, { error: 'This room is full.' });

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    if (!m) { m = { id: client, name, streams: new Set() }; room.members.set(client, m); }
    m.name = name;
    const wasOnline = m.streams.size > 0;
    m.streams.add(res);
    if (isHost) clearTimeout(room.hostTimer);
    emit(m, 'hello', { you: client, isHost, settings: settingsOf(room), state: room.state, members: memberList(room), chat: room.chat, now: Date.now() });
    if (!wasOnline) {
      broadcast(room, 'members', memberList(room), client);
      if (!isHost) broadcast(room, 'notice', { text: `${name} joined` }, client);
    }
    const ping = setInterval(() => res.write(`event: ping\ndata: ${Date.now()}\n\n`), 20000);
    req.on('close', () => {
      clearInterval(ping);
      m.streams.delete(res);
      if (!rooms.has(room.id) || m.streams.size) return;
      m.voice = null; // voice connections die with the stream; the client re-announces when it's back
      broadcast(room, 'members', memberList(room));
      if (client === room.hostClient) {
        // Give the host a few minutes to come back (page reload, flaky Wi-Fi).
        room.hostTimer = setTimeout(() => closeRoom(room, 'The host left.'), HOST_GRACE_MS);
      } else {
        // Short grace period so a reconnecting listener keeps their place (even in a locked room).
        setTimeout(() => {
          if (m.streams.size || !rooms.has(room.id) || room.members.get(client) !== m) return;
          room.members.delete(client);
          broadcast(room, 'members', memberList(room));
          broadcast(room, 'notice', { text: `${m.name} left` });
        }, 30000);
      }
    });
    return;
  }

  // POST /api/rooms/:id/send  { client, host?, type, data }
  if (parts[1] === 'send' && req.method === 'POST') {
    const body = await readBody(req);
    const client = clean(body.client, 40);
    const m = room.members.get(client);
    if (!m) return sendJson(res, 403, { error: 'Not in this room.' });
    const isHost = body.host === room.hostToken && client === room.hostClient;
    const data = body.data || {};
    switch (body.type) {
      case 'state':
        if (!isHost) return sendJson(res, 403, { error: 'Only the host can do that.' });
        // Merge, so the queue (only re-sent when it changes) stays available for late joiners.
        room.state = { ...room.state, ...data, at: Date.now() };
        broadcast(room, 'state', { state: room.state, now: Date.now() }, client);
        break;
      case 'chat': {
        const text = clean(data.text, 500);
        if (!text) break;
        // The host can post neutral room notices (e.g. "Riya added a song").
        const msg = data.system && isHost ? { from: 'room', name: '', text, at: Date.now(), system: true } : { from: client, name: m.name, text, at: Date.now() };
        room.chat.push(msg); if (room.chat.length > 60) room.chat.shift();
        broadcast(room, 'chat', msg);
        break;
      }
      case 'cmd': // a listener asks the host to do something (only if the host allows it)
        if (data.action === 'add' ? !(room.allowAdd || room.allowControl) : !room.allowControl) {
          return sendJson(res, 403, { error: data.action === 'add' ? "The host isn't taking song requests right now." : 'Only the host controls playback.' });
        }
        emit(room.members.get(room.hostClient) || { streams: new Set() }, 'cmd', { from: client, name: m.name, ...data });
        break;
      case 'settings':
        if (!isHost) return sendJson(res, 403, { error: 'Only the host can do that.' });
        if (typeof data.locked === 'boolean') room.locked = data.locked;
        if (typeof data.allowControl === 'boolean') room.allowControl = data.allowControl;
        if (typeof data.allowAdd === 'boolean') room.allowAdd = data.allowAdd;
        if (data.name) room.name = clean(data.name, 60);
        broadcast(room, 'settings', settingsOf(room));
        break;
      case 'voice': // joined / left / muted in voice chat
        m.voice = data.on ? { mic: !!data.mic, muted: !!data.muted } : null;
        broadcast(room, 'members', memberList(room));
        break;
      case 'signal': { // WebRTC offer/answer/ICE for one other member; the audio itself goes peer-to-peer
        const target = room.members.get(clean(data.to, 40));
        if (!target || target.id === client) return sendJson(res, 404, { error: 'gone' });
        emit(target, 'signal', { from: client, data: data.payload });
        break;
      }
      case 'kick': {
        if (!isHost) return sendJson(res, 403, { error: 'Only the host can do that.' });
        const target = room.members.get(clean(data.client, 40));
        if (target && target.id !== room.hostClient) {
          room.banned.add(target.id);
          emit(target, 'kicked', {});
          for (const s of target.streams) s.end();
          room.members.delete(target.id);
          broadcast(room, 'members', memberList(room));
        }
        break;
      }
      case 'close':
        if (!isHost) return sendJson(res, 403, { error: 'Only the host can do that.' });
        closeRoom(room, 'The host ended the room.');
        break;
      default:
        return sendJson(res, 400, { error: 'unknown type' });
    }
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'not found' });
}

/* ---------------- optional public link (Cloudflare quick tunnel) ---------------- */
const share = { url: null, proc: null, starting: false, error: null };
function cloudflaredPath() {
  const candidates = [
    process.env.CLOUDFLARED,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // Fall back to PATH lookup.
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const exe of ['cloudflared.exe', 'cloudflared']) { const p = path.join(dir, exe); if (dir && fs.existsSync(p)) return p; }
  }
  return null;
}
function startShare() {
  if (share.url || share.starting) return;
  const bin = cloudflaredPath();
  if (!bin) { share.error = 'missing'; return; }
  share.starting = true; share.error = null;
  const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { windowsHide: true });
  share.proc = proc;
  const onData = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !share.url) {
      share.url = m[0]; share.starting = false;
      console.log(`\n  Public link (anyone with a room link can join): ${share.url}\n`);
    }
  };
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  proc.on('exit', () => { share.url = null; share.starting = false; share.proc = null; });
  proc.on('error', () => { share.error = 'failed'; share.starting = false; });
  setTimeout(() => { if (share.starting) { share.starting = false; share.error = 'timeout'; proc.kill(); } }, 45000);
}
function stopShare() { if (share.proc) share.proc.kill(); share.url = null; share.starting = false; }
process.on('exit', stopShare);
process.on('SIGINT', () => { stopShare(); process.exit(0); });

async function handleShare(req, res, action) {
  if (!isLocalAdmin(req)) return sendJson(res, 403, { error: 'Only available on the PC running Vinyl.' });
  if (action === 'start' && req.method === 'POST') startShare();
  if (action === 'stop' && req.method === 'POST') stopShare();
  return sendJson(res, 200, { url: share.url, starting: share.starting, available: !!cloudflaredPath(), error: share.error });
}

/* ---------------- http ---------------- */
http.createServer(async (req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }

  try {
    if (p.startsWith('/api/rooms')) return await handleRooms(req, res, p.slice('/api/rooms'.length).split('/').filter(Boolean));
    if (p.startsWith('/api/share')) return await handleShare(req, res, p.split('/')[3]);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  if (p === '/lan.json') {
    if (viaTunnel(req)) return sendJson(res, 404, []);
    return sendJson(res, 200, lanUrls());
  }
  if (p.endsWith('/')) p += 'index.html';

  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log('\n  Vinyl is running\n');
  console.log(`  On this PC:        http://localhost:${PORT}`);
  const lan = lanUrls();
  if (lan.length) {
    console.log(`  Phone / tablet:    ${lan[0]}   (same Wi-Fi)`);
    console.log(`  If that won't load: ${lan.slice(1, -1).join('  or  ')}`);
  }
  console.log(`\n  Listening rooms are on. ${cloudflaredPath() ? 'Friends outside your Wi-Fi can join once you turn on "Share over the internet" in a room.' : 'Install cloudflared to let friends outside your Wi-Fi join (see README).'}`);
  console.log('\n  Keep this window open while listening. Press Ctrl+C to stop.\n');
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE' || e.code === 'EACCES') console.error(`\n  Port ${PORT} is busy. Vinyl may already be running: open http://localhost:${PORT}\n`);
  else console.error(e);
  process.exit(1);
});
