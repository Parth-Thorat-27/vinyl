'use strict';

/* =========================================================================
   The crate: every song in the queue is a record standing in it.
   Hover (or focus) a sleeve to pull it out for a look; click it and the record
   flies onto the turntable (deck.js) and plays. While the queue is empty the
   crate holds three demo records, so there's always something to try.
   Loaded before app.js; app.js calls renderCrate() whenever the queue changes,
   crateMeta() when a song's title arrives, and crateBoot() once.
   ========================================================================= */

const DEMO_RECORDS = [
  { id: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', artist: 'Queen' },
  { id: 'OPf0YbXqDm0', title: 'Uptown Funk', artist: 'Mark Ronson ft. Bruno Mars' },
  { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', artist: 'Rick Astley' },
];

const Crate = { list: null, preview: null, shown: null, hideTimer: null, lastIndex: null, slide: null };
const crateDemo = () => !S.queue.length && !roomActive();
const crateTracks = () => (crateDemo() ? DEMO_RECORDS : S.queue);
const recordKey = (t) => (t.src || 'yt') + t.id;

/* ---------- the sleeves ---------- */
function sleeve(t, i, demo) {
  const on = !demo && i === S.index, art = artUrl(t);
  const by = trackArtist(t) ? ` by ${trackArtist(t)}` : '';
  const el = h('button', {
    class: 'sleeve' + (on ? ' on-deck' : ''), 'data-i': i, 'data-key': recordKey(t),
    'data-vid': t.src === 'sp' ? null : t.id,
    'aria-label': on ? `On the turntable: ${trackTitle(t)}${by}` : `Play ${trackTitle(t)}${by}`,
  },
  art ? h('img', { src: art, alt: '', loading: 'lazy', decoding: 'async' }) : null,
  h('span', { class: 'sleeve-no', text: String(i + 1).padStart(2, '0') }),
  h('span', { class: 'sleeve-title', text: trackTitle(t) }));
  if (t.src !== 'sp' && !t.title && !meta[t.id]) metaObserver.observe(el);
  return el;
}

function renderCrate() {
  const list = $('#crateList');
  if (!list) return;
  const demo = crateDemo(), tracks = crateTracks();
  crateHide();
  list.replaceChildren();
  list.classList.toggle('demo', demo);
  $('#crateCount').textContent = demo ? '· demo' : `· ${tracks.length}`;
  const frag = document.createDocumentFragment();
  tracks.forEach((t, i) => frag.append(sleeve(t, i, demo)));
  list.append(frag);
  if (demo) list.append(h('p', { class: 'crate-note', text: 'Three demo records to try. Add your own in Library and they take their place.' }));
  // Keep the record that's on the turntable in view when it changes.
  if (!demo && S.index !== Crate.lastIndex) $('.sleeve.on-deck', list)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  Crate.lastIndex = demo ? null : S.index;
}

// A title arrived for a pasted song: print it on its spine.
function crateMeta(id) {
  for (const el of $$(`.sleeve[data-vid="${id}"] .sleeve-title`)) el.textContent = meta[id].t;
  if (Crate.shown?.dataset.vid === id) crateShow(Crate.shown);
}

/* ---------- pulling a record out for a look ---------- */
function crateShow(el) {
  const t = crateTracks()[+el.dataset.i];
  if (!t) return;
  clearTimeout(Crate.hideTimer);
  const p = Crate.preview, art = artUrl(t);
  const on = !crateDemo() && +el.dataset.i === S.index;
  const img = $('.cp-sleeve', p);
  if (art) img.src = art; else img.removeAttribute('src');
  $('.mini-label', p).style.backgroundImage = art ? `url("${art}")` : '';
  $('.cp-title', p).textContent = trackTitle(t);
  $('.cp-artist', p).textContent = trackArtist(t);
  $('.cp-hint', p).hidden = !on; // clicking to put it on goes without saying; only say it's already there
  p.classList.toggle('on-deck', on);

  // Beside the crate, level with the sleeve (above it when the crate runs sideways), kept on screen.
  const r = el.getBoundingClientRect(), box = Crate.list.getBoundingClientRect();
  const w = p.offsetWidth, ph = p.offsetHeight, side = box.height > box.width;
  const left = side ? box.left - w - 14 : r.left + r.width / 2 - w / 2;
  const top = side ? r.top + r.height / 2 - ph / 2 : box.top - ph - 12;
  p.style.left = `${Math.max(12, Math.min(innerWidth - w - 12, left))}px`;
  p.style.top = `${Math.max(12, Math.min(innerHeight - ph - 12, top))}px`;

  const fresh = Crate.shown !== el, open = p.classList.contains('show');
  if (fresh) Crate.shown?.classList.remove('peek');
  Crate.shown = el;
  el.classList.add('peek');
  p.classList.add('show');
  // Opening the preview slides the record out (CSS). Moving on to another sleeve while it's open
  // slides the new one out of its own sleeve too: back inside, then out to where the CSS puts it.
  if (fresh && open && !deckCalm.matches) {
    Crate.slide?.cancel();
    Crate.slide = $('.mini-record', p).animate([{ transform: 'none', offset: 0 }],
      { duration: 500, delay: 60, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'backwards' });
  }
}
function crateHide() {
  clearTimeout(Crate.hideTimer);
  Crate.shown?.classList.remove('peek');
  Crate.shown = null;
  Crate.preview?.classList.remove('show');
}
const crateHideSoon = () => { clearTimeout(Crate.hideTimer); Crate.hideTimer = setTimeout(crateHide, 160); };

/* ---------- putting it on ---------- */
function cratePlay(i, from) {
  crateHide();
  if (crateDemo()) {
    Deck.flyFrom = from;
    setQueue(DEMO_RECORDS.map((t) => ({ ...t })), i);
    return;
  }
  if (i === S.index) { togglePlay(); return; }
  if (roomIntercept('index', { i })) return;
  Deck.flyFrom = from;
  playIndex(i);
}
// Where a flying record starts or lands: a small record over the sleeve.
function circleOver(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, d: Math.min(r.width, r.height, 160) * (el.classList.contains('sleeve') ? 2.2 : 1) };
}

function crateBoot() {
  const list = Crate.list = $('#crateList'), p = Crate.preview = $('#cratePreview');
  const hover = matchMedia('(hover: hover) and (pointer: fine)');
  list.addEventListener('click', (e) => {
    const s = e.target.closest('.sleeve');
    if (s) cratePlay(+s.dataset.i, circleOver(s));
  });
  // The list runs to the bottom of the crate, so leaving it isn't enough: off a sleeve and onto
  // the empty space (or the gaps) puts the record back, unless the pointer reaches another sleeve first.
  list.addEventListener('pointerover', (e) => {
    const s = e.target.closest('.sleeve');
    if (s && hover.matches) crateShow(s);
    else if (Crate.shown) crateHideSoon();
  });
  list.addEventListener('pointerleave', crateHideSoon);
  list.addEventListener('focusin', (e) => { const s = e.target.closest('.sleeve'); if (s?.matches(':focus-visible')) crateShow(s); });
  list.addEventListener('focusout', crateHideSoon);
  list.addEventListener('scroll', crateHide, { passive: true });
  p.addEventListener('pointerenter', () => clearTimeout(Crate.hideTimer));
  p.addEventListener('pointerleave', crateHideSoon);
  p.addEventListener('click', () => {
    if (Crate.shown) cratePlay(+Crate.shown.dataset.i, circleOver($('.mini-record', p)));
  });
  renderCrate();
}
