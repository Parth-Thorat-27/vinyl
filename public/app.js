'use strict';

/* =========================================================================
   Vinyl: a turntable-style player for YouTube Music.
   Playback uses the official YouTube IFrame Player API. Your account
   (optional) is read through the YouTube Data API v3 with read-only OAuth.
   ========================================================================= */

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const store = {
  get(k, d) { try { const v = localStorage.getItem('vinyl.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('vinyl.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem('vinyl.' + k); } catch { /* ignore */ } },
};

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('class', 'i'); s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(ns, 'use'); u.setAttribute('href', '#i-' + name);
  s.append(u); return s;
}
function iconBtn(name, title, onclick) {
  return h('button', { class: 'icon-btn sm', title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); onclick(e); } }, icon(name));
}

const isId = (s) => typeof s === 'string' && /^[\w-]{11}$/.test(s);
const isSpId = (s) => typeof s === 'string' && /^[A-Za-z0-9]{22}$/.test(s);
const isSpArt = (u) => typeof u === 'string' && /^https:\/\/[\w.-]*\.(scdn\.co|spotifycdn\.com)\//.test(u);
const validTrack = (t) => !!t && (t.src === 'sp' ? isSpId(t.id) : isId(t.id));
const thumb = (id, q = 'mqdefault') => `https://i.ytimg.com/vi/${id}/${q}.jpg`;
const artUrl = (t) => (t.src === 'sp' ? (isSpArt(t.art) ? t.art : '') : thumb(t.id));
const uid = () => Math.random().toString(36).slice(2, 10);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const decode = (s) => new DOMParser().parseFromString(s || '', 'text/html').documentElement.textContent;
function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = String(sec % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
function shuffleArr(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
let toastTimer;
function toast(msg, ms = 3400) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* Tidy up YouTube titles: drop "(Official Video)" noise and split "Artist - Song". */
function cleanMeta(title = '', author = '') {
  const topic = /\s-\sTopic$/i.test(author);
  let a = author.replace(/\s-\sTopic$/i, '').replace(/VEVO$/i, '').trim();
  let t = title
    .replace(/\s*[([][^)\]]*\b(?:official|video|audio|lyrics?|visuali[sz]er|remaster(?:ed)?|mv|m\/v|hd|hq|4k)\b[^)\]]*[)\]]/gi, '')
    .trim();
  const m = !topic && t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) { a = m[1].trim(); t = m[2].trim(); }
  return { t: t || title, a };
}

/* ---------- state ---------- */
const S = {
  queue: store.get('queue', []).filter(validTrack).map((t) => ({ ...t, uid: uid() })),
  original: null,
  index: store.get('index', -1),
  pos: store.get('pos', 0),
  shuffle: store.get('shuffle', false),
  repeat: store.get('repeat', 'off'), // off | all | one
  volume: store.get('volume', 80),
  muted: false,
  showVideo: store.get('showVideo', matchMedia('(min-width: 960px)').matches),
  library: store.get('library', []),
};
if (S.index >= S.queue.length) S.index = S.queue.length ? 0 : -1;
const meta = store.get('meta', {}); // videoId -> { t, a }

const persist = debounce(() => {
  if (!roomIsGuest()) {
    store.set('queue', S.queue.map(({ uid: _u, ...t }) => t));
    store.set('index', S.index);
  }
  store.set('shuffle', S.shuffle);
  store.set('repeat', S.repeat);
  store.set('volume', S.volume);
  store.set('showVideo', S.showVideo);
  store.set('library', S.library);
}, 300);
const persistMeta = debounce(() => {
  const keys = Object.keys(meta);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete meta[k];
  store.set('meta', meta);
}, 1500);

const trackTitle = (t) => t.title || meta[t.id]?.t || 'Loading…';
const trackArtist = (t) => t.artist || meta[t.id]?.a || '';

/* ---------- metadata (titles for tracks that came from a pasted playlist) ---------- */
const metaWanted = new Set();
let metaActive = 0;
function needMeta(id) {
  if (!isId(id) || meta[id] || metaWanted.has(id)) return;
  metaWanted.add(id); pumpMeta();
}
function pumpMeta() {
  while (metaActive < 4 && metaWanted.size) {
    const id = metaWanted.values().next().value;
    metaWanted.delete(id); metaActive++;
    fetchMeta(id)
      .then((m) => { if (m) { meta[id] = m; persistMeta(); applyMeta(id); } })
      .finally(() => { metaActive--; pumpMeta(); });
  }
}
async function oembed(url) {
  const u = encodeURIComponent(url);
  for (const ep of [`https://www.youtube.com/oembed?format=json&url=${u}`, `https://noembed.com/embed?url=${u}`]) {
    try {
      const r = await fetch(ep);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.title) return j;
    } catch { /* try next */ }
  }
  return null;
}
async function fetchMeta(id) {
  const j = await oembed('https://www.youtube.com/watch?v=' + id);
  return j ? cleanMeta(j.title, j.author_name || '') : null;
}
function applyMeta(id) {
  const m = meta[id];
  for (const row of $$(`.row[data-vid="${id}"]`)) {
    const tEl = $('.t', row), aEl = $('.a', row);
    if (tEl && tEl.textContent === 'Loading…') tEl.textContent = m.t;
    if (aEl && !aEl.textContent) aEl.textContent = m.a;
  }
  if (S.queue[S.index]?.id === id) updateNowPlaying();
  else updateUpNext();
}
const metaObserver = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { needMeta(e.target.dataset.vid); metaObserver.unobserve(e.target); }
}, { rootMargin: '300px' });

