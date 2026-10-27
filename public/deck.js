'use strict';

/* =========================================================================
   The deck: a turntable built from real parts.
   - The record is pressed onto a canvas for each song (grooves, the quiet bands
     between tracks, run-out and a matrix number in the dead wax). It spins with
     the platter's weight: up to speed in well under a second, braking a bit slower.
   - The light stays put while the record turns under it, so the sheen stands still.
   - The tonearm follows the song like a real stylus, lifts to travel, and can be
     picked up and dropped anywhere on the record to seek.
   - The strobe marks on the platter rim stand still once it reaches 33⅓.
   - The volume knob from Dacx: plain at rest, hold and turn it, tap to mute.
   Loaded before app.js; uses its globals (S, phase, eng, userSeek…) at call
   time, and app.js calls deckBoot(), deckSync() and knobRender().
   ========================================================================= */

const DECK_SPIN = (100 / 3) * 6;    // 33⅓ rpm in degrees per second
const ARM_LEN = 59.5;               // pivot to stylus in deck units (the stylus in #armShape)
const ARM_REST = 88;                // arm direction on its rest (deg, 0 = right, clockwise)
const GROOVE_START = 0.955;         // where the music starts and ends, as a fraction
const GROOVE_END = 0.405;           // of the record's radius
const deckCalm = matchMedia('(prefers-reduced-motion: reduce)');

const Deck = {
  el: null, stage: null, disc: null, vinyl: null, sheen: null, arm: null, shadow: null, strobes: [],
  geo: null, u: 1,
  angle: 0, omega: 0, strobe: 0,
  armAngle: ARM_REST, lift: 0, drag: null, hold: null,
  running: false, last: 0, track: null, pressed: '', pressTimer: null,
};

/* ---------- geometry ---------- */
function deckGeo() {
  const cs = getComputedStyle(Deck.el);
  const n = (p) => parseFloat(cs.getPropertyValue(p));
  const g = { cx: n('--cx'), cy: n('--cy'), rr: n('--rr'), px: n('--px'), py: n('--py'), len: ARM_LEN };
  g.dist = Math.hypot(g.cx - g.px, g.cy - g.py);
  g.toSpindle = Math.atan2(g.cy - g.py, g.cx - g.px) * 180 / Math.PI;
  return g;
}
// Arm direction that puts the stylus r deck units from the spindle (law of cosines).
function armAngleFor(r) {
  const g = Deck.geo;
  const c = (g.dist ** 2 + g.len ** 2 - r ** 2) / (2 * g.dist * g.len);
  return g.toSpindle - Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
}
function radiusFor(deg) {
  const g = Deck.geo, phi = (g.toSpindle - deg) * Math.PI / 180;
  return Math.sqrt(Math.max(0, g.dist ** 2 + g.len ** 2 - 2 * g.dist * g.len * Math.cos(phi)));
}
// A groove is a spiral of even pitch, so the radius shrinks steadily through the song.
const armAt = (p) => armAngleFor(Deck.geo.rr * (GROOVE_START - (GROOVE_START - GROOVE_END) * p));
function progressAt(deg) {
  const f = radiusFor(deg) / Deck.geo.rr;
  if (f > GROOVE_START + 0.03 || f < GROOVE_END - 0.02) return null; // not over the music
  return Math.max(0, Math.min(0.999, (GROOVE_START - f) / (GROOVE_START - GROOVE_END)));
}

