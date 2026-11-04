'use strict';

/* =========================================================================
   Spotify support for Vinyl.
   - Sign-in: Authorization Code + PKCE (no client secret), refresh tokens kept locally.
   - Playback on PC: Web Playback SDK, so the browser itself is a Spotify device (Premium).
   - Playback on phones/tablets: the SDK isn't supported there, so Vinyl remote-controls
     the Spotify app through Spotify Connect.
   Loaded before app.js. Top-level code here only defines things; it uses app.js
   helpers (store, h, icon, toast, S, setQueue…) at call time, and app.js calls spBoot().
   ========================================================================= */

const SP = {
  tokens: null,            // { access, refresh, exp }
  refreshing: null,
  me: null, playlists: null, hidden: 0, loading: false,
  sdk: null, sdkDevice: null, sdkInit: null, sdkError: null,
  devices: [], activeDevice: null, prepared: new Set(),
  st: null,                // last known playback state { id, name, paused, position, duration, at }
  last: null,              // previous state of the current track (for end detection)
  cued: null, loadedAt: 0, endedFor: null,
  poll: null, polling: false, volTimer: null,
};
const SP_API = 'https://api.spotify.com/v1';
const SP_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SP_SCOPES = [
  'streaming', 'user-read-email', 'user-read-private',
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'playlist-read-private', 'playlist-read-collaborative', 'user-library-read',
].join(' ');
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const SP_NOT_YOURS = "Spotify only lets apps open playlists you own or collaborate on. Add the songs to one of your own playlists (or your Liked Songs) and open that instead.";

const sdkSupported = () => !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  && !(navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const spCanSignIn = () => window.isSecureContext && (location.protocol === 'https:' || LOOPBACK.includes(location.hostname));

/* Spotify rejects "localhost" redirect URIs but accepts 127.0.0.1; callback.html hops back. */
function spRedirectUri() {
  const dir = location.pathname.replace(/[^/]*$/, '');
  const host = location.hostname === 'localhost' ? '127.0.0.1' : location.hostname;
  return `${location.protocol}//${host}${location.port ? ':' + location.port : ''}${dir}callback.html`;
}

/* ---------- auth ---------- */
function randStr(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const a = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(a, (b) => chars[b % 62]).join('');
}
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function spLogin() {
  const clientId = store.get('spClientId', '');
  if (!clientId) { openSettings('setSpotify'); return; }
  if (!spCanSignIn()) {
    toast('Spotify sign-in works on this PC (http://127.0.0.1) or on an https:// address. See the README.');
    return;
  }
  // Open the popup before any await so popup blockers allow it.
  const popup = window.open('about:blank', 'vinyl-spotify', 'width=480,height=760');
  const verifier = randStr(64), nonce = randStr(16), redirect = spRedirectUri();
  const ret = new TextEncoder().encode(location.origin + location.pathname);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  store.set('spAuth', { verifier, nonce, redirect, popup: !!popup, at: Date.now() });
  const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirect,
    code_challenge_method: 'S256', code_challenge: challenge, scope: SP_SCOPES,
    state: nonce + '~' + b64url(ret),
  });
  if (popup) popup.location.href = url; else location.href = url;
}