/* ---------- album art & dynamic colour ---------- */
const artCache = {};
function artFor(id) {
  if (artCache[id]) return Promise.resolve(artCache[id]);
  return new Promise((res) => {
    const img = new Image();
    const done = (ok) => { artCache[id] = ok ? img.src : thumb(id); res(artCache[id]); };
    img.onload = () => done(img.naturalWidth > 200); // missing maxres returns a 120px placeholder
    img.onerror = () => done(false);
    img.src = thumb(id, 'maxresdefault');
  });
}
function extractColor(src) {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const N = 28, c = document.createElement('canvas'); c.width = c.height = N;
        const x = c.getContext('2d', { willReadFrequently: true });
        const s = Math.min(img.width, img.height);
        x.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, N, N);
        const d = x.getImageData(0, 0, N, N).data;
        const bins = Array.from({ length: 24 }, () => ({ w: 0, s: 0 }));
        let total = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
          const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
          if (l < 0.1 || l > 0.93) continue;
          const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
          let hue = 0;
          if (max !== min) {
            if (max === r) hue = ((g - b) / (max - min)) % 6;
            else if (max === g) hue = (b - r) / (max - min) + 2;
            else hue = (r - g) / (max - min) + 4;
            hue = (hue * 60 + 360) % 360;
          }
          const w = sat * sat * (1 - Math.abs(l - 0.5));
          total += w;
          const bin = bins[Math.floor(hue / 15) % 24];
          bin.w += w; bin.s += sat * w; bin.h = (bin.h || 0) + hue * w;
        }
        const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
        if (!best.w || total < 2) return res({ h: 30, s: 0, gray: true });
        res({ h: Math.round(best.h / best.w), s: best.s / best.w });
      } catch { res(null); }
    };
    img.onerror = () => res(null);
    img.src = src;
  });
}
function hueFromId(id) {
  let n = 0; for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return { h: n % 360, s: 0.6 };
}
function applyTheme(c) {
  const st = document.documentElement.style;
  const props = ['--accent', '--accent-2', '--on-accent', '--tint', '--plinth-1', '--plinth-2'];
  if (!c) { props.forEach((p) => st.removeProperty(p)); $('meta[name=theme-color]').content = '#121014'; return; }
  const { h: hue } = c;
  const s = c.gray ? 0.06 : Math.min(0.85, Math.max(0.4, c.s));
  const pct = (v) => `${Math.round(v * 100)}%`;
  st.setProperty('--accent', `hsl(${hue} ${pct(s)} ${c.gray ? '80%' : '68%'})`);
  st.setProperty('--accent-2', `hsl(${hue} ${pct(s)} ${c.gray ? '70%' : '58%'})`);
  st.setProperty('--on-accent', `hsl(${hue} 40% 10%)`);
  st.setProperty('--tint', `hsl(${hue} ${pct(s * 0.5)} 14%)`);
  st.setProperty('--plinth-1', `hsl(${hue} ${pct(s * 0.32)} 23%)`);
  st.setProperty('--plinth-2', `hsl(${hue} ${pct(s * 0.32)} 12%)`);
  $('meta[name=theme-color]').content = `hsl(${hue} ${pct(s * 0.4)} 10%)`;
}

let shownArt = null;
async function setArt(t) {
  const key = t ? (t.src || 'yt') + t.id : null;
  shownArt = key;
  const img = $('#labelArt'), deck = $('#deck');
  const url = t ? (t.src === 'sp' ? artUrl(t) : await artFor(t.id)) : '';
  if (shownArt !== key) return;
  if (!url) {
    img.removeAttribute('href'); deck.classList.add('no-art');
    applyTheme(t ? hueFromId(t.id) : null); return;
  }
  img.setAttribute('href', url); deck.classList.remove('no-art');
  // YouTube thumbs get a separate cache entry for the CORS request.
  const c = await extractColor(t.src === 'sp' ? url : thumb(t.id) + '?c=1');
  if (shownArt !== key) return;
  applyTheme(c || hueFromId(t.id));
}

/* The turntable itself (record, platter, tonearm, knob) lives in deck.js. */

/* ---------- YouTube players ---------- */
const PS = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
let player, helper, ytReady = false, helperReady = false, pendingAutoplay = null;
let phase = 'idle'; // idle | loading | playing | paused
let errStreak = 0, loadingTimer;

window.onYouTubeIframeAPIReady = () => {
  const vars = { playsinline: 1, rel: 0, modestbranding: 1, enablejsapi: 1, origin: location.origin };
  player = new YT.Player('ytPlayer', {
    width: '100%', height: '100%', playerVars: vars,
    events: { onReady: onPlayerReady, onStateChange: onPlayerState, onError: onPlayerError },
  });
  helper = new YT.Player('ytHelper', {
    width: 200, height: 200, playerVars: { ...vars, mute: 1 },
    events: {
      onReady: () => { helperReady = true; helper.mute(); },
      onStateChange: (e) => helperListener?.(e.data),
      onError: (e) => helperError?.(e.data),
    },
  });
};
(function loadYT() {
  if (location.protocol === 'file:') {
    $('#title').textContent = 'Start the app with start.bat';
    $('#artist').textContent = 'YouTube playback does not work from a file:// page.';
    return;
  }
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  s.onerror = () => toast("Couldn't reach YouTube. Check your internet connection.");
  document.head.append(s);
})();

/* ---------- playback engines ----------
   Every track plays through an engine: YouTube (default) or Spotify (spotify.js).
   They share one interface so the queue can mix both. */
const YTE = {
  name: 'yt',
  ready: () => ytReady,
  load(t, autoplay, start = 0) {
    const o = { videoId: t.id, startSeconds: Math.floor(start) };
    autoplay ? player.loadVideoById(o) : player.cueVideoById(o);
  },
  play() { player.playVideo(); },
  pause() { player.pauseVideo(); },
  stop() { if (ytReady) player.stopVideo(); },
  seek(s) { player.seekTo(s, true); },
  time: () => player?.getCurrentTime?.() || 0,
  duration: () => player?.getDuration?.() || 0,
  volume(v) { if (ytReady) player.setVolume(v); },
  mute(m) { if (ytReady) (m ? player.mute() : player.unMute()); },
  isLoaded: (t) => player?.getVideoData?.()?.video_id === t.id && player.getPlayerState() !== PS.ENDED,
};
const eng = (t = S.queue[S.index]) => (t?.src === 'sp' ? SPE : YTE);
const isCurrent = (E) => eng() === E;

function onPlayerReady() {
  ytReady = true;
  player.setVolume(S.volume);
  const t = S.queue[S.index];
  if (!t || t.src === 'sp') return;
  if (pendingAutoplay != null) { const a = pendingAutoplay; pendingAutoplay = null; playIndex(S.index, a.autoplay, a.start); }
  else player.cueVideoById({ videoId: t.id, startSeconds: Math.floor(S.pos || 0) });
}
function onPlayerState(e) {
  if (!isCurrent(YTE)) return; // a Spotify track is playing; ignore the stopped YouTube player
  switch (e.data) {
    case PS.PLAYING: errStreak = 0; setPhase('playing'); pullVideoData(); break;
    case PS.PAUSED: setPhase('paused'); break;
    case PS.BUFFERING: if (phase === 'idle') setPhase('loading'); break;
    case PS.ENDED: onEnded(); break;
    case PS.CUED: if (phase !== 'loading') setPhase('idle'); break;
    default: break;
  }
}
function onPlayerError(e) {
  if (!isCurrent(YTE)) return;
  const t = S.queue[S.index];
  const name = t ? `"${trackTitle(t)}"` : 'This track';
  const why = e.data === 101 || e.data === 150 ? "can't be played outside YouTube"
    : e.data === 100 ? 'was removed or is private' : "couldn't be played";
  errStreak++;
  if (errStreak >= Math.min(S.queue.length, 8)) { toast(`${name} ${why}. Stopping.`); setPhase('idle'); return; }
  toast(`${name} ${why}. Skipping.`);
  setTimeout(() => next(true), 900);
}
function pullVideoData() {
  const t = S.queue[S.index], d = player.getVideoData?.();
  if (!t || !d || d.video_id !== t.id || meta[t.id] || t.title || !d.title) return;
  meta[t.id] = cleanMeta(d.title, d.author || ''); persistMeta(); applyMeta(t.id);
}

