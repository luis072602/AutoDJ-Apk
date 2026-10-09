// La lista de canciones: de dónde sale el audio de cada una, cuándo se carga y cuándo se libera.
//
// Una canción decodificada ocupa ~80 MB, así que solo se mantienen en memoria la que suena y las
// dos siguientes. El resto conserva su análisis (BPM, intro, final) y se vuelve a cargar al acercarse su turno.
import { S, SCENES, ready, emit, log } from './state.js';
import { ensure } from './audio.js';
import { analyze, META } from './analyze.js';
import { streamUrl } from './youtube.js';

// En celulares con poca memoria solo se adelanta una.
const AHEAD = navigator.deviceMemory && navigator.deviceMemory <= 4 ? 1 : 2;
const NET_PAUSE = 10000;   // tras un fallo de red no se insiste durante 10 s
let netFail = 0;
const online = () => Date.now() - netFail > NET_PAUSE;

// ---------- Análisis recordado entre sesiones (canciones de YouTube) ----------
let metaCache = {};
try { metaCache = JSON.parse(localStorage.getItem('adj_yt_meta') || '{}') || {}; } catch {}
function saveMeta(t) {
  if (!t.vid) return;
  metaCache[t.vid] = Object.fromEntries(META.map(k => [k, t[k]]));
  try { localStorage.setItem('adj_yt_meta', JSON.stringify(metaCache)); } catch {}
}

// vid = identificador del video en YouTube
export function makeTrack({ name, vid = null, file = null, len = null, bpm = null, genre = null, url = null }) {
  const t = { id: S.nid++, name, vid, file, len, bpm, genre, url, an: false, buffer: null, loading: null, bad: false, err: null };
  if (vid && metaCache[vid]) Object.assign(t, metaCache[vid], { an: true });
  return t;
}

// ---------- Carga ----------
async function fetchData(t) {
  if (t.file) return t.file.arrayBuffer();
  let r;
  try { r = await fetch(streamUrl(t.vid)); }
  catch { throw Object.assign(new Error('sin conexión'), { offline: true }); }
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    throw new Error(j && j.error || 'YouTube no entregó esta canción (' + r.status + ')');
  }
  return r.arrayBuffer();
}

// Trae el audio a memoria y, la primera vez, lo analiza. Nunca rechaza: si falla, marca la canción.
export function load(t) {
  if (ready(t)) return Promise.resolve(t);
  if (t.loading) return t.loading;
  ensure();
  t.loading = (async () => {
    try {
      t.buffer = await S.ctx.decodeAudioData(await fetchData(t));
      if (!t.an) { await analyze(t); saveMeta(t); }
      t.err = null;
    } catch (e) {
      t.buffer = null;
      t.err = e.message || 'no se pudo leer el audio';
      // Sin red no se descarta la canción; si falla dos veces habiendo red, es la canción y se salta
      if (e.offline) { netFail = Date.now(); t.fails = (t.fails || 0) + 1; }
      if (!e.offline || (t.fails >= 2 && navigator.onLine !== false)) t.bad = true;
    } finally {
      t.loading = null;
      emit();
    }
    return t;
  })();
  emit();
  return t.loading;
}

// ---------- Orden de reproducción ----------
const baseIdx = () => S.tracks.indexOf(S.cur ? S.cur.t : S.last);

export function upcoming(n) {
  const out = [], N = S.tracks.length, base = baseIdx(), now = S.cur && S.cur.t;
  for (let k = 1; k <= N && out.length < n; k++) {
    const i = base + k;
    if (i >= N && !S.loop) break;
    const t = S.tracks[i % N];
    if (!t.bad && t !== now && !out.includes(t)) out.push(t);
  }
  return out;
}
export const nextTrack = () => upcoming(1)[0] || null;

// Se llama varias veces por segundo: adelanta la carga de lo que viene y libera lo que ya no hace falta.
export function housekeeping() {
  if (!S.tracks.length) return;
  const next = upcoming(AHEAD);
  for (const t of next) if (!ready(t) && !t.loading && (t.file || online())) load(t);
  const keep = new Set([S.cur && S.cur.t, S.mix && S.mix.nd.t, S.mix && S.mix.o.t, S.cue, ...next]);
  for (const t of S.tracks) if (t.buffer && !t.loading && !keep.has(t)) t.buffer = null;
}

