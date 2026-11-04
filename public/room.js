'use strict';

/* =========================================================================
   Listening rooms: the host plays music, everyone with the link hears it in sync.
   Transport: Server-Sent Events from Vinyl's own server.js (down) + small POSTs (up).
   Each listener plays the audio on their own device (YouTube player / their own
   Spotify), so Vinyl only syncs "what is playing, where, and is it paused".
   Loaded before app.js; uses its helpers at call time; app.js calls roomBoot().
   ========================================================================= */

const Room = {
  id: null, isHost: false, hostToken: null, client: null,
  es: null, retry: null, members: [], chat: [], settings: {}, state: null,
  offset: 0, qFrom: 0, sentQSig: '', stash: null, notifyTimer: null, beat: null,
  share: { url: null, starting: false, available: false, local: false },
  lanBase: null, unread: 0,
};
const roomActive = () => !!Room.id;
const roomIsGuest = () => !!Room.id && !Room.isHost;
const roomIsHost = () => !!Room.id && Room.isHost;

function roomClientId() {
  let id = store.get('clientId', '');
  if (!/^[\w-]{8,40}$/.test(id)) { id = randStr(16); store.set('clientId', id); }
  return id;
}
async function roomApi(path, body) {
  const r = await fetch('api/rooms' + path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { cache: 'no-store' });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new Error("Listening rooms need Vinyl's own server. Start Vinyl with start.bat (or host it with server.js).");
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error || 'Room error'), { status: r.status });
  return j;
}
function roomSend(type, data) {
  if (!Room.id) return Promise.resolve();
  return roomApi(`/${Room.id}/send`, { client: Room.client, host: Room.hostToken || undefined, type, data })
    .catch((err) => { if (type !== 'state' && type !== 'signal') toast(err.message); });
}

/* ---------- invite link ---------- */
function roomInviteUrl() {
  const base = Room.share.url ? Room.share.url + '/' : Room.lanBase || (location.origin + location.pathname);
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
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) { Room.lanBase = null; return; }
  try {
    const urls = await (await fetch('lan.json', { cache: 'no-store' })).json();
    Room.lanBase = urls[0] ? urls[0] + '/' : null;
  } catch { Room.lanBase = null; }
}