function setPhase(p) {
  const was = phase;
  phase = p;
  document.body.dataset.phase = p;
  $('#deck').classList.toggle('playing', p === 'playing');
  $('#playIcon').setAttribute('href', p === 'playing' || p === 'loading' ? '#i-pause' : '#i-play');
  clearTimeout(loadingTimer);
  if (p === 'loading') {
    // If autoplay gets blocked (common on phones before the first tap), fall back to a play button.
    loadingTimer = setTimeout(() => {
      if (phase !== 'loading') return;
      const st = player?.getPlayerState?.();
      if (!isCurrent(YTE) || st === PS.UNSTARTED || st === PS.CUED) setPhase('idle');
    }, isCurrent(YTE) ? 8000 : 12000);
  }
  deckSync();
  if (was !== p) roomNotify();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p === 'playing' ? 'playing' : p === 'paused' ? 'paused' : 'none';
}

/* ---------- playback control ---------- */
function playIndex(i, autoplay = true, start = 0) {
  const t = S.queue[i]; if (!t) return;
  const before = S.queue[S.index] ? eng() : null;
  S.index = i; S.pos = start;
  if (!roomIsGuest()) store.set('pos', start);
  const E = eng(t);
  if (before && before !== E) before.stop();
  if (E === YTE && !ytReady) pendingAutoplay = { autoplay, start };
  else if (E === SPE && !SPE.ready()) { setPhase('idle'); toast('Connect Spotify in Library to play Spotify tracks'); }
  else {
    setPhase(autoplay ? 'loading' : 'idle');
    Promise.resolve().then(() => E.load(t, autoplay, start)).catch(engineError);
  }
  if (t.src !== 'sp') needMeta(t.id);
  if (S.queue[i + 1]?.src !== 'sp' && S.queue[i + 1]) needMeta(S.queue[i + 1].id);
  updateNowPlaying(); renderQueue(); persist(); roomNotify();
}
function engineError(err) {
  toast(err?.message || 'Playback failed');
  setPhase('idle');
}
function onEnded() {
  if (roomIsGuest()) { setPhase('idle'); return; } // the host decides what plays next
  if (S.repeat === 'one') {
    if (isCurrent(YTE)) { player.seekTo(0, true); player.playVideo(); } else playIndex(S.index);
    return;
  }
  if (S.index < S.queue.length - 1) return playIndex(S.index + 1);
  if (S.repeat === 'all' && S.queue.length) return playIndex(0);
  setPhase('idle');
}
function next(auto = false) {
  if (auto && roomIsGuest()) return;
  if (!auto && roomIntercept('next')) return;
  if (!S.queue.length) return;
  if (S.index < S.queue.length - 1) return playIndex(S.index + 1);
  if (S.repeat === 'all' || !auto) return playIndex(0);
  setPhase('idle');
}
function prev() {
  if (roomIntercept('prev')) return;
  if (!S.queue.length) return;
  const E = eng();
  if (S.index >= 0 && E.ready() && E.time() > 3) { E.seek(0); return; }
  playIndex(S.index > 0 ? S.index - 1 : S.repeat === 'all' ? S.queue.length - 1 : 0);
}
function togglePlay() {
  if (roomIntercept('toggle')) return;
  if (!S.queue.length) { toast('Add some music first'); openPanel('library'); setTimeout(() => $('#linkInput').focus(), 350); return; }
  if (S.index < 0) return playIndex(0);
  const E = eng(), t = S.queue[S.index];
  if (!E.ready()) { toast(E === SPE ? 'Connect Spotify in Library to play this track' : 'Player is still loading…'); return; }
  if (phase === 'playing' || phase === 'loading') {
    Promise.resolve().then(() => E.pause()).catch(engineError);
    if (E === SPE) setPhase('paused');
    return;
  }
  if (!E.isLoaded(t)) return playIndex(S.index);
  setPhase('loading');
  Promise.resolve().then(() => E.play()).catch(engineError);
}
function seekBy(sec) {
  const E = eng();
  if (S.index < 0 || !E.ready()) return;
  userSeek(Math.max(0, E.time() + sec));
}
function userSeek(sec) {
  if (roomIntercept('seek', { to: sec })) return;
  const E = eng();
  if (S.index < 0 || !E.ready()) return;
  E.seek(sec); roomNotify();
}

