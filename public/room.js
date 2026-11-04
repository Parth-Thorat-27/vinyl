'use strict';

/* =========================================================================
   Listening rooms: the host plays music, everyone with the link hears it in sync.
   Transport: Server-Sent Events from Vinyl's own server.js (down) + small POSTs (up).
   Each listener plays the audio on their own device (YouTube player / their own
   Spotify), so Vinyl only syncs "what is playing, where, and is it paused".
   Extras: optional PIN, song requests with a per-person limit, vote to skip,
   emoji reactions, handing the host role on, and voice chat (voice.js).
   Loaded before app.js; uses its helpers at call time; app.js calls roomBoot().
   ========================================================================= */

const Room = {
  id: null, isHost: false, hostToken: null, client: null, me: null, pin: '',
  es: null, retry: null, members: [], chat: [], settings: {}, state: null,
  offset: 0, qFrom: 0, sentQSig: '', stash: null, notifyTimer: null, beat: null,
  share: { url: null, starting: false, available: false, local: false },
  net: null, lanBase: null, lanSecure: false, unread: 0,
  votes: { count: 0, needed: 1, key: '' }, myVote: '', localPause: false,
};
const roomActive = () => !!Room.id;
const roomIsGuest = () => !!Room.id && !Room.isHost;
const roomIsHost = () => !!Room.id && Room.isHost;
const REACTIONS = ['🔥', '❤️', '😂', '👏', '🎉', '😮', '💃', '🙌'];

// The private key that proves who you are to the room server. Never shown to anyone;
// other people see you by a public id (Room.me) that the server derives from it.
function roomClientId() {
  let id = store.get('clientId', '');
  if (!/^[\w-]{16,40}$/.test(id)) { id = randStr(24); store.set('clientId', id); }
  return id;
}
async function roomApi(path, body) {
  const r = await fetch('api/rooms' + path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { cache: 'no-store' });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new Error("Listening rooms need Vinyl's own server. Start Vinyl with start.bat (or host it with server.js).");
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error || 'Room error'), { status: r.status, needPin: !!j.needPin });
  return j;
}
function roomSend(type, data) {
  if (!Room.id) return Promise.resolve();
  return roomApi(`/${Room.id}/send`, { client: Room.client, host: Room.hostToken || undefined, type, data })
    .catch((err) => { if (!['state', 'signal', 'leave'].includes(type)) toast(err.message); throw err; })
    .catch(() => null);
}

/* ---------- invite link ---------- */
// Prefer, in order: the public internet link, the https Wi-Fi link (lets phones use their mic),
// the plain Wi-Fi link, or simply wherever this page is being served from.
function roomInviteUrl(plain) {
  const base = Room.share.url ? Room.share.url + '/'
    : (plain ? Room.net?.http?.[0] && Room.net.http[0] + '/' : Room.lanBase) || (location.origin + location.pathname);
  return `${base}#room=${Room.id}`;
}
async function roomRefreshShare(action) {
  try {
    const r = await fetch('api/share' + (action ? '/' + action : ''), action ? { method: 'POST' } : { cache: 'no-store' });
    if (!r.ok) { Room.share.local = false; return; }
    Object.assign(Room.share, await r.json(), { local: true });
  } catch { Room.share.local = false; }
}
async function roomFindLanBase() {
  Room.lanBase = null; Room.lanSecure = false;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
  try {
    Room.net = await (await fetch('api/net', { cache: 'no-store' })).json();
    if (Room.net.https?.[0]) { Room.lanBase = Room.net.https[0] + '/'; Room.lanSecure = true; }
    else if (Room.net.http?.[0]) Room.lanBase = Room.net.http[0] + '/';
  } catch { /* older server */ }
}

