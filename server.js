// Tiny zero-dependency server for Vinyl.
//  - Serves ./public on every network interface so phones/tablets on the same Wi-Fi can open it,
//    over http and (with a self-made certificate) https, so phones can use their mic in voice chat.
//  - Relays private listening rooms (Server-Sent Events down, small POSTs up), with rate limits.
//  - Hands out voice-chat relay (TURN) settings when configured, so voice works on strict networks.
//  - Optionally opens a temporary public https link with Cloudflare's free "quick tunnel"
//    (needs cloudflared installed) so friends outside your Wi-Fi can join a room.
//  - Runs as-is on cloud hosts (Render, Fly.io, Railway): set VINYL_CLOUD=1 or let it detect them.
//
//   node server.js                 -> http on 7733, https on 7734
//   set PORT=3000 && node server.js
// Settings come from environment variables or vinyl.config.json (see vinyl.config.example.json).
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

/* ---------------- settings ---------------- */
function loadConfig() {
  const file = process.env.VINYL_CONFIG || path.join(__dirname, 'vinyl.config.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
const CFG = loadConfig();
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const CLOUD = env('VINYL_CLOUD', '') === '1' || !!(process.env.RENDER || process.env.FLY_APP_NAME || process.env.RAILWAY_ENVIRONMENT);
const PORT = Number(env('PORT', CFG.port || 7733));
const HTTPS_PORT = Number(env('HTTPS_PORT', CFG.httpsPort || PORT + 1));
const HTTPS_ON = !CLOUD && env('VINYL_HTTPS', CFG.https === false ? '0' : '1') !== '0';
const TURN = {
  urls: env('TURN_URLS', (CFG.turn?.urls || []).join(',')).split(',').map((s) => s.trim()).filter(Boolean),
  username: env('TURN_USERNAME', CFG.turn?.username || ''),
  credential: env('TURN_CREDENTIAL', CFG.turn?.credential || ''),
  meteredApp: env('METERED_APP', CFG.meteredApp || ''),
  meteredKey: env('METERED_API_KEY', CFG.meteredApiKey || ''),
  cfKeyId: env('CF_TURN_KEY_ID', CFG.cloudflareTurnKeyId || ''),
  cfToken: env('CF_TURN_API_TOKEN', CFG.cloudflareTurnApiToken || ''),
};
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

/* ---------------- addresses ---------------- */
// YouTube refuses to play embeds on pages served from a bare IP address ("This video is
// unavailable"), so phones get a hostname instead: sslip.io is a free public DNS name that
// simply points back at the IP inside it (192-168-0-5.sslip.io -> 192.168.0.5).
// The PC's own .local name and the raw IP are listed as fallbacks.
function lanIps() {
  if (CLOUD) return [];
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal && !i.address.startsWith('169.254.'))
    .map((i) => i.address);
}
const sslipName = (ip) => `${ip.replace(/\./g, '-')}.sslip.io`;
const localName = () => `${os.hostname().toLowerCase()}.local`;
function lanUrls(scheme = 'http', port = PORT) {
  const ips = lanIps();
  if (!ips.length) return [];
  return [
    ...ips.map((ip) => `${scheme}://${sslipName(ip)}:${port}`),
    `${scheme}://${localName()}:${port}`,
    ...ips.map((ip) => `${scheme}://${ip}:${port}`),
  ];
}

const hostOf = (req) => (req.headers.host || '').replace(/:\d+$/, '');
const viaTunnel = (req) => !!req.headers['cf-connecting-ip'] || /trycloudflare\.com$/.test(hostOf(req));
/* A request is "from this PC" only if it hits a loopback address directly,
   not through the Cloudflare tunnel (which also connects from 127.0.0.1). */
function isLocalAdmin(req) {
  const ip = req.socket.remoteAddress || '';
  return !CLOUD && ['localhost', '127.0.0.1', '[::1]'].includes(hostOf(req))
    && /^(::1|127\.|::ffff:127\.)/.test(ip)
    && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];
}
function clientIp(req) {
  if (req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']);
  if (CLOUD && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

/* ---------------- helpers ---------------- */
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
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* ---------------- abuse protection: token buckets ---------------- */
const buckets = new Map();
// Allow `burst` actions at once, refilling `perSec` per second. Returns false when over the limit.
function allow(key, burst, perSec, cost = 1) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { tokens: burst, at: now }; buckets.set(key, b); }
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSec);
  b.at = now;
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  return true;
}
setInterval(() => { const old = Date.now() - 30 * 60 * 1000; for (const [k, b] of buckets) if (b.at < old) buckets.delete(k); }, 10 * 60 * 1000).unref();
const LIMITS = { // per member: [burst, refill per second]
  chat: [8, 1], react: [12, 2], cmd: [15, 1], vote: [6, 0.5], signal: [300, 60], state: [40, 5],
  voice: [10, 1], settings: [20, 2], kick: [10, 0.5], handoff: [5, 0.2], tell: [20, 2], close: [3, 0.1],
};
const slowDown = (res) => sendJson(res, 429, { error: 'Slow down a little and try again in a moment.' });
const sseByIp = new Map();
const MAX_SSE_PER_IP = 40;

