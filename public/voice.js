'use strict';

/* =========================================================================
   Voice chat for listening rooms.
   Everyone in voice gets a direct WebRTC audio connection to everyone else
   (a small mesh: fine for a handful of friends). Vinyl's server only relays the
   connection setup messages; the voices themselves go device to device.
   The music keeps playing on each device and dips while someone is talking.
   Loaded after room.js and before app.js; everything here runs at call time.
   ========================================================================= */

const Voice = {
  on: false, mic: null, muted: false,
  peers: new Map(),           // memberId -> { pc, ice: [], audio, meter }
  ctx: null, selfMeter: null,
  speaking: new Set(),         // member ids currently talking ('self' for you)
  heardAt: 0, duck: 1, loop: null, chain: Promise.resolve(),
};
const VOICE_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const voiceCanTalk = () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
const voiceVol = () => store.get('voiceVol', 100);
const voiceDucks = () => store.get('voiceDuck', true);

/* ---------- joining & leaving ---------- */
async function voiceJoin() {
  if (!roomActive() || Voice.on) return;
  Voice.ctx = Voice.ctx || new (window.AudioContext || window.webkitAudioContext)();
  Voice.ctx.resume().catch(() => {});
  let mic = null;
  if (voiceCanTalk()) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      toast(err?.name === 'NotAllowedError'
        ? 'Microphone blocked. You can still listen; allow the mic in your browser settings to talk.'
        : 'No microphone found. You joined to listen.', 5000);
    }
  } else {
    toast('Talking needs the secure https:// room link. You joined to listen; ask the host for the internet link to talk.', 6000);
  }
  if (!roomActive()) { mic?.getTracks().forEach((t) => t.stop()); return; }
  Voice.mic = mic; Voice.on = true; Voice.muted = false;
  Voice.selfMeter = mic ? voiceMeter(mic) : null;
  voiceAnnounce();
  voiceOnMembers();
  clearInterval(Voice.loop);
  Voice.loop = setInterval(voiceTick, 100);
  renderVoice();
  if (mic) toast('You\'re in voice. Headphones keep the music out of your mic.', 3500);
}
function voiceLeave(silent) {
  if (!Voice.on) return;
  for (const id of [...Voice.peers.keys()]) voiceClose(id);
  Voice.mic?.getTracks().forEach((t) => t.stop());
  Voice.mic = null; Voice.selfMeter = null; Voice.on = false; Voice.muted = false;
  Voice.speaking.clear();
  clearInterval(Voice.loop); Voice.loop = null;
  voiceSetDuck(1, true);
  if (!silent && roomActive()) roomSend('voice', { on: false });
  renderVoice(); voicePaintMembers();
}
function voiceAnnounce() {
  if (Voice.on) roomSend('voice', { on: true, mic: !!Voice.mic, muted: Voice.muted });
}
function voiceToggleMute() {
  if (!Voice.on) { voiceJoin(); return; }
  if (!Voice.mic) { toast('You joined to listen only, so there is no mic to unmute.'); return; }
  Voice.muted = !Voice.muted;
  Voice.mic.getAudioTracks().forEach((t) => { t.enabled = !Voice.muted; });
  voiceAnnounce();
  renderVoice();
}