/* ---------- pressing the record ---------- */
function hashStr(s) {
  let n = 2166136261;
  for (const ch of s) n = Math.imul(n ^ ch.charCodeAt(0), 16777619);
  return n >>> 0;
}
function seeded(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let grainTile;
function grain(x) {
  if (!grainTile) {
    grainTile = document.createElement('canvas');
    grainTile.width = grainTile.height = 128;
    const g = grainTile.getContext('2d'), d = g.createImageData(128, 128);
    for (let i = 0; i < d.data.length; i += 4) {
      d.data[i] = d.data[i + 1] = d.data[i + 2] = Math.random() * 255;
      d.data[i + 3] = 10;
    }
    g.putImageData(d, 0, 0);
  }
  return x.createPattern(grainTile, 'repeat');
}

// Every song gets its own pressing: same record, different grooves.
function deckPress() {
  const css = Deck.disc.clientWidth;
  const size = Math.min(1800, Math.round(css * Math.min(devicePixelRatio || 1, 2.5)));
  if (!size) return;
  const key = `${Deck.track}@${size}`;
  if (key === Deck.pressed) return;
  Deck.pressed = key;

  const cv = Deck.vinyl;
  cv.width = cv.height = size;
  const x = cv.getContext('2d'), R = size / 2, k = size / css; // canvas px per CSS px
  const seed = hashStr(Deck.track || 'vinyl'), rnd = seeded(seed);
  const TAU = Math.PI * 2;
  const ring = (r, w, a) => {
    x.beginPath(); x.arc(0, 0, r, 0, TAU);
    x.lineWidth = w; x.strokeStyle = `rgba(255,255,255,${a})`; x.stroke();
  };
  x.translate(R, R);

  // Black vinyl with a polished bead round the edge.
  x.beginPath(); x.arc(0, 0, R, 0, TAU); x.fillStyle = '#0b0b0d'; x.fill();
  ring(R * 0.993, R * 0.014, 0.025);
  ring(R - 0.7 * k, 1.1 * k, 0.16);

  // Lead-in: a few wide turns before the music.
  for (let f = 0.982; f > GROOVE_START; f -= 0.0085) ring(R * f, 0.6 * k, 0.055);

  // The songs: fine grooves that catch more light where the music is loud,
  // and smooth, darker bands between tracks.
  const songs = 4 + Math.floor(rnd() * 5);
  const gaps = Array.from({ length: songs - 1 },
    () => GROOVE_END + 0.04 + rnd() * (GROOVE_START - GROOVE_END - 0.08));
  const ph = [rnd() * 9, rnd() * 9, rnd() * 9];
  const pitch = 1.15 * k;
  for (let r = R * GROOVE_END; r < R * GROOVE_START; r += pitch) {
    const f = r / R;
    if (gaps.some((g) => Math.abs(f - g) < 0.0055)) continue;
    const loud = 0.5 + 0.25 * Math.sin(f * 41 + ph[0]) + 0.25 * Math.sin(f * 113 + ph[1]) * Math.sin(f * 7 + ph[2]);
    ring(r, pitch * 0.5, (0.012 + 0.05 * loud * (0.55 + 0.45 * rnd())).toFixed(3));
  }

  // Run-out: a wide spiral into the locked groove, then the dead wax.
  for (let f = GROOVE_END; f > 0.362; f -= 0.011) ring(R * f, 0.6 * k, 0.05);
  ring(R * 0.356, 0.8 * k, 0.09);

  // Matrix number scratched into the dead wax.
  const code = `VNL-${seed % 90000 + 10000}-A1`;
  const rad = R * 0.381;
  x.save();
  x.rotate(rnd() * TAU);
  x.font = `500 ${Math.max(6 * k, R * 0.03)}px Outfit, sans-serif`;
  x.fillStyle = 'rgba(255,255,255,.15)';
  x.textBaseline = 'middle';
  let at = 0;
  for (const ch of code) {
    const w = x.measureText(ch).width;
    x.save(); x.rotate(at + w / 2 / rad); x.fillText(ch, -w / 2, -rad); x.restore();
    at += (w + 0.8 * k) / rad;
  }
  x.restore();

  // A little grain, so the sheen on top never bands.
  x.globalCompositeOperation = 'source-atop';
  x.fillStyle = grain(x);
  x.fillRect(-R, -R, size, size);
}

/* ---------- the motor, the arm and the light ---------- */
function deckWake() {
  if (!Deck.el || Deck.running) return;
  Deck.running = true;
  Deck.last = performance.now();
  requestAnimationFrame(deckFrame);
}

function deckFrame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - Deck.last) / 1000));
  Deck.last = now;
  const calm = deckCalm.matches;
  const motor = phase === 'playing' || phase === 'loading';
  const speed = calm ? DECK_SPIN / 4 : DECK_SPIN;

  // Platter: a strong motor, a gentler brake.
  const want = motor ? speed : 0;
  if (calm) Deck.omega = want;
  else Deck.omega += (want - Deck.omega) * (1 - Math.exp(-dt / (motor ? 0.2 : 0.4)));
  if (!motor && Deck.omega < 1) Deck.omega = 0;
  Deck.angle = (Deck.angle + Deck.omega * dt) % 360;
  // Under the strobe lamp the rim marks only seem to move while the speed is off.
  Deck.strobe = (Deck.strobe + (Deck.omega < speed / 2 ? Deck.omega : Deck.omega - speed) * dt) % 360;

  // Tonearm: where the stylus should be, and whether the cue lever holds it up.
  const t = S.queue[S.index];
  let aim = ARM_REST, cue = 0;
  if (Deck.drag) { aim = Deck.drag.angle; cue = 1; }
  else if (t && phase !== 'idle') {
    const E = eng(), d = E.ready() ? E.duration() : 0;
    aim = armAt(d > 0 ? Math.min(1, E.time() / d) : 0);
    if (Deck.hold) {
      // Just dropped the needle: stay there until the player catches up.
      if (now > Deck.hold.until || Math.abs(aim - Deck.hold.angle) < 0.6) { Deck.hold = null; seeking = false; }
      else aim = Deck.hold.angle;
    }
    if (phase === 'paused') cue = 1;
  }
  const gap = aim - Deck.armAngle;
  if (!Deck.drag && Math.abs(gap) > 1.2) cue = 1; // never drag the stylus across the grooves
  Deck.lift += (cue - Deck.lift) * (1 - Math.exp(-dt / 0.1));
  if (Deck.drag || Math.abs(gap) <= 1.2 || Deck.lift > 0.8) {
    const max = (Deck.drag ? 600 : 70) * dt;
    const step = gap * (1 - Math.exp(-dt / (Deck.drag ? 0.03 : 0.12)));
    Deck.armAngle += Math.max(-max, Math.min(max, step));
  }
  // A real record is never perfectly flat: the arm rides it, once a turn.
  const warp = !calm && motor && Deck.lift < 0.05 ? Math.sin(Deck.angle * Math.PI / 180) * 0.1 : 0;

  const rot = (Deck.armAngle + warp - 90).toFixed(3), lift = Deck.lift, u = Deck.u;
  Deck.disc.style.transform = `rotate(${Deck.angle.toFixed(2)}deg)`;
  for (const s of Deck.strobes) s.style.transform = `rotate(${Deck.strobe.toFixed(2)}deg)`;
  Deck.arm.style.transform = `rotate(${rot}deg) scale(${(1 + 0.014 * lift).toFixed(4)})`;
  Deck.shadow.style.transform = `translate(${((0.4 + 1.5 * lift) * u).toFixed(2)}px, ${((0.7 + 2.4 * lift) * u).toFixed(2)}px) rotate(${rot}deg)`;
  Deck.shadow.style.opacity = (0.55 - 0.25 * lift).toFixed(3);

  const settled = !motor && !Deck.omega && !Deck.drag && !Deck.hold
    && Math.abs(gap) < 0.02 && Math.abs(cue - Deck.lift) < 0.003;
  if (settled) { Deck.running = false; return; }
  requestAnimationFrame(deckFrame);
}

