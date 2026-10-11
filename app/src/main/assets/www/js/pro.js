// Modo Pro: consola manual de dos decks. Aquí no mezcla el piloto automático: mezcla el usuario.
//
// Cada deck:  fuente → ganancia → graves → medios → agudos → fader → crossfader ─┐
//                                                                               ├→ bus → filtro → master
// Efectos (eco, reverb, flanger) cuelgan del bus y vuelven al master.           ┘
import { S, $, $$, esc, fmt, clamp, ready, log } from './state.js';
import { ensure } from './audio.js';
import { load } from './library.js';
import { stop, adopt, pos, isRunning } from './mixer.js';

const BEATS = [1, 2, 4, 8, 16];
const MAX_TEMPO = 8;   // ± % del fader de tempo

const mkDeck = i => ({
  i, t: null, src: null, playing: false, off: 0, at: 0, rate: 1, cue: 0,
  hot: [null, null, null, null], loop: { on: false, beats: 4, s: 0, e: 0 }, n: null, el: null
});
const D = [mkDeck(0), mkDeck(1)];
let fx = null, xfade = .5;

// ---------- Audio ----------
function graph() {
  if (fx) return fx;
  const c = S.ctx, bus = c.createGain(), filt = c.createBiquadFilter();
  filt.type = 'lowpass'; filt.frequency.value = 22000;
  bus.connect(filt); filt.connect(S.master);

  // Eco: retardo con realimentación
  const delay = c.createDelay(2), fb = c.createGain(), echo = c.createGain();
  delay.delayTime.value = .375; fb.gain.value = .45; echo.gain.value = 0;
  filt.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(echo); echo.connect(S.master);

  // Reverb: respuesta de sala hecha con ruido que se apaga
  const conv = c.createConvolver(), reverb = c.createGain(), len = Math.floor(c.sampleRate * 2.2);
  const ir = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
  conv.buffer = ir; reverb.gain.value = 0;
  filt.connect(conv); conv.connect(reverb); reverb.connect(S.master);

  // Flanger: retardo muy corto que oscila
  const fd = c.createDelay(.05), ffb = c.createGain(), lfo = c.createOscillator(), depth = c.createGain(), flanger = c.createGain();
  fd.delayTime.value = .005; ffb.gain.value = .6; lfo.frequency.value = .25; depth.gain.value = .003; flanger.gain.value = 0;
  lfo.connect(depth); depth.connect(fd.delayTime); lfo.start();
  filt.connect(fd); fd.connect(ffb); ffb.connect(fd); fd.connect(flanger); flanger.connect(S.master);

  return fx = { bus, filt, delay, wet: { echo, reverb, flanger } };
}

function nodes(d) {
  if (d.n) return d.n;
  const c = S.ctx, g = graph();
  const trim = c.createGain(), low = c.createBiquadFilter(), mid = c.createBiquadFilter(), hi = c.createBiquadFilter();
  const fader = c.createGain(), xf = c.createGain(), meter = c.createAnalyser();
  low.type = 'lowshelf'; low.frequency.value = 250;
  mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = .7;
  hi.type = 'highshelf'; hi.frequency.value = 4000;
  meter.fftSize = 512;
  trim.connect(low); low.connect(mid); mid.connect(hi); hi.connect(fader); fader.connect(xf); xf.connect(g.bus);
  fader.connect(meter);
  d.n = { trim, low, mid, hi, fader, xf, meter, buf: new Float32Array(512) };
  setXfade(xfade);
  return d.n;
}

function setXfade(x) {
  xfade = x;
  D.forEach(d => { if (d.n) d.n.xf.gain.value = Math.cos((d.i ? 1 - x : x) * Math.PI / 2); });
}

// Posición actual en segundos (con loop activo, la reproducción da vueltas entre s y e)
function at(d) {
  if (!d.t) return 0;
  let p = d.playing ? d.off + (S.ctx.currentTime - d.at) * d.rate : d.off;
  const L = d.loop;
  if (L.on && d.playing && p >= L.e) p = L.s + (p - L.s) % (L.e - L.s);
  return clamp(p, 0, d.t.dur);
}
const rebase = d => { d.off = at(d); d.at = S.ctx.currentTime; };

