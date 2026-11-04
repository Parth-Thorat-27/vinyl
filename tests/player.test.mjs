// The player in a real browser (with a stand-in YouTube): reorder, crossfade, sleep timer,
// recently played, synced lyrics.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, browser, sleep } from './helpers.mjs';

let srv, b;
before(async () => { srv = await startServer(); b = await browser({ name: 'player' }); await b.open(srv.url + '/'); });
after(async () => { await b?.close(); srv?.stop(); });

const A = 'aaaaaaaaaa1', B = 'bbbbbbbbbb2', C = 'cccccccccc3', D = 'dddddddddd4';
const reset = async (ids, durs = {}, speed = 1) => {
  await b.ev(`(() => { endCrossfade(); store.set('crossfade', 0); sleepSet(0); window.__fakeDur = ${JSON.stringify(durs)}; window.__fakeSpeed = ${speed};
    setQueue(${JSON.stringify(ids.map((id) => ({ id, title: 'T-' + id, artist: 'Band' })))}, 0); })()`);
  await b.waitFor(`phase === 'playing'`);
};
const order = () => b.ev(`JSON.stringify(S.queue.map(t => t.id))`);

test('plays the first song', async () => {
  await reset([A, B, C, D]);
  assert.equal(await b.ev('S.queue[S.index].id'), A);
  assert.equal(await b.ev(`$('#title').textContent`), 'T-' + A);
});

test('moves songs: function, keyboard, and drag with the mouse', async () => {
  await reset([A, B, C, D]);
  await b.ev('moveTrack(3, 1)');
  assert.equal(await order(), JSON.stringify([A, D, B, C]));
  assert.equal(await b.ev('S.index'), 0, 'current song stays current');

  // Keyboard: focus D's handle and press arrow down.
  await b.ev(`selectTab('queue'); $('#queueList .row[data-i="1"] .drag-handle').focus()`);
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  assert.equal(await order(), JSON.stringify([A, B, D, C]));

  // Drag: take the last row's handle up above the second row.
  const pos = JSON.parse(await b.ev(`(() => {
    const h = $('#queueList .row[data-i="3"] .drag-handle').getBoundingClientRect();
    const t = $('#queueList .row[data-i="1"]').getBoundingClientRect();
    return JSON.stringify({ x: h.left + h.width / 2, y: h.top + h.height / 2, ty: t.top + 4 });
  })()`));
  await b.mouse('mousePressed', pos.x, pos.y);
  for (let k = 1; k <= 6; k++) await b.mouse('mouseMoved', pos.x, pos.y + (pos.ty - pos.y) * (k / 6));
  await b.mouse('mouseReleased', pos.x, pos.ty);
  assert.equal(await order(), JSON.stringify([A, C, B, D]));
});

test('crossfade blends into the next song', async () => {
  await reset([A, B], { [A]: 14, [B]: 60 }, 2);
  await b.ev(`store.set('crossfade', 3)`);
  // At 2x speed the 14s song reaches its last 3 seconds after ~5.5s.
  await b.waitFor('XF.active', 12000, 50);
  assert.equal(await b.ev('S.queue[S.index].id'), B, 'the next song becomes current right away');
  const mid = JSON.parse(await b.ev(`JSON.stringify({ old: XF.old.getVolume(), now: player.getVolume(), oldId: XF.old.getVideoData().video_id })`));
  assert.equal(mid.oldId, A);
  await sleep(1200);
  const later = JSON.parse(await b.ev(`JSON.stringify({ old: XF.active ? XF.old.getVolume() : 0, now: player.getVolume() })`));
  assert.ok(later.now > mid.now, `new song should get louder: ${mid.now} -> ${later.now}`);
  await b.waitFor('!XF.active', 5000);
  assert.equal(await b.ev('spare.getPlayerState()'), 5, 'the old song is stopped');
  assert.equal(await b.ev('player.getVolume()'), await b.ev('musicVolume()'));
  assert.equal(await b.ev('phase'), 'playing');
});

test('sleep timer: "end of song" stops instead of moving on', async () => {
  await reset([A, B], { [A]: 6 }, 3);
  await b.ev(`sleepSet('song')`);
  assert.equal(await b.ev(`$('#sleepPill').hidden`), false);
  await b.waitFor(`phase === 'idle'`, 8000);
  assert.equal(await b.ev('S.queue[S.index].id'), A, 'did not go on to the next song');
  assert.equal(await b.ev(`$('#sleepPill').hidden`), true);
});

test('sleep timer: minutes fade the music out, then pause', async () => {
  await reset([A, B]);
  await b.ev('sleepSet(0.05)'); // 3 seconds
  await sleep(1000);
  assert.ok(await b.ev('sleepFade < 1'), 'music is fading');
  await b.waitFor(`phase === 'paused'`, 6000);
  await b.waitFor('sleepFade === 1', 2000);
});

test('recently played lists songs, newest first', async () => {
  await reset([C]);
  await reset([D]);
  const hist = JSON.parse(await b.ev(`JSON.stringify(store.get('history', []).map(h => h.id))`));
  assert.equal(hist[0], D);
  assert.equal(hist[1], C);
  await b.ev(`selectTab('library')`);
  assert.ok((await b.ev(`$('#historyList').innerText`)).includes('T-' + D));
});

test('synced lyrics follow the song', async () => {
  b.lyrics = { synced: '[00:00.00] First line\n[00:02.00] Second line\n[00:04.50] Third line\n[01:00.00] Much later' };
  await reset(['eeeeeeeeee5']);
  await b.ev(`selectTab('lyrics')`);
  await b.waitFor(`$$('#lyricsLines .lyric').length === 4`, 5000);
  await b.waitFor(`$('#lyricsLines .lyric.on')?.textContent === 'Second line'`, 5000);
  // Clicking a line jumps there.
  await b.ev(`$$('#lyricsLines .lyric')[3].click()`);
  await b.waitFor(`$('#lyricsLines .lyric.on')?.textContent === 'Much later'`, 3000);
  assert.ok(await b.ev('eng().time() >= 59'));
  b.lyrics = null;
});

test('no page errors', () => {
  assert.deepEqual(b.errors, []);
});
