// Listas guardadas y la cola, guardadas en la cuenta (tabla «playlists» de Supabase).
//
// También se guarda una copia en el teléfono: sin internet se sigue viendo todo, y lo que se cambie
// sin red se sube al volver la conexión. La cola actual es la lista especial «__cola__», que no se muestra:
// se guarda sola cada vez que cambia y al abrir la app (o entrar desde otro teléfono) se recupera.
import { S, $, esc, bus, emit, log } from './state.js';
import { addTracks } from './library.js';
import { account, cloudReady, rest } from './auth.js';
import { stop } from './mixer.js';

const QUEUE = '__cola__';
let user = null;           // correo de la cuenta abierta (la copia del teléfono es por cuenta)
let lists = {};            // nombre → { tracks, at, dirty }  (dirty = cambiado aquí, falta subirlo)
let gone = [];             // borradas aquí que falta borrar en la cuenta
let cloud = 'wait';        // 'ok' | 'offline' | 'setup' (falta crear la tabla en Supabase) | 'wait'
let restored = false;      // la cola ya se recuperó: desde ahí se guarda sola

const KEY = () => 'adj_lists:' + user;
function keepLocal() {
  try { localStorage.setItem(KEY(), JSON.stringify({ lists, gone })); } catch {}
}
function readLocal() {
  try { const j = JSON.parse(localStorage.getItem(KEY()) || 'null'); lists = j && j.lists || {}; gone = j && j.gone || []; }
  catch { lists = {}; gone = []; }
}

// Lo que se guarda de cada canción: lo justo para volver a encontrarla en YouTube
const pack = tracks => tracks.filter(t => t.vid).map(t => {
  const o = { vid: t.vid, name: t.name };
  if (t.len || t.dur) o.len = Math.round(t.len || t.dur);
  if (t.genre) o.genre = t.genre;
  if (t.url) o.url = t.url;
  return o;
});

// ---------- Sincronizar con la cuenta ----------
function fail(err) {
  cloud = err.offline ? 'offline' : (err.status === 404 || /PGRST20|42P01/.test(err.code || '')) ? 'setup' : 'offline';
  paintLists();
}
async function push(name) {
  const l = lists[name];
  if (!l || !cloudReady()) return;
  try {
    await rest('playlists?on_conflict=user_id,name', {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      body: { name, tracks: l.tracks, updated_at: new Date(l.at).toISOString() }
    });
    l.dirty = false; cloud = 'ok';
    keepLocal(); paintLists();
  } catch (err) { fail(err); }
}
async function drop(name) {
  try {
    await rest('playlists?name=eq.' + encodeURIComponent(name), { method: 'DELETE', prefer: 'return=minimal' });
    gone = gone.filter(n => n !== name); cloud = 'ok';
    keepLocal(); paintLists();
  } catch (err) { fail(err); }
}

// La cuenta manda, salvo lo que se cambió en este teléfono sin conexión, que se sube
async function pull() {
  if (!cloudReady()) { cloud = 'offline'; return; }
  let rows;
  try { rows = await rest('playlists?select=name,tracks,updated_at'); }
  catch (err) { return fail(err); }
  cloud = 'ok';
  for (const n of gone) await drop(n);
  const mine = Object.entries(lists).filter(([, l]) => l.dirty);
  const next = {};
  for (const r of rows) if (!gone.includes(r.name)) next[r.name] = { tracks: r.tracks || [], at: Date.parse(r.updated_at) || 0, dirty: false };
  for (const [n, l] of mine) if (!next[n] || next[n].at < l.at) next[n] = l;
  lists = next;
  keepLocal();
  for (const [n, l] of Object.entries(lists)) if (l.dirty) await push(n);
}

function save(name, tracks) {
  lists[name] = { tracks, at: Date.now(), dirty: true };
  gone = gone.filter(n => n !== name);
  keepLocal(); paintLists();
  push(name);
}

// ---------- La cola se guarda sola ----------
let qTimer = 0, qSig = '';
function watchQueue() {
  if (!restored || !user) return;
  const tracks = pack(S.tracks), sig = tracks.map(t => t.vid).join(',');
  if (sig === qSig) return;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { qSig = sig; save(QUEUE, tracks); }, 3000);
}
function restoreQueue() {
  const q = lists[QUEUE];
  qSig = q ? q.tracks.map(t => t.vid).join(',') : '';
  if (q && q.tracks.length && !S.tracks.length) {
    const n = addTracks(q.tracks);
    if (n) log('Recuperé tu cola: ' + n + ' canciones. Pulsa Reproducir en la Cabina.');
  }
  restored = true;
  watchQueue();   // si ya había canciones antes de recuperar, se guardan
}

async function login() {
  user = account();
  if (!user) return;
  readLocal();
  paintLists();
  await pull();
  restoreQueue();
  paintLists();
}
function logout() {
  clearTimeout(qTimer);
  user = null; lists = {}; gone = []; restored = false; qSig = ''; cloud = 'wait';
  paintLists();
}