function kill(d) {
  const s = d.src;
  d.src = null;
  if (s) { try { s.stop(); } catch {} try { s.disconnect(); } catch {} }
}
function start(d, from) {
  kill(d);
  const s = S.ctx.createBufferSource(), L = d.loop;
  s.buffer = d.t.buffer; s.playbackRate.value = d.rate;
  if (L.on) { s.loop = true; s.loopStart = L.s; s.loopEnd = L.e; }
  s.connect(nodes(d).trim);
  s.onended = () => { if (d.src === s) { d.src = null; d.playing = false; d.off = d.cue; } };   // llegó al final: vuelve al cue
  d.off = clamp(from, 0, d.t.dur - .05); d.at = S.ctx.currentTime;
  s.start(0, d.off);
  d.src = s; d.playing = true;
}
function pause(d) {
  if (!d.playing) return;
  d.off = at(d); d.playing = false;
  kill(d);
}
function seek(d, x) {
  if (!d.t) return;
  if (d.playing) start(d, x); else d.off = clamp(x, 0, d.t.dur);
}

function setTempo(d, pct) {
  if (d.playing) rebase(d);
  d.rate = 1 + pct / 100;
  if (d.src) d.src.playbackRate.setValueAtTime(d.rate, S.ctx.currentTime);
  d.el.querySelector('.pd-rate').value = pct;
  d.el.querySelector('.pd-pct').textContent = (pct > 0 ? '+' : '') + pct.toFixed(1) + '%';
}
// SYNC: iguala el tempo de este deck al del otro (no alinea el golpe: eso se hace de oído)
function sync(d) {
  const o = D[1 - d.i];
  if (!d.t || !o.t) return log('Carga una canción en cada deck para sincronizar');
  const r = o.t.bpm * o.rate / d.t.bpm, c = [r, r * 2, r / 2].sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1))[0];
  const pct = (c - 1) * 100;
  if (Math.abs(pct) > MAX_TEMPO) return log('Los BPM están muy lejos para sincronizar (' + Math.round(d.t.bpm) + ' y ' + Math.round(o.t.bpm * o.rate) + ')', true);
  setTempo(d, Math.round(pct * 10) / 10);
  log('Deck ' + 'AB'[d.i] + ' a ' + Math.round(d.t.bpm * d.rate) + ' BPM');
}

function setLoop(d, on) {
  const L = d.loop;
  if (!d.t) return;
  if (d.playing) rebase(d);
  if (on) {
    const beat = 60 / d.t.bpm, p = at(d);
    L.s = Math.max(0, d.t.b0 + Math.floor((p - d.t.b0) / beat) * beat);   // empieza en el golpe anterior
    L.e = Math.min(d.t.dur, L.s + L.beats * beat);
  }
  L.on = on && L.e > L.s;
  if (d.src) { d.src.loopStart = L.s; d.src.loopEnd = L.e; d.src.loop = L.on; }
}
function stepLoop(d, dir) {
  const L = d.loop;
  L.beats = BEATS[clamp(BEATS.indexOf(L.beats) + dir, 0, BEATS.length - 1)];
  if (L.on) { if (d.playing) rebase(d); L.e = Math.min(d.t.dur, L.s + L.beats * 60 / d.t.bpm); if (d.src) d.src.loopEnd = L.e; }
}

function setTrack(d, t, from) {
  pause(d);
  d.t = t; d.cue = t.b0 || t.start || 0; d.off = from == null ? d.cue : from;
  d.hot = [null, null, null, null];
  d.loop.on = false;
  setTempo(d, 0);
  S.proKeep = D.map(x => x.t).filter(Boolean);   // que la lista no libere el audio de lo que está en los decks
}
async function loadInto(d, t) {
  log('Cargando «' + t.name + '» en el deck ' + 'AB'[d.i] + '…');
  if (t.bad) { t.bad = false; t.err = null; }
  d.el.classList.add('busy');
  await load(t);
  d.el.classList.remove('busy');
  if (!ready(t)) return log('No se pudo cargar «' + t.name + '»: ' + (t.err || 'error'), true);
  if (!S.pro) return;
  setTrack(d, t);
  log('Deck ' + 'AB'[d.i] + ': «' + t.name + '» · ' + Math.round(t.bpm) + ' BPM');
}