/* ---------- create / join / leave ---------- */
async function roomCreate(name) {
  const client = roomClientId();
  const myName = name || store.get('name', '') || 'Host';
  store.set('name', myName);
  const j = await roomApi('', { client, name: `${myName}'s room` });
  Room.id = j.room; Room.hostToken = j.hostToken; Room.isHost = true; Room.client = client;
  store.set('room', { id: Room.id, hostToken: Room.hostToken });
  history.replaceState(null, '', location.pathname + location.search);
  await Promise.all([roomFindLanBase(), roomRefreshShare()]);
  roomConnect();
  roomShowTab(true); openPanel('room');
  toast('Room started. Copy the invite link to bring friends in.');
}
function roomJoin(id, name) {
  const client = roomClientId();
  store.set('name', name);
  // Keep the listener's own queue safe; the room's queue replaces it while they're in.
  Room.stash = { queue: S.queue, index: S.index, original: S.original };
  if (S.queue[S.index]) eng().stop();
  S.queue = []; S.index = -1; S.original = null;
  Room.id = id; Room.isHost = false; Room.hostToken = null; Room.client = client;
  store.set('room', { id });
  SP.sdk?.activateElement?.();
  roomConnect();
  roomShowTab(true); renderQueue(); updateNowPlaying();
}
function roomTeardown(message) {
  const wasGuest = roomIsGuest();
  voiceLeave(true);
  Room.es?.close(); Room.es = null;
  clearTimeout(Room.retry); clearInterval(Room.beat);
  Room.id = null; Room.isHost = false; Room.hostToken = null; Room.state = null; Room.members = []; Room.chat = [];
  store.del('room');
  if (/#room=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  if (wasGuest) {
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
  if (Room.isHost) {
    if (!confirm('End the room for everyone?')) return;
    roomSend('close', {});
  }
  roomTeardown(Room.isHost ? 'Room ended' : 'You left the room');
}

/* ---------- connection ---------- */
function roomConnect() {
  Room.es?.close();
  const q = new URLSearchParams({ client: Room.client, name: store.get('name', '') || 'Listener' });
  if (Room.hostToken) q.set('host', Room.hostToken);
  const es = new EventSource(`api/rooms/${Room.id}/events?${q}`);
  Room.es = es;
  const on = (ev, fn) => es.addEventListener(ev, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); } });
  on('hello', (d) => {
    Room.offset = d.now - Date.now();
    Room.isHost = d.isHost; Room.settings = d.settings; Room.members = d.members; Room.chat = d.chat || [];
    if (!Room.isHost && d.state) roomApply(d.state, d.now);
    if (Room.isHost) { Room.sentQSig = ''; roomNotify(true); }
    clearInterval(Room.beat);
    Room.beat = setInterval(roomHeartbeat, Room.isHost ? 5000 : 2500);
    roomRenderAll();
    voiceOnHello();
  });
  on('state', (d) => { if (!Room.isHost) roomApply(d.state, d.now); });
  on('members', (m) => { Room.members = m; roomRenderMembers(); roomRenderStatus(); voiceOnMembers(); });
  on('signal', (d) => voiceOnSignal(d.from, d.data));
  on('settings', (s) => { Room.settings = s; roomRenderAll(); });
  on('chat', (m) => {
    Room.chat.push(m); if (Room.chat.length > 60) Room.chat.shift();
    roomRenderChat();
    const roomTabOpen = !$('[data-tab="room"].tab-body').hidden && (!isPhoneLayout() || $('#panel').classList.contains('open'));
    if (m.from !== Room.client && !m.system && !roomTabOpen) { Room.unread++; roomRenderStatus(); toast(`${m.name}: ${m.text}`, 4000); }
  });
  on('notice', (n) => toast(n.text, 2500));
  on('cmd', (c) => { if (Room.isHost) roomHandleCmd(c); });
  on('kicked', () => roomTeardown('The host removed you from the room.'));
  on('closed', (d) => roomTeardown(d.reason || 'The room has ended.'));
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED || Room.es !== es) return; // the browser retries by itself
    // The server refused us (or is gone): find out why.
    roomApi(`/${Room.id}`).then((info) => {
      if (info.locked && !Room.isHost) roomTeardown('The host has locked this room.');
      else Room.retry = setTimeout(() => Room.id && roomConnect(), 3000);
    }).catch((err) => {
      if (err.status === 404) roomTeardown('This room has ended.');
      else Room.retry = setTimeout(() => Room.id && roomConnect(), 3000);
    });
  };
}