/* ---------- create / join / leave ---------- */
async function roomCreate(name) {
  const client = roomClientId();
  const myName = name || store.get('name', '') || 'Host';
  store.set('name', myName);
  const j = await roomApi('', { client, name: `${myName}'s room` });
  Room.id = j.room; Room.hostToken = j.hostToken; Room.isHost = true; Room.client = client; Room.stash = null;
  store.set('room', { id: Room.id, hostToken: Room.hostToken });
  history.replaceState(null, '', location.pathname + location.search);
  await Promise.all([roomFindLanBase(), roomRefreshShare()]);
  roomConnect();
  roomShowTab(true); openPanel('room');
  toast('Room started. Copy the invite link to bring friends in.');
}
function roomJoin(id, name, pin = '') {
  const client = roomClientId();
  store.set('name', name);
  // Keep the listener's own queue safe; the room's queue replaces it while they're in.
  Room.stash = { queue: S.queue, index: S.index, original: S.original };
  if (S.queue[S.index]) eng().stop();
  S.queue = []; S.index = -1; S.original = null;
  Room.id = id; Room.isHost = false; Room.hostToken = null; Room.client = client; Room.pin = pin;
  store.set('room', { id });
  SP.sdk?.activateElement?.();
  roomConnect();
  roomShowTab(true); renderQueue(); updateNowPlaying();
}
function roomTeardown(message) {
  voiceLeave(true);
  // Say goodbye so others see us leave straight away (listeners only; hosts hand over or close).
  if (Room.id && !Room.isHost && Room.es) roomSend('leave', {});
  Room.es?.close(); Room.es = null;
  clearTimeout(Room.retry); clearInterval(Room.beat);
  const wasGuest = roomIsGuest();
  Room.id = null; Room.isHost = false; Room.hostToken = null; Room.state = null; Room.members = []; Room.chat = [];
  Room.pin = ''; Room.myVote = ''; Room.localPause = false;
  store.del('room');
  if (/#room=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  // Give back the queue this person had before joining (listeners, and hosts who were handed the room).
  if (wasGuest || Room.stash) {
    if (S.queue[S.index]) eng().stop();
    const st = Room.stash || { queue: [], index: -1, original: null };
    S.queue = st.queue; S.index = st.index; S.original = st.original; Room.stash = null;
    setPhase('idle'); updateNowPlaying(); renderQueue();
    if (S.queue[S.index]) playIndex(S.index, false);
  }
  roomShowTab(false); roomRenderStatus();
  if (message) toast(message, 5000);
}
function roomLeave() {
  if (Room.isHost && Room.members.some((m) => m.online && !m.host)) { roomDialog('leave'); return; }
  if (Room.isHost) {
    if (!confirm('End the room?')) return;
    roomSend('close', {});
    roomTeardown('Room ended');
    return;
  }
  roomTeardown('You left the room');
}

/* ---------- connection ---------- */
function roomConnect() {
  Room.es?.close();
  const q = new URLSearchParams({ client: Room.client, name: store.get('name', '') || 'Listener' });
  if (Room.hostToken) q.set('host', Room.hostToken);
  if (Room.pin) q.set('pin', Room.pin);
  const es = new EventSource(`api/rooms/${Room.id}/events?${q}`);
  Room.es = es;
  const on = (ev, fn) => es.addEventListener(ev, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); } });
  on('hello', (d) => {
    Room.offset = d.now - Date.now();
    Room.me = d.you;
    Room.isHost = d.isHost; Room.settings = d.settings; Room.members = d.members; Room.chat = d.chat || [];
    if (d.votes) Room.votes = d.votes;
    if (Room.isHost) Room.pinValue = d.pin || '';
    if (!Room.isHost && d.state) roomApply(d.state, d.now);
    if (Room.isHost) { Room.sentQSig = ''; roomNotify(true); }
    roomStartBeat();
    roomRenderAll();
    voiceOnHello();
  });
  on('state', (d) => { if (!Room.isHost) roomApply(d.state, d.now); });
  on('members', (m) => { Room.members = m; roomRenderMembers(); roomRenderStatus(); roomRenderHeader(); voiceOnMembers(); });
  on('signal', (d) => voiceOnSignal(d.from, d.data));
  on('settings', (s) => { Room.settings = s; roomRenderAll(); });
  on('votes', (v) => { Room.votes = v; if (Room.myVote && Room.myVote !== v.key) Room.myVote = ''; roomRenderVotes(); });
  on('react', (r) => roomFloat(r.emoji, r.from === Room.me ? '' : r.name));
  on('chat', (m) => {
    Room.chat.push(m); if (Room.chat.length > 60) Room.chat.shift();
    roomRenderChat();
    const roomTabOpen = !$('[data-tab="room"].tab-body').hidden && (!isPhoneLayout() || $('#panel').classList.contains('open'));
    if (m.from !== Room.me && !m.system && !roomTabOpen) { Room.unread++; roomRenderStatus(); toast(`${m.name}: ${m.text}`, 4000); }
  });
  on('notice', (n) => toast(n.text, 3000));
  on('cmd', (c) => { if (Room.isHost) roomHandleCmd(c); });
  on('promoted', (d) => {
    // The room was handed to us: we play the music for everyone now.
    Room.isHost = true; Room.hostToken = d.hostToken; Room.pinValue = d.pin || '';
    Room.localPause = false;
    store.set('room', { id: Room.id, hostToken: Room.hostToken });
    Room.sentQSig = ''; roomStartBeat(); roomNotify(true);
    roomRenderAll(); renderQueue();
    toast("You're the host now. What you play, everyone hears.", 4500);
  });
  on('demoted', () => {
    // We handed the room on: from now on we follow the new host. Keep our own queue for later.
    Room.isHost = false; Room.hostToken = null;
    store.set('room', { id: Room.id });
    if (!Room.stash) Room.stash = { queue: S.queue.slice(), index: S.index, original: S.original };
    roomStartBeat(); roomRenderAll();
  });
  on('kicked', () => roomTeardown('The host removed you from the room.'));
  on('closed', (d) => roomTeardown(d.reason || 'The room has ended.'));
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED || Room.es !== es) return; // the browser retries by itself
    // The server refused us (or is gone): find out why.
    roomApi(`/${Room.id}`).then((info) => {
      if (info.locked && !Room.isHost) roomTeardown('The host has locked this room.');
      else if (info.pin && !Room.isHost && !Room.me) roomTeardown('That PIN wasn\'t right.');
      else Room.retry = setTimeout(() => Room.id && roomConnect(), 3000);
    }).catch((err) => {
      if (err.status === 404) roomTeardown('This room has ended.');
      else Room.retry = setTimeout(() => Room.id && roomConnect(), 3000);
    });
  };
}
function roomStartBeat() {
  clearInterval(Room.beat);
  Room.beat = setInterval(roomHeartbeat, Room.isHost ? 5000 : 2500);
}