/* queue editing */
function setQueue(tracks, start = 0) {
  if (roomIntercept('replace', { tracks, start })) return;
  let q = tracks.filter(validTrack).map((t) => ({ ...t, uid: uid() }));
  if (!q.length) { toast('Nothing playable found there'); return; }
  start = Math.min(Math.max(0, start), q.length - 1);
  if (S.shuffle) {
    S.original = q.slice();
    const first = q[start], rest = q.filter((_, j) => j !== start);
    q = [first, ...shuffleArr(rest)]; start = 0;
  } else S.original = null;
  S.queue = q;
  playIndex(start, true);
}
function enqueue(tracks, { playNow = false } = {}) {
  if (roomIntercept('add', { tracks, playNow })) return;
  const items = tracks.filter(validTrack).map((t) => ({ ...t, uid: uid() }));
  if (!items.length) return;
  const wasEmpty = !S.queue.length;
  if (playNow && S.index >= 0) S.queue.splice(S.index + 1, 0, ...items);
  else S.queue.push(...items);
  if (S.original) S.original.push(...items);
  if (playNow) return playIndex(wasEmpty ? 0 : S.index + 1);
  if (wasEmpty) return playIndex(0);
  renderQueue(); updateUpNext(); persist();
  toast(items.length === 1 ? `Added "${trackTitle(items[0])}" to queue` : `Added ${items.length} tracks to queue`);
}
function removeAt(i) {
  if (roomIntercept('remove', { i })) return;
  const [t] = S.queue.splice(i, 1);
  if (S.original) S.original = S.original.filter((x) => x.uid !== t.uid);
  if (i < S.index) S.index--;
  else if (i === S.index) {
    if (!S.queue.length) {
      eng(t).stop(); S.index = -1; setPhase('idle'); updateNowPlaying();
    } else {
      playIndex(Math.min(i, S.queue.length - 1), phase === 'playing' || phase === 'loading');
      return;
    }
  }
  renderQueue(); updateUpNext(); persist();
}
function clearQueue() {
  if (roomIsGuest()) { toast('Only the host can clear the room queue.'); return; }
  if (S.queue[S.index]) eng().stop();
  S.queue = []; S.original = null; S.index = -1;
  setPhase('idle'); updateNowPlaying(); renderQueue(); persist();
}
function toggleShuffle() {
  if (roomIntercept('shuffle')) return;
  S.shuffle = !S.shuffle;
  const cur = S.queue[S.index];
  if (S.shuffle) {
    S.original = S.queue.slice();
    const rest = shuffleArr(S.queue.filter((_, j) => j !== S.index));
    S.queue = cur ? [cur, ...rest] : rest;
  } else if (S.original) {
    const alive = new Set(S.queue.map((t) => t.uid));
    S.queue = S.original.filter((t) => alive.has(t.uid));
    S.original = null;
  }
  S.index = cur ? S.queue.findIndex((t) => t.uid === cur.uid) : -1;
  syncToggles(); renderQueue(); updateUpNext(); persist();
  toast(S.shuffle ? 'Shuffle on' : 'Shuffle off', 1400);
}
function cycleRepeat() {
  if (roomIntercept('repeat')) return;
  S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off';
  syncToggles(); updateUpNext(); persist(); roomNotify();
  toast({ off: 'Repeat off', all: 'Repeat queue', one: 'Repeat this song' }[S.repeat], 1400);
}
function setVolume(v) {
  S.volume = Math.max(0, Math.min(100, Math.round(v)));
  YTE.volume(S.volume); SPE.volume(S.volume);
  if (S.muted && S.volume > 0) toggleMute(false);
  setRange($('#vol'), S.volume, 100); knobRender(); persist();
}
function toggleMute(force) {
  S.muted = typeof force === 'boolean' ? force : !S.muted;
  YTE.mute(S.muted); SPE.mute(S.muted);
  $('#volIcon').setAttribute('href', S.muted ? '#i-volume-off' : '#i-volume');
  knobRender();
}
function toggleVideo(force) {
  S.showVideo = typeof force === 'boolean' ? force : !S.showVideo;
  syncVideoDock();
  $('#btnVideo').setAttribute('aria-pressed', S.showVideo);
  $('#chkVideo').checked = S.showVideo;
  persist();
}
function syncVideoDock() {
  // Spotify tracks have no video, so the window steps aside while one plays.
  const show = S.showVideo && S.queue[S.index]?.src !== 'sp';
  $('#videoDock').classList.toggle('hidden', !show);
  document.body.classList.toggle('video-on', show);
}
function syncToggles() {
  $('#btnShuffle').setAttribute('aria-pressed', S.shuffle);
  $('#btnRepeat').setAttribute('aria-pressed', S.repeat !== 'off');
  $('#repeatIcon').setAttribute('href', S.repeat === 'one' ? '#i-repeat-one' : '#i-repeat');
}

/* ---------- now playing UI ---------- */
function updateNowPlaying() {
  const t = S.queue[S.index];
  syncVideoDock();
  if (!t) {
    $('#title').textContent = 'Drop the needle';
    $('#artist').textContent = 'Paste a YouTube Music or Spotify link to start';
    document.title = 'Vinyl';
    if (shownArt) setArt(null);
    setRange($('#seek'), 0, 1000); $('#tCur').textContent = $('#tDur').textContent = '0:00';
    updateUpNext(); return;
  }
  $('#title').textContent = trackTitle(t);
  $('#artist').textContent = trackArtist(t);
  document.title = `${trackTitle(t)} · Vinyl`;
  if (shownArt !== (t.src || 'yt') + t.id) setArt(t);
  updateUpNext();
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: trackTitle(t), artist: trackArtist(t), album: 'Vinyl',
        artwork: t.src === 'sp'
          ? (artUrl(t) ? [{ src: artUrl(t), sizes: '300x300', type: 'image/jpeg' }] : [])
          : [
            { src: thumb(t.id, 'hqdefault'), sizes: '480x360', type: 'image/jpeg' },
            { src: thumb(t.id), sizes: '320x180', type: 'image/jpeg' },
          ],
      });
    } catch { /* unsupported */ }
  }
}
function updateUpNext() {
  const n = S.queue.length > 1 ? (S.queue[S.index + 1] || (S.repeat === 'all' ? S.queue[0] : null)) : null;
  const title = n && (n.title || meta[n.id]?.t);
  $('#upNext').textContent = title ? `Up next · ${title}` : '';
}
function setRange(el, v, max) {
  el.value = v;
  el.style.setProperty('--p', `${(v / max) * 100}%`);
}

let seeking = false, lastPosSave = 0, lastPosState = 0;
setInterval(() => {
  deckSync();
  const E = eng();
  if (S.index < 0 || !E.ready()) return;
  const d = E.duration() || 0, c = Math.min(E.time() || 0, d || Infinity);
  if (!seeking) { setRange($('#seek'), d ? (c / d) * 1000 : 0, 1000); $('#tCur').textContent = fmt(c); }
  $('#tDur').textContent = fmt(d);
  if (phase === 'playing') {
    const now = Date.now();
    if (now - lastPosSave > 4000 && !roomIsGuest()) { lastPosSave = now; S.pos = c; store.set('pos', c); }
    if (d && now - lastPosState > 1000 && 'mediaSession' in navigator && navigator.mediaSession.setPositionState) {
      lastPosState = now;
      try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d), playbackRate: 1 }); } catch { /* ignore */ }
    }
  }
}, 250);

/* ---------- list rendering ---------- */
function trackRow(t, { current = false, onClick, actions = [], sub } = {}) {
  const sp = t.src === 'sp', art = artUrl(t);
  const row = h('div', { class: 'row' + (current ? ' current' : '') + (sp ? ' sp' : ''), role: 'button', tabindex: '0', 'data-vid': sp ? null : t.id },
    h('div', { class: 'row-art' },
      art ? h('img', { src: art, alt: '', loading: 'lazy', decoding: 'async' }) : null,
      current ? h('div', { class: 'eq' }, h('i'), h('i'), h('i')) : null),
    h('div', { class: 'row-text' },
      h('div', { class: 't', text: trackTitle(t) }),
      h('div', { class: 'a', text: sub ?? trackArtist(t) })),
    h('div', { class: 'actions' }, actions));
  row.addEventListener('click', () => onClick?.());
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) onClick?.(); });
  if (!sp && !t.title && !meta[t.id]) metaObserver.observe(row);
  return row;
}
function collectionRow({ cover, coverUrl, glyph, glyphClass, title, sub, onClick, actions = [] }) {
  const art = h('div', { class: 'row-art' });
  if (coverUrl || cover) art.append(h('img', { src: coverUrl || thumb(cover), alt: '', loading: 'lazy' }));
  if (glyph) { const g = h('div', { class: 'glyph' + (glyphClass ? ' ' + glyphClass : '') }); g.append(icon(glyph)); art.append(g); }
  const row = h('div', { class: 'row', role: 'button', tabindex: '0' },
    art,
    h('div', { class: 'row-text' }, h('div', { class: 't', text: title }), h('div', { class: 'a', text: sub || '' })),
    h('div', { class: 'actions' }, actions));
  row.addEventListener('click', () => onClick?.());
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) onClick?.(); });
  return row;
}
const empty = (title, text) => h('div', { class: 'empty' }, h('b', { text: title }), text);

