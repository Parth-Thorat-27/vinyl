// Voice chat between two real browsers using Chrome's fake microphone: connecting, mute,
// push to talk, and that relay settings from the server are used.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, browser } from './helpers.mjs';

let srv, host, guest;
before(async () => {
  srv = await startServer({ TURN_URLS: 'turn:relay.invalid:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });
  [host, guest] = await Promise.all([browser({ name: 'vhost', fakeMedia: true }), browser({ name: 'vguest', fakeMedia: true })]);
  await host.open(srv.url + '/');
  const room = await host.ev(`roomCreate('Parth').then(() => Room.id)`);
  await guest.open(`${srv.url}/#room=${room}`);
  await guest.waitFor(`$('#roomDialog').open`);
  await guest.ev(`(() => { $('#roomDialogBody input').value = 'Riya'; [...$$('#roomDialogBody button')].find((x) => /Join/.test(x.textContent)).click(); })()`);
  await guest.waitFor('Room.me');
});
after(async () => { await host?.close(); await guest?.close(); srv?.stop(); });

const connected = (b) => b.ev(`[...Voice.peers.values()].filter((p) => p.pc.connectionState === 'connected').length`);
const micOn = (b) => b.ev(`Voice.mic.getAudioTracks().every((t) => t.enabled)`);

test('both join voice and connect, with the relay settings from the server', async () => {
  await host.ev('voiceJoin()');
  await guest.ev('voiceJoin()');
  await host.waitFor(`(${'[...Voice.peers.values()].filter((p) => p.pc.connectionState === "connected").length'}) === 1`, 15000);
  assert.equal(await connected(guest), 1);
  assert.equal(await host.ev('Voice.ice.relay'), true);
  assert.ok(await host.ev(`Voice.ice.iceServers.some((s) => [].concat(s.urls).includes('turn:relay.invalid:3478'))`));
  // The other side's audio arrives.
  await host.waitFor(`[...Voice.peers.values()].some((p) => p.audio && p.audio.srcObject && p.audio.srcObject.getAudioTracks().length)`);
});

test('mute turns the mic off and tells the room', async () => {
  assert.equal(await micOn(guest), true);
  await guest.ev('voiceToggleMute()');
  assert.equal(await micOn(guest), false);
  await host.waitFor(`Room.members.find((m) => m.name === 'Riya').voice.muted === true`);
  await guest.ev('voiceToggleMute()');
  assert.equal(await micOn(guest), true);
});

test('push to talk: silent until T is held', async () => {
  await guest.ev('voiceSetPtt(true)');
  assert.equal(await micOn(guest), false);
  await host.waitFor(`Room.members.find((m) => m.name === 'Riya').voice.ptt === true`);
  await guest.ev(`document.activeElement?.blur()`);
  await guest.key('keyDown', 't');
  assert.equal(await micOn(guest), true);
  await guest.key('keyUp', 't');
  assert.equal(await micOn(guest), false);
  // Holding the on-screen button works too.
  const box = JSON.parse(await guest.ev(`(() => { openPanel('room'); const b = $('#roomVoice .ptt-btn').getBoundingClientRect(); return JSON.stringify({ x: b.left + 10, y: b.top + 10 }); })()`));
  await guest.mouse('mousePressed', box.x, box.y);
  assert.equal(await micOn(guest), true);
  await guest.mouse('mouseReleased', box.x, box.y);
  assert.equal(await micOn(guest), false);
  await guest.ev('voiceSetPtt(false)');
  assert.equal(await micOn(guest), true);
});

test('leaving voice closes the connection on both sides', async () => {
  await guest.ev('voiceLeave()');
  await host.waitFor('Voice.peers.size === 0', 5000);
  assert.equal(await guest.ev('Voice.peers.size'), 0);
});

test('no page errors', () => {
  assert.deepEqual(host.errors, []);
  assert.deepEqual(guest.errors, []);
});