// The light leans a little toward the mouse, so the sheen moves like it would on a real deck.
let lightQueued = false;
function deckLight(e) {
  if (e.pointerType !== 'mouse' || deckCalm.matches || lightQueued) return;
  lightQueued = true;
  requestAnimationFrame(() => {
    lightQueued = false;
    const r = Deck.el.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / innerWidth;
    const dy = (e.clientY - (r.top + r.height / 2)) / innerHeight;
    Deck.sheen.style.setProperty('--light', `${(dx * 30 - dy * 12).toFixed(1)}deg`);
  });
}

/* ---------- needle drop: pick the arm up, put it down anywhere on the record ---------- */
function armDown(e) {
  if (e.button > 0) return;
  e.stopPropagation(); // not a swipe or a tap on the record
  e.preventDefault();
  if (!S.queue[S.index]) { toast('Add some music first'); return; }
  if (roomIsGuest() && !Room.settings.allowControl) { toast('Only the host controls playback in this room.'); return; }
  e.currentTarget.setPointerCapture(e.pointerId);
  Deck.drag = { id: e.pointerId, angle: Deck.armAngle };
  Deck.hold = null;
  seeking = true; // app.js leaves the seek bar alone while we preview the drop
  Deck.el.classList.add('dragging');
  armMove(e);
  deckWake();
}
function armMove(e) {
  if (Deck.drag?.id !== e.pointerId) return;
  const r = Deck.el.getBoundingClientRect(), g = Deck.geo;
  let a = Math.atan2(e.clientY - (r.top + g.py / 100 * r.height), e.clientX - (r.left + g.px / 100 * r.width)) * 180 / Math.PI;
  if (a < -90) a += 360;
  a = Math.max(ARM_REST, Math.min(armAt(1) + 2, a));
  Deck.drag.angle = a;
  // Show where the needle would land.
  const p = progressAt(a), E = eng(), d = E.ready() ? E.duration() : 0;
  if (p != null && d) { setRange($('#seek'), p * 1000, 1000); $('#tCur').textContent = fmt(p * d); }
}
function armUp(e, cancelled = false) {
  if (Deck.drag?.id !== e.pointerId) return;
  const a = Deck.drag.angle;
  Deck.drag = null;
  Deck.el.classList.remove('dragging');
  const p = cancelled ? null : progressAt(a), E = eng(), d = E.ready() ? E.duration() : 0;
  if (p == null || !d) { seeking = false; deckWake(); return; } // let go off the record: it swings back
  Deck.hold = { angle: a, until: performance.now() + 2500 };
  const at = p * d;
  if (phase === 'playing' || phase === 'loading' || roomIsGuest()) userSeek(at);
  else playIndex(S.index, true, at);
  deckWake();
}