/* ---------- host: publish what's playing ---------- */
const roomTrack = (t) => (t ? {
  src: t.src === 'sp' ? 'sp' : undefined, id: t.id,
  title: t.title || meta[t.id]?.t || '', artist: t.artist || meta[t.id]?.a || '',
  art: t.src === 'sp' ? t.art : undefined, dur: t.dur || undefined,
  addedBy: t.addedBy || undefined, addedById: t.addedById || undefined,
} : null);
function roomNotify(now) {
  if (!roomIsHost()) return;
  clearTimeout(Room.notifyTimer);
  Room.notifyTimer = setTimeout(roomPublish, now ? 0 : 200);
}
function roomPublish() {
  if (!roomIsHost()) return;
  const E = eng(), t = S.queue[S.index];
  const from = Math.max(0, S.index - 10);
  const win = S.queue.slice(from, from + 300);
  const sig = from + ':' + win.map((x) => x.uid).join(',') + ':' + win.map((x) => (x.title || meta[x.id]?.t ? 1 : 0)).join('');
  const state = {
    index: S.index - from, from,
    track: roomTrack(t),
    playing: phase === 'playing' || phase === 'loading',
    position: t && E.ready() ? E.time() : 0,
    repeat: S.repeat, shuffle: S.shuffle,
  };
  if (sig !== Room.sentQSig) { state.queue = win.map(roomTrack); Room.sentQSig = sig; }
  roomSend('state', state);
}
function roomHeartbeat() {
  if (roomIsHost()) { if (phase === 'playing') roomPublish(); return; }
  if (roomIsGuest() && Room.state) roomCorrectDrift();
}

/* ---------- host: commands from listeners ---------- */
function roomCleanTracks(list) {
  return (Array.isArray(list) ? list.slice(0, 300) : []).map((t) => ({
    src: t?.src === 'sp' ? 'sp' : undefined, id: String(t?.id || ''),
    title: String(t?.title || '').slice(0, 200), artist: String(t?.artist || '').slice(0, 200),
    art: isSpArt(t?.art) ? t.art : undefined, dur: Number(t?.dur) || undefined,
  })).filter(validTrack);
}
// How many of this person's requests are still waiting to play.
const roomWaiting = (who) => S.queue.filter((t, i) => i > S.index && t.addedById === who).length;
function roomHandleCmd(c) {
  const who = String(c.name || 'A listener').slice(0, 30);
  const find = () => (S.queue[c.index]?.id === c.id ? c.index : S.queue.findIndex((t) => t.id === c.id));
  switch (c.action) {
    case 'toggle': togglePlay(); break;
    case 'next':
      if (c.from === 'vote') {
        // Only skip the song people voted on, not the one after it.
        if (c.key && c.key !== `${S.index}:${S.queue[S.index]?.id}`) return;
        next(); toast('Skipped by vote', 2200); return;
      }
      next(); break;
    case 'prev': prev(); break;
    case 'seek': if (Number.isFinite(c.to)) userSeek(c.to); break;
    case 'shuffle': toggleShuffle(); break;
    case 'repeat': cycleRepeat(); break;
    case 'index': { const i = find(); if (i >= 0) playIndex(i); break; }
    case 'remove': { const i = find(); if (i >= 0) removeAt(i); break; }
    case 'move': { const i = find(); if (i >= 0 && Number.isFinite(c.to)) moveTrack(i, c.to - (c.base || 0)); break; }
    case 'add': case 'replace': {
      let tracks = roomCleanTracks(c.tracks).map((t) => ({ ...t, addedBy: who, addedById: c.from }));
      if (!tracks.length) return;
      // Request limit: each person can only have so many songs waiting at once.
      const limit = Room.settings.requestLimit || 0;
      if (limit && !Room.settings.allowControl) {
        const room = Math.max(0, limit - roomWaiting(c.from));
        if (tracks.length > room) {
          roomSend('tell', { to: c.from, text: room
            ? `Only ${room} more of your songs fit right now (limit ${limit} waiting).`
            : `You already have ${limit} songs waiting. Add more once one of them plays.` });
          tracks = tracks.slice(0, room);
          if (!tracks.length) return;
        }
      }
      const what = tracks.length === 1 ? `"${tracks[0].title || 'a song'}"` : `${tracks.length} songs`;
      if (c.action === 'replace' && Room.settings.allowControl) setQueue(tracks, Math.max(0, Math.min(Number(c.start) || 0, tracks.length - 1)));
      else enqueue(tracks, { playNow: !!c.playNow && Room.settings.allowControl });
      toast(`${who} added ${what} to the queue`);
      roomSend('chat', { text: `🎵 ${who} added ${what}`, system: true });
      return;
    }
    default: return;
  }
  toast(`${who} used the controls`, 1600);
}

