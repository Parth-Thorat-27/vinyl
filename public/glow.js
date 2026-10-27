'use strict';

/* =========================================================================
   The glow: a full-screen WebGL fireside behind the whole app. Warm smoke
   drifting up, embers catching on its ridges, a hearth glow behind the
   turntable and a few sparks, in the album's warm accent.
   It follows the music in two ways:
   - Always: playing, paused, the volume knob, and every record that drops.
   - When you let it listen (this tab's sound, or the microphone): the bass
     makes the embers flare and the hearth thump, mids stir the smoke and
     highs throw sparks. Browsers won't let a page hear YouTube or Spotify
     directly, so this is opt-in, explained first, and nothing is recorded.
   Loaded before app.js; app.js calls glowBoot(), deck.js calls glowKick().
   ========================================================================= */

const GLOW_VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const GLOW_FRAG = `
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uMouse;   /* canvas px, y-up */
uniform vec2  uFocus;   /* the turntable's platter, canvas px, y-up */
uniform float uHeat;    /* playing, volume, record drops */
uniform float uBass;    /* 0..1 */
uniform float uMid;
uniform float uHigh;
uniform float uKick;    /* a beat landing, decays */
uniform vec3  uAccent;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, amp = 0.5;
  mat2 rot = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) { v += amp * vnoise(p); p = rot * p; amp *= 0.5; }
  return v;
}

void main() {
  float mn = min(uRes.x, uRes.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / mn;
  vec2 c = (uFocus - 0.5 * uRes) / mn;
  vec2 m = (uMouse - 0.5 * uRes) / mn;
  float t = uTime * 0.06;

  /* Air stirred by the platter: the smoke turns gently around the turntable. */
  vec2 d = p - c;
  float r = length(d);
  float sw = exp(-r * 1.5) * (0.5 + 0.9 * uMid) * sin(t * 0.7 + r * 2.0) * 0.6;
  vec2 ps = c + mat2(cos(sw), -sin(sw), sin(sw), cos(sw)) * d;

  /* Domain-warped smoke, rising like heat. */
  float rise = t * (1.0 + 0.8 * uMid);
  vec2 q = vec2(fbm(ps * 1.6 + vec2(0.0, -rise)), fbm(ps * 1.6 + vec2(4.7, -rise * 0.8)));
  vec2 w = vec2(
    fbm(ps * 1.6 + 2.3 * q + vec2(1.7, 9.2) + vec2(t * 0.4, -rise * 0.5)),
    fbm(ps * 1.6 + 2.3 * q + vec2(8.3, 2.8) - vec2(t * 0.3, rise * 0.4))
  );
  w -= (p - m) * exp(-length(p - m) * 2.6) * 0.35; /* it leans toward the cursor */
  float f = fbm(ps * 1.6 + 2.1 * w);

  float near = exp(-r * 1.1);
  float heat = uHeat * (0.5 + 0.5 * near) + uKick * 0.5 + uBass * 0.35;

  vec3 base = vec3(0.067, 0.047, 0.035); /* espresso, #110c09 */
  vec3 col = base;

  /* The warped noise lives between about 0.18 and 0.62 (measured), so the
     thresholds below are set to that range, not to 0..1. */

  /* Cream smoke */
  float fn = smoothstep(0.18, 0.62, f);
  col += vec3(1.0, 0.84, 0.64) * fn * fn * 0.21 * (0.35 + 0.65 * heat);

  /* Embers: hot patches on the ridges, and thin glowing veins along one contour
     of the smoke, like the edge of burning paper. Both catch more on the beat. */
  float v = f * (0.6 + 0.4 * q.x);
  float hot = smoothstep(0.34 - 0.06 * uBass - 0.05 * uKick, 0.52, v);
  float vein = smoothstep(0.03, 0.0, abs(v - (0.41 - 0.04 * uBass))) * smoothstep(0.15, 0.5, fn);
  vec3 ember = mix(uAccent, vec3(1.0, 0.7, 0.34), 0.3);
  col += ember * (hot * hot * 0.62 + vein * (0.38 + 0.3 * uKick)) * heat;

  /* Deep red in the folds */
  float fold = smoothstep(0.25, 0.65, q.y);
  col += vec3(0.42, 0.13, 0.04) * fold * fold * 0.3 * heat;

  /* A hearth glow behind the turntable that breathes with the bass */
  col += uAccent * exp(-r * r * 1.6) * (0.09 + 0.16 * uBass + 0.12 * uKick) * (0.35 + 0.65 * uHeat);

  /* Sparks drifting up, more of them with the highs */
  vec2 sp = p * 26.0 - vec2(0.0, uTime * 1.4);
  vec2 cell = floor(sp);
  float h = hash(cell);
  vec2 jit = vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5;
  float spark = step(0.988 - 0.022 * uHigh, h) * smoothstep(0.13, 0.0, length(fract(sp) - 0.5 + jit * 0.6));
  spark *= 0.5 + 0.5 * sin(uTime * 5.0 + h * 40.0);
  col += vec3(1.0, 0.7, 0.36) * spark * (0.2 + 0.9 * uHigh) * uHeat * (0.35 + 0.65 * near);

  /* Edges settle back to espresso */
  float vig = smoothstep(1.8, 0.2, length(p - c * 0.4));
  col = mix(base * 0.85, col, vig);

  /* Dither against banding */
  col += (hash(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

const Glow = {
  canvas: null, gl: null, uni: null, scale: 0.5,
  clock: 0, last: 0, frames: 0, slow: 0, degraded: false,
  mouse: [0, 0], aim: [0, 0], focus: [0, 0], focusAt: 0, accent: [1, 0.55, 0.25], accentAt: 0,
  heat: 0.3, burst: 0, bass: 0, mid: 0, high: 0, kick: 0,
  // listening
  stream: null, ac: null, source: null, analyser: null, bins: null, peaks: [0.1, 0.1, 0.1], bassAvg: 0, lastKick: 0,
};

/* ---------- WebGL ---------- */
function glowSetup() {
  const canvas = Glow.canvas = $('#glow');
  const gl = canvas?.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl) { canvas?.remove(); return false; }
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = compile(gl.VERTEX_SHADER, GLOW_VERT), fs = compile(gl.FRAGMENT_SHADER, GLOW_FRAG);
  if (!vs || !fs) { canvas.remove(); return false; }
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { canvas.remove(); return false; }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one big triangle
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  Glow.gl = gl;
  Glow.uni = Object.fromEntries(['uRes', 'uTime', 'uMouse', 'uFocus', 'uHeat', 'uBass', 'uMid', 'uHigh', 'uKick', 'uAccent']
    .map((n) => [n, gl.getUniformLocation(prog, n)]));
  // The smoke is soft by nature, so it renders at reduced resolution.
  Glow.scale = 0.5 * Math.min(devicePixelRatio || 1, 1.5);
  return true;
}
function glowResize() {
  const c = Glow.canvas;
  c.width = Math.max(2, Math.round(innerWidth * Glow.scale));
  c.height = Math.max(2, Math.round(innerHeight * Glow.scale));
  Glow.gl.viewport(0, 0, c.width, c.height);
  Glow.focusAt = 0;
}

// The accent is an animated CSS colour; a 1px canvas turns whatever form it's in into rgb.
let accentProbe;
function glowAccent() {
  accentProbe ||= document.createElement('canvas').getContext('2d');
  accentProbe.fillStyle = '#ff8c42';
  accentProbe.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff8c42';
  accentProbe.fillRect(0, 0, 1, 1);
  const [r, g, b] = accentProbe.getImageData(0, 0, 1, 1).data;
  Glow.accent = [r / 255, g / 255, b / 255];
}

/* ---------- what the music is doing ---------- */
function glowBand(lo, hi) {
  const hz = Glow.ac.sampleRate / Glow.analyser.fftSize, bins = Glow.bins;
  let sum = 0, n = 0;
  for (let i = Math.max(1, Math.floor(lo / hz)); i <= Math.min(bins.length - 1, Math.ceil(hi / hz)); i++) { sum += bins[i]; n++; }
  return n ? sum / n / 255 : 0;
}
function glowHear(now, dt) {
  const k = Math.min(1, dt * 60); // per-frame rates, steady at any frame rate
  if (Glow.analyser) {
    Glow.analyser.getByteFrequencyData(Glow.bins);
    // Each band is measured against its own recent peak, so quiet rooms and loud tabs both move it.
    const raw = [glowBand(30, 150), glowBand(150, 2000), glowBand(2000, 8000)];
    const lvl = raw.map((v, i) => {
      Glow.peaks[i] = Math.max(v, Glow.peaks[i] * (1 - 0.004 * k), 0.06);
      return Math.min(1, v / Glow.peaks[i]);
    });
    const ease = (cur, v) => cur + (v - cur) * (v > cur ? 0.5 : 0.12) * k;
    Glow.bass = ease(Glow.bass, lvl[0]);
    Glow.mid = ease(Glow.mid, lvl[1]);
    Glow.high = ease(Glow.high, lvl[2]);
    // A kick: the bass jumping well above where it's been sitting.
    Glow.bassAvg += (lvl[0] - Glow.bassAvg) * 0.06 * k;
    if (lvl[0] - Glow.bassAvg > 0.2 && now - Glow.lastKick > 180) { Glow.kick = 1; Glow.lastKick = now; }
  } else {
    // Not listening: the glow only knows whether music is playing, so it breathes.
    const on = phase === 'playing' ? 1 : 0, c = Glow.clock;
    Glow.bass += ((0.3 + 0.14 * Math.sin(c * 0.9) + 0.06 * Math.sin(c * 2.3)) * on - Glow.bass) * 0.03 * k;
    Glow.mid += ((0.38 + 0.1 * Math.sin(c * 0.6 + 1)) * on - Glow.mid) * 0.03 * k;
    Glow.high += (0.32 * on - Glow.high) * 0.03 * k;
  }
  Glow.kick *= Math.pow(0.9, k);
  Glow.burst *= Math.pow(0.975, k);
  // Heat: warm embers at rest, a fire when playing, scaled by the volume knob.
  const vol = S.muted ? 0 : S.volume / 100;
  const want = phase === 'playing' ? 0.55 + 0.45 * vol : phase === 'loading' ? 0.55 : phase === 'paused' ? 0.38 : 0.3;
  Glow.heat += (want - Glow.heat) * 0.02 * k;
}

function glowFrame(now) {
  requestAnimationFrame(glowFrame);
  const dt = Math.min(0.1, Math.max(0, (now - Glow.last) / 1000));
  Glow.last = now;
  const calm = deckCalm.matches;
  Glow.frames++;
  if (calm && Glow.frames % 30) return; // reduced motion: a still fire, redrawn twice a second

  // Adaptive quality: if frames keep running long, drop the resolution once.
  if (!Glow.degraded && Glow.frames > 90) {
    if (dt > 0.027) { if (++Glow.slow > 45) { Glow.degraded = true; Glow.scale *= 0.65; glowResize(); } }
    else if (Glow.slow) Glow.slow--;
  }

  glowHear(now, dt);
  if (!calm) Glow.clock += dt * (1 + 0.6 * Glow.mid);
  if (now > Glow.accentAt) { glowAccent(); Glow.accentAt = now + 400; }
  if (now > Glow.focusAt && Deck.geo) {
    const f = discCircle();
    Glow.focus = [f.x * Glow.scale, Glow.canvas.height - f.y * Glow.scale];
    Glow.focusAt = now + 1000;
  }
  Glow.mouse[0] += (Glow.aim[0] - Glow.mouse[0]) * 0.07;
  Glow.mouse[1] += (Glow.aim[1] - Glow.mouse[1]) * 0.07;

  const gl = Glow.gl, u = Glow.uni, c = Glow.canvas;
  gl.uniform2f(u.uRes, c.width, c.height);
  gl.uniform1f(u.uTime, Glow.clock);
  gl.uniform2f(u.uMouse, Glow.mouse[0] * Glow.scale, c.height - Glow.mouse[1] * Glow.scale);
  gl.uniform2f(u.uFocus, Glow.focus[0], Glow.focus[1]);
  gl.uniform1f(u.uHeat, Math.min(1.6, Glow.heat + Glow.burst));
  gl.uniform1f(u.uBass, Glow.bass);
  gl.uniform1f(u.uMid, Glow.mid);
  gl.uniform1f(u.uHigh, Glow.high);
  gl.uniform1f(u.uKick, Glow.kick);
  gl.uniform3f(u.uAccent, ...Glow.accent);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// A record landing, or the needle dropping: the fire flares up for a moment.
function glowKick(strength = 1) {
  Glow.burst = Math.max(Glow.burst, strength);
}

/* ---------- listening (opt-in) ---------- */
const canHearTab = () => !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
const canHearMic = () => !!navigator.mediaDevices?.getUserMedia;

async function glowListen(kind) {
  glowStopListening(true);
  let stream;
  try {
    stream = kind === 'tab'
      ? await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 }, audio: true,
        preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', systemAudio: 'exclude',
      })
      : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (err) {
    toast(err?.name === 'NotAllowedError' ? 'No problem. The glow will keep following the player.' : "Couldn't start listening on this browser.");
    return;
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    toast('No sound was shared. Try again and keep "Share tab audio" turned on.', 5000);
    return;
  }
  // Only the sound is used. A tab share also carries a 1 fps picture; it stays open
  // because some browsers end the sound along with it.
  Glow.ac ||= new AudioContext();
  await Glow.ac.resume();
  const an = Glow.analyser = Glow.ac.createAnalyser();
  an.fftSize = 2048;
  an.smoothingTimeConstant = 0.55;
  Glow.bins = new Uint8Array(an.frequencyBinCount);
  Glow.source = Glow.ac.createMediaStreamSource(stream);
  Glow.source.connect(an); // measured only: never sent to the speakers, never recorded
  Glow.stream = stream;
  Glow.peaks = [0.1, 0.1, 0.1];
  // "Stop sharing" in the browser's own bar ends the tracks.
  for (const t of stream.getTracks()) t.addEventListener('ended', () => glowStopListening());
  $('#btnListen').setAttribute('aria-pressed', 'true');
  toast(kind === 'tab' ? 'The glow is listening to this tab.' : 'The glow is listening through the microphone.');
}
function glowStopListening(quiet) {
  if (!Glow.stream) return;
  Glow.stream.getTracks().forEach((t) => t.stop());
  Glow.source?.disconnect();
  Glow.stream = Glow.analyser = Glow.source = null;
  $('#btnListen').setAttribute('aria-pressed', 'false');
  if (!quiet) toast('The glow stopped listening.');
}

/* ---------- boot (called by app.js) ---------- */
function glowBoot() {
  if (glowSetup()) {
    glowResize();
    addEventListener('resize', glowResize);
    Glow.aim = [innerWidth / 2, innerHeight / 2];
    Glow.mouse = [...Glow.aim];
    addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') Glow.aim = [e.clientX, e.clientY]; }, { passive: true });
    requestAnimationFrame((now) => { Glow.last = now; glowFrame(now); });
  }

  // The listen button only shows where a browser can actually hear something.
  const btn = $('#btnListen'), d = $('#listenDialog');
  if (!window.isSecureContext || !(canHearTab() || canHearMic()) || !Glow.gl) return;
  btn.hidden = false;
  $('#btnListenTab').hidden = !canHearTab();
  $('#btnListenMic').hidden = !canHearMic();
  btn.addEventListener('click', () => (Glow.stream ? glowStopListening() : d.showModal()));
  $('#btnCloseListen').addEventListener('click', () => d.close());
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  $('#btnListenTab').addEventListener('click', () => { d.close(); glowListen('tab'); });
  $('#btnListenMic').addEventListener('click', () => { d.close(); glowListen('mic'); });
}