/* ---------------- listening rooms ---------------- */
const rooms = new Map(); // id -> room
const MAX_ROOMS = Number(env('MAX_ROOMS', 50)), MAX_MEMBERS = 30;
const HOST_GRACE_MS = Number(env('HOST_GRACE_MS', 60 * 1000)); // host may reload / reconnect within this time
const EMPTY_ROOM_MS = 3 * 60 * 1000;
const REACTIONS = ['🔥', '❤️', '😂', '👏', '🎉', '😮', '💃', '🙌'];

// Each member has a private client id (their key to the room, never shared) and a public id
// that others see, derived from it, so nobody can act in someone else's name.
const pubId = (room, secret) => crypto.createHash('sha256').update(`${room.id}:${secret}`).digest('base64url').slice(0, 12);
const byPub = (room, pub) => [...room.members.values()].find((x) => x.pub === pub);
function memberList(room) {
  return [...room.members.values()].map((m) => ({ id: m.pub, name: m.name, host: m.id === room.hostClient, online: m.streams.size > 0, voice: m.voice || null }))
    .filter((m) => m.online || m.host);
}
function emit(m, event, data) {
  if (!m) return;
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
function settingsOf(room) {
  return {
    name: room.name, locked: room.locked, allowControl: room.allowControl, allowAdd: room.allowAdd,
    voteSkip: room.voteSkip, requestLimit: room.requestLimit, hasPin: !!room.pin,
  };
}
// Which song is playing right now, as far as votes are concerned.
const trackKey = (room) => (room.state?.track ? `${(room.state.from || 0) + (room.state.index || 0)}:${room.state.track.id}` : '');
function listenersOnline(room) {
  return [...room.members.values()].filter((m) => m.streams.size && m.id !== room.hostClient).length;
}
function voteStatus(room) {
  const needed = Math.max(1, Math.floor(listenersOnline(room) / 2) + 1);
  return { count: room.votes.key === trackKey(room) ? room.votes.ids.size : 0, needed, key: trackKey(room) };
}
function resetVotes(room) { room.votes = { key: trackKey(room), ids: new Set() }; }
// Make someone else the host (the host handed over, or left and didn't come back).
function promote(room, target, reason) {
  const old = room.members.get(room.hostClient);
  room.hostToken = rid(24);
  room.hostClient = target.id;
  clearTimeout(room.hostTimer);
  emit(target, 'promoted', { hostToken: room.hostToken, pin: room.pin || '' });
  if (old && old.id !== target.id) emit(old, 'demoted', {});
  resetVotes(room);
  broadcast(room, 'members', memberList(room));
  broadcast(room, 'notice', { text: reason || `${target.name} is now the host` });
}
function onHostGone(room) {
  // Keep the music going: hand the room to someone who's still here.
  const next = [...room.members.values()].find((m) => m.id !== room.hostClient && m.streams.size);
  if (next) promote(room, next, `The host left, so ${next.name} is now the host`);
  else closeRoom(room, 'The host left.');
}

async function handleRooms(req, res, parts) {
  const ip = clientIp(req);
  // POST /api/rooms  -> create
  if (parts.length === 0 && req.method === 'POST') {
    if (!allow(`create:${ip}`, 5, 1 / 120)) return sendJson(res, 429, { error: "You've opened a lot of rooms. Wait a couple of minutes and try again." });
    if (rooms.size >= MAX_ROOMS) return sendJson(res, 503, { error: 'Too many rooms open on this server.' });
    const body = await readBody(req, 8 * 1024);
    const room = {
      id: rid(16), hostToken: rid(24), hostClient: clean(body.client, 40) || rid(8),
      name: clean(body.name, 60) || 'Listening room',
      locked: false, allowControl: false, allowAdd: true, voteSkip: true, requestLimit: 5, pin: '',
      state: null, chat: [], members: new Map(), banned: new Set(), hostTimer: null, votes: { key: '', ids: new Set() },
    };
    rooms.set(room.id, room);
    // Close rooms whose host never connects.
    room.hostTimer = setTimeout(() => { if (!room.members.get(room.hostClient)?.streams.size) closeRoom(room, 'The host left.'); }, EMPTY_ROOM_MS);
    return sendJson(res, 200, { room: room.id, hostToken: room.hostToken, name: room.name });
  }
  if (!allow(`peek:${ip}`, 60, 3)) return slowDown(res);
  const room = rooms.get(parts[0]);
  if (!room) return sendJson(res, 404, { error: 'This room has ended or the link is wrong.' });

  // GET /api/rooms/:id  -> peek (for the join screen)
  if (parts.length === 1 && req.method === 'GET') {
    const host = room.members.get(room.hostClient);
    return sendJson(res, 200, { name: room.name, host: host?.name || 'Host', listeners: memberList(room).length, locked: room.locked, pin: !!room.pin });
  }

  // POST /api/rooms/:id/check {pin}  -> is this PIN right? (limited, so it can't be guessed)
  if (parts[1] === 'check' && req.method === 'POST') {
    const body = await readBody(req, 4 * 1024);
    if (!room.pin || sameSecret(body.pin, room.pin)) return sendJson(res, 200, { ok: true });
    if (!allow(`pin:${ip}:${room.id}`, 5, 1 / 120)) return sendJson(res, 429, { error: 'Too many wrong PINs. Wait a few minutes and try again.' });
    return sendJson(res, 403, { error: "That PIN isn't right.", needPin: true });
  }

  // GET /api/rooms/:id/events?client=&name=&host=&pin=  -> SSE stream
  if (parts[1] === 'events' && req.method === 'GET') {
    if (!allow(`sse:${ip}`, 30, 0.5)) return slowDown(res);
    if ((sseByIp.get(ip) || 0) >= MAX_SSE_PER_IP) return slowDown(res);
    const q = new URL(req.url, 'http://x').searchParams;
    const client = clean(q.get('client'), 40), name = clean(q.get('name'), 30) || 'Listener';
    const isHost = sameSecret(q.get('host'), room.hostToken);
    if (!client) return sendJson(res, 400, { error: 'missing client' });
    if (isHost && client !== room.hostClient) room.hostClient = client;
    if (!isHost && client === room.hostClient) return sendJson(res, 403, { error: 'forbidden' });
    let m = room.members.get(client);
    if (!isHost && room.banned.has(client)) return sendJson(res, 403, { error: 'The host removed you from this room.' });
    if (!m && !isHost && room.locked) return sendJson(res, 403, { error: 'The host has locked this room.' });
    if (!m && !isHost && room.pin && !sameSecret(q.get('pin'), room.pin)) {
      allow(`pin:${ip}:${room.id}`, 5, 1 / 120);
      return sendJson(res, 403, { error: 'This room needs a PIN.', needPin: true });
    }
    if (!m && room.members.size >= MAX_MEMBERS) return sendJson(res, 403, { error: 'This room is full.' });

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    sseByIp.set(ip, (sseByIp.get(ip) || 0) + 1);
    if (!m) { m = { id: client, pub: pubId(room, client), name, streams: new Set() }; room.members.set(client, m); }
    m.name = name;
    const wasOnline = m.streams.size > 0;
    m.streams.add(res);
    if (isHost) clearTimeout(room.hostTimer);
    emit(m, 'hello', {
      you: m.pub, isHost, settings: settingsOf(room), pin: isHost ? room.pin : undefined,
      state: room.state, members: memberList(room), chat: room.chat, votes: voteStatus(room), now: Date.now(),
    });
    if (!wasOnline) {
      broadcast(room, 'members', memberList(room), client);
      broadcast(room, 'votes', voteStatus(room));
      if (!isHost) broadcast(room, 'notice', { text: `${name} joined` }, client);
    }
    const ping = setInterval(() => res.write(`event: ping\ndata: ${Date.now()}\n\n`), 20000);
    res.on('close', () => {
      clearInterval(ping);
      sseByIp.set(ip, Math.max(0, (sseByIp.get(ip) || 1) - 1));
      m.streams.delete(res);
      if (!rooms.has(room.id) || m.streams.size) return;
      m.voice = null; // voice connections die with the stream; the client re-announces when it's back
      broadcast(room, 'members', memberList(room));
      if (client === room.hostClient) {
        // Give the host a minute to come back (page reload, flaky Wi-Fi), then hand the room on.
        room.hostTimer = setTimeout(() => { if (rooms.has(room.id) && !room.members.get(room.hostClient)?.streams.size) onHostGone(room); }, HOST_GRACE_MS);
      } else {
        // Short grace period so a reconnecting listener keeps their place (even in a locked room).
        setTimeout(() => {
          if (m.streams.size || !rooms.has(room.id) || room.members.get(client) !== m) return;
          room.members.delete(client);
          room.votes.ids.delete(client);
          broadcast(room, 'members', memberList(room));
          broadcast(room, 'votes', voteStatus(room));
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
    const [burst, rate] = LIMITS[body.type] || [10, 1];
    if (!allow(`send:${room.id}:${client}:${body.type}`, burst, rate)) return slowDown(res);
    const isHost = sameSecret(body.host, room.hostToken) && client === room.hostClient;
    const data = body.data || {};
    const hostOnly = () => sendJson(res, 403, { error: 'Only the host can do that.' });
    switch (body.type) {
      case 'state': {
        if (!isHost) return hostOnly();
        // Merge, so the queue (only re-sent when it changes) stays available for late joiners.
        const before = trackKey(room);
        room.state = { ...room.state, ...data, at: Date.now() };
        broadcast(room, 'state', { state: room.state, now: Date.now() }, client);
        if (trackKey(room) !== before) { resetVotes(room); broadcast(room, 'votes', voteStatus(room)); }
        break;
      }
      case 'chat': {
        const text = clean(data.text, 500);
        if (!text) break;
        // The host can post neutral room notices (e.g. "Riya added a song").
        const msg = data.system && isHost ? { from: 'room', name: '', text, at: Date.now(), system: true } : { from: m.pub, name: m.name, text, at: Date.now() };
        room.chat.push(msg); if (room.chat.length > 60) room.chat.shift();
        broadcast(room, 'chat', msg);
        break;
      }
      case 'react': {
        if (!REACTIONS.includes(data.emoji)) return sendJson(res, 400, { error: 'unknown reaction' });
        broadcast(room, 'react', { from: m.pub, name: m.name, emoji: data.emoji });
        break;
      }
      case 'vote': { // vote to skip the current song
        if (!room.voteSkip) return sendJson(res, 403, { error: 'Vote to skip is off in this room.' });
        if (isHost) return sendJson(res, 400, { error: 'You are the host: just skip.' });
        const key = trackKey(room);
        if (!key) break;
        if (room.votes.key !== key) resetVotes(room);
        if (data.on === false) room.votes.ids.delete(client); else room.votes.ids.add(client);
        const v = voteStatus(room);
        broadcast(room, 'votes', v);
        if (v.count >= v.needed) {
          emit(room.members.get(room.hostClient), 'cmd', { from: 'vote', name: 'The room', action: 'next', key });
          room.votes = { key: `skipped:${key}`, ids: new Set() };
          broadcast(room, 'notice', { text: 'Skipped by vote' });
        }
        break;
      }
      case 'cmd': // a listener asks the host to do something (only if the host allows it)
        if (data.action === 'add' ? !(room.allowAdd || room.allowControl) : !room.allowControl) {
          return sendJson(res, 403, { error: data.action === 'add' ? "The host isn't taking song requests right now." : 'Only the host controls playback.' });
        }
        emit(room.members.get(room.hostClient), 'cmd', { ...data, from: m.pub, name: m.name });
        break;
      case 'tell': { // the host replies privately to one listener (e.g. "you've hit the request limit")
        if (!isHost) return hostOnly();
        emit(byPub(room, clean(data.to, 20)), 'notice', { text: clean(data.text, 200) });
        break;
      }
      case 'settings':
        if (!isHost) return hostOnly();
        if (typeof data.locked === 'boolean') room.locked = data.locked;
        if (typeof data.allowControl === 'boolean') room.allowControl = data.allowControl;
        if (typeof data.allowAdd === 'boolean') room.allowAdd = data.allowAdd;
        if (typeof data.voteSkip === 'boolean') room.voteSkip = data.voteSkip;
        if (Number.isFinite(data.requestLimit)) room.requestLimit = Math.max(0, Math.min(50, Math.round(data.requestLimit)));
        if (typeof data.pin === 'string') {
          if (data.pin && !/^\d{4,8}$/.test(data.pin)) return sendJson(res, 400, { error: 'A PIN is 4 to 8 digits.' });
          room.pin = data.pin;
        }
        if (data.name) room.name = clean(data.name, 60);
        broadcast(room, 'settings', settingsOf(room));
        break;
      case 'voice': // joined / left / muted in voice chat
        m.voice = data.on ? { mic: !!data.mic, muted: !!data.muted, ptt: !!data.ptt } : null;
        broadcast(room, 'members', memberList(room));
        break;
      case 'signal': { // WebRTC offer/answer/ICE for one other member; the audio itself goes peer-to-peer
        const target = byPub(room, clean(data.to, 20));
        if (!target || target.id === client) return sendJson(res, 404, { error: 'gone' });
        emit(target, 'signal', { from: m.pub, data: data.payload });
        break;
      }
      case 'handoff': { // the host makes someone else the host
        if (!isHost) return hostOnly();
        const target = data.client ? byPub(room, clean(data.client, 20))
          : [...room.members.values()].find((x) => x.id !== client && x.streams.size);
        if (!target || target.id === client || !target.streams.size) return sendJson(res, 404, { error: 'Nobody else is here to take over.' });
        promote(room, target);
        break;
      }
      case 'leave': {
        // Browsers can keep a closed connection open in the background, so people say goodbye
        // explicitly (also sent when a listener closes the tab) and drop off the list right away.
        if (client === room.hostClient) return sendJson(res, 400, { error: 'Hosts hand over or end the room.' });
        room.members.delete(client);
        room.votes.ids.delete(client);
        for (const s2 of m.streams) s2.end();
        broadcast(room, 'members', memberList(room));
        broadcast(room, 'votes', voteStatus(room));
        broadcast(room, 'notice', { text: `${m.name} left` });
        break;
      }
      case 'kick': {
        if (!isHost) return hostOnly();
        const target = byPub(room, clean(data.client, 20));
        if (target && target.id !== room.hostClient) {
          room.banned.add(target.id);
          emit(target, 'kicked', {});
          for (const s of target.streams) s.end();
          room.members.delete(target.id);
          room.votes.ids.delete(target.id);
          broadcast(room, 'members', memberList(room));
        }
        break;
      }
      case 'close':
        if (!isHost) return hostOnly();
        closeRoom(room, 'The host ended the room.');
        break;
      default:
        return sendJson(res, 400, { error: 'unknown type' });
    }
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'not found' });
}

/* ---------------- voice relay (TURN) settings ---------------- */
// Direct (peer-to-peer) voice fails on some strict networks. A TURN relay fixes that.
// Configure one of: fixed TURN_URLS/USERNAME/CREDENTIAL, a Metered app + API key,
// or a Cloudflare TURN key. Credentials are only handed to people inside a room.
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const iceCache = { servers: null, until: 0, pending: null };
async function turnServers() {
  if (TURN.urls.length) return [{ urls: TURN.urls, username: TURN.username, credential: TURN.credential }];
  if (iceCache.servers && Date.now() < iceCache.until) return iceCache.servers;
  if (iceCache.pending) return iceCache.pending;
  iceCache.pending = (async () => {
    try {
      if (TURN.meteredApp && TURN.meteredKey) {
        const r = await fetch(`https://${TURN.meteredApp}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(TURN.meteredKey)}`);
        if (!r.ok) throw new Error(`Metered ${r.status}`);
        const list = await r.json();
        iceCache.servers = Array.isArray(list) ? list : [];
        iceCache.until = Date.now() + 6 * 60 * 60 * 1000;
      } else if (TURN.cfKeyId && TURN.cfToken) {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${TURN.cfKeyId}/credentials/generate-ice-servers`, {
          method: 'POST', headers: { Authorization: `Bearer ${TURN.cfToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }),
        });
        if (!r.ok) throw new Error(`Cloudflare TURN ${r.status}`);
        const j = await r.json();
        const s = j.iceServers;
        iceCache.servers = (Array.isArray(s) ? s : [s]).filter(Boolean);
        iceCache.until = Date.now() + 12 * 60 * 60 * 1000;
      } else {
        iceCache.servers = [];
        iceCache.until = Date.now() + 60 * 60 * 1000;
      }
    } catch (err) {
      console.error('  Voice relay (TURN) settings failed:', err.message);
      iceCache.servers = [];
      iceCache.until = Date.now() + 5 * 60 * 1000;
    } finally { iceCache.pending = null; }
    return iceCache.servers;
  })();
  return iceCache.pending;
}
async function handleIce(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const room = rooms.get(q.get('room') || '');
  if (!room || !room.members.has(clean(q.get('client'), 40))) return sendJson(res, 403, { error: 'Join a room first.' });
  if (!allow(`ice:${clientIp(req)}`, 20, 0.5)) return slowDown(res);
  const turn = await turnServers();
  return sendJson(res, 200, { iceServers: [...STUN, ...turn], relay: turn.length > 0 });
}

/* ---------------- optional public link (Cloudflare quick tunnel) ---------------- */
const share = { url: null, proc: null, starting: false, error: null };
function cloudflaredPath() {
  if (CLOUD) return null;
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
process.on('SIGTERM', () => { stopShare(); process.exit(0); });

async function handleShare(req, res, action) {
  if (!isLocalAdmin(req)) return sendJson(res, 403, { error: 'Only available on the PC running Vinyl.' });
  if (action === 'start' && req.method === 'POST') startShare();
  if (action === 'stop' && req.method === 'POST') stopShare();
  return sendJson(res, 200, { url: share.url, starting: share.starting, available: !!cloudflaredPath(), error: share.error });
}

/* ---------------- https on the local network ---------------- */
// Browsers only allow the microphone on secure (https) pages. To let phones on the same
// Wi-Fi talk in voice chat, Vinyl makes its own certificate with OpenSSL (it ships with Git
// for Windows). Phones see a one-time "not private" warning because nobody vouches for it.
let httpsReady = false;
function opensslPath() {
  const candidates = [
    process.env.OPENSSL,
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const exe of ['openssl.exe', 'openssl']) { const p = path.join(dir, exe); if (dir && fs.existsSync(p)) return p; }
  }
  return null;
}
function localCert() {
  const dir = path.join(__dirname, '.certs');
  const keyFile = path.join(dir, 'vinyl-key.pem'), certFile = path.join(dir, 'vinyl-cert.pem'), metaFile = path.join(dir, 'names.json');
  const ips = lanIps();
  const names = ['localhost', localName(), ...ips.map(sslipName)];
  const want = [...names.map((n) => `DNS:${n}`), 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].sort();
  try {
    const had = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (want.every((n) => had.includes(n))) return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  } catch { /* make a new one */ }
  const bin = opensslPath();
  if (!bin) return null;
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(bin, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
    '-keyout', keyFile, '-out', certFile, '-subj', '/CN=Vinyl on this PC',
    '-addext', `subjectAltName=${want.join(',')}`], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) { console.error('  Could not make an https certificate:', (r.stderr || '').trim().split('\n').pop()); return null; }
  fs.writeFileSync(metaFile, JSON.stringify(want));
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

/* ---------------- http ---------------- */
async function handler(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }

  try {
    if (p.startsWith('/api/rooms')) return await handleRooms(req, res, p.slice('/api/rooms'.length).split('/').filter(Boolean));
    if (p.startsWith('/api/share')) return await handleShare(req, res, p.split('/')[3]);
    if (p === '/api/ice') return await handleIce(req, res);
    if (p === '/api/net') {
      const local = !viaTunnel(req) && !CLOUD;
      return sendJson(res, 200, {
        cloud: CLOUD,
        http: local ? lanUrls('http', PORT) : [],
        https: local && httpsReady ? lanUrls('https', HTTPS_PORT) : [],
        localHttps: local && httpsReady ? `https://localhost:${HTTPS_PORT}` : null,
      });
    }
    if (p === '/healthz') return sendJson(res, 200, { ok: true, rooms: rooms.size });
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  if (p === '/lan.json') {
    if (viaTunnel(req) || CLOUD) return sendJson(res, 200, []);
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
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  });
}

function started() {
  console.log('\n  Vinyl is running\n');
  if (CLOUD) {
    console.log(`  Cloud mode on port ${PORT}. Open your service's public https address.`);
  } else {
    console.log(`  On this PC:        http://localhost:${PORT}`);
    const lan = lanUrls();
    if (lan.length) {
      console.log(`  Phone / tablet:    ${lan[0]}   (same Wi-Fi)`);
      console.log(`  If that won't load: ${lan.slice(1, -1).join('  or  ')}`);
      if (httpsReady) console.log(`  For voice chat:    ${lanUrls('https', HTTPS_PORT)[0]}   (tap "Advanced" > "Proceed" the first time)`);
    }
    console.log(`\n  Listening rooms are on. ${cloudflaredPath() ? 'Friends outside your Wi-Fi can join once you turn on "Share over the internet" in a room.' : 'Install cloudflared to let friends outside your Wi-Fi join (see README).'}`);
  }
  const relay = TURN.urls.length || (TURN.meteredApp && TURN.meteredKey) || (TURN.cfKeyId && TURN.cfToken);
  console.log(`  Voice relay (TURN): ${relay ? 'configured' : 'not set up (voice still works on most networks)'}`);
  console.log('\n  Keep this window open while listening. Press Ctrl+C to stop.\n');
}

// Listen on IPv6 and IPv4 together ("::"). Browsers try "localhost" over IPv6 first; with an
// IPv4-only server Windows makes every connection wait before falling back, which made pages
// load seconds slower. Machines without IPv6 fall back to IPv4 only.
function listen(srv, port, onUp, onFail) {
  const tryHost = (host, fallback) => {
    srv.once('error', (e) => {
      if (fallback && (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL' || e.code === 'EINVAL')) tryHost('0.0.0.0', false);
      else onFail(e);
    });
    srv.listen({ port, host, ipv6Only: false }, onUp);
  };
  tryHost('::', true);
}

const server = http.createServer(handler);
listen(server, PORT, () => {
  if (HTTPS_ON) {
    const tls = localCert();
    if (tls) {
      listen(https.createServer(tls, handler), HTTPS_PORT, () => { httpsReady = true; started(); },
        (e) => { console.error(`  https port ${HTTPS_PORT} unavailable (${e.code}); continuing without it.`); started(); });
      return;
    }
  }
  started();
}, (e) => {
  if (e.code === 'EADDRINUSE' || e.code === 'EACCES') console.error(`\n  Port ${PORT} is busy. Vinyl may already be running: open http://localhost:${PORT}\n`);
  else console.error(e);
  process.exit(1);
});

module.exports = { server };