async function spHandleCallback() {
  let cb = null;
  try { cb = JSON.parse(localStorage.getItem('vinyl.spCallback') || 'null'); } catch { /* ignore */ }
  if (!cb) return;
  const auth = store.get('spAuth', null);
  if (!auth) return; // another tab already handled it
  localStorage.removeItem('vinyl.spCallback'); store.del('spAuth');
  if (cb.error) { toast(cb.error === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify sign-in failed (${cb.error}).`); return; }
  if (!cb.state || cb.state.split('~')[0] !== auth.nonce || Date.now() - auth.at > 15 * 60 * 1000) {
    toast('Spotify sign-in expired. Please try again.'); return;
  }
  try {
    const r = await fetch(SP_TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: cb.code, redirect_uri: auth.redirect,
        client_id: store.get('spClientId', ''), code_verifier: auth.verifier,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Spotify sign-in failed: ${j.error_description || j.error || r.status}`);
    spSaveTokens(j);
    toast('Connected to Spotify');
    renderSpotify(); spLoadLibrary(); spInitSDK();
    if (!$('[data-tab="search"].tab-body').hidden) renderSearch();
  } catch (err) { toast(err.message); }
}
function spSaveTokens(j, oldRefresh) {
  SP.tokens = { access: j.access_token, refresh: j.refresh_token || oldRefresh, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  store.set('spTokens', SP.tokens);
}
async function spToken() {
  const t = SP.tokens;
  if (!t) throw new Error('Connect Spotify first (Library → Spotify).');
  if (Date.now() < t.exp - 60000) return t.access;
  if (!SP.refreshing) {
    SP.refreshing = (async () => {
      const r = await fetch(SP_TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: store.get('spClientId', '') }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { spLogout(true); throw new Error('Your Spotify session ended. Connect again in Library.'); }
      spSaveTokens(j, t.refresh);
    })().finally(() => { SP.refreshing = null; });
  }
  await SP.refreshing;
  return SP.tokens.access;
}
function spLogout(silent) {
  if (isCurrent(SPE) && phase !== 'idle') { SPE.pause().catch(() => {}); setPhase('idle'); }
  SP.tokens = null; SP.me = null; SP.playlists = null; store.del('spTokens');
  if (SP.sdk) { SP.sdk.disconnect(); }
  SP.sdk = SP.sdkDevice = SP.sdkInit = null; SP.activeDevice = null; SP.prepared.clear();
  spSyncPolling(); renderSpotify();
  if (!silent) toast('Spotify disconnected');
}

/* ---------- Web API ---------- */
async function spApi(path, { method = 'GET', body } = {}, retry = true) {
  const token = await spToken();
  const r = await fetch(SP_API + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && retry) { SP.tokens.exp = 0; return spApi(path, { method, body }, false); }
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* empty or non-JSON body */ }
  if (r.status === 429) throw Object.assign(new Error('Spotify is rate-limiting requests. Wait a moment and try again.'), { status: 429 });
  if (!r.ok) {
    const msg = j?.error?.message || `Spotify error ${r.status}`;
    const premium = j?.error?.reason === 'PREMIUM_REQUIRED' || /premium/i.test(msg);
    throw Object.assign(new Error(premium ? 'Playing Spotify songs needs a Spotify Premium account.' : `Spotify: ${msg}`), { status: r.status, reason: j?.error?.reason });
  }
  return j;
}
async function spAll(path, max = 1000) {
  const out = [];
  let next = path;
  while (next && out.length < max) {
    const j = await spApi(next.startsWith('http') ? next.slice(SP_API.length) : next);
    if (!j) break;
    out.push(...(j.items || []));
    next = j.next;
  }
  return out;
}
function pickImg(images) {
  const imgs = (images || []).filter((i) => i && isSpArt(i.url));
  return (imgs.find((i) => i.width >= 200 && i.width <= 320) || imgs[0])?.url || '';
}
function spTrack(tr, albumImages) {
  if (!tr || (tr.type && tr.type !== 'track') || tr.is_local || !isSpId(tr.id)) return null;
  return {
    src: 'sp', id: tr.id, title: tr.name || 'Unknown',
    artist: (tr.artists || []).map((a) => a.name).join(', '),
    art: pickImg(tr.album?.images?.length ? tr.album.images : albumImages),
    dur: tr.duration_ms || 0,
  };
}
async function spCollection(kind, id) {
  if (kind === 'liked') {
    const items = await spAll('/me/tracks?limit=50', 2000);
    return { title: 'Liked Songs', tracks: items.map((it) => spTrack(it.track || it.item)).filter(Boolean) };
  }
  if (kind === 'track') {
    const t = spTrack(await spApi(`/tracks/${id}`));
    return { title: t?.title, cover: t?.art, tracks: t ? [t] : [] };
  }
  if (kind === 'album') {
    const al = await spApi(`/albums/${id}`);
    const items = await spAll(`/albums/${id}/tracks?limit=50`, 500);
    return { title: al?.name, cover: pickImg(al?.images), tracks: items.map((tr) => spTrack(tr, al?.images)).filter(Boolean) };
  }
  // playlist
  let pl, items;
  try {
    pl = await spApi(`/playlists/${id}?fields=name,images`);
    items = await spAll(`/playlists/${id}/items?limit=50`, 2000);
  } catch (err) {
    if (err.status === 403 || err.status === 404) throw new Error(SP_NOT_YOURS);
    throw err;
  }
  const tracks = items.map((it) => spTrack(it.item || it.track)).filter(Boolean);
  if (!tracks.length) throw new Error(`That playlist looks empty. ${SP_NOT_YOURS}`);
  return { title: pl?.name, cover: pickImg(pl?.images), tracks };
}
async function spSearch(q) {
  const page = (offset) => spApi(`/search?type=track&limit=10&offset=${offset}&q=${encodeURIComponent(q)}`);
  const [a, b] = await Promise.all([page(0), page(10).catch(() => null)]);
  return [...(a?.tracks?.items || []), ...(b?.tracks?.items || [])].map((t) => spTrack(t)).filter(Boolean);
}