/* ---------- listener: follow the host ---------- */
function roomExpected(st) {
  const elapsed = st.playing ? (Date.now() + Room.offset - st.at) / 1000 : 0;
  const p = (st.position || 0) + Math.max(0, elapsed);
  return st.track?.dur ? Math.min(p, st.track.dur / 1000) : p;
}
function roomApply(st, now) {
  if (!st) return;
  if (now) Room.offset = now - Date.now();
  if (st.queue) Room.queueCache = st.queue;
  Room.state = { ...Room.state, ...st };
  const s = Room.state;
  const base = (Room.queueCache || []).map((t) => ({ ...t, uid: uid() }));
  const target = s.track;
  const before = S.queue[S.index];
  const keepUids = before && base[s.index] && before.id === base[s.index].id && before.src === base[s.index].src;
  if (st.queue || !S.queue.length) {
    S.queue = base;
    if (keepUids) S.queue[s.index] = before;
  }
  Room.qFrom = s.from || 0;
  S.repeat = s.repeat || 'off'; S.shuffle = !!s.shuffle; syncToggles();
  if (!target) {
    if (before) eng().stop();
    S.index = -1; setPhase('idle'); updateNowPlaying(); renderQueue(); return;
  }
  if (!S.queue[s.index] || S.queue[s.index].id !== target.id) {
    S.queue[s.index] = { ...target, uid: uid() };
  }
  const sameTrack = before && before.id === target.id && before.src === target.src && eng(before).isLoaded(before);
  if (!sameTrack) {
    S.index = s.index;
    if (!eng(target).ready()) {
      setPhase('idle'); updateNowPlaying(); renderQueue();
      if (target.src === 'sp') roomHint('This song is on Spotify. Connect Spotify Premium in Library to hear it.');
      return;
    }
    playIndex(s.index, s.playing && !Room.localPause, roomExpected(s));
  } else {
    S.index = s.index;
    const E = eng();
    if (s.playing && !Room.localPause && (phase === 'paused' || phase === 'idle')) {
      setPhase('loading');
      Promise.resolve().then(() => { E.seek(roomExpected(s)); return E.play(); }).catch(engineError);
    } else if (!s.playing && (phase === 'playing' || phase === 'loading')) {
      Promise.resolve().then(() => E.pause()).catch(() => {});
      if (E === SPE) setPhase('paused');
      E.seek(s.position || 0);
    } else roomCorrectDrift();
    updateNowPlaying(); renderQueue();
  }
}
function roomCorrectDrift() {
  const s = Room.state, E = eng(), t = S.queue[S.index];
  if (!s?.playing || !t || phase !== 'playing' || !E.ready() || Room.localPause) {
    if (s?.playing && t && phase === 'idle' && !Room.localPause && E.ready()) roomHint('Tap play to start listening');
    return;
  }
  const want = roomExpected(s), have = E.time();
  if (Math.abs(have - want) > 1.6) E.seek(want);
}
function roomHint(text) {
  const el = $('#roomHint');
  if (el) { el.textContent = text; el.hidden = false; }
}

