// Inicio de sesión obligatorio. Las cuentas viven en Supabase, que guarda las contraseñas cifradas (hash bcrypt):
// la app nunca las almacena, solo conserva la «sesión» que Supabase entrega al entrar.
import { $ } from './state.js';
import * as config from './config.js';

const STORE = 'adj_session';
// En el servidor de pruebas (dev_server.py) se puede forzar con ?cuentas=prueba para ver la pantalla sin Supabase
const MOCK = new URLSearchParams(location.search).get('cuentas') === 'prueba';
const URL_ = MOCK ? location.origin : config.SUPABASE_URL, KEY = MOCK ? 'mock' : config.SUPABASE_KEY;
let session = null;

const ERRORS = [
  [/invalid login credentials/i, 'Correo o contraseña incorrectos'],
  [/already registered|already been registered|user already exists/i, 'Ya existe una cuenta con ese correo'],
  [/password should be at least|weak password/i, 'La contraseña es muy corta o muy fácil de adivinar'],
  [/valid email|invalid format|email address .* invalid/i, 'Escribe un correo válido'],
  [/email not confirmed/i, 'Confirma tu correo con el enlace que te enviamos y vuelve a entrar'],
  [/banned/i, 'Esta cuenta fue bloqueada'],
  [/rate limit|too many/i, 'Demasiados intentos; espera un momento'],
  [/signups? (are )?(not allowed|disabled)/i, 'El registro de cuentas nuevas está cerrado']
];
function explain(j, status) {
  const msg = (j && (j.msg || j.error_description || j.message || j.error)) || '';
  const hit = ERRORS.find(([re]) => re.test(msg));
  return hit ? hit[1] : (msg || 'Error ' + status);
}

// Petición a Supabase. Lanza Error con .offline si no hubo red.
async function api(path, body) {
  let r;
  try {
    r = await fetch(URL_ + '/auth/v1/' + path, {
      method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
  } catch { throw Object.assign(new Error('Sin conexión a internet'), { offline: true }); }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(explain(j, r.status));
  return j || {};
}

// «Mantener la sesión»: si no se marca, se olvida al cerrar la app
function save(s, keep) {
  const meta = s.user && s.user.user_metadata || {};
  session = { refresh: s.refresh_token, email: s.user && s.user.email || '', name: meta.name || '', keep };
  try {
    localStorage.removeItem(STORE); sessionStorage.removeItem(STORE);
    (keep ? localStorage : sessionStorage).setItem(STORE, JSON.stringify(session));
  } catch {}
}
function load() {
  try { return JSON.parse(localStorage.getItem(STORE) || sessionStorage.getItem(STORE) || 'null'); } catch { return null; }
}
function forget() {
  session = null;
  try { localStorage.removeItem(STORE); sessionStorage.removeItem(STORE); } catch {}
}

// ---------- Pantalla ----------
function show(mode) {
  $('#auth').hidden = false;
  $('#auth').dataset.mode = mode;
  $('#authT').textContent = mode === 'login' ? 'Inicia sesión' : 'Crea tu cuenta';
  $('#authGo').textContent = mode === 'login' ? 'Entrar' : 'Registrarme';
  $('#authSwap').textContent = mode === 'login' ? '¿No tienes cuenta? Regístrate' : 'Ya tengo cuenta';
  $('#authNameBox').hidden = mode === 'login';
  $('#authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  say('');
}
function say(msg, ok = false) {
  $('#authMsg').textContent = msg;
  $('#authMsg').classList.toggle('ok', ok);
}
function enter() {
  $('#auth').hidden = true;
  $('#authPass').value = '';
  $('#who').textContent = session.name ? session.name + ' · ' + session.email : session.email;
  $('#account').hidden = false;
}

async function submit(e) {
  e.preventDefault();
  const mode = $('#auth').dataset.mode, email = $('#authEmail').value.trim(), password = $('#authPass').value;
  const name = $('#authName').value.trim(), keep = $('#authKeep').checked;
  if (!email || !password) return say('Escribe tu correo y tu contraseña');
  if (mode === 'signup' && password.length < 8) return say('La contraseña debe tener al menos 8 caracteres');
  $('#authGo').disabled = true;
  say(mode === 'login' ? 'Entrando…' : 'Creando la cuenta…', true);
  try {
    const s = mode === 'login'
      ? await api('token?grant_type=password', { email, password })
      : await api('signup', { email, password, data: { name } });
    if (s.refresh_token) { save(s, keep); enter(); }
    else { show('login'); say('Cuenta creada. Confirma tu correo con el enlace que te enviamos y luego entra.', true); }
  } catch (err) { say(err.message); }
  $('#authGo').disabled = false;
}

// Al abrir la app: si hay sesión guardada se valida con Supabase. Si la cuenta fue borrada o bloqueada, vuelve al login.
// Sin internet se deja pasar con la sesión guardada (de todos modos sin red no hay música que buscar).
export async function initAuth() {
  if (!URL_ || !KEY) return;   // aún sin configurar: la app no pide sesión
  $('#authForm').onsubmit = submit;
  $('#authSwap').onclick = () => show($('#auth').dataset.mode === 'login' ? 'signup' : 'login');
  $('#authEye').onclick = () => { const p = $('#authPass'); p.type = p.type === 'password' ? 'text' : 'password'; };
  $('#logout').onclick = () => { forget(); $('#account').hidden = true; show('login'); };

  session = load();
  if (!session) return show('login');
  try {
    save(await api('token?grant_type=refresh_token', { refresh_token: session.refresh }), session.keep);
    enter();
  } catch (err) {
    if (err.offline) return enter();
    const blocked = err.message === 'Esta cuenta fue bloqueada';
    forget(); show('login'); say(blocked ? err.message : 'Tu sesión terminó. Vuelve a entrar.');
  }
}
