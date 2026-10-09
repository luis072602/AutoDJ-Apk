// Estado compartido y utilidades pequeñas que usan todos los módulos.

export const $ = s => document.querySelector(s);
export const $$ = s => [...document.querySelectorAll(s)];
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
export const fold = x => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const SCENES = {
  variado: { n: 'Variado (auto)', mix: 14, sync: true, auto: true, sort: 'near', d: 'Se adapta a cada canción: mide su intro y su final y ajusta el cruce' },
  fiesta: { n: 'Fiesta', mix: 16, sync: true, sort: (a, b) => a.bpm - b.bpm, d: 'Sube el ritmo poco a poco, cruces largos' },
  chill: { n: 'Chill / lounge', mix: 22, sync: false, sort: 'near', d: 'Canciones de BPM parecido, cruces suaves' },
  gym: { n: 'Entrenamiento', mix: 8, sync: true, sort: (a, b) => a.energy - b.energy, by: 'energy', d: 'De menos a más energía, cruces medios' },
  radio: { n: 'Corte rápido', mix: 4, sync: false, sort: null, d: 'Respeta tu orden, cruces cortos' }
};

export const S = {
  ctx: null, master: null, analyser: null,
  tracks: [],
  cur: null,       // deck que suena
  mix: null,       // cruce en curso: { nd, o, at, dur, end }
  cue: null,       // canción pedida que aún se está cargando
  last: null,      // última canción que sonó (para saber cuál sigue)
  scene: 'variado', mixT: 14, sync: true, loop: true,
  flip: 0, nid: 0
};

// Una canción está lista para mezclar cuando tiene el audio en memoria y ya fue analizada.
export const ready = t => !!(t && t.an && t.buffer);

// Aviso de «algo cambió en la lista»: la interfaz se vuelve a pintar.
export const bus = new EventTarget();
export const emit = () => bus.dispatchEvent(new Event('change'));

export function log(msg, warn = false) {
  const el = $('#log');
  el.textContent = msg;
  el.classList.toggle('warn', warn);
}