/* ---------- listener: route controls ---------- */
// Returns true when the action was handled by the room (so the caller should stop).
function roomIntercept(action, payload = {}) {
  if (!roomIsGuest()) return false;
  if (action === 'toggle' && !Room.settings.allowControl) {
    // Without control rights, play/pause only affects your own device.
    const s = Room.state;
    if (phase === 'playing' || phase === 'loading') {
      Room.localPause = true; eng().pause(); if (isCurrent(SPE)) setPhase('paused');
    } else if (s?.track) {
      Room.localPause = false; const hint = $('#roomHint'); if (hint) hint.hidden = true;
      const t = S.queue[S.index];
      if (t && eng().isLoaded(t)) { setPhase('loading'); eng().seek(roomExpected(s)); Promise.resolve().then(() => eng().play()).catch(engineError); }
      else playIndex(S.index, true, roomExpected(s));
    }
    return true;
  }
  if (action === 'next' && !Room.settings.allowControl && Room.settings.voteSkip) { roomVote(); return true; }
  if (action === 'add' || action === 'replace') {
    if (!Room.settings.allowControl) {
      if (Room.settings.allowAdd === false) { toast("The host isn't taking song requests right now."); return true; }
      const limit = Room.settings.requestLimit || 0;
      const waiting = roomWaiting(Room.me);
      if (limit && waiting >= limit) { toast(`You already have ${limit} songs waiting. Add more once one of them plays.`); return true; }
      // Requests always join the end of the queue and wait their turn.
      let tracks = (payload.tracks || []).slice(0, 300).map(roomTrack);
      if (limit) tracks = tracks.slice(0, limit - waiting);
      if (!tracks.length) return true;
      const ahead = Math.max(0, S.queue.length - S.index - 1);
      roomSend('cmd', { action: 'add', tracks, playNow: false });
      toast(`Added to the room queue${ahead ? `: it plays after ${ahead} more song${ahead === 1 ? '' : 's'}` : ', up next'}`, 3500);
      return true;
    }
  }
  if (!Room.settings.allowControl) { toast('Only the host controls playback in this room. You can still add songs and change your own volume.'); return true; }
  if (action === 'toggle') Room.localPause = false;
  if (action === 'index' || action === 'remove' || action === 'move') {
    const t = S.queue[payload.i];
    if (!t) return true;
    payload = { index: Room.qFrom + payload.i, id: t.id, ...(action === 'move' ? { to: Room.qFrom + payload.to } : {}) };
  }
  if (action === 'add' || action === 'replace') payload = { ...payload, tracks: (payload.tracks || []).slice(0, 300).map(roomTrack) };
  roomSend('cmd', { action, ...payload });
  if (action === 'add' || action === 'replace') toast('Sent to the host');
  return true;
}
function roomVote() {
  if (!Room.settings.voteSkip) return;
  const on = Room.myVote !== Room.votes.key;
  Room.myVote = on ? Room.votes.key : '';
  roomSend('vote', { on });
  if (on) toast(`Voted to skip (${Room.votes.count + 1}/${Room.votes.needed} needed)`, 2000);
  roomRenderVotes();
}
function roomReact(emoji) {
  roomSend('react', { emoji });
}
// Reactions float up over the turntable for a couple of seconds.
function roomFloat(emoji, name) {
  if (!REACTIONS.includes(emoji)) return;
  const deck = $('#deckWrap') || document.body;
  const r = deck.getBoundingClientRect();
  const el = h('div', { class: 'react-float' }, h('span', { class: 'react-emoji', text: emoji }), name ? h('span', { class: 'react-name', text: name }) : null);
  el.style.left = `${r.left + r.width * (0.2 + Math.random() * 0.6)}px`;
  el.style.top = `${r.top + r.height * 0.75}px`;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

/* ---------- UI ---------- */
function roomShowTab(on) {
  $('#tabRoom').hidden = !on;
  if (!on && !$('[data-tab="room"].tab-body').hidden) selectTab(S.queue.length ? 'queue' : 'library');
  document.body.classList.toggle('in-room', on);
  roomRenderStatus();
}
function roomRenderStatus() {
  const pill = $('#roomPill');
  if (!roomActive()) { pill.hidden = true; return; }
  pill.hidden = false;
  const n = Room.members.filter((m) => m.online).length;
  $('#roomPillText').textContent = `${Room.isHost ? 'Hosting' : 'Live'} · ${n}`;
  pill.classList.toggle('unread', Room.unread > 0);
}
function roomRenderAll() {
  roomRenderStatus(); roomRenderHeader(); roomRenderMembers(); roomRenderChat(); renderVoice();
}
function roomRenderHeader() {
  const box = $('#roomHead');
  if (!box || !roomActive()) return;
  box.replaceChildren();
  const host = Room.members.find((m) => m.host);
  const st = Room.settings;
  box.append(
    h('div', { class: 'room-title' },
      h('span', { class: 'live-dot' }),
      h('div', {}, h('b', { text: st.name || 'Listening room' }),
        h('div', { class: 'a', text: Room.isHost ? 'You are the host' : `Hosted by ${host?.name || 'the host'}` })),
      st.hasPin ? h('span', { class: 'pill', title: 'People need a PIN to join', text: 'PIN' }) : null),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', onclick: roomOpenInvite }, icon('link'), 'Invite'),
      h('button', { class: 'btn', onclick: roomLeave, text: Room.isHost ? 'Leave' : 'Leave' })));

  // Reactions + vote to skip, for everyone.
  const bar = h('div', { class: 'react-bar', role: 'group', 'aria-label': 'Send a reaction' });
  for (const e of REACTIONS) bar.append(h('button', { class: 'react-btn', title: `React ${e}`, 'aria-label': `React ${e}`, onclick: () => roomReact(e), text: e }));
  box.append(bar, h('div', { id: 'roomVotes', class: 'votes' }));

  if (Room.isHost) box.append(roomSettingsBlock());
  else {
    box.append(h('p', { class: 'hint', text: st.allowControl
      ? 'Everyone here can control playback and add songs.'
      : st.allowAdd !== false
        ? `Add songs from Library or Search and they join the queue${st.requestLimit ? ` (up to ${st.requestLimit} waiting per person)` : ''}. Play/pause only affects your device.`
        : 'The host picks the music. Play/pause only affects your device.' }));
  }
  box.append(h('p', { class: 'hint room-hint', id: 'roomHint', hidden: true }));
  roomRenderVotes();
}
function roomSettingsBlock() {
  const st = Room.settings;
  const sw = (label, key, dflt) => {
    const input = h('input', { type: 'checkbox' });
    input.checked = st[key] === undefined ? dflt : !!st[key];
    input.addEventListener('change', () => roomSend('settings', { [key]: input.checked }));
    return h('label', { class: 'switch' }, input, h('span', { text: label }));
  };
  const limit = h('select', { 'aria-label': 'Songs each listener can have waiting' });
  for (const [v, label] of [[0, 'No limit'], [1, '1 song'], [2, '2 songs'], [3, '3 songs'], [5, '5 songs'], [10, '10 songs']]) {
    limit.append(h('option', { value: String(v), text: label }));
  }
  limit.value = String(st.requestLimit ?? 5);
  limit.addEventListener('change', () => roomSend('settings', { requestLimit: +limit.value }));

  const pin = h('input', { type: 'text', inputmode: 'numeric', maxlength: '8', placeholder: 'No PIN', value: Room.pinValue || '', 'aria-label': 'Room PIN' });
  const setPin = h('button', { class: 'btn', text: 'Set PIN' });
  setPin.addEventListener('click', async () => {
    const v = pin.value.trim();
    if (v && !/^\d{4,8}$/.test(v)) { toast('A PIN is 4 to 8 digits.'); return; }
    const ok = await roomSend('settings', { pin: v });
    if (ok) { Room.pinValue = v; toast(v ? `PIN set. New people need ${v} to join.` : 'PIN removed'); }
  });

  return h('details', { class: 'room-settings', open: store.get('roomSettingsOpen', false) || undefined,
    ontoggle: (e) => store.set('roomSettingsOpen', e.target.open) },
  h('summary', { text: 'Room settings' }),
  h('div', { class: 'room-switches' },
    sw('Listeners can add songs to the queue', 'allowAdd', true),
    h('label', { class: 'select-row' }, h('span', { text: 'Songs each person can have waiting' }), limit),
    sw('Listeners can vote to skip a song', 'voteSkip', true),
    sw('Listeners can also skip, pause and seek', 'allowControl', false),
    sw('Lock room (no new people can join)', 'locked', false),
    h('div', { class: 'pin-row' }, h('span', { text: 'PIN to join' }), h('div', { class: 'field' }, pin), setPin)));
}
function roomRenderVotes() {
  const box = $('#roomVotes');
  if (!box || !roomActive()) return;
  box.replaceChildren();
  const v = Room.votes, st = Room.settings;
  if (!st.voteSkip || !Room.state?.track && !Room.isHost) return;
  if (Room.isHost) {
    if (v.count) box.append(h('span', { class: 'hint', text: `${v.count} of ${v.needed} want to skip this song` }));
    return;
  }
  const mine = Room.myVote && Room.myVote === v.key;
  const btn = h('button', { class: 'btn' + (mine ? ' primary' : '') }, icon('next'), mine ? 'Voted to skip' : 'Vote to skip');
  btn.addEventListener('click', roomVote);
  box.append(btn, h('span', { class: 'hint', text: `${v.count}/${v.needed}` }));
}
function roomRenderMembers() {
  const box = $('#roomMembers');
  if (!box || !roomActive()) return;
  box.replaceChildren();
  for (const m of Room.members) {
    const initial = (m.name || '?').trim().charAt(0).toUpperCase();
    const v = m.voice;
    const me = m.id === Room.me;
    box.append(h('div', { class: 'member' + (m.online ? '' : ' away') + (v ? ' in-voice' : '') + (v && (v.muted || !v.mic) ? ' voice-muted' : ''), 'data-id': m.id,
      title: v ? (v.mic ? (v.ptt ? `${m.name} uses push to talk` : v.muted ? `${m.name} is muted` : `${m.name} is in voice`) : `${m.name} is listening to voice`) : m.name },
      h('span', { class: 'avatar', text: initial }),
      v ? h('span', { class: 'member-mic' }, icon(v.mic && !v.muted ? 'mic' : 'mic-off')) : null,
      h('span', { class: 'member-name', text: m.name + (me ? ' (you)' : '') }),
      m.host ? h('span', { class: 'pill', text: 'host' }) : null,
      Room.isHost && !m.host && m.online ? iconBtn('crown', `Make ${m.name} the host`, () => {
        if (confirm(`Make ${m.name} the host? They'll pick the music and you'll follow along.`)) roomSend('handoff', { client: m.id });
      }) : null,
      Room.isHost && !m.host ? iconBtn('close', `Remove ${m.name}`, () => {
        if (confirm(`Remove ${m.name} from the room?`)) roomSend('kick', { client: m.id });
      }) : null));
  }
  voicePaintMembers();
}
function roomRenderChat() {
  const log = $('#roomChat');
  if (!log || !roomActive()) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren();
  if (!Room.chat.length) log.append(h('div', { class: 'chat-empty', text: 'Say hi 👋' }));
  for (const m of Room.chat) {
    if (m.system) { log.append(h('div', { class: 'msg-system', text: m.text })); continue; }
    log.append(h('div', { class: 'msg' + (m.from === Room.me ? ' mine' : '') },
      h('span', { class: 'msg-name', text: m.name }), h('span', { class: 'msg-text', text: m.text })));
  }
  if (atBottom || Room.chat[Room.chat.length - 1]?.from === Room.me) log.scrollTop = log.scrollHeight;
}