/* ---------- links ---------- */
function parseSpotifyLink(raw) {
  const s = (raw || '').trim();
  let m = s.match(/^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/);
  if (m) return { kind: m[1], id: m[2] };
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  if (u.hostname === 'spotify.link' || u.hostname.endsWith('.spotify.link')) return { kind: 'short' };
  if (!/(^|\.)spotify\.com$/.test(u.hostname)) return null;
  m = u.pathname.match(/^\/(?:intl-[\w-]+\/)?(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]{22})/);
  return m ? { kind: m[1], id: m[2] } : { kind: 'unsupported' };
}
async function handleSpotifyLink(p, mode) {
  if (p.kind === 'short') { toast("Short spotify.link links can't be opened here. Open it once, then copy the full open.spotify.com link."); return false; }
  if (p.kind === 'unsupported') { toast('Vinyl can open Spotify songs, albums and playlists.'); return false; }
  if (!store.get('spClientId', '')) { toast('Set up Spotify first.'); openSettings('setSpotify'); return false; }
  if (!SP.tokens) { toast('Connect Spotify first. A sign-in window is opening.'); spLogin(); return false; }
  const c = await spCollection(p.kind, p.id);
  if (!c.tracks.length) throw new Error('Nothing playable there.');
  if (mode === 'play') {
    if (p.kind === 'track') enqueue(c.tracks, { playNow: true }); else setQueue(c.tracks, 0);
    closePanelOnPhone();
  } else enqueue(c.tracks);
  if (p.kind !== 'track') saveToLibrary({ src: 'sp', kind: p.kind, id: p.id, title: c.title, cover: c.cover, count: c.tracks.length });
  return true;
}