// ---------- Usar una lista ----------
// «Cargar»: la lista reemplaza la cola. Lo que está sonando sigue y después entra la lista.
function loadList(name) {
  const l = lists[name];
  if (!l) return;
  const playing = [S.cur && S.cur.t, S.mix && S.mix.nd.t].filter(Boolean);
  S.tracks = S.tracks.filter(t => playing.includes(t));
  if (!playing.length && S.cue) stop('Cargando la lista');
  S.cue = null;
  const n = addTracks(l.tracks);
  emit();
  log('Lista «' + name + '» cargada: ' + n + ' canciones' + (playing.length ? '. Entra después de la que suena.' : '. Pulsa Reproducir en la Cabina.'));
}
function appendList(name) {
  const l = lists[name];
  if (!l) return;
  const n = addTracks(l.tracks);
  log(n ? 'Agregué ' + n + ' canciones de «' + name + '» a la cola.' : 'Todas las canciones de «' + name + '» ya estaban en la cola.');
}
function removeList(name) {
  delete lists[name];
  if (!gone.includes(name)) gone.push(name);
  keepLocal(); paintLists();
  drop(name);
  log('Lista «' + name + '» borrada.');
}

// ---------- Pantalla ----------
const ago = at => {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'ahora';
  if (m < 60) return 'hace ' + m + ' min';
  if (m < 1440) return 'hace ' + Math.round(m / 60) + ' h';
  return new Date(at).toLocaleDateString('es', { day: 'numeric', month: 'short' });
};
const SYNC = {
  ok: 'Guardadas en tu cuenta: las verás en cualquier teléfono donde entres.',
  offline: 'Sin conexión: se guardan en este teléfono y se suben a tu cuenta al volver internet.',
  setup: 'Por ahora solo se guardan en este teléfono (falta activar las listas en la cuenta).',
  wait: ''
};
let confirmName = null, confirmTimer = 0;
export function paintLists() {
  const names = Object.keys(lists).filter(n => n !== QUEUE).sort((a, b) => lists[b].at - lists[a].at);
  $('#lsCnt').textContent = names.length ? '· ' + names.length : '';
  $('#lsSync').textContent = SYNC[cloud];
  $('#lsList').innerHTML = names.length ? names.map(n => {
    const l = lists[n], sure = confirmName === n;
    return `<li data-n="${esc(n)}"><div class="t"><b>${esc(n)}</b><small>${l.tracks.length} canciones · ${ago(l.at)}${l.dirty && cloud !== 'setup' ? ' · sin subir' : ''}</small></div>` +
      `<span class="ops"><button data-a="load" class="ls-load" aria-label="Cargar «${esc(n)}» en la cola">▶</button>` +
      `<button data-a="add" aria-label="Agregar «${esc(n)}» a la cola">＋</button>` +
      `<button data-a="del" class="${sure ? 'sure' : ''}" aria-label="Borrar «${esc(n)}»">${sure ? '¿Borrar?' : '✕'}</button></span></li>`;
  }).join('') : '<li class="empty">Aún no tienes listas. Arma una cola en «Música» y guárdala arriba con un nombre.</li>';
}

export function initLists() {
  bus.addEventListener('login', login);
  bus.addEventListener('logout', logout);
  bus.addEventListener('change', watchQueue);
  addEventListener('online', () => { if (user) pull().then(paintLists); });

  const saveNow = () => {
    const name = $('#lsName').value.trim().slice(0, 40);
    if (!name || name === QUEUE) return log('Escribe un nombre para la lista', true);
    const tracks = pack(S.tracks);
    if (!tracks.length) return log('La cola está vacía: agrega canciones en «Música» antes de guardarla.', true);
    const had = !!lists[name];
    save(name, tracks);
    $('#lsName').value = '';
    log((had ? 'Lista «' + name + '» actualizada' : 'Lista «' + name + '» guardada') + ' con ' + tracks.length + ' canciones.');
  };
  $('#lsSave').onclick = saveNow;
  $('#lsName').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); saveNow(); } };

  $('#lsList').onclick = e => {
    const b = e.target.closest('button[data-a]'), li = e.target.closest('li[data-n]');
    if (!li) return;
    const name = li.dataset.n;
    if (!b) { $('#lsName').value = name; return; }   // tocar el nombre lo deja listo para sobrescribir
    if (b.dataset.a === 'load') loadList(name);
    if (b.dataset.a === 'add') appendList(name);
    if (b.dataset.a === 'del') {
      clearTimeout(confirmTimer);
      if (confirmName === name) { confirmName = null; removeList(name); return; }
      confirmName = name; paintLists();
      confirmTimer = setTimeout(() => { confirmName = null; paintLists(); }, 3000);
    }
  };
  paintLists();
}