// ---------- Altas y bajas ----------
export async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('audio/') && !/\.(mp3|wav|m4a|ogg|flac|aac|opus|webm)$/i.test(f.name)) continue;
    const t = makeTrack({ name: f.name.replace(/\.[^.]+$/, ''), file: f });
    S.tracks.push(t); emit();
    await load(t);
    if (t.bad) {
      const k = S.tracks.indexOf(t);
      if (k >= 0) S.tracks.splice(k, 1);
      log('No pude leer «' + f.name + '»', true);
    }
    emit();
  }
}

// Suma canciones de YouTube a la lista (sin repetir las que ya están). Devuelve cuántas entraron.
export function addTracks(items) {
  const have = new Set(S.tracks.map(t => t.vid).filter(Boolean));
  const fresh = items.filter(it => !have.has(it.vid) && have.add(it.vid)).map(makeTrack);
  S.tracks.push(...fresh);
  emit();
  return fresh.length;
}
export const hasTrack = vid => S.tracks.some(t => t.vid === vid);

export function removeTrack(t) {
  if ((S.cur && S.cur.t === t) || (S.mix && (S.mix.nd.t === t || S.mix.o.t === t))) { log('No puedes quitar la canción que está sonando', true); return; }
  if (S.cue === t) S.cue = null;
  S.tracks.splice(S.tracks.indexOf(t), 1);
  emit();
}

export function moveTrack(i, d) {
  const j = i + d;
  if (j < 0 || j >= S.tracks.length) return;
  [S.tracks[i], S.tracks[j]] = [S.tracks[j], S.tracks[i]];
  emit();
}

// Reordena lo que queda por sonar según el ambiente. Las canciones sin analizar van al final.
export function autoSort() {
  const sc = SCENES[S.scene], s = sc.sort, usable = t => sc.by === 'energy' ? t.an : !!t.bpm;
  const ci = baseIdx(), head = S.tracks.slice(0, ci + 1), tail = S.tracks.slice(ci + 1);
  const rest = tail.filter(usable), raw = tail.filter(t => !usable(t));
  if (typeof s === 'function') rest.sort(s);
  else if (s === 'near' && rest.length) {
    // Encadena cada canción con la de BPM más cercano a la anterior
    const out = [];
    let last = head.length ? head[head.length - 1] : null;
    if (!last || !last.bpm) { rest.sort((a, b) => a.bpm - b.bpm); last = rest.shift(); out.push(last); }
    while (rest.length) { rest.sort((a, b) => Math.abs(a.bpm - last.bpm) - Math.abs(b.bpm - last.bpm)); last = rest.shift(); out.push(last); }
    rest.push(...out);
  }
  S.tracks = [...head, ...rest, ...raw];
  emit();
  log('Lista ordenada para: ' + sc.n + (raw.length ? ' · ' + raw.length + ' sin analizar quedaron al final (pulsa «Analizar todo»)' : ''));
}

// ---------- Analizar toda la lista (BPM medido, intro y final de cada canción) ----------
let scanning = false;
export const isScanning = () => scanning;
export async function scanAll() {
  if (scanning) { scanning = false; return; }
  const todo = S.tracks.filter(t => !t.an && !t.bad);
  if (!todo.length) { log('Toda la lista ya está analizada.'); return; }
  scanning = true; emit();
  let n = 0, offline = false;
  for (const t of todo) {
    if (!scanning) break;
    n++;
    if (!S.tracks.includes(t) || t.an) continue;
    log('Analizando ' + n + ' de ' + todo.length + ': «' + t.name + '»…');
    await load(t);
    if (!t.an && !t.bad) { offline = true; break; }
  }
  const left = S.tracks.filter(t => !t.an && !t.bad).length;
  if (offline) log('Sin conexión: el análisis se detuvo.', true);
  else if (left) log('Análisis detenido: faltan ' + left + ' canciones.');
  else log('Lista analizada. Ya puedes ordenarla para el ambiente.');
  scanning = false; emit();
}