/* ---------- devices ---------- */
function spInitSDK() {
  if (!SP.tokens || !sdkSupported()) return Promise.resolve(null);
  if (SP.sdkInit) return SP.sdkInit;
  SP.sdkInit = new Promise((resolve) => {
    let settled = false;
    const done = (id, err) => {
      if (settled) return; settled = true;
      if (err) { SP.sdkError = err; if (err !== 'premium') SP.sdkInit = null; }
      resolve(id);
    };
    const start = () => {
      const p = new Spotify.Player({
        name: 'Vinyl',
        getOAuthToken: (cb) => { spToken().then(cb).catch(() => {}); },
        volume: (S.muted ? 0 : musicVolume()) / 100,
      });
      p.addListener('ready', ({ device_id: id }) => { SP.sdk = p; SP.sdkDevice = id; done(id); renderSpotifyDevices(); });
      p.addListener('not_ready', () => { SP.sdkDevice = null; });
      p.addListener('initialization_error', ({ message }) => done(null, message));
      p.addListener('authentication_error', ({ message }) => done(null, message));
      p.addListener('account_error', () => { done(null, 'premium'); toast('Playing Spotify songs needs a Spotify Premium account.'); });
      p.addListener('playback_error', ({ message }) => { if (isCurrent(SPE) && message) toast(`Spotify: ${message}`); });
      p.addListener('player_state_changed', (s) => {
        if (!s || SP.activeDevice !== SP.sdkDevice) return;
        const ct = s.track_window?.current_track;
        spObserve({ id: ct?.id, name: ct?.name, paused: s.paused, position: s.position, duration: s.duration, at: performance.now() });
      });
      p.connect().then((ok) => { if (!ok) done(null, 'connect'); });
      setTimeout(() => done(null, 'timeout'), 15000);
    };
    if (window.Spotify?.Player) start();
    else {
      window.onSpotifyWebPlaybackSDKReady = start;
      const s = document.createElement('script');
      s.src = 'https://sdk.scdn.co/spotify-player.js';
      s.onerror = () => done(null, 'load');
      document.head.append(s);
    }
  });
  return SP.sdkInit;
}
async function spDevices() {
  const j = await spApi('/me/player/devices');
  SP.devices = (j?.devices || []).filter((d) => d.id && !d.is_restricted);
  renderSpotifyDevices();
  return SP.devices;
}
async function spPickDevice() {
  const want = store.get('spTarget', 'auto');
  if ((want === 'auto' || want === 'sdk') && sdkSupported()) {
    const id = await spInitSDK();
    if (id) return id;
    if (SP.sdkError === 'premium') throw new Error('Playing Spotify songs needs a Spotify Premium account.');
    if (want === 'sdk') throw new Error("Spotify couldn't start in this browser. Pick another device in Library → Spotify.");
  }
  const devs = await spDevices();
  const d = devs.find((x) => x.id === want) || devs.find((x) => x.is_active && x.id !== SP.sdkDevice) || devs.find((x) => x.id !== SP.sdkDevice);
  if (!d) throw new Error('Open the Spotify app on this phone, tablet or computer, then press play again.');
  return d.id;
}
async function spPrepare(dev) {
  if (SP.prepared.has(dev)) return;
  SP.prepared.add(dev);
  // Vinyl owns shuffle/repeat, so turn Spotify's own versions off on that device.
  await Promise.allSettled([
    spApi(`/me/player/shuffle?state=false&device_id=${dev}`, { method: 'PUT' }),
    spApi(`/me/player/repeat?state=off&device_id=${dev}`, { method: 'PUT' }),
  ]);
}
async function spTransfer(target) {
  if (!SP.tokens || !isCurrent(SPE) || SP.cued || phase !== 'playing') return;
  try {
    const dev = target === 'auto' || target === 'sdk' ? (sdkSupported() ? await spInitSDK() : null) : target;
    if (!dev || dev === SP.activeDevice) return;
    await spApi('/me/player', { method: 'PUT', body: { device_ids: [dev], play: true } });
    SP.activeDevice = dev; spSyncPolling();
    toast('Moved playback');
  } catch (err) { toast(err.message); }
}

