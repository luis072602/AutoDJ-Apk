// Cadena de salida: decks → master → ecualizador (5 bandas) → limitador → analizador → altavoces.
// Todo lo que suena pasa por aquí, venga de donde venga.
import { S, clamp } from './state.js';

export const BANDS = [
  { f: 60, t: 'lowshelf', l: '60' },
  { f: 230, t: 'peaking', q: 1, l: '230' },
  { f: 910, t: 'peaking', q: 1, l: '910' },
  { f: 3600, t: 'peaking', q: 1, l: '3,6k' },
  { f: 14000, t: 'highshelf', l: '14k' }
];

export const gains = [0, 0, 0, 0, 0];
try {
  const g = JSON.parse(localStorage.getItem('adj_eq') || 'null');
  if (Array.isArray(g) && g.length === 5) g.forEach((v, i) => gains[i] = clamp(Math.round(+v) || 0, -12, 12));
} catch {}

let filters = [];
let volume = .9;

export function ensure() {
  if (S.ctx) return;
  // En iPhone, sin esto el interruptor de silencio deja muda la página
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  const ctx = S.ctx = new (window.AudioContext || window.webkitAudioContext)();
  S.master = ctx.createGain();
  S.master.gain.value = volume;
  let node = S.master;
  filters = BANDS.map((b, i) => {
    const f = ctx.createBiquadFilter();
    f.type = b.t; f.frequency.value = b.f; f.gain.value = gains[i];
    if (b.q) f.Q.value = b.q;
    node.connect(f); node = f;
    return f;
  });
  // Limitador: evita saturar al subir bandas
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = .003; lim.release.value = .15;
  S.analyser = ctx.createAnalyser();
  S.analyser.fftSize = 1024; S.analyser.smoothingTimeConstant = .8;
  node.connect(lim); lim.connect(S.analyser); S.analyser.connect(ctx.destination);
}

export function setGains(values) {
  values.forEach((v, i) => {
    gains[i] = v;
    if (filters[i]) filters[i].gain.setTargetAtTime(v, S.ctx.currentTime, .02);
  });
  try { localStorage.setItem('adj_eq', JSON.stringify(gains)); } catch {}
}

export function setVolume(v) {
  volume = v;
  if (S.master) S.master.gain.value = v;
}