/* ---------- layout ---------- */
// Pick whichever arrangement gives the biggest turntable (the same sums as .plinth in style.css):
// wide = controls in a column beside the deck, tall = knob beside the deck,
// narrow = everything stacked.
function deckLayout() {
  const st = Deck.stage, cs = getComputedStyle(st.firstElementChild);
  const v = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
  const W = st.clientWidth - 2 * v('--pad'), H = st.clientHeight - 2 * v('--pad'), gap = v('--gap');
  const stack = v('--lcd-h') + v('--keys-h');
  const size = {
    wide: Math.min(H, W - gap - v('--col')),
    tall: Math.min(W - gap - v('--knob-col'), H - stack - 2 * gap),
    narrow: Math.min(W, H - stack - v('--knob-min') - 3 * gap),
  };
  const mode = Object.keys(size).reduce((a, b) => (size[b] > size[a] ? b : a));
  if (st.dataset.layout !== mode) st.dataset.layout = mode;
}
function deckResize() {
  deckLayout();
  Deck.geo = deckGeo();
  Deck.u = Deck.el.clientWidth / 100;
  clearTimeout(Deck.pressTimer);
  Deck.pressTimer = setTimeout(deckPress, Deck.pressed ? 150 : 0);
  deckWake();
}

/* ---------- volume knob ---------- */
const KNOB_FROM = 135, KNOB_SWEEP = 270; // from bottom-left, over the top, to bottom-right
const Knob = { el: null, ticks: [], pointer: null, drag: null, last: 0, down: null, turning: false, reveal: null, flash: null };