/* ---------- playback engine ---------- */
const SPE = {
  name: 'sp',
  ready: () => !!SP.tokens,
  async load(t, autoplay, start = 0) {
    SP.sdk?.activateElement?.(); // must run inside the user's tap on some browsers
    SP.cued = autoplay ? null : { t, start };
    SP.st = { id: t.id, name: t.title, paused: true, position: start * 1000, duration: t.dur || 0, at: performance.now() };
    SP.last = null; SP.endedFor = null; SP.loadedAt = performance.now();
    if (!autoplay) { spSyncPolling(); return; }
    const dev = await spPickDevice();
    // Hand Spotify the following run of Spotify tracks too, so it keeps going gaplessly
    // (and keeps playing through the queue when a phone is locked in remote mode).
    const uris = [];
    for (let j = S.index; j < S.queue.length && uris.length < 50; j++) {
      const q = S.queue[j];
      if (q.src !== 'sp') break;
      uris.push('spotify:track:' + q.id);
      if (S.repeat === 'one') break;
    }
    if (!uris.length) uris.push('spotify:track:' + t.id);
    await spApi(`/me/player/play?device_id=${dev}`, { method: 'PUT', body: { uris, position_ms: Math.round(start * 1000) } });
    SP.activeDevice = dev; SP.loadedAt = performance.now();
    if (dev !== SP.sdkDevice) SPE.volume(S.muted ? 0 : musicVolume());
    spPrepare(dev);
    spSyncPolling();
  },
  async play() {
    if (SP.cued) { const { t, start } = SP.cued; return SPE.load(t, true, start); }
    SP.sdk?.activateElement?.();
    if (SP.sdk && SP.activeDevice === SP.sdkDevice) return SP.sdk.resume();
    await spApi(`/me/player/play${SP.activeDevice ? '?device_id=' + SP.activeDevice : ''}`, { method: 'PUT' });
    if (SP.st) { SP.st.paused = false; SP.st.at = performance.now(); }
    setPhase('playing');
  },
  async pause() {
    if (SP.st) { SP.st.position = SPE.time() * 1000; SP.st.paused = true; SP.st.at = performance.now(); }
    if (SP.sdk && SP.activeDevice === SP.sdkDevice) return SP.sdk.pause();
    await spApi('/me/player/pause', { method: 'PUT' }).catch(() => {});
  },
  stop() {
    if (SP.tokens && SP.st && !SP.st.paused && !SP.cued) SPE.pause().catch(() => {});
    SP.cued = null;
    spSyncPolling();
  },
  seek(sec) {
    const ms = Math.max(0, Math.round(sec * 1000));
    if (SP.st) { SP.st.position = ms; SP.st.at = performance.now(); }
    SP.last = null;
    if (SP.cued) { SP.cued.start = sec; return; }
    if (SP.sdk && SP.activeDevice === SP.sdkDevice) SP.sdk.seek(ms);
    else spApi(`/me/player/seek?position_ms=${ms}`, { method: 'PUT' }).catch((e) => toast(e.message));
  },
  time() {
    const st = SP.st;
    if (!st) return 0;
    const p = st.position + (st.paused ? 0 : performance.now() - st.at);
    return Math.max(0, st.duration ? Math.min(p, st.duration) : p) / 1000;
  },
  duration: () => (SP.st?.duration || 0) / 1000,
  volume(v) {
    if (!SP.tokens) return;
    if (SP.sdk) SP.sdk.setVolume(v / 100).catch(() => {});
    if (SP.activeDevice && SP.activeDevice !== SP.sdkDevice && isCurrent(SPE)) {
      clearTimeout(SP.volTimer);
      SP.volTimer = setTimeout(() => {
        spApi(`/me/player/volume?volume_percent=${v}&device_id=${SP.activeDevice}`, { method: 'PUT' }).catch(() => {});
      }, 400);
    }
  },
  mute(m) { SPE.volume(m ? 0 : musicVolume()); },
  isLoaded: (t) => !!SP.st && SP.st.id === t.id,
};

/* Reconcile a playback state from Spotify with Vinyl's queue. */
function spObserve(st) {
  const cur = S.queue[S.index];
  if (!cur || cur.src !== 'sp' || SP.cued || !st.id) return;
  const now = performance.now();
  const same = (q) => q.id === st.id || (!!st.name && q.title === st.name && q.src === 'sp');
  const prev = SP.last;
  const projected = prev ? prev.position + (prev.paused ? 0 : now - prev.at) : 0;
  const nearEnd = !!prev && prev.duration > 0 && projected > prev.duration - 4000;
  const settled = now - SP.loadedAt > 3000;

  if (!same(cur)) {
    // Spotify moved on by itself: either to the next track of the run we gave it, or past its end.
    const j = S.queue.findIndex((q, k) => k > S.index && q.src === 'sp' && same(q));
    if (settled && j > S.index) {
      S.index = j; S.pos = 0; SP.st = st; SP.last = { ...st }; SP.loadedAt = now; SP.endedFor = null;
      setPhase(st.paused ? 'paused' : 'playing');
      updateNowPlaying(); renderQueue(); persist();
    } else if (settled && nearEnd) spEnded(cur);
    return;
  }
  if (st.paused && st.position < 1000 && nearEnd) { spEnded(cur); return; }
  SP.st = st; SP.last = { ...st };
  setPhase(st.paused ? 'paused' : 'playing');
}
function spEnded(cur) {
  if (SP.endedFor === cur.uid) return;
  SP.endedFor = cur.uid; SP.last = null;
  onEnded();
  // End of the queue: stop Spotify's own autoplay from carrying on.
  if (phase === 'idle' && isCurrent(SPE)) SPE.pause().catch(() => {});
}
function spSyncPolling() {
  const want = !!SP.tokens && isCurrent(SPE) && !!SP.activeDevice && SP.activeDevice !== SP.sdkDevice && !SP.cued;
  if (want && !SP.poll) SP.poll = setInterval(spPoll, 1500);
  if (!want && SP.poll) { clearInterval(SP.poll); SP.poll = null; }
}
async function spPoll() {
  if (document.hidden || SP.polling) return;
  SP.polling = true;
  try {
    const j = await spApi('/me/player');
    if (j?.item) {
      spObserve({ id: j.item.id, name: j.item.name, paused: !j.is_playing, position: j.progress_ms || 0, duration: j.item.duration_ms || 0, at: performance.now() });
    }
  } catch { /* transient; try again next tick */ } finally { SP.polling = false; }
}