// ---------- Efectos y sonidos ----------
function toggleFx(k, on) {
  const g = graph(), now = S.ctx.currentTime;
  if (k === 'filter') return g.filt.frequency.setTargetAtTime(on ? 700 : 22000, now, .05);
  if (k === 'echo' && on) {   // el eco repite cada 3/4 de tiempo de lo que esté sonando
    const d = D.find(x => x.playing) || D.find(x => x.t);
    if (d) g.delay.delayTime.setValueAtTime(clamp(45 / (d.t.bpm * d.rate), .1, 1.5), now);
  }
  g.wet[k].gain.setTargetAtTime(on ? { echo: .5, reverb: .45, flanger: .8 }[k] : 0, now, .03);
}

function sample(kind) {
  const c = S.ctx, t = c.currentTime, out = c.createGain();
  out.connect(S.master);
  const noise = secs => {
    const b = c.createBuffer(1, Math.floor(c.sampleRate * secs), c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const s = c.createBufferSource(); s.buffer = b; return s;
  };
  if (kind === 'kick') {
    const o = c.createOscillator();
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(40, t + .14);
    out.gain.setValueAtTime(1, t); out.gain.exponentialRampToValueAtTime(.001, t + .4);
    o.connect(out); o.start(t); o.stop(t + .42);
  } else if (kind === 'horn') {
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.connect(out);
    out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(.28, t + .03);
    out.gain.setValueAtTime(.28, t + .7); out.gain.linearRampToValueAtTime(0, t + .95);
    for (const f of [233, 294, 349, 466]) {
      const o = c.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * .94, t); o.frequency.linearRampToValueAtTime(f, t + .08);
      o.connect(lp); o.start(t); o.stop(t + 1);
    }
  } else if (kind === 'sweep') {
    const s = noise(1.6), bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2;
    bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(9000, t + 1.5);
    out.gain.setValueAtTime(.05, t); out.gain.linearRampToValueAtTime(.5, t + 1.45); out.gain.linearRampToValueAtTime(0, t + 1.6);
    s.connect(bp); bp.connect(out); s.start(t);
  } else {   // palmada: tres golpes de ruido muy seguidos
    const s = noise(.35), bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = .8;
    out.gain.setValueAtTime(0, t);
    for (const dt of [0, .012, .026]) { out.gain.setValueAtTime(.8, t + dt); out.gain.exponentialRampToValueAtTime(.05, t + dt + .01); }
    out.gain.exponentialRampToValueAtTime(.001, t + .3);
    s.connect(bp); bp.connect(out); s.start(t);
  }
}

// ---------- Interfaz ----------
const DECK_HTML = i => `
  <div class="pd-head">
    <span class="pd-tag">${'AB'[i]}</span>
    <button class="pd-load">Cargar</button>
    <span class="pd-name clip">Sin canción</span>
    <span class="pd-time">0:00</span>
  </div>
  <canvas class="pd-wave"></canvas>
  <div class="pd-body">
    <div class="pd-tempo">
      <button class="pd-sync">SYNC</button>
      <input class="pd-rate" type="range" min="-${MAX_TEMPO}" max="${MAX_TEMPO}" step=".1" value="0" aria-label="Tempo">
      <span class="pd-pct">0.0%</span>
    </div>
    <div class="pd-jog"><div class="pd-plate"><div class="pd-spin"></div><div class="pd-lbl"><b class="pd-bpm">—</b><small>BPM</small></div></div></div>
    <div class="pd-ctl">
      <div class="pd-loop"><button data-l="-1" aria-label="Loop más corto">‹</button><button class="pd-loopb">LOOP 4</button><button data-l="1" aria-label="Loop más largo">›</button></div>
      <button class="pd-cue">CUE</button>
      <button class="pd-play" aria-label="Reproducir o pausar">▶</button>
      <div class="pd-hot">${[0, 1, 2, 3].map(h => `<button data-h="${h}">${h + 1}</button>`).join('')}</div>
    </div>
  </div>`;

