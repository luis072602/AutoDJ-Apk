// Panel del ecualizador: 5 bandas, ajustes rápidos y analizador de espectro.
import { S, $, $$ } from './state.js';
import { BANDS, gains, setGains } from './audio.js';

const PRESETS = {
  'Plano': [0, 0, 0, 0, 0],
  'Bajos': [8, 5, 0, -1, 0],
  'Voces': [-3, -1, 4, 4, 1],
  'Brillante': [-2, 0, 1, 5, 8],
  'Fiesta': [6, 3, -1, 2, 5]
};

function paintEq() {
  $$('#bands input').forEach((r, i) => { r.value = gains[i]; $('#db' + i).textContent = (gains[i] > 0 ? '+' : '') + gains[i]; });
  $$('#presets button').forEach(b => b.classList.toggle('on', PRESETS[b.dataset.k].every((v, i) => v === gains[i])));
}
function setBand(i, v) {
  const g = [...gains]; g[i] = v;
  setGains(g); paintEq();
}

export function initEq() {
  $('#bands').innerHTML = BANDS.map((b, i) =>
    `<label class="band" title="${b.l} Hz · doble clic para volver a 0"><span class="db" id="db${i}"></span>` +
    `<input type="range" min="-12" max="12" step="1" value="0" data-b="${i}" aria-label="${b.l} Hz"><span class="hz">${b.l}</span></label>`).join('');
  $('#presets').innerHTML = Object.keys(PRESETS).map(k => `<button class="chip mini" data-k="${k}">${k}</button>`).join('');
  $('#bands').oninput = e => { const i = e.target.dataset.b; if (i !== undefined) setBand(+i, +e.target.value); };
  $('#bands').ondblclick = e => { const i = e.target.dataset.b; if (i !== undefined) setBand(+i, 0); };
  $('#presets').onclick = e => { const k = e.target.dataset.k; if (k) { setGains(PRESETS[k]); paintEq(); } };
  paintEq();
}

// Ajusta el tamaño interno del lienzo a su tamaño en pantalla. Devuelve false si no se ve.
export function fit(c) {
  const d = window.devicePixelRatio || 1, w = Math.round(c.clientWidth * d), h = Math.round(c.clientHeight * d);
  if (!w || !h) return false;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return true;
}

let data = null, colors = null;
export function drawSpectrum() {
  const c = $('#spec');
  if (!fit(c)) return;
  const g = c.getContext('2d'), an = S.analyser, d = window.devicePixelRatio || 1;
  g.clearRect(0, 0, c.width, c.height);
  if (!an) return;
  if (!colors) { const cs = getComputedStyle(document.documentElement); colors = [cs.getPropertyValue('--a').trim(), cs.getPropertyValue('--b').trim()]; }
  if (!data) data = new Uint8Array(an.frequencyBinCount);
  an.getByteFrequencyData(data);
  const N = 32, bw = c.width / N, hz = S.ctx.sampleRate / an.fftSize, lo = Math.log(40), hi = Math.log(16000);
  const grad = g.createLinearGradient(0, c.height, 0, 0);
  grad.addColorStop(0, colors[0]); grad.addColorStop(1, colors[1]);
  g.fillStyle = grad;
  for (let i = 0; i < N; i++) {
    const a = Math.floor(Math.exp(lo + (hi - lo) * i / N) / hz), b = Math.max(a + 1, Math.floor(Math.exp(lo + (hi - lo) * (i + 1) / N) / hz));
    let m = 0;
    for (let k = a; k < b && k < data.length; k++) m = Math.max(m, data[k]);
    const v = m / 255 * c.height;
    g.fillRect(i * bw + d, c.height - v, bw - 2 * d, v);
  }
}