/* ---------- library UI ---------- */
async function spLoadLibrary() {
  if (!SP.tokens) return;
  SP.loading = true; renderSpotify();
  try {
    SP.me = await spApi('/me');
    const items = (await spAll('/me/playlists?limit=50', 300)).filter(Boolean);
    const mine = items.filter((p) => p.owner?.id === SP.me?.id || p.collaborative);
    SP.hidden = items.length - mine.length;
    SP.playlists = mine.map((p) => ({ id: p.id, title: p.name, count: p.items?.total ?? p.tracks?.total ?? 0, cover: pickImg(p.images) }));
    spDevices().catch(() => {});
  } catch (err) { toast(err.message); }
  SP.loading = false; renderSpotify();
}
async function spPlayCollection(kind, id, title, { shuffle = false, add = false } = {}) {
  try {
    toast(`Loading ${title}…`, 1500);
    const { tracks } = await spCollection(kind, id);
    if (!tracks.length) { toast(`${title} is empty`); return; }
    if (add) { enqueue(tracks); return; }
    if (shuffle && !S.shuffle) { S.shuffle = true; syncToggles(); }
    setQueue(tracks, shuffle ? Math.floor(Math.random() * tracks.length) : 0);
    closePanelOnPhone();
  } catch (err) { toast(err.message); }
}
function renderSpotifyDevices() {
  const sel = $('#spDevice');
  if (!sel) return;
  const want = store.get('spTarget', 'auto');
  const opts = [['auto', sdkSupported() ? 'Automatic (this browser)' : 'Automatic (your Spotify app)']];
  if (sdkSupported()) opts.push(['sdk', 'This browser']);
  for (const d of SP.devices) if (d.id !== SP.sdkDevice) opts.push([d.id, `${d.name} · ${d.type.toLowerCase()}`]);
  if (!opts.some(([v]) => v === want)) opts.push([want, 'Last used device']);
  sel.replaceChildren(...opts.map(([v, label]) => h('option', { value: v, text: label })));
  sel.value = want;
}
function renderSpotify() {
  const box = $('#spotifyBox');
  if (!box) return;
  box.replaceChildren();
  if (!store.get('spClientId', '')) {
    box.append(h('div', { class: 'card' },
      h('p', { class: 'muted', text: 'Play your Spotify songs, playlists and liked songs on the turntable. Needs Spotify Premium and a free developer Client ID (a one-time 5-minute setup).' }),
      h('button', { class: 'btn', onclick: () => openSettings('setSpotify') }, icon('spotify'), 'Set up Spotify')));
    return;
  }
  if (!SP.tokens) {
    const can = spCanSignIn();
    box.append(h('div', { class: 'card' },
      h('p', { class: 'muted', text: can
        ? 'Sign in to load your Spotify playlists and liked songs.'
        : 'Spotify sign-in works on the PC (http://127.0.0.1) or on an https:// address. See the README to host Vinyl on HTTPS for your phone.' }),
      can ? h('button', { class: 'btn primary', onclick: spLogin }, icon('spotify'), 'Connect Spotify') : null));
    return;
  }
  box.append(h('div', { class: 'account-head' },
    h('span', { text: SP.me?.display_name ? `Connected as ${SP.me.display_name}` : 'Connected' }),
    h('button', { class: 'text-btn', onclick: spLoadLibrary, text: 'Refresh' })));

  const sel = h('select', { id: 'spDevice', 'aria-label': 'Play Spotify on' });
  sel.addEventListener('focus', () => spDevices().catch(() => {}));
  sel.addEventListener('change', () => { store.set('spTarget', sel.value); spTransfer(sel.value); });
  box.append(h('label', { class: 'device-row' }, icon('devices'), h('span', { text: 'Play on' }), sel));
  renderSpotifyDevices();

  box.append(collectionRow({
    glyph: 'heart', glyphClass: 'sp', title: 'Liked Songs', sub: 'Spotify',
    onClick: () => spPlayCollection('liked', null, 'Liked Songs'),
    actions: [
      iconBtn('shuffle', 'Shuffle play', () => spPlayCollection('liked', null, 'Liked Songs', { shuffle: true })),
      iconBtn('add', 'Add to queue', () => spPlayCollection('liked', null, 'Liked Songs', { add: true })),
    ],
  }));
  if (SP.loading && !SP.playlists) { box.append(h('div', { class: 'loading-row', text: 'Loading your Spotify playlists…' })); return; }
  for (const p of SP.playlists || []) {
    box.append(collectionRow({
      coverUrl: p.cover || null, glyph: p.cover ? null : 'spotify', glyphClass: 'sp',
      title: p.title, sub: `Spotify playlist · ${p.count} tracks`,
      onClick: () => spPlayCollection('playlist', p.id, p.title),
      actions: [
        iconBtn('shuffle', 'Shuffle play', () => spPlayCollection('playlist', p.id, p.title, { shuffle: true })),
        iconBtn('add', 'Add to queue', () => spPlayCollection('playlist', p.id, p.title, { add: true })),
      ],
    }));
  }
  if (SP.hidden) {
    box.append(h('div', { class: 'note', text: `${SP.hidden} followed playlist${SP.hidden === 1 ? ' is' : 's are'} hidden. Spotify only lets apps open playlists you own or collaborate on.` }));
  }
}