// Perilla: se arrastra hacia arriba o abajo; doble toque la centra. Valor de -1 a 1.
function knob(el, onChange) {
  let v = 0, y0 = null, v0 = 0;
  const set = x => { v = clamp(x, -1, 1); el.style.transform = 'rotate(' + v * 135 + 'deg)'; onChange(v); };
  el.onpointerdown = e => { el.setPointerCapture(e.pointerId); y0 = e.clientY; v0 = v; };
  el.onpointermove = e => { if (y0 != null) set(v0 + (y0 - e.clientY) / 70); };
  el.onpointerup = el.onpointercancel = () => y0 = null;
  el.ondblclick = () => set(0);
  set(0);
}
// Corte fuerte hacia abajo (como en una mezcladora real) y realce suave hacia arriba
const eqDb = v => v < 0 ? v * 26 : v * 6;

function bindDeck(d) {
  const el = d.el, q = s => el.querySelector(s);
  q('.pd-load').onclick = () => pick(d);
  q('.pd-play').onclick = () => { if (!d.t) return pick(d); if (d.playing) pause(d); else if (ready(d.t)) start(d, d.off); };
  q('.pd-cue').onclick = () => { if (!d.t) return; if (d.playing) { pause(d); d.off = d.cue; } else d.cue = d.off; };   // sonando: vuelve al cue; en pausa: lo fija aquí
  q('.pd-sync').onclick = () => sync(d);
  q('.pd-rate').oninput = e => setTempo(d, +e.target.value);
  q('.pd-rate').ondblclick = () => setTempo(d, 0);
  q('.pd-loopb').onclick = () => setLoop(d, !d.loop.on);
  q('.pd-loop').addEventListener('click', e => { const s = e.target.dataset.l; if (s) stepLoop(d, +s); });
  q('.pd-hot').onclick = e => {
    const h = e.target.dataset.h;
    if (h === undefined || !d.t) return;
    if (d.hot[h] == null) d.hot[h] = at(d); else seek(d, d.hot[h]);
  };
  q('.pd-hot').oncontextmenu = e => { e.preventDefault(); const h = e.target.dataset.h; if (h !== undefined) d.hot[h] = null; };   // mantener pulsado lo borra
  q('.pd-wave').onclick = e => { if (d.t) seek(d, e.offsetX / e.currentTarget.clientWidth * d.t.dur); };
}

// Elegir canción de la cola para un deck
function pick(d) {
  if (!S.tracks.length) return log('La cola está vacía: sal del Modo Pro y agrega canciones en «Música».', true);
  $('#proPickT').textContent = 'Cargar en el deck ' + 'AB'[d.i];
  $('#proPickL').innerHTML = S.tracks.map((t, i) =>
    `<li data-i="${i}"><div class="t"><b>${esc(t.name)}</b><small>${t.an ? fmt(t.dur) : t.len ? fmt(t.len) : ''}</small></div><span class="bpm">${t.bpm ? Math.round(t.bpm) : '—'}</span></li>`).join('');
  $('#proPickL').onclick = e => {
    const li = e.target.closest('[data-i]');
    if (!li) return;
    $('#proPick').hidden = true;
    loadInto(d, S.tracks[+li.dataset.i]);
  };
  $('#proPick').hidden = false;
}

function fit(c) {
  const r = window.devicePixelRatio || 1, w = Math.round(c.clientWidth * r), h = Math.round(c.clientHeight * r);
  if (!w || !h) return false;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return true;
}
const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
let colors = null;