/* ---------- connections ---------- */
// Called whenever the member list changes: connect to new voice members, drop departed ones.
// For each pair, the member with the smaller id starts the call, so two people never call each other at once.
function voiceOnMembers() {
  if (!Voice.on) { voicePaintMembers(); return; }
  const inVoice = new Map(Room.members.filter((m) => m.voice && m.online && m.id !== Room.client).map((m) => [m.id, m]));
  for (const id of [...Voice.peers.keys()]) if (!inVoice.has(id)) voiceClose(id);
  for (const id of inVoice.keys()) {
    if (!Voice.peers.has(id) && Room.client < id) voiceCall(id);
  }
  voicePaintMembers(); renderVoice();
}
// The room connection dropped and came back: the server forgot we were in voice.
function voiceOnHello() {
  if (!Voice.on) return;
  for (const id of [...Voice.peers.keys()]) voiceClose(id);
  voiceAnnounce();
}
function voicePeer(id, initiator) {
  let p = Voice.peers.get(id);
  if (p) return p;
  const pc = new RTCPeerConnection({ iceServers: VOICE_ICE });
  p = { pc, ice: [], audio: null, meter: null };
  Voice.peers.set(id, p);
  if (Voice.mic) for (const track of Voice.mic.getAudioTracks()) pc.addTrack(track, Voice.mic);
  else if (initiator) pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.onicecandidate = (e) => { if (e.candidate) voiceSignal(id, { ice: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (p.audio?.srcObject === stream) return;
    p.audio = p.audio || new Audio();
    p.audio.autoplay = true;
    p.audio.srcObject = stream;
    p.audio.volume = voiceVol() / 100;
    p.audio.play().catch(() => toast('Tap anywhere to hear the room\'s voices', 4000));
    p.meter = voiceMeter(stream);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      const name = Room.members.find((m) => m.id === id)?.name || 'someone';
      toast(`Couldn't connect voice with ${name}. Their network may block direct connections.`, 5000);
    }
    renderVoice();
  };
  return p;
}
async function voiceCall(id) {
  const p = voicePeer(id, true);
  try {
    await p.pc.setLocalDescription(await p.pc.createOffer());
    voiceSignal(id, { sdp: p.pc.localDescription.toJSON() });
  } catch (err) { console.error('voice offer', err); voiceClose(id); }
}
function voiceClose(id) {
  const p = Voice.peers.get(id);
  if (!p) return;
  Voice.peers.delete(id);
  Voice.speaking.delete(id);
  try { p.pc.close(); } catch { /* already closed */ }
  if (p.audio) { p.audio.pause(); p.audio.srcObject = null; }
  try { p.meter?.src.disconnect(); } catch { /* ignore */ }
}
function voiceSignal(to, payload) { roomSend('signal', { to, payload }); }
// Signals are handled one at a time, in order, so an answer never races its offer.
function voiceOnSignal(from, data) {
  Voice.chain = Voice.chain.then(() => voiceHandleSignal(from, data)).catch((err) => console.error('voice signal', err));
}
async function voiceHandleSignal(from, data) {
  if (!Voice.on || !data) return;
  let p = Voice.peers.get(from);
  if (data.sdp?.type === 'offer') {
    if (p) voiceClose(from); // they restarted the call
    p = voicePeer(from, false);
    await p.pc.setRemoteDescription(data.sdp);
    await p.pc.setLocalDescription(await p.pc.createAnswer());
    voiceSignal(from, { sdp: p.pc.localDescription.toJSON() });
  } else if (data.sdp?.type === 'answer') {
    if (!p || p.pc.signalingState !== 'have-local-offer') return;
    await p.pc.setRemoteDescription(data.sdp);
  } else if (data.ice) {
    if (!p) return;
    if (!p.pc.remoteDescription) { p.ice.push(data.ice); return; }
    await p.pc.addIceCandidate(data.ice).catch(() => {});
    return;
  }
  if (p?.pc.remoteDescription && p.ice.length) {
    for (const c of p.ice.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
  }
}

/* ---------- who's talking, and making room for them ---------- */
function voiceMeter(stream) {
  const src = Voice.ctx.createMediaStreamSource(stream);
  const an = Voice.ctx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  return { src, an, buf: new Float32Array(an.fftSize), level: 0, until: 0 };
}
function voiceLevel(m, now) {
  m.an.getFloatTimeDomainData(m.buf);
  let sum = 0;
  for (const v of m.buf) sum += v * v;
  const rms = Math.sqrt(sum / m.buf.length);
  m.level = Math.max(rms, m.level * 0.8);
  if (m.level > 0.015) m.until = now + 350; // hold briefly so the light doesn't flicker between words
  return now < m.until;
}
function voiceTick() {
  if (!Voice.on) return;
  const now = performance.now(), was = [...Voice.speaking].join();
  Voice.speaking.clear();
  if (Voice.selfMeter && !Voice.muted && voiceLevel(Voice.selfMeter, now)) Voice.speaking.add('self');
  let someoneElse = false;
  for (const [id, p] of Voice.peers) {
    if (p.meter && voiceLevel(p.meter, now)) { Voice.speaking.add(id); someoneElse = true; }
  }
  if (someoneElse) Voice.heardAt = now;
  // Dip the music while others talk; ease it back in shortly after they stop.
  const target = voiceDucks() && now - Voice.heardAt < 900 ? 0.3 : 1;
  voiceSetDuck(target > Voice.duck ? Math.min(target, Voice.duck + 0.07) : Math.max(target, Voice.duck - 0.25));
  if ([...Voice.speaking].join() !== was) voicePaintMembers();
}
function voiceSetDuck(f, now) {
  f = Math.round(f * 100) / 100;
  if (f === Voice.duck && !now) return;
  Voice.duck = f;
  setMusicDuck(f);
}
function voiceSetVolume(v) {
  store.set('voiceVol', v);
  for (const p of Voice.peers.values()) if (p.audio) p.audio.volume = v / 100;
}

/* ---------- UI ---------- */
function voicePaintMembers() {
  for (const el of $$('#roomMembers .member')) {
    const id = el.dataset.id;
    const talking = Voice.on && Voice.speaking.has(id === Room.client ? 'self' : id);
    el.classList.toggle('speaking', talking);
  }
  const mine = $('#btnMic');
  if (mine) mine.classList.toggle('speaking', Voice.speaking.has('self'));
}
function renderVoice() {
  const box = $('#roomVoice'), mic = $('#btnMic');
  if (mic) {
    mic.hidden = !Voice.on;
    mic.setAttribute('aria-pressed', String(Voice.on && !Voice.muted && !!Voice.mic));
    mic.title = !Voice.mic ? 'Listening only' : Voice.muted ? 'Unmute your mic' : 'Mute your mic';
    $('use', mic)?.setAttribute('href', Voice.mic && !Voice.muted ? '#i-mic' : '#i-mic-off');
  }
  if (!box) return;
  box.replaceChildren();
  if (!roomActive()) return;
  const others = Room.members.filter((m) => m.voice && m.online && m.id !== Room.client);
  if (!Voice.on) {
    const join = h('button', { class: 'btn primary' }, icon('mic'), 'Join voice');
    join.addEventListener('click', voiceJoin);
    box.append(
      h('div', { class: 'voice-top' },
        h('div', {}, h('b', { text: 'Voice chat' }),
          h('div', { class: 'a', text: others.length ? `${others.length} talking in voice now` : 'Talk while the music plays' })),
        join),
      h('p', { class: 'hint', text: voiceCanTalk()
        ? 'Uses your microphone. Headphones work best, so the music doesn\'t echo back.'
        : 'On this link you can listen to voice chat but not talk. The secure https:// room link lets you talk too.' }));
    return;
  }
  const states = [...Voice.peers.values()].map((p) => p.pc.connectionState);
  const connected = states.filter((s) => s === 'connected').length;
  const status = !others.length ? 'Waiting for others to join voice'
    : connected === others.length ? `Talking with ${connected} ${connected === 1 ? 'person' : 'people'}`
      : `Connecting… ${connected}/${others.length}`;
  const muteBtn = h('button', { class: 'btn' + (Voice.mic && !Voice.muted ? ' primary' : '') },
    icon(Voice.mic && !Voice.muted ? 'mic' : 'mic-off'), !Voice.mic ? 'Listening only' : Voice.muted ? 'Unmute' : 'Mute');
  muteBtn.disabled = !Voice.mic;
  muteBtn.addEventListener('click', voiceToggleMute);
  const leave = h('button', { class: 'btn', text: 'Leave voice' });
  leave.addEventListener('click', () => voiceLeave());
  const vol = h('input', { type: 'range', class: 'range', min: '0', max: '100', value: String(voiceVol()), 'aria-label': 'Voice volume' });
  vol.style.setProperty('--p', `${voiceVol()}%`);
  vol.addEventListener('input', () => { vol.style.setProperty('--p', `${vol.value}%`); voiceSetVolume(+vol.value); });
  const duck = h('input', { type: 'checkbox' });
  duck.checked = voiceDucks();
  duck.addEventListener('change', () => store.set('voiceDuck', duck.checked));
  box.append(
    h('div', { class: 'voice-top' },
      h('div', {}, h('b', { text: 'Voice chat' }), h('div', { class: 'a', text: status })),
      h('span', { class: 'live-dot' })),
    h('div', { class: 'btn-row' }, muteBtn, leave),
    h('label', { class: 'voice-vol' }, icon('group'), h('span', { text: 'Voices' }), vol),
    h('label', { class: 'switch' }, duck, h('span', { text: 'Turn the music down while people talk' })));
}