/* invite / create / join dialog */
function roomDialog(mode, info = {}) {
  const d = $('#roomDialog'), body = $('#roomDialogBody');
  body.replaceChildren();
  const nameInput = h('input', { type: 'text', maxlength: '30', placeholder: 'Your name', value: store.get('name', '') });
  const nameField = h('div', { class: 'field' }, icon('account'), nameInput);
  const needName = () => {
    const v = nameInput.value.trim();
    if (!v) { toast('Pick a name so people know who you are'); nameInput.focus(); return null; }
    return v;
  };
  if (mode === 'create') {
    $('#roomDialogTitle').textContent = 'Listen together';
    const go = h('button', { class: 'btn primary' }, icon('group'), 'Start a room');
    go.addEventListener('click', async () => {
      const n = needName(); if (!n) return;
      go.disabled = true;
      try { await roomCreate(n); d.close(); } catch (err) { toast(err.message); } finally { go.disabled = false; }
    });
    body.append(
      h('p', { class: 'muted', text: 'Start a private room and send the link to friends. Whatever you play, they hear in sync on their own phone, tablet or PC, and you can all talk in voice chat. Only people with the link can get in; you can add a PIN, lock the room or remove people any time.' }),
      nameField, h('div', { class: 'btn-row' }, go));
  } else if (mode === 'join') {
    $('#roomDialogTitle').textContent = `Join ${info.host || 'a'}'s room`;
    const pinInput = info.pin ? h('input', { type: 'password', inputmode: 'numeric', maxlength: '8', placeholder: 'Room PIN', autocomplete: 'off' }) : null;
    const go = h('button', { class: 'btn primary' }, icon('play'), 'Join and listen');
    go.addEventListener('click', async () => {
      const n = needName(); if (!n) return;
      let pin = '';
      if (pinInput) {
        pin = pinInput.value.trim();
        if (!/^\d{4,8}$/.test(pin)) { toast('Enter the room PIN (4 to 8 digits). Ask the host for it.'); pinInput.focus(); return; }
        go.disabled = true;
        try { await roomApi(`/${info.id}/check`, { pin }); } catch (err) { toast(err.message); go.disabled = false; pinInput.select(); return; }
        go.disabled = false;
      }
      d.close(); roomJoin(info.id, n, pin);
    });
    body.append(
      h('p', { class: 'muted', text: `${info.name || 'Listening room'} · ${info.listeners || 0} here now. You'll hear what the host plays, in sync. Your own queue is kept safe until you leave.` }),
      nameField,
      pinInput ? h('div', { class: 'field' }, icon('lock'), pinInput) : null,
      h('div', { class: 'btn-row' }, go, h('button', { class: 'btn', onclick: () => { d.close(); history.replaceState(null, '', location.pathname + location.search); }, text: 'Not now' })));
  } else if (mode === 'leave') {
    $('#roomDialogTitle').textContent = 'Leave the room?';
    const others = Room.members.filter((m) => m.online && !m.host);
    const hand = h('button', { class: 'btn primary', text: `Hand over to ${others[0]?.name || 'someone'} and leave` });
    hand.addEventListener('click', async () => {
      d.close();
      const ok = await roomSend('handoff', { client: others[0]?.id });
      if (!ok) return;
      // We're a listener now (even if the server's "demoted" message hasn't arrived yet): say goodbye
      // like one, and keep our own queue.
      if (!Room.stash) Room.stash = { queue: S.queue.slice(), index: S.index, original: S.original };
      Room.isHost = false; Room.hostToken = null;
      roomTeardown(`You left. ${others[0]?.name || 'Someone'} is the host now.`);
    });
    const end = h('button', { class: 'btn danger', text: 'End the room for everyone' });
    end.addEventListener('click', () => { d.close(); roomSend('close', {}); roomTeardown('Room ended'); });
    body.append(
      h('p', { class: 'muted', text: 'Others are still listening. Hand the room to someone so the music keeps going, or end it for everyone. (To pick someone else, use the crown next to their name.)' }),
      h('div', { class: 'btn-row' }, hand, end, h('button', { class: 'btn', onclick: () => d.close(), text: 'Stay' })));
  } else if (mode === 'invite') {
    $('#roomDialogTitle').textContent = 'Invite friends';
    body.append(roomInviteBody());
  } else if (mode === 'error') {
    $('#roomDialogTitle').textContent = "Can't join";
    body.append(h('p', { class: 'muted', text: info.text }), h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => d.close(), text: 'OK' })));
  }
  if (!d.open) d.showModal();
  if (mode === 'create' || mode === 'join') setTimeout(() => nameInput.focus(), 50);
}
function roomInviteBody() {
  const wrap = h('div', { class: 'invite' });
  const url = roomInviteUrl();
  const link = h('code', { text: url });
  const copy = h('button', { class: 'btn primary' }, icon('link'), 'Copy link');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
    catch { window.prompt('Copy this link:', url); }
  });
  const row = h('div', { class: 'btn-row' }, copy);
  if (navigator.share) {
    row.append(h('button', { class: 'btn', onclick: () => navigator.share({ title: 'Listen with me on Vinyl', url }).catch(() => {}) }, 'Share…'));
  }
  const qrBox = h('div', { class: 'invite-qr' });
  loadQR().then((qrcode) => {
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    qrBox.append(h('img', { src: qr.createDataURL(4, 2), alt: 'QR code for the invite link' }));
  }).catch(() => {});

  let reach;
  if (Room.share.url) reach = 'Anyone with this link can join from anywhere, and talk in voice chat, while Vinyl is running on this PC.';
  else if (Room.lanBase && Room.lanSecure) reach = 'Works for people on the same Wi-Fi, voice chat included. The first time, their browser warns that the connection isn\'t private (Vinyl made its own certificate): tap "Advanced", then "Proceed".';
  else if (Room.lanBase) reach = 'This link works for people on the same Wi-Fi as this PC. They can listen to voice chat but need the secure internet link below to talk.';
  else reach = 'Anyone who can open this Vinyl address can join with the link.';
  wrap.append(h('div', { class: 'invite-top' }, qrBox, h('div', { class: 'invite-link' }, link, row)), h('p', { class: 'hint', text: reach }));
  if (Room.settings.hasPin) wrap.append(h('p', { class: 'hint', text: `This room has a PIN${Room.pinValue ? ` (${Room.pinValue})` : ''}. Tell your friends separately; it isn't in the link.` }));
  if (!Room.share.url && Room.lanSecure && Room.net?.http?.[0]) {
    wrap.append(h('p', { class: 'hint' }, 'No warning, but no talking: ', h('code', { text: roomInviteUrl(true) })));
  }

  // Internet sharing (only the PC running Vinyl can turn it on).
  if (Room.share.local) {
    const sec = h('div', { class: 'card share-card' });
    if (Room.share.url) {
      sec.append(h('b', { text: 'Sharing over the internet is on' }),
        h('p', { class: 'hint', text: 'A temporary secure link through Cloudflare. It stops when you turn it off or close Vinyl.' }),
        h('button', { class: 'btn', onclick: async () => { await roomRefreshShare('stop'); roomDialog('invite'); }, text: 'Turn off' }));
    } else if (Room.share.available) {
      const on = h('button', { class: 'btn primary' }, 'Share over the internet');
      on.addEventListener('click', async () => {
        on.disabled = true; on.textContent = 'Opening a secure link…';
        await roomRefreshShare('start');
        for (let i = 0; i < 40 && !Room.share.url && !Room.share.error; i++) { await sleepMs(1000); await roomRefreshShare(); }
        if (!Room.share.url) toast("Couldn't open a public link. Check your internet connection and try again.");
        roomDialog('invite');
      });
      sec.append(h('b', { text: 'Friends not on your Wi-Fi?' }),
        h('p', { class: 'hint', text: 'Open a temporary secure link through Cloudflare (free, no account) so anyone with the invite can join from anywhere.' }), on);
    } else {
      sec.append(h('b', { text: 'Friends not on your Wi-Fi?' }),
        h('p', { class: 'hint', text: "Install Cloudflare's free cloudflared tool once, then restart Vinyl. In a terminal run:" }),
        h('code', { text: 'winget install --id Cloudflare.cloudflared' }));
    }
    wrap.append(sec);
  }
  return wrap;
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function roomOpenInvite() {
  await Promise.all([roomRefreshShare(), Room.lanBase ? null : roomFindLanBase()]);
  roomDialog('invite');
}
function roomTopButton() {
  if (roomActive()) { Room.unread = 0; roomRenderStatus(); openPanel('room'); return; }
  roomDialog('create');
}
async function roomCheckHash() {
  const m = location.hash.match(/room=([\w-]{10,40})/);
  if (!m) return false;
  const id = m[1];
  if (Room.id === id) return true;
  try {
    const info = await roomApi(`/${id}`);
    if (info.locked) { roomDialog('error', { text: 'The host has locked this room. Ask them to unlock it.' }); return true; }
    roomDialog('join', { ...info, id });
  } catch (err) {
    roomDialog('error', { text: err.status === 404 ? 'This room has ended, or the link is wrong.' : err.message });
  }
  return true;
}