function paintDeck(d) {
  const el = d.el, q = s => el.querySelector(s), t = d.t, p = at(d);
  el.classList.toggle('loaded', !!t);
  el.classList.toggle('playing', d.playing);
  setText(q('.pd-name'), t ? t.name : 'Sin canción');
  setText(q('.pd-time'), t ? fmt(p) + ' / ' + fmt(t.dur) : '0:00');
  setText(q('.pd-bpm'), t ? (t.bpm * d.rate).toFixed(1) : '—');
  setText(q('.pd-play'), d.playing ? '❚❚' : '▶');
  setText(q('.pd-loopb'), 'LOOP ' + d.loop.beats);
  q('.pd-loopb').classList.toggle('on', d.loop.on);
  q('.pd-cue').classList.toggle('on', !!t && !d.playing && Math.abs(p - d.cue) < .02);
  el.querySelectorAll('.pd-hot button').forEach((b, h) => b.classList.toggle('on', d.hot[h] != null));
  q('.pd-spin').style.transform = 'rotate(' + (p * 200) % 360 + 'deg)';   // ~33 rpm

  const c = q('.pd-wave');
  if (!fit(c)) return;
  const g = c.getContext('2d'), W = c.width, H = c.height, r = window.devicePixelRatio || 1;
  g.clearRect(0, 0, W, H);
  if (!t || !t.wave) return;
  const x = s => s / t.dur * W, n = t.wave.length, bw = 2 * r, N = Math.floor(W * Math.min(1, t.waveDur / t.dur) / bw);
  if (d.loop.on) { g.fillStyle = 'rgba(255,255,255,.14)'; g.fillRect(x(d.loop.s), 0, x(d.loop.e) - x(d.loop.s), H); }
  for (let i = 0; i < N; i++) {
    const h = Math.max(r, t.wave[Math.floor(i / N * n)] / 100 * (H - 4 * r));
    g.fillStyle = i * bw < x(p) ? colors[d.i] : colors[2];
    g.fillRect(i * bw, (H - h) / 2, bw - r * .5, h);
  }
  g.fillStyle = '#fff8'; g.fillRect(x(d.cue), 0, r, H);
  g.fillStyle = '#ffd24a'; d.hot.forEach(h => { if (h != null) g.fillRect(x(h) - r, 0, 2 * r, H * .3); });
  g.fillStyle = '#fff'; g.fillRect(x(p) - r, 0, 2 * r, H);
}

function paintVu() {
  const c = $('#pmVu');
  if (!fit(c)) return;
  const g = c.getContext('2d'), W = c.width, H = c.height, SEG = 10, gap = Math.max(1, H / 60);
  g.clearRect(0, 0, W, H);
  D.forEach(d => {
    let lvl = 0;
    if (d.n && d.playing) {
      d.n.meter.getFloatTimeDomainData(d.n.buf);
      let sum = 0; for (const v of d.n.buf) sum += v * v;
      lvl = clamp((20 * Math.log10(Math.sqrt(sum / d.n.buf.length) + 1e-6) + 42) / 42, 0, 1);   // -42 dB … 0 dB
    }
    const x = d.i ? W * .58 : W * .12, w = W * .3, sh = (H - gap * (SEG - 1)) / SEG;
    for (let s = 0; s < SEG; s++) {
      const on = s / SEG < lvl;
      g.fillStyle = !on ? 'rgba(255,255,255,.07)' : s >= SEG - 2 ? '#ef4444' : s >= SEG - 4 ? '#f5b83d' : '#34d399';
      g.fillRect(x, H - (s + 1) * sh - s * gap, w, sh);
    }
  });
}

export function paintPro() {
  if (!S.pro) return;
  if (!colors) { const cs = getComputedStyle(document.documentElement), v = k => cs.getPropertyValue(k).trim(); colors = [v('--a'), v('--b'), v('--bd')]; }
  D.forEach(paintDeck);
  paintVu();
}

// El deck «principal»: de los que suenan, el que más se oye; si ninguno suena, el primero con canción
const loud = d => d.n ? d.n.fader.gain.value * d.n.xf.gain.value : 0;
function lead() {
  const on = D.filter(d => d.playing).sort((a, b) => loud(b) - loud(a));
  return on[0] || D.find(d => d.t) || null;
}

// Lo que se muestra en la notificación mientras el Modo Pro está abierto
export function proNow() {
  const d = lead();
  if (!d) return { id: 'pro', vid: '', name: 'Modo Pro', sub: 'AutoDJ', playing: false, dur: 0, pos: 0, rate: 1 };
  return { id: 'pro' + d.i + d.t.id, vid: d.t.vid || '', name: d.t.name, sub: 'Modo Pro · Deck ' + 'AB'[d.i], playing: d.playing, dur: d.t.dur, pos: at(d), rate: d.rate };
}
// Pausa y reproducir desde la notificación o los audífonos
let resume = [];
export function proCommand(c) {
  const on = D.filter(d => d.playing);
  if (c === 'next') return;
  if (on.length && c !== 'play') { resume = on; on.forEach(pause); }
  else if (!on.length && c !== 'pause') {
    const again = resume.filter(d => d.t && ready(d.t));
    (again.length ? again : [lead()].filter(d => d && ready(d.t))).forEach(d => start(d, d.off));
    resume = [];
  }
}

