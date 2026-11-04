'use strict';

/* =========================================================================
   Player extras: sleep timer, recently played, synced lyrics, and the
   Playback settings (crossfade + sleep timer). Crossfade itself lives in
   app.js next to the YouTube players.
   Loaded before app.js; uses its helpers at call time; app.js calls
   extrasBoot(), and its 250ms tick calls sleepTick() and lyricsTick().
   ========================================================================= */

/* ---------- sleep timer ---------- */
const Sleep = { at: 0, endOfSong: false, fading: false };
const SLEEP_FADE_MS = 15000;
function sleepSet(mins) {
  Sleep.endOfSong = mins === 'song';
  Sleep.chosen = typeof mins === 'number' && mins > 0 ? mins : null;
  Sleep.at = typeof mins === 'number' && mins > 0 ? Date.now() + mins * 60000 : 0;
  if (Sleep.fading) { Sleep.fading = false; setSleepFade(1); }
  sleepRender();
  if (Sleep.endOfSong) toast('Music stops after this song 🌙', 2500);
  else if (Sleep.at) toast(`Music stops in ${mins} minutes 🌙`, 2500);
  else toast('Sleep timer off', 1500);
}
const sleepStopsAfterSong = () => Sleep.endOfSong;
// app.js asks this when a song ends: true means "don't start the next one".
function sleepConsumeEndOfSong() {
  if (!Sleep.endOfSong) return false;
  Sleep.endOfSong = false;
  sleepRender();
  toast('Sleep timer: stopped the music. Good night 🌙', 4000);
  return true;
}
function sleepTick() {
  if (!Sleep.at) return;
  const left = Sleep.at - Date.now();
  if (left <= SLEEP_FADE_MS && left > 0) {
    // Ease the music down over the last few seconds instead of cutting it off.
    Sleep.fading = true;
    setSleepFade(Math.max(0, left / SLEEP_FADE_MS));
  }
  if (left <= 0) {
    Sleep.at = 0; Sleep.fading = false;
    if (phase === 'playing' || phase === 'loading') {
      if (roomIsGuest()) { Room.localPause = true; eng().pause(); if (isCurrent(SPE)) setPhase('paused'); }
      else togglePlay();
    }
    setTimeout(() => setSleepFade(1), 600);
    toast('Sleep timer: paused the music. Good night 🌙', 4000);
  }
  if (Math.floor(left / 1000) % 15 === 0) sleepRender();
}
function sleepRender() {
  const pill = $('#sleepPill');
  if (pill) {
    const on = Sleep.at || Sleep.endOfSong;
    pill.hidden = !on;
    if (on) $('#sleepPillText').textContent = Sleep.endOfSong ? 'after this song' : `${Math.max(1, Math.ceil((Sleep.at - Date.now()) / 60000))} min`;
  }
  for (const b of $$('#sleepOptions button')) {
    const v = b.dataset.sleep;
    b.setAttribute('aria-pressed', String(v === 'song' ? Sleep.endOfSong : !!Sleep.at && v === String(Sleep.chosen)));
  }
}

