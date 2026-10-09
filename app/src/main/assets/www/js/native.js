// Puente con la app de Android: le cuenta qué suena (para la notificación y la pantalla de bloqueo)
// y recibe los botones de pausa y siguiente que el usuario toca fuera de la app.
import { S } from './state.js';
import { togglePlay, skip, pos, isRunning } from './mixer.js';

export function initNative() {
  const app = window.AutoDJNative;
  if (!app) return;   // en un navegador no hay app detrás

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
