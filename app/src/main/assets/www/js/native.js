// Puente con la app de Android: le cuenta qué suena (para la notificación y la pantalla de bloqueo)
// y recibe los botones de pausa y siguiente que el usuario toca fuera de la app.
import { S, $, esc } from './state.js';
import { togglePlay, skip, pos, isRunning } from './mixer.js';

const RELEASE = 'https://api.github.com/repos/luis072602/AutoDJ-Apk/releases/latest';
const APK = 'https://github.com/luis072602/AutoDJ-Apk/releases/latest/download/AutoDJ.apk';
const build = v => +String(v).split('.').pop() || 0;   // «0.1.7» → 7: el número que sube en cada versión

// Compara la versión instalada con la última publicada y, si hay una más nueva, muestra el aviso
export async function checkUpdate(current) {
  try {
    const r = await fetch(RELEASE, { cache: 'no-store' });
    if (!r.ok) return;
    const latest = ((await r.json()).name || '').replace(/^\D+/, '');   // «AutoDJ 0.1.8» → «0.1.8»
    if (build(latest) <= build(current)) return;
    const a = $('#update');
    a.href = APK;
    a.innerHTML = 'Hay una versión nueva (' + esc(latest) + ') · <b>Actualizar</b>';
    a.hidden = false;
  } catch {}   // sin conexión: se intentará la próxima vez
}

export function initNative() {
  const app = window.AutoDJNative;
  if (!app) return;   // en un navegador no hay app detrás

  checkUpdate(app.version());

  window.autodjCommand = c => {
    if (c === 'next') skip();
    else if (c === 'toggle' || (c === 'play') !== isRunning()) togglePlay();
  };

  let last = '';
  setInterval(() => {
    const d = S.mix ? S.mix.nd : S.cur, playing = isRunning();
    const key = d ? d.t.id + '|' + playing + '|' + !!S.mix : '';
    if (key === last) return;
    last = key;
    if (!d) return app.stopped();
    // «Artista - Título» → dos líneas
    const i = d.t.name.indexOf(' - ');
    const title = i > 0 ? d.t.name.slice(i + 3) : d.t.name, artist = i > 0 ? d.t.name.slice(0, i) : '';
    app.nowPlaying(d.t.vid || '', title, S.mix ? 'Mezclando · ' + artist : artist, playing,
      Math.round(d.t.dur * 1000), Math.round(Math.max(0, pos(d)) * 1000), d.rate);
  }, 500);
}