function renderQueue() {
  const list = $('#queueList');
  metaObserver.disconnect();
  list.replaceChildren();
  $('#queueCount').textContent = S.queue.length ? `· ${S.queue.length}` : '';
  if (!S.queue.length) { list.append(empty('Your queue is empty', 'Paste a YouTube Music or Spotify link in Library to fill it.')); return; }
  const frag = document.createDocumentFragment();
  S.queue.forEach((t, i) => {
    frag.append(trackRow(t, {
      current: i === S.index,
      onClick: () => (i === S.index ? togglePlay() : roomIntercept('index', { i }) || playIndex(i)),
      actions: [iconBtn('close', 'Remove from queue', () => removeAt(i))],
    }));
  });
  list.append(frag);
  roomNotify();
}
function scrollQueueToCurrent() {
  const cur = $('#queueList .row.current');
  if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ---------- links & playlists ---------- */
function parseLink(input) {
  const s = (input || '').trim();
  if (!s) return null;
  if (isId(s)) return { video: s };
  if (/^(PL|OLAK5uy_|RD|UU|FL)[\w-]{10,}$/.test(s)) return { list: s };
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m)\./, '');
  let video = null, list = u.searchParams.get('list');
  if (host === 'youtu.be') video = u.pathname.slice(1, 12);
  else if (host === 'youtube.com' || host === 'music.youtube.com' || host.endsWith('.youtube.com')) {
    video = u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    if (m) video = m[1];
    const b = u.pathname.match(/^\/browse\/VL([\w-]+)/);
    if (b) list = b[1];
  } else return null;
  if (!isId(video)) video = null;
  if (list && !/^[\w-]+$/.test(list)) list = null;
  if (!video && !list) return null;
  return { video, list };
}

/* The helper player reads a playlist's video IDs without playing anything. */
let helperListener = null, helperError = null, lastResolved = '';
function resolvePlaylist(list) {
  return new Promise((resolve, reject) => {
    if (!helperReady) { reject(new Error('Player is still loading. Try again in a second.')); return; }
    const started = Date.now();
    let done = false, poll, timer;
    const finish = (fn, v) => {
      if (done) return; done = true;
      clearTimeout(timer); clearInterval(poll); helperListener = helperError = null;
      fn(v);
    };
    const tryGet = () => {
      const ids = (helper.getPlaylist?.() || []).filter(isId);
      if (!ids.length) return;
      const key = ids.length + ids[0] + ids[ids.length - 1];
      if (key === lastResolved && Date.now() - started < 2500) return; // stale result from the previous playlist
      lastResolved = key;
      finish(resolve, ids);
    };
    timer = setTimeout(() => finish(reject, new Error("Couldn't open that playlist. Is it public or unlisted?")), 15000);
    helperListener = (st) => { if (st === PS.CUED || st === PS.UNSTARTED) tryGet(); };
    helperError = () => finish(reject, new Error("Couldn't open that playlist. Is it public or unlisted?"));
    helper.cuePlaylist({ listType: 'playlist', list });
    poll = setInterval(tryGet, 400);
  });
}
function listKind(id, e) {
  if (e?.src === 'sp') return e.kind === 'album' ? 'Spotify album' : 'Spotify playlist';
  if (id.startsWith('OLAK5uy_')) return 'Album';
  if (id.startsWith('RD')) return 'Mix';
  return 'Playlist';
}
async function saveToLibrary(entry) {
  const old = S.library.find((e) => e.id === entry.id);
  S.library = [{ ...old, ...entry }, ...S.library.filter((e) => e.id !== entry.id)].slice(0, 100);
  persist(); renderSaved();
  if (entry.src !== 'sp' && (!old?.title || old.title === listKind(entry.id))) {
    const j = await oembed('https://www.youtube.com/playlist?list=' + entry.id);
    const e = S.library.find((x) => x.id === entry.id);
    if (e) { e.title = j?.title ? decode(j.title) : listKind(entry.id); persist(); renderSaved(); }
  }
}

