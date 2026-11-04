// Room server API: rooms, PIN, private ids, votes, handoff, rate limits, voice relay, cloud mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, sse, post, sleep } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer({ HOST_GRACE_MS: '1500', TURN_URLS: 'turn:relay.example.com:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' }); });
after(() => srv?.stop());

const api = (p) => `${srv.url}/api/rooms${p}`;
async function makeRoom(name = 'Test') {
  const r = await post(api(''), { client: `host-${Math.random().toString(36).slice(2)}xxxxxxxx`, name });
  assert.equal(r.status, 200);
  return r.body;
}
const listen = (room, client, extra = '') => sse(api(`/${room}/events?client=${client}&name=${encodeURIComponent(client.slice(0, 8))}${extra}`));
const send = (room, client, type, data, host) => post(api(`/${room}/send`), { client, host, type, data });

test('serves the app and health check', async () => {
  assert.equal((await fetch(srv.url + '/')).status, 200);
  assert.equal((await fetch(srv.url + '/voice.js')).status, 200);
  assert.deepEqual(await (await fetch(srv.url + '/healthz')).json(), { ok: true, rooms: 0 });
  assert.equal((await fetch(srv.url + '/../server.js')).status, 404);
});

test('a room: host + listener, public ids never reveal private ones', async () => {
  const r = await makeRoom();
  const hostClient = 'HOSTSECRET-aaaaaaaaaaaaa';
  // The room was created with a random host client id; connecting with the token adopts ours.
  const host = listen(r.room, hostClient, `&host=${r.hostToken}`);
  await host.ready;
  const hello = await host.next('hello');
  assert.equal(hello.isHost, true);
  assert.notEqual(hello.you, hostClient);

  const guestSecret = 'GUESTSECRET-bbbbbbbbbbbb';
  const guest = listen(r.room, guestSecret);
  await guest.ready;
  const gh = await guest.next('hello');
  assert.equal(gh.isHost, false);
  const members = (await host.next('members', (m) => m.length === 2));
  assert.ok(members.every((m) => m.id.length === 12));
  assert.ok(!JSON.stringify(members).includes(guestSecret), 'private client id leaked');

  // Chat carries the public id only.
  await send(r.room, guestSecret, 'chat', { text: 'hi' });
  const msg = await host.next('chat');
  assert.equal(msg.text, 'hi');
  assert.equal(msg.from, gh.you);

  // A listener can't pretend to be the host.
  assert.equal((await send(r.room, guestSecret, 'state', { playing: true })).status, 403);
  // Someone who isn't in the room can't post.
  assert.equal((await send(r.room, 'STRANGER-ccccccccccccccc', 'chat', { text: 'x' })).status, 403);
  host.close(); guest.close();
});

test('PIN: needed to join, checked with a limit on guesses', async () => {
  const r = await makeRoom();
  const host = listen(r.room, 'PINHOST-aaaaaaaaaaaaaaaa', `&host=${r.hostToken}`);
  await host.ready; await host.next('hello');
  assert.equal((await send(r.room, 'PINHOST-aaaaaaaaaaaaaaaa', 'settings', { pin: '12' }, r.hostToken)).status, 400);
  assert.equal((await send(r.room, 'PINHOST-aaaaaaaaaaaaaaaa', 'settings', { pin: '4321' }, r.hostToken)).status, 200);
  assert.equal((await (await fetch(api(`/${r.room}`))).json()).pin, true);

  // Without the PIN the event stream refuses.
  await assert.rejects(listen(r.room, 'NOPIN-bbbbbbbbbbbbbbbbbb').ready, (e) => e.status === 403 && e.body.needPin);
  // The check endpoint: right PIN ok, wrong PINs get rate-limited.
  assert.equal((await post(api(`/${r.room}/check`), { pin: '4321' })).status, 200);
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await post(api(`/${r.room}/check`), { pin: '0000' })).status);
  assert.ok(codes.includes(403) && codes.at(-1) === 429, `got ${codes}`);
  // With the PIN you're in.
  const ok = listen(r.room, 'WITHPIN-cccccccccccccccc', '&pin=4321');
  await ok.ready;
  assert.equal((await ok.next('hello')).isHost, false);
  host.close(); ok.close();
});