/* ---------- boot (called by app.js) ---------- */
function roomBoot() {
  Room.client = roomClientId();
  $('#btnRoom').addEventListener('click', roomTopButton);
  $('#roomPill').addEventListener('click', roomTopButton);
  $('#btnCloseRoomDialog').addEventListener('click', () => $('#roomDialog').close());
  $('#roomChatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#roomChatInput'), text = input.value.trim();
    if (!text) return;
    input.value = '';
    roomSend('chat', { text });
  });
  window.addEventListener('hashchange', roomCheckHash);
  // A listener closing the tab leaves the room right away. (A host gets a minute to come back,
  // since closing and reloading look the same from here.)
  window.addEventListener('pagehide', () => {
    if (!roomIsGuest()) return;
    const body = JSON.stringify({ client: Room.client, type: 'leave', data: {} });
    navigator.sendBeacon?.(`api/rooms/${Room.id}/send`, new Blob([body], { type: 'application/json' }));
  });
  voiceBoot();

  const saved = store.get('room', null);
  roomCheckHash().then((fromLink) => {
    if (fromLink || !saved?.id) return;
    if (saved.hostToken) {
      // Host reloaded the page: pick the room back up.
      Room.id = saved.id; Room.hostToken = saved.hostToken; Room.isHost = true;
      Promise.all([roomFindLanBase(), roomRefreshShare()]).then(() => { roomConnect(); roomShowTab(true); });
    } else {
      roomApi(`/${saved.id}`).then((info) => roomDialog('join', { ...info, id: saved.id })).catch(() => store.del('room'));
    }
  });
}