let busy = false;
function setBusy(b) {
  busy = b;
  $('#btnLinkPlay').disabled = b; $('#btnLinkQueue').disabled = b;
  $('#btnLinkPlay').lastChild.textContent = b ? 'Loading…' : 'Play';
}
async function handleLink(mode) {
  if (busy) return;
  const input = $('#linkInput'), raw = input.value;
  const spLink = parseSpotifyLink(raw);
  if (spLink) {
    setBusy(true);
    try { if (await handleSpotifyLink(spLink, mode)) input.value = ''; } catch (err) { toast(err.message); } finally { setBusy(false); }
    return;
  }
  const p = parseLink(raw);
  if (!p) {
    toast(/browse\/MPRE/.test(raw)
      ? 'For albums, use the album\'s Share → Copy link (it contains "playlist?list=").'
      : "That doesn't look like a YouTube Music, YouTube or Spotify link.");
    return;
  }
  if (p.list === 'LM' || p.list === 'LL') {
    toast('Liked songs are private. Connect your account under "Your account" to load them.');
    return;
  }
  setBusy(true);
  try {
    if (p.list) {
      const ids = await resolvePlaylist(p.list);
      const tracks = ids.map((id) => ({ id }));
      const start = p.video ? Math.max(0, ids.indexOf(p.video)) : 0;
      if (mode === 'play') { setQueue(tracks, start); closePanelOnPhone(); } else enqueue(tracks);
      saveToLibrary({ id: p.list, count: ids.length, cover: ids[start] });
    } else {
      if (mode === 'play') { enqueue([{ id: p.video }], { playNow: true }); closePanelOnPhone(); } else enqueue([{ id: p.video }]);
    }
    input.value = '';
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
}
async function playSaved(entry, { shuffle = false, add = false } = {}) {
  try {
    toast(`Loading ${entry.title || 'playlist'}…`, 1500);
    const tracks = entry.src === 'sp'
      ? (await spCollection(entry.kind, entry.id)).tracks
      : (await resolvePlaylist(entry.id)).map((id) => ({ id }));
    entry.count = tracks.length; persist();
    if (add) { enqueue(tracks); return; }
    if (shuffle && !S.shuffle) { S.shuffle = true; syncToggles(); }
    setQueue(tracks, shuffle ? Math.floor(Math.random() * tracks.length) : 0);
    closePanelOnPhone();
  } catch (err) { toast(err.message); }
}
function renderSaved() {
  const list = $('#savedList');
  list.replaceChildren();
  if (!S.library.length) {
    list.append(empty('Nothing saved yet', 'Playlists and albums you paste (YouTube Music or Spotify) show up here.'));
    return;
  }
  for (const e of S.library) {
    list.append(collectionRow({
      cover: isId(e.cover) ? e.cover : null,
      coverUrl: isSpArt(e.cover) ? e.cover : null,
      glyph: isId(e.cover) || isSpArt(e.cover) ? null : 'library',
      title: e.title || listKind(e.id, e),
      sub: [listKind(e.id, e), e.count ? `${e.count} tracks` : ''].filter(Boolean).join(' · '),
      onClick: () => playSaved(e),
      actions: [
        iconBtn('shuffle', 'Shuffle play', () => playSaved(e, { shuffle: true })),
        iconBtn('add', 'Add to queue', () => playSaved(e, { add: true })),
        iconBtn('close', 'Remove', () => { S.library = S.library.filter((x) => x !== e); persist(); renderSaved(); }),
      ],
    }));
  }
}

/* ---------- Google account (optional, YouTube Data API v3, read-only) ---------- */
const G = { token: null, exp: 0, playlists: null, loading: false };
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

function loadGIS() {
  return new Promise((res, rej) => {
    if (window.google?.accounts?.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => res(); s.onerror = () => rej(new Error("Couldn't load Google sign-in."));
    document.head.append(s);
  });
}
async function connect() {
  const clientId = store.get('clientId', '');
  if (!clientId) { openSettings('setGoogle'); throw new Error('Add your Google client ID first.'); }
  await loadGIS();
  return new Promise((res, rej) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPE,
      callback: (r) => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        G.token = r.access_token; G.exp = Date.now() + (Number(r.expires_in) - 60) * 1000;
        store.set('connected', true); res();
      },
      error_callback: (e) => rej(new Error(e?.type === 'popup_closed' ? 'Sign-in was cancelled.' : e?.message || 'Sign-in failed.')),
    });
    client.requestAccessToken({ prompt: store.get('connected') ? '' : 'consent' });
  });
}
async function yt(path, params) {
  if (!G.token || Date.now() > G.exp) await connect();
  const u = new URL('https://www.googleapis.com/youtube/v3/' + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + G.token } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { G.token = null; renderAccount(); throw new Error('Session expired. Reconnect your account.'); }
  if (!r.ok) throw new Error(j.error?.message ? decode(j.error.message) : `YouTube API error ${r.status}`);
  return j;
}
async function ytAll(path, params, max = 1000) {
  const items = []; let pageToken;
  do {
    const j = await yt(path, { ...params, maxResults: 50, ...(pageToken ? { pageToken } : {}) });
    items.push(...(j.items || [])); pageToken = j.nextPageToken;
  } while (pageToken && items.length < max);
  return items;
}
const fromSnippet = (id, title, channel) => { const m = cleanMeta(decode(title), decode(channel || '')); return { id, title: m.t, artist: m.a }; };

