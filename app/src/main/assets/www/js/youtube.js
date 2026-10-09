// YouTube: búsqueda y enlaces. Las rutas /api/… las atiende la propia app (YouTube.java),
// que busca y descarga el audio en el teléfono; por eso no hace falta ningún servidor.
import { $, esc, fmt, log } from './state.js';
import { addTracks, hasTrack } from './library.js';

const QUICK = ['Reggaeton', 'Corridos tumbados', 'Salsa', 'Vallenato', 'Bachata', 'Pop latino', 'Trap latino', 'Merengue', 'Rock en español', 'Electrónica'];
const MIN_LEN = 60, MAX_LEN = 480;   // fuera quedan los fragmentos y los sets largos (no caben en memoria)

export const streamUrl = id => '/api/audio?v=' + encodeURIComponent(id);

async function api(path, params) {
  const u = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let r;
  try { r = await fetch(u); }
  catch { throw new Error('Sin conexión, intenta de nuevo'); }
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(j && j.error || 'Error ' + r.status);
  return j;
}

// La duración puede venir desconocida (0 o negativa): esas se dejan pasar
const usable = it => it.vid && (!(it.len > 0) || (it.len >= MIN_LEN && it.len <= MAX_LEN));
const toItem = it => ({ vid: it.vid, name: it.name, len: it.len > 0 ? it.len : null, url: 'https://music.youtube.com/watch?v=' + it.vid });

let results = [], quick = null;

function render(title) {
  $('#resT').textContent = title || '';
  $('#addAll').hidden = !results.length;
  $('#resBox').hidden = !title;
  $('#res').innerHTML = results.length ? results.map((it, i) =>
    `<li class="${hasTrack(it.vid) ? 'in' : ''}"><div class="t" data-a="${i}" title="Agregar a la lista"><b>${esc(it.name)}</b>` +
    `<small>${it.len ? fmt(it.len) : ''}</small></div>` +
    `<span class="ops"><button data-a="${i}" aria-label="Agregar">${hasTrack(it.vid) ? '✓' : '+'}</button></span></li>`).join('')
    : '<li class="empty">Sin resultados que se puedan mezclar.</li>';
  document.querySelectorAll('#genres button').forEach(b => b.classList.toggle('on', b.dataset.g === quick));
}

async function show(title, job) {
  log('Buscando…');
  try {
    const j = await job();
    results = j.items.filter(usable).map(toItem);
    render(j.title ? '«' + j.title + '»' : title);
    const n = results.length;
    log(n ? (n === 1 ? '1 canción encontrada' : n + ' canciones encontradas') + '. Toca una para agregarla, o «Agregar todas».' : 'No encontré canciones que se puedan mezclar.');
  } catch (e) { log(e.message, true); }
}

function search(text) {
  const q = (text || $('#aq').value).trim();
  if (!q) return;
  quick = text || null;
  if (/^https?:\/\//i.test(q)) show('Enlace', () => api('/api/playlist', { url: q }));
  else show('Resultados de «' + q + '»', () => api('/api/search', { q }));
}

export function initYouTube() {
  $('#genres').innerHTML = QUICK.map(g => `<button class="chip mini" data-g="${esc(g)}">${esc(g)}</button>`).join('');
  $('#genres').onclick = e => { const g = e.target.dataset.g; if (g) search(g); };
  $('#ago').onclick = () => search();
  $('#aq').onkeydown = e => { if (e.key === 'Enter') { e.target.blur(); search(); } };
  $('#res').onclick = e => {
    const el = e.target.closest('[data-a]');
    if (!el) return;
    const it = results[+el.dataset.a];
    if (addTracks([it])) log('Agregada: «' + it.name + '»');
    render($('#resT').textContent);
  };
  $('#addAll').onclick = () => {
    const n = addTracks(results);
    log(n ? (n === 1 ? '1 canción agregada' : n + ' canciones agregadas') + ' a la lista. Pulsa Reproducir.' : 'Esas canciones ya estaban en la lista.');
    render($('#resT').textContent);
  };
}
