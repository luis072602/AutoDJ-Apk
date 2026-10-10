// Motor de mezcla: dos decks, cruce alineado al compás y piloto automático.
import { S, SCENES, ready, emit, log, clamp } from './state.js';
import { ensure } from './audio.js';
import { load, nextTrack, housekeeping } from './library.js';

const curve = f => Float32Array.from({ length: 64 }, (_, i) => f(i / 63));
const OUT = curve(x => Math.cos(x * Math.PI / 2)), IN = curve(x => Math.sin(x * Math.PI / 2));

const MAX_SHIFT = .05;   // cambio máximo de velocidad para igualar BPM: más que esto deforma la voz
const GLIDE = 8;         // segundos que tarda un deck en volver a su velocidad original tras la mezcla

export function pos(d) {
  const g = d.glide;
  if (!g) return d.off + (S.ctx.currentTime - d.at) * d.rate;
  // Durante el regreso la velocidad baja en línea recta de g.r a 1; después sigue a velocidad normal
  const t = S.ctx.currentTime - g.t0, x = clamp(t, 0, g.T);
  return g.off + g.r * x + (1 - g.r) * x * x / (2 * g.T) + Math.max(0, t - g.T);
}
export const isRunning = () => !!(S.ctx && S.ctx.state === 'running' && S.cur);

function makeDeck(t, rate, off, side = S.flip++ % 2) {
  const ctx = S.ctx, src = ctx.createBufferSource();
  src.buffer = t.buffer; src.playbackRate.value = rate;
  const hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
  hp.type = 'highpass'; hp.frequency.value = 10;
  lp.type = 'lowpass'; lp.frequency.value = 22000;
  src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(S.master);
  return { t, src, hp, lp, g, rate, off, at: 0, side };
}
function stopDeck(d) {
  if (!d) return;
  try { d.src.stop(); } catch {}
  try { d.g.disconnect(); } catch {}
}

// Terminada la mezcla, la canción vuelve poco a poco a su velocidad (y tono) original
function release(d) {
  if (d.rate === 1) return;
  const now = S.ctx.currentTime;
  d.glide = { t0: now, T: GLIDE, r: d.rate, off: pos(d) };
  d.src.playbackRate.setValueAtTime(d.rate, now);
  d.src.playbackRate.linearRampToValueAtTime(1, now + GLIDE);
  d.rate = 1;
}

const snap = (t, x, m) => { const B = 240 / t.bpm; return t.b0 + Math[m]((x - t.b0) / B) * B; };

function pickRate(o, t) {
  if (!o || !S.sync || o.t.weak || t.weak) return 1;
  const r = o.t.bpm * o.rate / t.bpm, c = [r, r * 2, r / 2].sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1))[0];
  // Cambiar la velocidad también cambia el tono: si hace falta demasiado, mejor no igualar y cruzar por tiempo
  return Math.abs(c - 1) > MAX_SHIFT ? 1 : c;
}

// Decide cuándo sale la actual, desde dónde entra la siguiente y cuántos tiempos dura el cruce
function plan(o, t, fast) {
  const ot = o.t, rate = pickRate(o, t), bo = 60 / ot.bpm, bi = 60 / t.bpm, Bo = bo / o.rate, p = pos(o);
  const intro = Math.max(0, t.drop - t.b0), outro = Math.max(0, ot.end - ot.out);
  let D = SCENES[S.scene].auto ? clamp(Math.min(intro, outro) || 6, 6, 24) : S.mixT;
  if (fast) D = Math.min(D, 8);
  let nb = Math.max(4, Math.round(D / Bo / 4) * 4);
  if (!fast && intro < nb * bi) nb = Math.max(8, Math.round(intro / bi / 4) * 4);
  const soon = p + .4 * o.rate;
  let ms = fast ? snap(ot, soon, 'ceil') : snap(ot, Math.min(ot.out, ot.end - nb * bo), 'floor');
  if (ms < soon) ms = snap(ot, soon, 'ceil');
  nb = Math.max(2, Math.min(nb, Math.floor((ot.dur - ms) / bo) - 1));
  const long = intro > nb * bi;
  return { t, rate, ms, nb, long, inP: long ? t.drop - nb * bi : t.b0, D: nb * Bo };
}

function start(t) {
  ensure(); S.ctx.resume();
  const d = makeDeck(t, 1, t.start);
  d.at = S.ctx.currentTime + .05; d.src.start(d.at, t.start);
  S.cur = d; S.last = t;
  log('Arrancó «' + t.name + '»');
}