async function loadAccountPlaylists() {
  G.loading = true; renderAccount();
  try {
    const items = await ytAll('playlists', { part: 'snippet,contentDetails', mine: 'true' }, 200);
    G.playlists = items.map((p) => ({
      id: p.id, title: decode(p.snippet.title), count: p.contentDetails?.itemCount ?? 0,
      thumb: p.snippet.thumbnails?.medium?.url || p.snippet.thumbnails?.default?.url || '',
    }));
  } catch (err) { toast(err.message); }
  G.loading = false; renderAccount();
}
async function accountTracks(kind, id) {
  if (kind === 'liked') {
    const items = await ytAll('videos', { part: 'snippet', myRating: 'like' }, 1000);
    return items.map((v) => fromSnippet(v.id, v.snippet.title, v.snippet.channelTitle));
  }
  const items = await ytAll('playlistItems', { part: 'snippet', playlistId: id }, 2000);
  return items
    .filter((it) => isId(it.snippet?.resourceId?.videoId) && !/^(Deleted|Private) video$/.test(it.snippet.title))
    .map((it) => fromSnippet(it.snippet.resourceId.videoId, it.snippet.title, it.snippet.videoOwnerChannelTitle));
}
async function playAccount(kind, id, title, { shuffle = false, add = false } = {}) {
  try {
    toast(`Loading ${title}…`, 1500);
    const tracks = await accountTracks(kind, id);
    if (!tracks.length) { toast(`${title} is empty`); return; }
    if (add) { enqueue(tracks); return; }
    if (shuffle && !S.shuffle) { S.shuffle = true; syncToggles(); }
    setQueue(tracks, shuffle ? Math.floor(Math.random() * tracks.length) : 0);
    closePanelOnPhone();
  } catch (err) { toast(err.message); }
}
async function doConnect() {
  try { await connect(); toast('Connected to YouTube'); await loadAccountPlaylists(); }
  catch (err) { toast(err.message); renderAccount(); }
}
function disconnect() {
  if (G.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(G.token, () => {});
  G.token = null; G.playlists = null; store.del('connected');
  renderAccount(); renderSearch(); toast('Disconnected');
}
function renderAccount() {
  const box = $('#accountBox');
  box.replaceChildren();
  const clientId = store.get('clientId', '');
  if (!clientId) {
    box.append(h('div', { class: 'card' },
      h('p', { class: 'muted', text: 'Connect your YouTube account to browse your own playlists and liked songs, and to search. It needs a free Google Cloud client ID, a one-time 5-minute setup.' }),
      h('button', { class: 'btn', onclick: () => openSettings('setGoogle') }, icon('account'), 'Set up connection')));
    return;
  }
  if (!G.token) {
    const again = store.get('connected', false);
    box.append(h('div', { class: 'card' },
      h('p', { class: 'muted', text: again ? 'Reconnect to load your playlists and liked songs.' : 'Sign in with Google to load your YouTube Music playlists and liked songs.' }),
      h('button', { class: 'btn primary', onclick: doConnect }, icon('account'), again ? 'Reconnect' : 'Connect YouTube account')));
    return;
  }
  box.append(h('div', { class: 'account-head' },
    h('span', { text: 'Connected' }),
    h('button', { class: 'text-btn', onclick: loadAccountPlaylists, text: 'Refresh' })));
  box.append(collectionRow({
    glyph: 'heart', title: 'Liked songs', sub: 'Everything you\'ve liked',
    onClick: () => playAccount('liked', null, 'Liked songs'),
    actions: [
      iconBtn('shuffle', 'Shuffle play', () => playAccount('liked', null, 'Liked songs', { shuffle: true })),
      iconBtn('add', 'Add to queue', () => playAccount('liked', null, 'Liked songs', { add: true })),
    ],
  }));
  if (G.loading) { box.append(h('div', { class: 'loading-row', text: 'Loading your playlists…' })); return; }
  for (const p of G.playlists || []) {
    box.append(collectionRow({
      coverUrl: /^https:\/\/i\d?\.ytimg\.com\//.test(p.thumb) ? p.thumb : null,
      glyph: p.thumb ? null : 'library',
      title: p.title, sub: `${p.count} tracks`,
      onClick: () => playAccount('playlist', p.id, p.title),
      actions: [
        iconBtn('shuffle', 'Shuffle play', () => playAccount('playlist', p.id, p.title, { shuffle: true })),
        iconBtn('add', 'Add to queue', () => playAccount('playlist', p.id, p.title, { add: true })),
      ],
    }));
  }
  if (G.playlists && !G.playlists.length) box.append(h('div', { class: 'loading-row', text: 'No playlists on this account yet.' }));
}

/* search (YouTube needs the Google connection, Spotify needs the Spotify connection) */
const searchSrc = () => (store.get('searchSrc', 'yt') === 'sp' && store.get('spClientId', '') ? 'sp' : 'yt');
function renderSearch(results) {
  const list = $('#searchResults');
  list.replaceChildren();
  const seg = $('#searchSeg');
  seg.hidden = !store.get('spClientId', '');
  for (const b of $$('button', seg)) b.setAttribute('aria-pressed', b.dataset.src === searchSrc());
  $('#searchInput').placeholder = searchSrc() === 'sp' ? 'Search Spotify…' : 'Search songs, artists…';
  if (searchSrc() === 'sp') {
    if (!SP.tokens) {
      list.append(h('div', { class: 'empty' },
        h('b', { text: 'Connect Spotify to search it' }),
        h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn', onclick: spLogin }, icon('account'), 'Connect Spotify'))));
      return;
    }
  } else if (!store.get('clientId', '') || !G.token) {
    list.append(h('div', { class: 'empty' },
      h('b', { text: 'Search needs your account' }),
      'Connect YouTube in Library, or paste links directly.',
      h('div', { style: 'margin-top:14px' },
        h('button', { class: 'btn', onclick: () => (store.get('clientId', '') ? doConnect().then(() => renderSearch()) : openSettings('setGoogle')) },
          icon('account'), store.get('clientId', '') ? 'Connect' : 'Set up connection'))));
    return;
  }
  if (!results) {
    list.append(empty(searchSrc() === 'sp' ? 'Search Spotify' : 'Search YouTube Music', 'Find any song and play it, or add it to the queue.'));
    return;
  }
  if (!results.length) { list.append(empty('No results', 'Try a different search.')); return; }
  for (const t of results) {
    list.append(trackRow(t, {
      onClick: () => { enqueue([t], { playNow: true }); closePanelOnPhone(); },
      actions: [iconBtn('add', 'Add to queue', () => enqueue([t]))],
    }));
  }
}
async function doSearch(q) {
  if (!q.trim()) return;
  const list = $('#searchResults');
  list.replaceChildren(h('div', { class: 'loading-row', text: 'Searching…' }));
  try {
    if (searchSrc() === 'sp') { renderSearch(await spSearch(q)); return; }
    const j = await yt('search', { part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: '25', q });
    renderSearch((j.items || []).filter((it) => isId(it.id?.videoId))
      .map((it) => fromSnippet(it.id.videoId, it.snippet.title, it.snippet.channelTitle)));
  } catch (err) { toast(err.message); renderSearch(); }
}

/* ---------- panel / tabs ---------- */
const isPhoneLayout = () => matchMedia('(max-width: 959px)').matches;
function selectTab(name) {
  for (const t of $$('.tab')) t.setAttribute('aria-selected', t.dataset.tab === name);
  for (const b of $$('.tab-body')) b.hidden = b.dataset.tab !== name;
  if (name === 'search') { renderSearch(); if (searchSrc() === 'sp' ? SP.tokens : G.token) setTimeout(() => $('#searchInput').focus(), 50); }
  if (name === 'queue') requestAnimationFrame(scrollQueueToCurrent);
  store.set('tab', name);
}
function openPanel(tab) {
  if (tab) selectTab(tab);
  if (isPhoneLayout()) { $('#panel').classList.add('open'); $('#scrim').classList.add('show'); }
}
function closePanel() { $('#panel').classList.remove('open'); $('#scrim').classList.remove('show'); }
function closePanelOnPhone() { if (isPhoneLayout()) closePanel(); }

/* ---------- settings ---------- */
let qrLib;
function loadQR() {
  if (qrLib) return qrLib;
  qrLib = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
    s.onload = () => res(window.qrcode); s.onerror = rej;
    document.head.append(s);
  });
  return qrLib;
}
async function fillLan() {
  const box = $('#lanBox');
  box.replaceChildren();
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  let url = location.origin + location.pathname;
  let note = 'Open this address on your phone or tablet, then use "Add to Home Screen" (or "Install app").';
  if (local) {
    try {
      const urls = await (await fetch('lan.json', { cache: 'no-store' })).json();
      if (!urls.length) throw new Error('none');
      url = urls[0] + '/';
      note = 'Connect your phone or tablet to the same Wi-Fi as this PC, then scan the code or type the address. If it won\'t load, allow Node.js through Windows Firewall for private networks.';
      if (urls.length > 2) note += ` Still nothing? Try ${urls[1]} instead.`;
    } catch {
      box.append(h('div', { class: 'lan-text', text: 'Start the app with start.bat (or "node server.js") to get an address for your phone.' }));
      return;
    }
  }
  const text = h('div', { class: 'lan-text' }, h('div', { class: 'big' }, h('code', { text: url })), note);
  box.append(text);
  try {
    const qrcode = await loadQR();
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    box.prepend(h('img', { src: qr.createDataURL(5, 2), alt: 'QR code for ' + url }));
  } catch { /* QR is a nicety */ }
}
function openSettings(section) {
  const d = $('#settings');
  $('#originCode').textContent = location.origin;
  $('#clientIdInput').value = store.get('clientId', '');
  $('#chkVideo').checked = S.showVideo;
  const secure = window.isSecureContext;
  $('#originHint').textContent = secure
    ? `Google sign-in works on this address (${location.origin}). Add each address you use as an authorized origin.`
    : 'Google sign-in only works on http://localhost or an https:// address. On your phone, host the app on HTTPS (see README) to sign in there. Pasting links works everywhere.';
  $('#btnDisconnect').hidden = !G.token && !store.get('connected');
  spFillSettings();
  fillLan();
  if (!d.open) d.showModal();
  if (section) requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ block: 'start' }));
}

