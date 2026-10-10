// Arranque de la aplicación.
import { S } from './state.js';
import { tick, isRunning } from './mixer.js';
import { initEq } from './eq.js';
import { initYouTube } from './youtube.js';
import { initUi, paint } from './ui.js';
import { initNative } from './native.js';
import { initAuth } from './auth.js';

window.autodj = S; // para inspeccionar el estado desde la consola del navegador
initEq();
initYouTube();
initUi();
initNative();
initAuth();
setInterval(tick, 200);

// Mientras suena, se pide al aparato que no apague la pantalla: en celulares, al bloquearse se corta la mezcla.
let wake = null;
async function keepAwake() {
  if (!navigator.wakeLock || document.visibilityState !== 'visible') return;
  const on = isRunning();
  if (on && !wake) {
    try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => wake = null); } catch {}
  } else if (!on && wake) { wake.release(); wake = null; }
}
setInterval(keepAwake, 2000);
document.addEventListener('visibilitychange', keepAwake);
(function loop() { paint(); requestAnimationFrame(loop); })();