test('vote to skip: a majority of listeners tells the host to skip', async () => {
  const r = await makeRoom();
  const H = 'VOTEHOST-aaaaaaaaaaaaaaa';
  const host = listen(r.room, H, `&host=${r.hostToken}`);
  await host.ready; await host.next('hello');
  const gs = ['VOTER1-bbbbbbbbbbbbbbbbbb', 'VOTER2-cccccccccccccccccc', 'VOTER3-dddddddddddddddddd'];
  const streams = [];
  for (const g of gs) { const s = listen(r.room, g); await s.ready; await s.next('hello'); streams.push(s); }
  await send(r.room, H, 'state', { index: 0, from: 0, track: { id: 'dQw4w9WgXcQ' }, playing: true, position: 3 }, r.hostToken);
  await send(r.room, gs[0], 'vote', { on: true });
  const v1 = await host.next('votes', (v) => v.count === 1);
  assert.equal(v1.needed, 2); // 3 listeners -> 2 votes
  await send(r.room, gs[1], 'vote', { on: true });
  const cmd = await host.next('cmd', (c) => c.from === 'vote');
  assert.equal(cmd.action, 'next');
  // A new song resets the votes.
  await send(r.room, H, 'state', { index: 1, from: 0, track: { id: 'djV11Xbc914' }, playing: true, position: 0 }, r.hostToken);
  assert.equal((await host.next('votes', (v) => v.key === '1:djV11Xbc914')).count, 0);
  // The host can turn voting off.
  await send(r.room, H, 'settings', { voteSkip: false }, r.hostToken);
  assert.equal((await send(r.room, gs[2], 'vote', { on: true })).status, 403);
  host.close(); streams.forEach((s) => s.close());
});

test('handoff: the host hands over, and a host who leaves is replaced', async () => {
  const r = await makeRoom();
  const H = 'HANDHOST-aaaaaaaaaaaaaaa', G = 'HANDGUEST-bbbbbbbbbbbbbb', G2 = 'HANDGUEST2-ccccccccccccc';
  const host = listen(r.room, H, `&host=${r.hostToken}`);
  await host.ready; await host.next('hello');
  const guest = listen(r.room, G); await guest.ready; const gh = await guest.next('hello');
  const guest2 = listen(r.room, G2); await guest2.ready; const g2h = await guest2.next('hello');

  assert.equal((await send(r.room, H, 'handoff', { client: gh.you }, r.hostToken)).status, 200);
  const promo = await guest.next('promoted');
  assert.ok(promo.hostToken && promo.hostToken !== r.hostToken);
  await host.next('demoted');
  // The old token stops working; the new one works.
  assert.equal((await send(r.room, H, 'settings', { locked: true }, r.hostToken)).status, 403);
  assert.equal((await send(r.room, G, 'settings', { locked: false }, promo.hostToken)).status, 200);

  // The new host disappears: after the grace period the room moves on to someone still there.
  guest.close();
  const promo2 = await Promise.race([guest2.next('promoted', () => true, 6000), host.next('promoted', () => true, 6000)]);
  assert.ok(promo2.hostToken);
  assert.ok(g2h.you);
  host.close(); guest2.close();
});

test('reactions, kicking, and rate limits', async () => {
  const r = await makeRoom();
  const H = 'RLHOST-aaaaaaaaaaaaaaaaa', G = 'RLGUEST-bbbbbbbbbbbbbbbb';
  const host = listen(r.room, H, `&host=${r.hostToken}`); await host.ready; await host.next('hello');
  const guest = listen(r.room, G); await guest.ready; const gh = await guest.next('hello');

  assert.equal((await send(r.room, G, 'react', { emoji: '🔥' })).status, 200);
  assert.equal((await host.next('react')).emoji, '🔥');
  assert.equal((await send(r.room, G, 'react', { emoji: '<script>' })).status, 400);

  // Chat flood: the burst is allowed, then 429.
  const codes = [];
  for (let i = 0; i < 14; i++) codes.push((await send(r.room, G, 'chat', { text: `m${i}` })).status);
  assert.ok(codes.slice(0, 8).every((c) => c === 200), `burst: ${codes}`);
  assert.ok(codes.includes(429), `no limit hit: ${codes}`);

  // Kick: the listener is removed and can't come back.
  await send(r.room, H, 'kick', { client: gh.you }, r.hostToken);
  await guest.next('kicked');
  await assert.rejects(listen(r.room, G).ready, (e) => e.status === 403);
  host.close();
});

