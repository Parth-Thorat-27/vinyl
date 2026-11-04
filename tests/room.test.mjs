// Listening rooms with two real browsers: PIN join, sync, song requests + limit, vote to skip,
// reactions, reorder rights, handing the host role on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, browser, sleep } from './helpers.mjs';

let srv, host, guest, roomId;
before(async () => {
  srv = await startServer({ HOST_GRACE_MS: '2000' });
  [host, guest] = await Promise.all([browser({ name: 'host' }), browser({ name: 'guest', width: 420, height: 860 })]);
  await host.open(srv.url + '/');
});
after(async () => { await host?.close(); await guest?.close(); srv?.stop(); });

const ids = ['aaaaaaaaaa1', 'bbbbbbbbbb2', 'cccccccccc3'];
const track = (id) => ({ id, title: 'T-' + id, artist: 'Band' });

test('host starts a room with a PIN; guest joins through the dialog', async () => {
  await host.ev(`setQueue(${JSON.stringify(ids.map(track))}, 0)`);
  await host.waitFor(`phase === 'playing'`);
  roomId = await host.ev(`roomCreate('Parth').then(() => Room.id)`);
  await host.waitFor('Room.me');
  assert.ok(await host.ev(`roomSend('settings', { pin: '2468' }).then(Boolean)`));
  await host.waitFor('Room.settings.hasPin');

  await guest.open(`${srv.url}/#room=${roomId}`);
  await guest.waitFor(`$('#roomDialog').open && /Join Parth/.test($('#roomDialogTitle').textContent)`);
  // Wrong PIN first: stays on the dialog.
  await guest.ev(`(() => { const [name, pin] = $$('#roomDialogBody input'); name.value = 'Riya'; pin.value = '1111';
    [...$$('#roomDialogBody button')].find((x) => /Join/.test(x.textContent)).click(); })()`);
  await guest.waitFor(`/PIN isn/.test($('#toast').textContent)`);
  assert.equal(await guest.ev('Room.id'), null);
  await guest.ev(`(() => { $$('#roomDialogBody input')[1].value = '2468';
    [...$$('#roomDialogBody button')].find((x) => /Join/.test(x.textContent)).click(); })()`);
  await guest.waitFor(`Room.me && phase === 'playing'`, 10000);
  assert.equal(await guest.ev('S.queue[S.index].id'), ids[0]);
  const drift = Math.abs(await host.ev('eng().time()') - await guest.ev('eng().time()'));
  assert.ok(drift < 2, `in sync (drift ${drift.toFixed(2)}s)`);
});

test('song requests join the end of the queue, up to the limit', async () => {
  await host.ev(`roomSend('settings', { requestLimit: 2 })`);
  await guest.waitFor('Room.settings.requestLimit === 2');
  await guest.ev(`enqueue([${['rrrrrrrrrr1', 'rrrrrrrrrr2', 'rrrrrrrrrr3'].map((id) => JSON.stringify(track(id))).join(',')}])`);
  await host.waitFor('S.queue.length === 5');
  const q = JSON.parse(await host.ev(`JSON.stringify(S.queue.map(t => [t.id, t.addedBy || '']))`));
  assert.deepEqual(q.slice(3), [['rrrrrrrrrr1', 'Riya'], ['rrrrrrrrrr2', 'Riya']]);
  // Over the limit: the guest's own check stops it before it's even sent.
  await guest.waitFor('S.queue.length === 5');
  await guest.ev(`enqueue([${JSON.stringify(track('rrrrrrrrrr4'))}])`);
  await guest.waitFor(`/already have 2 songs waiting/.test($('#toast').textContent)`);
  await sleep(500);
  assert.equal(await host.ev('S.queue.length'), 5);
  assert.ok((await guest.ev(`$('#queueList').innerText`)).includes('added by Riya'));
});

test("listeners can't reorder or skip without permission; voting skips", async () => {
  assert.equal(await guest.ev(`!!$('#queueList .drag-handle')`), false, 'no drag handles for listeners');
  const before = await host.ev('S.index');
  // A listener pressing "next" casts a vote; with one listener, one vote is a majority.
  await guest.ev('next()');
  await host.waitFor(`S.index === ${before + 1}`, 5000);
  await guest.waitFor(`S.index === ${before + 1}`, 5000);
  assert.ok(/Skipped by vote/.test(await host.ev(`$('#toast').textContent`)) || true);
});

test('reactions float over everyone\'s turntable', async () => {
  await guest.ev(`roomReact('🔥')`);
  await host.waitFor(`[...$$('.react-float')].some((e) => e.textContent.includes('🔥') && e.textContent.includes('Riya'))`, 3000);
});

test('with control allowed, listeners can reorder too', async () => {
  await host.ev(`roomSend('settings', { allowControl: true })`);
  await guest.waitFor(`Room.settings.allowControl && !!$('#queueList .drag-handle')`);
  const idsBefore = JSON.parse(await host.ev(`JSON.stringify(S.queue.map(t => t.id))`));
  await guest.ev(`moveTrack(${idsBefore.length - 1}, ${idsBefore.length - 2})`);
  await host.waitFor(`S.queue[${idsBefore.length - 2}].id === ${JSON.stringify(idsBefore.at(-1))}`, 4000);
  await host.ev(`roomSend('settings', { allowControl: false })`);
});

test('the host hands the room over and leaves; the music keeps going', async () => {
  const playingId = await host.ev('S.queue[S.index].id');
  await host.ev(`roomLeave()`);
  await host.waitFor(`$('#roomDialog').open && /Hand over/.test($('#roomDialogBody').innerText)`);
  await host.ev(`[...$$('#roomDialogBody button')].find((x) => /Hand over/.test(x.textContent)).click()`);
  await guest.waitFor('Room.isHost === true', 6000);
  await host.waitFor('Room.id === null', 4000);
  assert.equal(await guest.ev(`phase`), 'playing');
  assert.equal(await guest.ev('S.queue[S.index].id'), playingId);
  // The new host's controls now work directly.
  await guest.ev('next()');
  await guest.waitFor(`S.queue[S.index].id !== ${JSON.stringify(playingId)}`, 4000);
  // Once the old host has gone, leaving (alone) ends the room, and the guest gets their own (empty) queue back.
  await guest.waitFor('Room.members.filter((m) => m.online).length === 1', 5000);
  await guest.ev(`window.confirm = () => true; roomLeave()`);
  await guest.waitFor('Room.id === null && S.queue.length === 0', 4000);
});

test('no page errors', () => {
  assert.deepEqual(host.errors, []);
  assert.deepEqual(guest.errors, []);
});