/* ---------- host: publish what's playing ---------- */
const roomTrack = (t) => (t ? {
  src: t.src === 'sp' ? 'sp' : undefined, id: t.id,
  title: t.title || meta[t.id]?.t || '', artist: t.artist || meta[t.id]?.a || '',
  art: t.src === 'sp' ? t.art : undefined, dur: t.dur || undefined,
  addedBy: t.addedBy || undefined,
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

/* ---------- host: commands from listeners (when allowed) ---------- */
function roomCleanTracks(list) {
  return (Array.isArray(list) ? list.slice(0, 300) : []).map((t) => ({
    src: t?.src === 'sp' ? 'sp' : undefined, id: String(t?.id || ''),
    title: String(t?.title || '').slice(0, 200), artist: String(t?.artist || '').slice(0, 200),
    art: isSpArt(t?.art) ? t.art : undefined, dur: Number(t?.dur) || undefined,
  })).filter(validTrack);
}
function roomCleanAdded(list) {
  return (Array.isArray(list) ? list.slice(0, 300) : []).map((t) => ({
    src: t?.src === 'sp' ? 'sp' : undefined, id: String(t?.id || ''),
    title: String(t?.title || '').slice(0, 200), artist: String(t?.artist || '').slice(0, 200),
    art: isSpArt(t?.art) ? t.art : undefined, dur: Number(t?.dur) || undefined,
    addedBy: t?.addedBy ? String(t.addedBy).slice(0, 30) : undefined,
  })).filter(validTrack);
}
function roomHandleCmd(c) {
  const who = String(c.name || 'A listener').slice(0, 30);
  const find = () => (S.queue[c.index]?.id === c.id ? c.index : S.queue.findIndex((t) => t.id === c.id));
  switch (c.action) {
    case 'toggle': togglePlay(); break;
    case 'next': next(); break;
    case 'prev': prev(); break;
    case 'seek': if (Number.isFinite(c.to)) userSeek(c.to); break;
    case 'shuffle': toggleShuffle(); break;
    case 'repeat': cycleRepeat(); break;
    case 'index': { const i = find(); if (i >= 0) playIndex(i); break; }
    case 'remove': { const i = find(); if (i >= 0) removeAt(i); break; }
    case 'add': case 'replace': {
      const tracks = roomCleanTracks(c.tracks).map((t) => ({ ...t, addedBy: who }));
      if (!tracks.length) break;
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
      Room.localPause = false; $('#roomHint').hidden = true;
      const t = S.queue[S.index];
      if (t && eng().isLoaded(t)) { setPhase('loading'); eng().seek(roomExpected(s)); Promise.resolve().then(() => eng().play()).catch(engineError); }
      else playIndex(S.index, true, roomExpected(s));
    }
    return true;
  }
  if (action === 'add' || action === 'replace') {
    if (!Room.settings.allowControl) {
      if (Room.settings.allowAdd === false) { toast("The host isn't taking song requests right now."); return true; }
      // Requests always join the end of the queue and wait their turn.
      const tracks = (payload.tracks || []).slice(0, 300).map(roomTrack);
      if (!tracks.length) return true;
      const ahead = Math.max(0, S.queue.length - S.index - 1);
      roomSend('cmd', { action: 'add', tracks, playNow: false });
      toast(`Added to the room queue${ahead ? `: it plays after ${ahead} more song${ahead === 1 ? '' : 's'}` : ', up next'}`, 3500);
      return true;
    }
  }
  if (!Room.settings.allowControl) { toast("Only the host controls playback in this room. You can still add songs and change your own volume."); return true; }
  if (action === 'toggle') Room.localPause = false;
  if (action === 'index' || action === 'remove') {
    const t = S.queue[payload.i];
    if (!t) return true;
    payload = { index: Room.qFrom + payload.i, id: t.id };
  }
  if (action === 'add' || action === 'replace') payload = { ...payload, tracks: (payload.tracks || []).slice(0, 300).map(roomTrack) };
  roomSend('cmd', { action, ...payload });
  if (action === 'add' || action === 'replace') toast('Sent to the host');
  return true;
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
  box.append(
    h('div', { class: 'room-title' },
      h('span', { class: 'live-dot' }),
      h('div', {}, h('b', { text: Room.settings.name || 'Listening room' }),
        h('div', { class: 'a', text: Room.isHost ? 'You are the host' : `Hosted by ${host?.name || 'the host'}` }))),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', onclick: roomOpenInvite }, icon('link'), 'Invite'),
      h('button', { class: 'btn', onclick: roomLeave, text: Room.isHost ? 'End room' : 'Leave' })));
  if (Room.isHost) {
    const sw = (label, key) => {
      const input = h('input', { type: 'checkbox' });
      input.checked = !!Room.settings[key];
      input.addEventListener('change', () => roomSend('settings', { [key]: input.checked }));
      return h('label', { class: 'switch' }, input, h('span', { text: label }));
    };
    const on = (key, dflt) => (Room.settings[key] === undefined ? dflt : Room.settings[key]);
    Room.settings.allowAdd = on('allowAdd', true);
    box.append(h('div', { class: 'room-switches' },
      sw('Listeners can add songs to the queue', 'allowAdd'),
      sw('Listeners can also skip, pause and seek', 'allowControl'),
      sw('Lock room (no new people can join)', 'locked')));
  } else {
    box.append(h('p', { class: 'hint', text: Room.settings.allowControl
      ? 'Everyone here can control playback and add songs.'
      : Room.settings.allowAdd !== false
        ? 'Add songs from Library or Search and they join the queue. Play/pause only affects your device.'
        : 'The host picks the music. Play/pause only affects your device.' }));
  }
  box.append(h('p', { class: 'hint room-hint', id: 'roomHint', hidden: true }));
}
function roomRenderMembers() {
  const box = $('#roomMembers');
  if (!box || !roomActive()) return;
  box.replaceChildren();
  for (const m of Room.members) {
    const initial = (m.name || '?').trim().charAt(0).toUpperCase();
    const v = m.voice;
    box.append(h('div', { class: 'member' + (m.online ? '' : ' away') + (v ? ' in-voice' : '') + (v && (v.muted || !v.mic) ? ' voice-muted' : ''), 'data-id': m.id,
      title: v ? (v.mic ? (v.muted ? `${m.name} is muted` : `${m.name} is in voice`) : `${m.name} is listening to voice`) : m.name },
      h('span', { class: 'avatar', text: initial }),
      v ? h('span', { class: 'member-mic' }, icon(v.mic && !v.muted ? 'mic' : 'mic-off')) : null,
      h('span', { class: 'member-name', text: m.name + (m.id === Room.client ? ' (you)' : '') }),
      m.host ? h('span', { class: 'pill', text: 'host' }) : null,
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
    log.append(h('div', { class: 'msg' + (m.from === Room.client ? ' mine' : '') },
      h('span', { class: 'msg-name', text: m.name }), h('span', { class: 'msg-text', text: m.text })));
  }
  if (atBottom || Room.chat[Room.chat.length - 1]?.from === Room.client) log.scrollTop = log.scrollHeight;
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
      h('p', { class: 'muted', text: 'Start a private room and send the link to friends. Whatever you play, they hear in sync on their own phone, tablet or PC. Only people with the link can get in, and you can lock the room or remove people any time.' }),
      nameField, h('div', { class: 'btn-row' }, go));
  } else if (mode === 'join') {
    $('#roomDialogTitle').textContent = `Join ${info.host || 'a'}'s room`;
    const go = h('button', { class: 'btn primary' }, icon('play'), 'Join and listen');
    go.addEventListener('click', () => {
      const n = needName(); if (!n) return;
      d.close(); roomJoin(info.id, n);
    });
    body.append(
      h('p', { class: 'muted', text: `${info.name || 'Listening room'} · ${info.listeners || 0} here now. You'll hear what the host plays, in sync. Your own queue is kept safe until you leave.` }),
      nameField,
      h('div', { class: 'btn-row' }, go, h('button', { class: 'btn', onclick: () => { d.close(); history.replaceState(null, '', location.pathname + location.search); }, text: 'Not now' })));
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
  if (Room.share.url) reach = 'Anyone with this link can join from anywhere while Vinyl is running on this PC.';
  else if (Room.lanBase) reach = 'This link works for people on the same Wi-Fi as this PC. They can listen to voice chat but need the secure internet link below to talk.';
  else reach = 'Anyone who can open this Vinyl address can join with the link.';
  wrap.append(h('div', { class: 'invite-top' }, qrBox, h('div', { class: 'invite-link' }, link, row)), h('p', { class: 'hint', text: reach }));

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
  $('#btnMic').addEventListener('click', voiceToggleMute);
  $('#btnCloseRoomDialog').addEventListener('click', () => $('#roomDialog').close());
  $('#roomChatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#roomChatInput'), text = input.value.trim();
    if (!text) return;
    input.value = '';
    roomSend('chat', { text });
  });
  window.addEventListener('hashchange', roomCheckHash);

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