test('room creation is rate-limited per address', async () => {
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await post(api(''), { client: `c${i}-xxxxxxxxxxxxxxxx`, name: 'x' })).status);
  assert.ok(codes.includes(429), `got ${codes}`);
});

test('voice relay settings only go to people in a room', async () => {
  // Earlier tests used up this address's room allowance, so use a fresh server.
  const s2 = await startServer({ TURN_URLS: 'turn:relay.example.com:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });
  try {
    assert.equal((await fetch(`${s2.url}/api/ice`)).status, 403);
    const r = await post(`${s2.url}/api/rooms`, { client: 'ICEHOST-aaaaaaaaaaaaaaaa', name: 'ice' });
    const host = sse(`${s2.url}/api/rooms/${r.body.room}/events?client=ICEHOST-aaaaaaaaaaaaaaaa&name=h&host=${r.body.hostToken}`);
    await host.ready; await host.next('hello');
    const j = await (await fetch(`${s2.url}/api/ice?room=${r.body.room}&client=ICEHOST-aaaaaaaaaaaaaaaa`)).json();
    assert.equal(j.relay, true);
    assert.ok(j.iceServers.some((s) => [].concat(s.urls).includes('turn:relay.example.com:3478') && s.username === 'u'));
    assert.ok(j.iceServers.some((s) => [].concat(s.urls).some((u) => u.startsWith('stun:'))));
    host.close();
  } finally { s2.stop(); }
});

test('cloud mode hides local network details', async () => {
  const c = await startServer({ VINYL_CLOUD: '1' });
  try {
    assert.deepEqual(await (await fetch(`${c.url}/lan.json`)).json(), []);
    const net = await (await fetch(`${c.url}/api/net`)).json();
    assert.equal(net.cloud, true);
    assert.deepEqual(net.http, []);
    assert.equal((await fetch(`${c.url}/api/share`)).status, 403);
  } finally { c.stop(); }
});

test('signals reach only the named member', async () => {
  const s3 = await startServer();
  try {
    const r = await post(`${s3.url}/api/rooms`, { client: 'SIGHOST-aaaaaaaaaaaaaaaa', name: 'sig' });
    const base = `${s3.url}/api/rooms/${r.body.room}`;
    const host = sse(`${base}/events?client=SIGHOST-aaaaaaaaaaaaaaaa&name=h&host=${r.body.hostToken}`); await host.ready; await host.next('hello');
    const a = sse(`${base}/events?client=SIGA-bbbbbbbbbbbbbbbbbbbb&name=a`); await a.ready; const ah = await a.next('hello');
    const b = sse(`${base}/events?client=SIGB-cccccccccccccccccccc&name=b`); await b.ready; await b.next('hello');
    await post(`${base}/send`, { client: 'SIGHOST-aaaaaaaaaaaaaaaa', type: 'signal', data: { to: ah.you, payload: { sdp: 'x' } } });
    const got = await a.next('signal');
    assert.deepEqual(got.data, { sdp: 'x' });
    await sleep(300);
    assert.ok(!b.events.some((e) => e.event === 'signal'));
    host.close(); a.close(); b.close();
  } finally { s3.stop(); }
});

test('a listener who leaves drops off the list straight away', async () => {
  const s4 = await startServer();
  try {
    const r = await post(`${s4.url}/api/rooms`, { client: 'LVHOST-aaaaaaaaaaaaaaaaa', name: 'leave' });
    const base = `${s4.url}/api/rooms/${r.body.room}`;
    const host = sse(`${base}/events?client=LVHOST-aaaaaaaaaaaaaaaaa&name=h&host=${r.body.hostToken}`); await host.ready; await host.next('hello');
    const g = sse(`${base}/events?client=LVGUEST-bbbbbbbbbbbbbbbb&name=g`); await g.ready; await g.next('hello');
    await host.next('members', (m) => m.length === 2);
    assert.equal((await post(`${base}/send`, { client: 'LVGUEST-bbbbbbbbbbbbbbbb', type: 'leave', data: {} })).status, 200);
    await host.next('members', (m) => m.length === 1);
    // The host can't just "leave" (they hand over or end the room).
    assert.equal((await post(`${base}/send`, { client: 'LVHOST-aaaaaaaaaaaaaaaaa', host: r.body.hostToken, type: 'leave', data: {} })).status, 400);
    host.close(); g.close();
  } finally { s4.stop(); }
});
