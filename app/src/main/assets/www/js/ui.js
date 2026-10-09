// Interfaz: consola (decks, onda, crossfader), ambiente y lista de reproducción.
import { S, SCENES, $, $$, esc, fmt, fold, clamp, bus, emit, log } from './state.js';
import { ensure, setVolume } from './audio.js';
import { addFiles, removeTrack, moveTrack, autoSort, scanAll, isScanning } from './library.js';
import { cue, togglePlay, skip, seek, stop, pos, isRunning } from './mixer.js';
import { drawSpectrum, fit } from './eq.js';

const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ---------- Lista ----------
function statusLine(t) {
  if (t.bad) return `<span class="err">No disponible${t.err ? ': ' + esc(t.err) : ''} · clic para reintentar</span>`;
  if (t.loading) return t.an ? 'cargando audio…' : (t.file ? 'analizando…' : 'descargando y analizando…');
  if (t.err) return `<span class="err">${esc(t.err)} · clic para reintentar</span>`;
  if (t.an) return fmt(t.dur) + ' · intro ' + Math.round(Math.max(0, t.drop - t.b0)) + ' s · final ' + Math.round(Math.max(0, t.end - t.out)) + ' s' + (t.weak ? ' · BPM incierto' : '');
  return (t.len ? fmt(t.len) + ' · ' : '') + (t.genre ? esc(t.genre) + ' · ' : '') + 'se analiza al acercarse su turno';
}
function row(t, i) {
  const cls = [S.cur && S.cur.t === t ? 'cur' : '', S.cue === t ? 'cue' : '', t.bad ? 'bad' : ''].join(' ');
  const link = t.url ? ` · <a href="${esc(t.url)}" target="_blank" rel="noopener" title="Abrir en YouTube Music">↗</a>` : '';
  return `<li data-i="${i}" class="${cls}"><span class="n">${i + 1}</span>` +
    `<div class="t" data-p="${i}" title="Clic para mezclar hacia esta canción"><b>${esc(t.name)}</b>` +
    `<small><span class="src">${t.file ? 'archivo' : 'YouTube'}</span>${statusLine(t)}${link}</small></div>` +
    `<span class="bpm">${t.bpm ? Math.round(t.bpm) : t.loading ? '…' : '—'}</span>` +
    `<span class="ops"><button data-u="${i}" aria-label="Subir">↑</button><button data-d="${i}" aria-label="Bajar">↓</button><button data-x="${i}" aria-label="Quitar">✕</button></span></li>`;
}
function renderList() {
  const raw = $('#q').value.trim(), q = fold(raw);
  const rows = S.tracks.map((t, i) => [t, i]).filter(([t]) => !q || fold(t.name).includes(q));
  $('#cnt').textContent = S.tracks.length ? '· ' + S.tracks.length + (q ? ' (mostrando ' + rows.length + ')' : '') : '';
  $('#list').innerHTML = rows.length ? rows.map(([t, i]) => row(t, i)).join('')
    : '<li class="empty">' + (S.tracks.length ? 'Ninguna canción coincide con «' + esc(raw) + '».' : 'Aún no hay canciones. Busca arriba y agrega las que quieras mezclar.') + '</li>';
  $('#scan').textContent = isScanning() ? 'Detener análisis' : 'Analizar todo';
}
function scrollToCurrent() {
  const sc = $('#sc'), li = sc.querySelector('li.cur');
  if (!li) return;
  const top = li.offsetTop, h = li.offsetHeight;
  if (top < sc.scrollTop || top + h > sc.scrollTop + sc.clientHeight)
    sc.scrollTo({ top: Math.max(0, top - sc.clientHeight / 2 + h / 2), behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth' });
}

// ---------- Consola ----------
let colors = null;
function drawWave() {
  const c = $('#wave');
  if (!fit(c)) return;
  const g = c.getContext('2d'), W = c.width, H = c.height, dpr = window.devicePixelRatio || 1, d = S.cur;
  g.clearRect(0, 0, W, H);
  if (!d || !d.t.wave) return;
  if (!colors) colors = [css('--a'), css('--b'), css('--bd')];
  const t = d.t, p = clamp(pos(d) / t.dur, 0, 1), n = t.wave.length, bw = 3 * dpr, N = Math.floor(W * Math.min(1, t.waveDur / t.dur) / bw);
  // Zonas de mezcla: intro (antes del golpe) y final (después del punto de salida)
  g.fillStyle = 'rgba(255,255,255,.06)';
  g.fillRect(t.start / t.dur * W, 0, (t.drop - t.start) / t.dur * W, H);
  g.fillRect(t.out / t.dur * W, 0, (t.end - t.out) / t.dur * W, H);
  for (let i = 0; i < N; i++) {
    const h = Math.max(2 * dpr, t.wave[Math.floor(i / N * n)] / 100 * (H - 10 * dpr)), x = i * bw;
    g.fillStyle = x / W < p ? colors[d.side] : colors[2];
    g.fillRect(x, (H - h) / 2, bw - dpr, h);
  }
  g.fillStyle = '#fff';
  g.fillRect(p * W - dpr, 0, 2 * dpr, H);
}

let shown = null;
export function paint() {
  const run = isRunning(), cur = S.cur, mix = S.mix;
  setText($('#play'), run ? '⏸ Pausa' : '▶ ' + (cur ? 'Continuar' : 'Reproducir'));
  const decks = { A: null, B: null };
  for (const d of [cur, mix && mix.nd]) if (d) decks[d.side ? 'B' : 'A'] = d;
  for (const s of ['A', 'B']) {
    const d = decks[s], el = $('#d' + s);
    el.classList.toggle('loaded', !!d);
    el.classList.toggle('playing', !!d && run && S.ctx.currentTime >= d.at);
    setText($('#n' + s), d ? d.t.name : 'Deck ' + s);
    setText($('#m' + s), d ? Math.round(d.t.bpm * d.rate) + ' BPM' + (d.rate !== 1 ? ' (' + (d.rate > 1 ? '+' : '') + ((d.rate - 1) * 100).toFixed(1) + '%)' : '') : '—');
  }
  setText($('#status'), mix ? 'Mezclando' : cur ? (run ? 'Sonando' : 'En pausa') : S.cue ? 'Cargando…' : 'Sin reproducir');
  setText($('#time'), cur ? fmt(Math.max(0, pos(cur))) + ' / ' + fmt(cur.t.dur) : '0:00 / 0:00');
  let x = cur ? cur.side : .5;
  if (mix) { const k = clamp((S.ctx.currentTime - mix.at) / mix.dur, 0, 1); x = mix.o.side + (mix.nd.side - mix.o.side) * k; }
  $('#xf').style.left = x * 100 + '%';
  const now = cur ? cur.t : null;
  if (now !== shown) { shown = now; renderList(); scrollToCurrent(); }
  drawSpectrum();
  drawWave();
}

// ---------- Eventos ----------
function setScene(k) {
  const sc = SCENES[k];
  S.scene = k; S.mixT = sc.mix; S.sync = sc.sync;
  $('#mixT').value = sc.mix; $('#mixT').disabled = !!sc.auto;
  $('#sync').checked = sc.sync;
  $('#mixV').textContent = sc.auto ? 'auto' : sc.mix + ' s';
  $('#sceneD').textContent = sc.d + '.';
  $$('#scenes button').forEach(b => b.classList.toggle('on', b.dataset.s === k));
}

export function initUi() {
  let pending = false;
  bus.addEventListener('change', () => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; renderList(); }, 30);
  });

  // Transporte
  $('#play').onclick = togglePlay;
  $('#skip').onclick = skip;
  $('#vol').oninput = e => setVolume(+e.target.value);
  setVolume(+$('#vol').value);
  $('#wave').onclick = e => { if (S.cur) seek(e.offsetX / e.currentTarget.clientWidth * S.cur.t.dur); };
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) return;
    e.preventDefault(); togglePlay();
  });

  // Ambiente
  $('#scenes').innerHTML = Object.entries(SCENES).map(([k, v]) => `<button class="chip mini" data-s="${k}" title="${v.d}">${v.n}</button>`).join('');
  $('#scenes').onclick = e => { const k = e.target.dataset.s; if (k) setScene(k); };
  $('#mixT').oninput = e => { S.mixT = +e.target.value; $('#mixV').textContent = e.target.value + ' s'; };
  $('#sync').onchange = e => S.sync = e.target.checked;
  $('#loop').onchange = e => S.loop = e.target.checked;
  setScene(S.scene);

  // Archivos
  $('#file').onchange = e => { ensure(); addFiles([...e.target.files]); e.target.value = ''; };
  const dz = $('#drop');
  ['dragover', 'dragenter'].forEach(v => dz.addEventListener(v, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(v => dz.addEventListener(v, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', e => { ensure(); addFiles([...e.dataTransfer.files]); });

  // Lista
  $('#list').onclick = e => {
    if (e.target.closest('a')) return;
    const b = e.target.closest('button'), t = e.target.closest('[data-p]');
    if (t) return cue(S.tracks[+t.dataset.p]);
    if (!b) return;
    const { u, d, x } = b.dataset;
    if (u !== undefined) moveTrack(+u, -1);
    if (d !== undefined) moveTrack(+d, 1);
    if (x !== undefined) removeTrack(S.tracks[+x]);
  };
  $('#q').oninput = renderList;
  $('#sort').onclick = autoSort;
  $('#scan').onclick = () => { ensure(); scanAll(); };
  let confirmTimer = 0;
  $('#clear').onclick = e => {
    const b = e.currentTarget;
    if (!confirmTimer) { b.textContent = '¿Seguro?'; confirmTimer = setTimeout(() => { confirmTimer = 0; b.textContent = 'Vaciar'; }, 3000); return; }
    clearTimeout(confirmTimer); confirmTimer = 0; b.textContent = 'Vaciar';
    if (isScanning()) scanAll();
    S.tracks = [];
    if (S.cur || S.mix || S.cue) stop('Lista vaciada'); else { emit(); log('Lista vaciada'); }
  };

  renderList();
}