/* ---------- wire up ---------- */
function bind() {
  $('#btnPlay').addEventListener('click', togglePlay);
  $('#btnNext').addEventListener('click', () => next());
  $('#btnPrev').addEventListener('click', prev);
  $('#btnShuffle').addEventListener('click', toggleShuffle);
  $('#btnRepeat').addEventListener('click', cycleRepeat);
  $('#btnMute').addEventListener('click', () => toggleMute());
  $('#btnVideo').addEventListener('click', () => toggleVideo());
  $('#btnSettings').addEventListener('click', () => openSettings());
  $('#btnClearQueue').addEventListener('click', () => { if (S.queue.length && confirm('Clear the whole queue?')) clearQueue(); });

  const seek = $('#seek');
  seek.addEventListener('input', () => {
    seeking = true;
    const d = eng().ready() ? eng().duration() : 0;
    seek.style.setProperty('--p', `${seek.value / 10}%`);
    $('#tCur').textContent = fmt((seek.value / 1000) * d);
  });
  seek.addEventListener('change', () => {
    const E = eng();
    if (E.ready() && S.index >= 0) userSeek((seek.value / 1000) * E.duration());
    seeking = false;
  });
  $('#vol').addEventListener('input', (e) => setVolume(+e.target.value));

  $('#linkForm').addEventListener('submit', (e) => { e.preventDefault(); handleLink('play'); });
  $('#btnLinkQueue').addEventListener('click', () => handleLink('queue'));
  $('#linkInput').addEventListener('paste', () => setTimeout(() => {
    if (parseLink($('#linkInput').value)) $('#linkInput').select();
  }, 0));
  for (const b of $$('#searchSeg button')) {
    b.addEventListener('click', () => { store.set('searchSrc', b.dataset.src); renderSearch(); $('#searchInput').focus(); });
  }
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); $('#searchInput').blur(); doSearch($('#searchInput').value); });

  for (const t of $$('.tab')) t.addEventListener('click', () => selectTab(t.dataset.tab));
  for (const b of $$('[data-open]')) b.addEventListener('click', () => openPanel(b.dataset.open));
  $('#scrim').addEventListener('click', closePanel);
  $('#sheetHandle').addEventListener('click', closePanel);
  let sheetY = null;
  $('#sheetHandle').addEventListener('pointerdown', (e) => { sheetY = e.clientY; });
  window.addEventListener('pointerup', (e) => { if (sheetY != null && e.clientY - sheetY > 40) closePanel(); sheetY = null; });

  // Tap the record to play/pause, swipe across the deck to skip.
  const deck = $('#deckWrap');
  let down = null;
  deck.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: Date.now(), onDisc: !!e.target.closest('#disc') }; });
  deck.addEventListener('pointerup', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) dx < 0 ? next() : prev();
    else if (down.onDisc && Math.hypot(dx, dy) < 10 && Date.now() - down.t < 500) togglePlay();
    down = null;
  });

  // Settings dialog
  $('#btnCloseSettings').addEventListener('click', () => $('#settings').close());
  $('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('#settings').close(); });
  $('#btnSaveClient').addEventListener('click', () => {
    const v = $('#clientIdInput').value.trim();
    if (v && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(v)) { toast('That doesn\'t look like a client ID. It ends with .apps.googleusercontent.com'); return; }
    if (v !== store.get('clientId', '')) { G.token = null; store.del('connected'); }
    store.set('clientId', v);
    renderAccount(); renderSearch();
    toast(v ? 'Saved. Now tap "Connect YouTube account" in Library.' : 'Client ID removed');
    if (v) { $('#settings').close(); openPanel('library'); }
  });
  $('#btnDisconnect').addEventListener('click', () => { disconnect(); $('#btnDisconnect').hidden = true; });
  $('#chkVideo').addEventListener('change', (e) => toggleVideo(e.target.checked));
  $('#btnResetSaved').addEventListener('click', () => { if (confirm('Remove all saved playlists?')) { S.library = []; persist(); renderSaved(); } });
  $('#btnResetAll').addEventListener('click', () => {
    if (!confirm('Reset the app? This clears your queue, saved playlists and settings on this device.')) return;
    try { Object.keys(localStorage).filter((k) => k.startsWith('vinyl.')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
    location.reload();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest('input, textarea, select') || $('#settings').open) return;
    if ((e.key === ' ' || e.key === 'Enter') && e.target.closest('button, [role=button]')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const map = {
      ' ': togglePlay, k: togglePlay,
      ArrowRight: () => (e.shiftKey ? next() : seekBy(5)),
      ArrowLeft: () => (e.shiftKey ? prev() : seekBy(-5)),
      ArrowUp: () => setVolume(S.volume + 5),
      ArrowDown: () => setVolume(S.volume - 5),
      n: () => next(), p: prev, s: toggleShuffle, r: cycleRepeat, m: () => toggleMute(), v: () => toggleVideo(),
      Escape: closePanel,
    };
    if (map[k]) { e.preventDefault(); map[k](); }
  });

  // Lock screen / headset / keyboard media keys
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* unsupported action */ } };
    set('play', () => { if (phase !== 'playing') togglePlay(); });
    set('pause', () => { if (phase === 'playing') togglePlay(); });
    set('nexttrack', () => next());
    set('previoustrack', prev);
    set('seekto', (d) => userSeek(d.seekTime));
    set('seekforward', () => seekBy(10));
    set('seekbackward', () => seekBy(-10));
  }

  matchMedia('(max-width: 959px)').addEventListener('change', (e) => { if (!e.matches) closePanel(); });
}

/* ---------- boot ---------- */
bind();
syncToggles();
toggleVideo(S.showVideo);
setRange($('#vol'), S.volume, 100);
renderQueue(); renderSaved(); renderAccount();
spBoot();
roomBoot();
selectTab(((t) => (t === 'room' ? 'queue' : t))(store.get('tab', S.queue.length ? 'queue' : 'library')));
updateNowPlaying();
deckBoot();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is optional */ });
}