/* ---------- recently played ---------- */
const HISTORY_MAX = 60;
function historyRecord(t) {
  if (!t || !validTrack(t)) return;
  const list = store.get('history', []);
  const key = (t.src || 'yt') + t.id;
  // Don't log the same song twice in a row (pause/resume, repeat).
  if (list[0] && (list[0].src || 'yt') + list[0].id === key && Date.now() - list[0].at < 10 * 60 * 1000) return;
  const entry = { src: t.src === 'sp' ? 'sp' : undefined, id: t.id, title: trackTitle(t) === 'Loading…' ? '' : trackTitle(t), artist: trackArtist(t), art: t.src === 'sp' ? t.art : undefined, dur: t.dur || undefined, at: Date.now() };
  store.set('history', [entry, ...list.filter((x) => (x.src || 'yt') + x.id !== key)].slice(0, HISTORY_MAX));
  historyRender();
}
function historyRender() {
  const box = $('#historyList');
  if (!box) return;
  const list = store.get('history', []);
  box.replaceChildren();
  $('#btnClearHistory').hidden = !list.length;
  if (!list.length) { box.append(empty('Nothing played yet', 'Songs you listen to show up here.')); return; }
  const showAll = box.dataset.all === '1';
  for (const t of list.slice(0, showAll ? HISTORY_MAX : 8)) {
    box.append(trackRow(t, {
      sub: [trackArtist(t), ago(t.at)].filter(Boolean).join(' · '),
      onClick: () => { enqueue([{ ...t, at: undefined }], { playNow: true }); closePanelOnPhone(); },
      actions: [iconBtn('add', 'Add to queue', () => enqueue([{ ...t, at: undefined }]))],
    }));
  }
  if (list.length > 8) {
    box.append(h('button', { class: 'text-btn more-btn', text: showAll ? 'Show less' : `Show all ${list.length}`,
      onclick: () => { box.dataset.all = showAll ? '0' : '1'; historyRender(); } }));
  }
}
function ago(at) {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const d = Math.round(hrs / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/* ---------- synced lyrics (from LRCLIB, a free open lyrics database) ---------- */
const Lyrics = { key: null, track: null, lines: null, plain: '', state: 'idle', active: -1, holdUntil: 0, cache: new Map() };
const lyricsVisible = () => !$('[data-tab="lyrics"].tab-body')?.hidden && (!isPhoneLayout() || $('#panel').classList.contains('open'));
function lyricsOnTrack(t) {
  const key = t ? (t.src || 'yt') + t.id + '|' + trackTitle(t) : null;
  if (key === Lyrics.key) return;
  Lyrics.key = key; Lyrics.track = t; Lyrics.lines = null; Lyrics.plain = ''; Lyrics.active = -1;
  Lyrics.state = t ? 'stale' : 'idle';
  if (lyricsVisible()) lyricsShow(); else lyricsRender();
}
function lyricsShow() {
  if (Lyrics.state === 'stale') lyricsLoad();
  else lyricsRender();
}
function parseLRC(text) {
  const out = [];
  for (const raw of (text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) {
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) / 1000 : 0;
      out.push({ t: Number(m[1]) * 60 + Number(m[2]) + frac, text: words });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
async function lyricsLoad() {
  const t = Lyrics.track, key = Lyrics.key;
  if (!t) { Lyrics.state = 'idle'; lyricsRender(); return; }
  const title = trackTitle(t), artist = trackArtist(t);
  if (title === 'Loading…') { Lyrics.state = 'stale'; return; } // wait for the title
  if (Lyrics.cache.has(key)) { Object.assign(Lyrics, Lyrics.cache.get(key), { state: 'ready' }); lyricsRender(); return; }
  Lyrics.state = 'loading'; lyricsRender();
  const dur = Math.round((t.dur ? t.dur / 1000 : 0) || (isCurrent(eng(t)) ? eng(t).duration() : 0));
  let found = null;
  try {
    const q = new URLSearchParams({ track_name: title, artist_name: artist });
    if (dur) q.set('duration', String(dur));
    let r = await fetch('https://lrclib.net/api/get?' + q);
    if (r.ok) found = await r.json();
    if (!found?.syncedLyrics) {
      r = await fetch('https://lrclib.net/api/search?' + new URLSearchParams({ q: `${artist} ${title}`.trim() }));
      const list = r.ok ? await r.json() : [];
      const near = (x) => !dur || Math.abs((x.duration || 0) - dur) <= 4;
      found = list.find((x) => x.syncedLyrics && near(x)) || list.find((x) => x.syncedLyrics) || list.find((x) => x.plainLyrics) || found;
    }
  } catch { found = null; }
  if (Lyrics.key !== key) return; // the song changed while we were looking
  const res = { lines: found?.syncedLyrics ? parseLRC(found.syncedLyrics) : null, plain: found?.plainLyrics || '' };
  Lyrics.cache.set(key, res);
  Object.assign(Lyrics, res, { state: 'ready', active: -1 });
  lyricsRender();
}
function lyricsRender() {
  const box = $('#lyricsBox');
  if (!box) return;
  box.replaceChildren();
  const t = Lyrics.track;
  if (!t) { box.append(empty('No song playing', 'Lyrics for the current song show up here, in time with the music.')); return; }
  box.append(h('div', { class: 'lyrics-head' }, h('b', { text: trackTitle(t) }), h('span', { text: trackArtist(t) })));
  if (Lyrics.state === 'loading' || Lyrics.state === 'stale') { box.append(h('div', { class: 'loading-row', text: 'Finding lyrics…' })); return; }
  if (Lyrics.lines?.length) {
    const wrap = h('div', { class: 'lyrics', id: 'lyricsLines' });
    Lyrics.lines.forEach((l, i) => {
      const line = h('button', { class: 'lyric' + (l.text ? '' : ' gap'), 'data-i': i, text: l.text || '♪' });
      line.addEventListener('click', () => userSeek(Math.max(0, l.t - 0.2)));
      wrap.append(line);
    });
    // Scrolling by hand pauses the auto-scroll for a moment.
    for (const ev of ['wheel', 'touchmove']) wrap.addEventListener(ev, () => { Lyrics.holdUntil = Date.now() + 4000; }, { passive: true });
    box.append(wrap);
    Lyrics.active = -1;
    lyricsTick(eng().ready() ? eng().time() : 0);
  } else if (Lyrics.plain) {
    box.append(h('p', { class: 'hint', text: 'These lyrics aren\'t timed to the music.' }), h('div', { class: 'lyrics plain', text: Lyrics.plain }));
  } else {
    box.append(empty('No lyrics found', 'LRCLIB doesn\'t have this song yet (or it\'s instrumental).'));
  }
  box.append(h('p', { class: 'hint lyrics-credit' }, 'Lyrics from ', h('a', { href: 'https://lrclib.net', target: '_blank', rel: 'noopener', text: 'LRCLIB' })));
}
function lyricsTick(time) {
  if (!Lyrics.lines?.length || Lyrics.state !== 'ready' || !lyricsVisible()) return;
  let i = -1;
  for (let k = 0; k < Lyrics.lines.length && Lyrics.lines[k].t <= time + 0.25; k++) i = k;
  if (i === Lyrics.active) return;
  Lyrics.active = i;
  const wrap = $('#lyricsLines');
  if (!wrap) return;
  for (const el of $$('.lyric.on, .lyric.past', wrap)) el.classList.remove('on', 'past');
  $$('.lyric', wrap).forEach((el, k) => { if (k < i) el.classList.add('past'); });
  const cur = $(`.lyric[data-i="${i}"]`, wrap);
  if (cur) {
    cur.classList.add('on');
    if (Date.now() > Lyrics.holdUntil) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

/* ---------- Playback settings ---------- */
function extrasBoot() {
  const xf = $('#crossfadeSelect');
  if (xf) {
    xf.value = String(crossfadeSecs());
    xf.addEventListener('change', () => {
      store.set('crossfade', +xf.value);
      toast(+xf.value ? `Songs now blend over ${xf.value} seconds` : 'Crossfade off', 2000);
    });
  }
  for (const b of $$('#sleepOptions button')) {
    b.addEventListener('click', () => sleepSet(b.dataset.sleep === 'song' ? 'song' : +b.dataset.sleep));
  }
  $('#sleepPill')?.addEventListener('click', () => openSettings('setPlayback'));
  $('#btnClearHistory')?.addEventListener('click', () => {
    if (confirm('Clear your recently played list?')) { store.set('history', []); historyRender(); }
  });
  historyRender();
  sleepRender();
  lyricsRender();
}
