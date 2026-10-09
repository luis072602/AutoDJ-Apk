// Análisis de una canción: BPM, compases, intro y final.
// Deja el resultado en la propia canción (ver META).

export const META = ['dur', 'bpm', 'weak', 'energy', 'start', 'end', 'b0', 'drop', 'out', 'wave', 'waveDur'];

export async function analyze(t) {
  const b = t.buffer, dur = Math.min(b.duration, 480);
  let R = 11025, hop = 55;
  try { new OfflineAudioContext(1, 1, R); } catch { R = 22050; hop = 110; }   // algunos navegadores no aceptan 11 kHz
  const E = R / hop, H = 100 / E;   // la envolvente tiene E puntos por segundo; cada nivel de energía dura H segundos
  const render = async f => {
    const oc = new OfflineAudioContext(1, Math.ceil(dur * R), R), s = oc.createBufferSource();
    let n = s; s.buffer = b;
    if (f) { n = oc.createBiquadFilter(); n.type = 'lowpass'; n.frequency.value = f; s.connect(n); }
    n.connect(oc.destination); s.start(0, 0, dur);
    return (await oc.startRendering()).getChannelData(0);
  };
  const envOf = d => {
    const o = [];
    for (let i = 0; i + hop <= d.length; i += hop) { let m = 0; for (let j = 0; j < hop; j++) m += Math.abs(d[i + j]); o.push(m / hop); }
    return o;
  };

  // 1) Estructura: nivel de energía cada medio segundo
  const full = envOf(await render(0)), L = [];
  for (let i = 0; i + 100 <= full.length; i += 100) { let m = 0; for (let j = 0; j < 100; j++) m += full[i + j]; L.push(m / 100); }
  const ref = [...L].sort((a, b) => a - b)[Math.floor(L.length * .75)] || 1e-6, trunc = dur < b.duration;
  t.dur = b.duration;
  t.energy = L.reduce((a, v) => a + v, 0) / L.length;
  const sus = (i, k) => { for (let j = 0; j < 3; j++) if ((L[i + j * k] || 0) < ref * .5) return false; return true; };
  let first = Math.max(0, L.findIndex(v => v > ref * .1)), last = L.length - 1;
  while (last > 0 && L[last] < ref * .1) last--;
  let f0 = Math.max(0, first * 100 - 100);
  while (f0 < full.length && full[f0] <= ref * .1) f0++;
  t.start = Math.max(0, f0 / E - .03);
  t.end = trunc ? b.duration : Math.min(b.duration, (last + 1) * H);
  let di = L.findIndex((v, i) => v >= ref * .6 && sus(i, 1)); if (di < 0) di = first;
  let oi = L.length - 1; while (oi > 0 && !(L[oi] >= ref * .6 && sus(oi, -1))) oi--;
  let rawD = di * H, rawO = trunc ? b.duration - 8 : (oi + 1) * H;
  if (rawO < rawD + 8) rawO = Math.max(rawD, t.end - 8);

  // Silueta para dibujar la canción en la consola (máx. 300 puntos, 0-100)
  const step = Math.ceil(L.length / 300), peak = Math.max(...L, 1e-6);
  t.wave = [];
  for (let i = 0; i < L.length; i += step) t.wave.push(Math.round(Math.max(...L.slice(i, i + step)) / peak * 100));
  t.waveDur = dur;

  // 2) Ritmo: BPM (grueso y fino), fase del pulso y primer tiempo fuerte del compás
  const low = envOf(await render(150)), on = low.map((v, i) => i ? Math.max(0, v - low[i - 1]) : 0);
  const W = Math.min(on.length, 36000), w0 = Math.max(0, Math.floor((on.length - W) / 2)), w = on.slice(w0, w0 + W);
  const f = j => { const k = Math.floor(j), r = j - k; return w[k] * (1 - r) + w[k + 1] * r; };
  const sc = bpm => {
    const lag = 60 * E / bpm; let s = 0, c = 0;
    for (let i = 0; i + lag * 2 + 2 < w.length; i++) { s += w[i] * (f(i + lag) + .5 * f(i + lag * 2)); c++; }
    return s / (c || 1);
  };
  let best = -1, bb = 120, tot = 0, n = 0;
  for (let q = 70; q <= 180; q += .5) { const v = sc(q); tot += v; n++; if (v > best) { best = v; bb = q; } }
  const c0 = bb;
  for (let q = c0 - .5; q <= c0 + .5; q += .02) { const v = sc(q); if (v > best) { best = v; bb = q; } }
  t.weak = !(best > (tot / n) * 1.35);
  while (bb < 80) bb *= 2;
  while (bb > 170) bb /= 2;
  t.bpm = bb;
  const P = 60 * E / bb, bp = 60 / bb, cnt = Math.floor((w.length - 4) / P);
  const bx = x => { const k = Math.round(x); return (w[k - 1] || 0) + (w[k] || 0) + (w[k + 1] || 0); };
  let bph = 0, bs = -1;
  for (let ph = 0; ph < P; ph++) { let v = 0; for (let j = 0; j < cnt; j++) v += bx(ph + j * P); if (v > bs) { bs = v; bph = ph; } }
  const acc = [0, 0, 0, 0];
  for (let j = 0; j < cnt; j++) acc[j % 4] += bx(bph + j * P);
  const m = acc.indexOf(Math.max(...acc)), bar = 4 * bp;
  let b0 = (w0 + bph + m * P) / E; b0 -= Math.floor(b0 / bar) * bar;
  while (b0 < t.start - .08) b0 += bar;
  t.b0 = b0;
  t.drop = Math.max(b0, b0 + Math.round((Math.max(rawD, b0) - b0) / bar) * bar);
  t.out = Math.max(t.drop, b0 + Math.floor((rawO - b0) / bar) * bar);
  t.an = true;
}
