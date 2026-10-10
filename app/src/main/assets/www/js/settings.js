// Ajustes: color de la interfaz. (La cuenta la maneja auth.js y la versión, native.js.)
import { $, bus } from './state.js';

// a = color principal (deck A, botones); b = color del deck B, elegido para que contraste con a
const THEMES = {
  violeta: { n: 'Violeta', a: '#7c7cff', b: '#ff8a4f' },
  azul: { n: 'Azul', a: '#3b82f6', b: '#ff8a4f' },
  verde: { n: 'Verde', a: '#10a37f', b: '#ff8a4f' },
  rosa: { n: 'Rosa', a: '#ec4899', b: '#38bdf8' },
  rojo: { n: 'Rojo', a: '#ef4444', b: '#38bdf8' }
};

function apply(key) {
  const k = THEMES[key] ? key : 'violeta', t = THEMES[k], root = document.documentElement.style;
  root.setProperty('--a', t.a);
  root.setProperty('--b', t.b);
  document.querySelectorAll('#themes button').forEach(b => b.classList.toggle('on', b.dataset.t === k));
  $('#themeN').textContent = t.n;
  try { localStorage.setItem('adj_theme', k); } catch {}
  bus.dispatchEvent(new Event('theme'));   // los lienzos (onda, espectro) vuelven a leer los colores
}

export function initSettings() {
  $('#themes').innerHTML = Object.entries(THEMES).map(([k, t]) =>
    `<button data-t="${k}" style="--sw:${t.a}" aria-label="${t.n}" title="${t.n}"></button>`).join('');
  $('#themes').onclick = e => { const k = e.target.dataset.t; if (k) apply(k); };
  let saved = 'violeta';
  try { saved = localStorage.getItem('adj_theme') || saved; } catch {}
  apply(saved);
}