/* ---------- settings ---------- */
function spFillSettings() {
  $('#spRedirectCode').textContent = spRedirectUri();
  $('#spClientIdInput').value = store.get('spClientId', '');
  $('#btnSpDisconnect').hidden = !SP.tokens;
  $('#spHint').textContent = !spCanSignIn()
    ? "Spotify sign-in only works on this PC (http://127.0.0.1:…) or an https:// address, not over the http://192.168… phone link. Host Vinyl on HTTPS to sign in on your phone (see README)."
    : location.hostname === 'localhost'
      ? 'Spotify no longer accepts "localhost" addresses, so Vinyl signs in through 127.0.0.1 and brings you back here automatically. Register the address above exactly.'
      : 'Register the address above exactly as shown.';
}

/* ---------- boot (called by app.js) ---------- */
function spBoot() {
  SP.tokens = store.get('spTokens', null);

  $('#btnSpSave').addEventListener('click', () => {
    const v = $('#spClientIdInput').value.trim();
    if (v && !/^[0-9a-f]{32}$/i.test(v)) { toast("That doesn't look like a Spotify Client ID (32 letters and numbers)."); return; }
    if (v !== store.get('spClientId', '')) spLogout(true);
    store.set('spClientId', v);
    renderSpotify(); renderSearch();
    toast(v ? 'Saved. Now tap "Connect Spotify" in Library.' : 'Spotify Client ID removed');
    if (v) { $('#settings').close(); openPanel('library'); }
  });
  $('#btnSpDisconnect').addEventListener('click', () => { spLogout(); $('#btnSpDisconnect').hidden = true; });

  window.addEventListener('storage', (e) => { if (e.key === 'vinyl.spCallback' && e.newValue) spHandleCallback(); });
  window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data?.type === 'vinyl-spotify') spHandleCallback(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && SP.poll) spPoll(); });

  spHandleCallback();
  const cur = S.queue[S.index];
  if (cur?.src === 'sp') SPE.load(cur, false, S.pos || 0);
  renderSpotify();
  if (SP.tokens) { spLoadLibrary(); spInitSDK(); }
}