// ---------- Entrar y salir ----------
function orient(mode) {
  const app = window.AutoDJNative;
  if (app && app.orientation) app.orientation(mode);
}

function enter() {
  ensure();
  // Lo que venía sonando en automático pasa al deck A en el mismo punto
  const cur = S.cur, t = cur && cur.t, p = cur ? pos(cur) : 0, running = isRunning();
  stop('Modo Pro: tú mezclas.');
  S.ctx.resume();
  S.pro = true;
  colors = null;
  D.forEach(nodes);
  if (t && ready(t)) { setTrack(D[0], t, clamp(p, 0, t.dur - 1)); if (running) start(D[0], D[0].off); }
  $('#pro').hidden = false;
  orient('landscape');
}

function exit() {
  // Lo que más se oye sigue sonando en automático desde el mismo punto; lo demás se apaga
  const keep = D.filter(d => d.playing && ready(d.t) && S.tracks.includes(d.t)).sort((a, b) => loud(b) - loud(a))[0];
  if (keep) {
    const now = S.ctx.currentTime, src = keep.src, fader = keep.n.fader.gain, level = fader.value;
    adopt(keep.t, clamp(at(keep) + .03 * keep.rate, 0, keep.t.dur - .5), keep.rate);
    fader.setValueAtTime(level, now); fader.linearRampToValueAtTime(0, now + .1);
    keep.src = null; keep.playing = false; keep.off = keep.cue;
    setTimeout(() => { try { src.stop(); src.disconnect(); } catch {} fader.cancelScheduledValues(0); fader.value = level; }, 200);
  }
  D.forEach(d => { pause(d); d.loop.on = false; });
  $$('#proFx button').forEach(b => { if (b.classList.contains('on')) { b.classList.remove('on'); toggleFx(b.dataset.fx, false); } });
  S.pro = false; S.proKeep = [];
  $('#pro').hidden = true; $('#proPick').hidden = true;
  orient('portrait');
  log(keep ? 'Saliste del Modo Pro: «' + keep.t.name + '» sigue en mezcla automática.' : 'Saliste del Modo Pro. Pulsa Reproducir para volver a la mezcla automática.');
}

export function initPro() {
  $$('.pdeck').forEach((el, i) => { el.innerHTML = DECK_HTML(i); D[i].el = el; bindDeck(D[i]); });

  // Mezcladora: perillas, faders y crossfader
  $$('.pm-ch').forEach((ch, i) => {
    ch.innerHTML = ['gain', 'hi', 'mid', 'low'].map(k => `<div class="pm-k"><div class="knob" data-k="${k}"></div><span>${k.toUpperCase()}</span></div>`).join('');
    ch.querySelectorAll('.knob').forEach(el => knob(el, v => {
      const n = D[i].n, k = el.dataset.k;
      if (!n) return;
      if (k === 'gain') n.trim.gain.value = Math.pow(10, v * 12 / 20);   // ±12 dB
      else n[k].gain.value = eqDb(v);
    }));
  });
  $$('.pm-vol').forEach((r, i) => r.oninput = () => { if (D[i].n) D[i].n.fader.gain.value = +r.value; });
  $('#pmXf').oninput = e => setXfade(+e.target.value);
  $('#pmXf').ondblclick = e => { e.target.value = .5; setXfade(.5); };

  $('#proFx').onclick = e => {
    const b = e.target.closest('[data-fx]');
    if (b) toggleFx(b.dataset.fx, b.classList.toggle('on'));
  };
  $('#proSmp').onclick = e => { const b = e.target.closest('[data-s]'); if (b) sample(b.dataset.s); };
  $('#proPickX').onclick = () => $('#proPick').hidden = true;
  $('#proExit').onclick = exit;

  // Antes de entrar se pregunta: el modo automático se detiene
  $('#proNo').onclick = () => $('#proAsk').hidden = true;
  $('#proYes').onclick = () => { $('#proAsk').hidden = true; enter(); };
  document.querySelector('#tabs [data-tab="pro"]').onclick = () => $('#proAsk').hidden = false;
}