function knobAngle(e) {
  const r = Knob.el.getBoundingClientRect();
  return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
}
function knobShow(on) {
  clearTimeout(Knob.reveal);
  Knob.el.classList.toggle('held', on);
}
function knobDown(e) {
  if (Knob.pointer != null || e.button > 0) return;
  const r = Knob.el.getBoundingClientRect();
  if (Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) > r.width / 2) return;
  Knob.pointer = e.pointerId;
  Knob.el.setPointerCapture(e.pointerId);
  Knob.down = { x: e.clientX, y: e.clientY, t: performance.now() };
  Knob.turning = false;
  Knob.last = knobAngle(e);
  Knob.reveal = setTimeout(() => knobShow(true), 140);
}
function knobMove(e) {
  if (e.pointerId !== Knob.pointer) return;
  if (!Knob.turning) {
    if (Math.hypot(e.clientX - Knob.down.x, e.clientY - Knob.down.y) < 8) return;
    Knob.turning = true;
    Knob.drag = S.volume;
    knobShow(true);
  }
  // Near the centre a tiny move swings the angle wildly, so ignore it.
  const r = Knob.el.getBoundingClientRect();
  if (Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) < r.width * 0.08) return;
  const a = knobAngle(e);
  let delta = a - Knob.last;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  Knob.last = a;
  Knob.drag = Math.max(0, Math.min(100, Knob.drag + delta / KNOB_SWEEP * 100));
  if (Math.round(Knob.drag) !== S.volume) setVolume(Knob.drag); // setVolume re-renders the knob
  else knobRender();
}
function knobUp(e, cancelled = false) {
  if (e.pointerId !== Knob.pointer) return;
  Knob.pointer = null;
  clearTimeout(Knob.reveal);
  const quick = performance.now() - Knob.down.t < 250;
  if (!cancelled && !Knob.turning && quick) toggleMute(); // a tap mutes
  Knob.turning = false;
  Knob.drag = null;
  knobShow(false);
  knobRender();
}
function knobFlash() {
  knobShow(true);
  clearTimeout(Knob.flash);
  Knob.flash = setTimeout(() => { if (Knob.pointer == null) knobShow(false); }, 800);
}
function knobKey(e) {
  const step = { ArrowUp: 2, ArrowRight: 2, ArrowDown: -2, ArrowLeft: -2, PageUp: 10, PageDown: -10 }[e.key];
  if (step) setVolume(S.volume + step);
  else if (e.key === 'Home') setVolume(0);
  else if (e.key === 'End') setVolume(100);
  else if (e.key === 'Enter' || e.key === ' ') toggleMute();
  else return;
  e.preventDefault();
  e.stopPropagation(); // the page's own shortcuts would seek on ← →
}
function knobRender() {
  if (!Knob.el) return;
  const v = Knob.drag ?? S.volume, muted = S.muted;
  Knob.el.style.setProperty('--turn', `${(KNOB_FROM + KNOB_SWEEP * v / 100 - 270).toFixed(1)}deg`);
  Knob.el.classList.toggle('muted', muted);
  Knob.el.setAttribute('aria-valuenow', Math.round(v));
  Knob.el.setAttribute('aria-valuetext', muted ? 'Muted' : `${Math.round(v)}%`);
  $('.knob-value', Knob.el).textContent = muted && Knob.drag == null ? 'Muted' : Math.round(v);
  Knob.ticks.forEach((l, i) => {
    const f = i / (Knob.ticks.length - 1), on = v > 0 && f <= v / 100 + 1e-6;
    l.classList.toggle('on', on);
    l.style.opacity = on ? (0.4 + 0.6 * f).toFixed(2) : '';
  });
}
function knobBoot() {
  const k = Knob.el = $('#knob'), ring = $('.knob-ring', k), ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i <= 40; i++) {
    const a = (KNOB_FROM + KNOB_SWEEP * i / 40) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', (50 + c * 42.5).toFixed(2)); l.setAttribute('y1', (50 + s * 42.5).toFixed(2));
    l.setAttribute('x2', (50 + c * 48).toFixed(2)); l.setAttribute('y2', (50 + s * 48).toFixed(2));
    ring.append(l); Knob.ticks.push(l);
  }
  k.addEventListener('pointerdown', knobDown);
  k.addEventListener('pointermove', knobMove);
  k.addEventListener('pointerup', (e) => knobUp(e));
  k.addEventListener('pointercancel', (e) => knobUp(e, true));
  k.addEventListener('wheel', (e) => { e.preventDefault(); setVolume(S.volume + (e.deltaY < 0 ? 2 : -2)); knobFlash(); }, { passive: false });
  k.addEventListener('keydown', knobKey);
  knobRender();
}

/* ---------- boot / sync (called by app.js) ---------- */
// Cheap enough to call often: re-presses the record when the song changes and wakes the motor.
function deckSync() {
  if (!Deck.el) return;
  const t = S.queue[S.index], key = t ? (t.src || 'yt') + t.id : '';
  if (key !== Deck.track) {
    Deck.track = key;
    $('#lcdSrc').textContent = !t ? '' : t.src === 'sp' ? 'Spotify' : 'YouTube';
    deckPress();
  }
  Deck.el.classList.toggle('lamp', phase !== 'idle');
  deckWake();
}
function deckBoot() {
  Deck.el = $('#deck'); Deck.stage = $('.stage'); Deck.disc = $('#disc'); Deck.vinyl = $('#vinyl');
  Deck.sheen = $('#sheen'); Deck.arm = $('#arm'); Deck.shadow = $('#armShadow'); Deck.strobes = $$('.strobe');
  Deck.track = null;
  const ro = new ResizeObserver(deckResize);
  ro.observe(Deck.stage); ro.observe(Deck.el);
  deckResize();
  for (const hit of $$('.arm-hit')) {
    hit.addEventListener('pointerdown', armDown);
    hit.addEventListener('pointermove', armMove);
    hit.addEventListener('pointerup', (e) => armUp(e));
    hit.addEventListener('pointercancel', (e) => armUp(e, true));
  }
  window.addEventListener('pointermove', deckLight, { passive: true });
  knobBoot();
  deckSync();
}