function go(pl) {
  const t = pl.t, o = S.cur;
  if (!ready(t) || S.mix || !o) return;
  const T = S.ctx.currentTime, nd = makeDeck(t, pl.rate, pl.inP), at = T + Math.max(.05, (pl.ms - pos(o)) / o.rate), dur = pl.D;
  const A = (p, v, w) => p.setValueAtTime(v, w);
  nd.at = at; nd.g.gain.value = 0; nd.g.gain.setValueCurveAtTime(IN, at, dur);
  A(o.g.gain, 1, T); o.g.gain.setValueCurveAtTime(OUT, at, dur);
  // La que sale pierde graves; la que entra llega sin graves ni brillo y se abre a mitad del cruce
  A(o.hp.frequency, 10, at); o.hp.frequency.exponentialRampToValueAtTime(400, at + dur * .6);
  A(nd.hp.frequency, 300, T); A(nd.hp.frequency, 300, at + dur * .4); nd.hp.frequency.exponentialRampToValueAtTime(10, at + dur * .65);
  A(nd.lp.frequency, 1500, T); nd.lp.frequency.exponentialRampToValueAtTime(20000, at + dur * .7);
  nd.src.start(at, pl.inP); o.src.stop(at + dur + .1);
  S.mix = { nd, o, at, dur, end: at + dur };
  log('Mezclando «' + o.t.name + '» → «' + t.name + '» · ' + Math.round(o.t.bpm * o.rate) + ' → ' + Math.round(t.bpm * pl.rate) + ' BPM · cruce de ' + pl.nb + ' tiempos (' + Math.round(dur) + ' s) · ' +
    (pl.long ? 'intro larga: entra ' + Math.round(dur) + ' s antes del golpe' : 'intro corta: entra desde el inicio') +
    (o.t.weak || t.weak ? ' · BPM incierto, cruce por tiempo' : ''));
}

export function stop(msg = 'Lista terminada') {
  stopDeck(S.cur); S.cur = null;
  if (S.mix) { stopDeck(S.mix.nd); stopDeck(S.mix.o); S.mix = null; }
  S.cue = null; S.last = null;
  log(msg); emit();
}

// Pide una canción: la carga si hace falta y, cuando está lista, arranca o mezcla hacia ella.
export async function cue(t) {
  if (!t) return;
  if (S.mix) { log('Espera a que termine la mezcla en curso'); return; }
  if (S.cur && S.cur.t === t) return;
  ensure();
  if (t.bad) { t.bad = false; t.err = null; t.fails = 0; }
  S.cue = t; emit();
  if (!ready(t)) log('Cargando «' + t.name + '»…');
  await load(t);
  if (S.cue !== t) return;
  S.cue = null;
  if (!ready(t)) {
    log('No se pudo cargar «' + t.name + '»: ' + (t.err || 'error'), true);
    if (!S.cur && t.bad) { S.last = t; const n = nextTrack(); if (n) cue(n); }
    return emit();
  }
  if (!S.cur) start(t);
  else if (!S.mix) go(plan(S.cur, t, true));
  emit();
}

export function togglePlay() {
  ensure();
  if (!S.cur) {
    if (S.cue) return;
    const t = (S.last && nextTrack()) || S.tracks.find(t => !t.bad);   // sigue donde quedó, o empieza la lista
    if (!t) { log('Agrega canciones primero'); return; }
    return cue(t);
  }
  if (S.ctx.state === 'running') S.ctx.suspend(); else S.ctx.resume();
}

export function skip() {
  if (!S.cur) return togglePlay();
  const n = nextTrack();
  if (n) cue(n); else log('No hay otra canción a la que mezclar');
}

// Salta a otro punto de la canción que suena (segundos)
export function seek(x) {
  const o = S.cur;
  if (!o || S.mix) return;
  const off = clamp(x, 0, o.t.dur - 1), d = makeDeck(o.t, o.rate, off, o.side);
  stopDeck(o);
  d.at = S.ctx.currentTime + .03; d.src.start(d.at, off);
  S.cur = d;
}

// Piloto automático: se ejecuta 5 veces por segundo
export function tick() {
  if (!S.ctx) return;
  housekeeping();
  if (S.ctx.state !== 'running') return;
  if (S.mix) {
    if (S.ctx.currentTime >= S.mix.end) { stopDeck(S.mix.o); S.cur = S.mix.nd; release(S.cur); S.last = S.cur.t; S.mix = null; emit(); }
    return;
  }
  const o = S.cur;
  if (!o || S.cue) return;
  const nt = nextTrack(), p = pos(o);
  if (ready(nt)) {
    // Con tiempo fijo por canción no se espera al final: al cumplirse se mezcla en el siguiente compás
    const due = S.autoLen > 0 && S.ctx.currentTime - o.at >= S.autoLen;
    const pl = plan(o, nt, due);
    if (due || (pl.ms - p) / o.rate <= 3.2) go(pl);
  }
  else if (p >= o.t.end || o.t.dur - p < .3) {
    // La actual terminó y la siguiente aún no está lista: se espera a que cargue
    if (nt) { stopDeck(o); S.cur = null; cue(nt); } else stop();
  }
}
