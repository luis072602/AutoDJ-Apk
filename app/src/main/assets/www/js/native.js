// Puente con la app de Android: le cuenta qué suena (para la notificación y la pantalla de bloqueo)
// y recibe los botones de pausa y siguiente que el usuario toca fuera de la app.
import { S, $, esc } from './state.js';
import { togglePlay, skip, pos, isRunning } from './mixer.js';
import { proNow, proCommand } from './pro.js';

const APK = 'https://github.com/luis072602/AutoDJ-Apk/releases/latest/download/AutoDJ.apk';
const build = v => +String(v).split('.').pop() || 0;   // «0.1.7» → 7: el número que sube en cada versión

// Compara la versión instalada con la última publicada y, si hay una más nueva, muestra el aviso.
// Devuelve un texto con el resultado, para el botón «Buscar actualización».
export async function checkUpdate(current) {
  let latest;
  try {
    const r = await fetch('/api/latest', { cache: 'no-store' }), j = await r.json();
    if (!r.ok) throw new Error(j.error);
    latest = j.latest;
  } catch { return 'No se pudo comprobar. Revisa tu conexión.'; }
  if (build(latest) <= build(current)) return 'Tienes la última versión.';
  const a = $('#update');
  a.href = APK;
  a.innerHTML = 'Hay una versión nueva (' + esc(latest) + ') · <b>Actualizar</b>';
  a.hidden = false;
  return 'Hay una versión nueva: ' + latest + '. Toca el aviso de arriba para instalarla.';
}

export function initNative() {
  const app = window.AutoDJNative;
  if (!app) return;   // en un navegador no hay app detrás

  // Versión instalada y comprobación de actualizaciones: al abrir, cada 6 horas y a mano desde Sonido
  const version = app.version();
  $('#ver').textContent = 'Versión ' + version;
  $('#about').hidden = false;
  $('#verCheck').onclick = async () => { $('#verMsg').textContent = 'Buscando…'; $('#verMsg').textContent = await checkUpdate(version); };
  checkUpdate(version);
  setInterval(() => checkUpdate(version), 6 * 3600 * 1000);

  window.autodjCommand = c => {
    if (S.pro) return proCommand(c);
    if (c === 'next') skip();
    else if (c === 'toggle' || (c === 'play') !== isRunning()) togglePlay();
  };

  // Dos veces por segundo mira qué suena; si cambió algo, se lo cuenta a Android.
  // En el Modo Pro se avisa desde que se entra (aunque aún no suene nada) para que la app quede
  // activa en segundo plano y Android no la frene al minimizarla.
  let last = '';
  setInterval(() => {
    let now = null;
    if (S.pro) now = proNow();
    else {
      const d = S.mix ? S.mix.nd : S.cur;
      if (d) now = { id: d.t.id, vid: d.t.vid || '', name: d.t.name, sub: S.mix ? 'Mezclando' : '', playing: isRunning(), dur: d.t.dur, pos: Math.max(0, pos(d)), rate: d.rate };
    }
    const key = now ? [now.id, now.playing, now.sub].join('|') : '';
    if (key === last) return;
    last = key;
    if (!now) return app.stopped();
    // «Artista - Título» → dos líneas
    const i = now.name.indexOf(' - ');
    const title = i > 0 ? now.name.slice(i + 3) : now.name, artist = i > 0 ? now.name.slice(0, i) : '';
    app.nowPlaying(now.vid, title, [now.sub, artist].filter(Boolean).join(' · '), now.playing,
      Math.round(now.dur * 1000), Math.round(now.pos * 1000), now.rate);
  }, 500);
}
