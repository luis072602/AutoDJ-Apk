// Inicio de sesión obligatorio. Las cuentas viven en Neon Auth, que guarda las contraseñas cifradas:
// la app nunca las almacena. La sesión es una cookie que solo Neon puede leer; en el teléfono queda el correo y el nombre.
// También: recuperar la contraseña con un código enviado al correo, y el acceso a las tablas de la cuenta (rest()).
import { $, bus } from './state.js';
import * as config from './config.js';

const STORE = 'adj_session';
// En el servidor de pruebas (dev_server.py) se puede forzar con ?cuentas=prueba para ver la pantalla sin Neon
const MOCK = new URLSearchParams(location.search).get('cuentas') === 'prueba';
const AUTH = MOCK ? location.origin + '/auth' : config.NEON_AUTH_URL, DATA = MOCK ? location.origin + '/rest/v1' : config.NEON_DATA_URL;
const CODE_LEN = 6;   // dígitos del código que llega al correo
let session = null;   // { email, name, keep } guardado en el teléfono
let access = null;    // { token, exp } solo en memoria: permiso de corta duración para leer y guardar listas

const ERRORS = {
  INVALID_EMAIL_OR_PASSWORD: 'Correo o contraseña incorrectos',
  USER_ALREADY_EXISTS: 'Ya existe una cuenta con ese correo',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'Ya existe una cuenta con ese correo',
  PASSWORD_TOO_SHORT: 'La contraseña es muy corta',
  PASSWORD_TOO_LONG: 'La contraseña es muy larga',
  INVALID_EMAIL: 'Escribe un correo válido',
  EMAIL_NOT_VERIFIED: 'Confirma tu correo y vuelve a entrar',
  INVALID_OTP: 'El código no es correcto o ya venció',
  OTP_EXPIRED: 'El código ya venció. Pide uno nuevo',
  TOO_MANY_ATTEMPTS: 'Demasiados intentos. Pide un código nuevo',
  BANNED_USER: 'Esta cuenta fue bloqueada',
  USER_NOT_FOUND: 'No hay ninguna cuenta con ese correo'
};
function explain(j, status) {
  if (status === 429) return 'Demasiados intentos; espera un momento';
  return (j && ERRORS[j.code]) || (j && j.message) || 'Error ' + status;
}

// Petición a Neon Auth. Lanza Error con .offline si no hubo red, .down si el servicio falló y .status.
async function call(path, { method = 'POST', body } = {}) {
  let r;
  try {
    r = await fetch(AUTH + path, {
      method,
      credentials: 'include',   // la sesión viaja en la cookie
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch { throw Object.assign(new Error('Sin conexión a internet'), { offline: true }); }
  const j = await r.json().catch(() => null);
  // .down: el servicio falló (5xx); no es culpa de la cuenta
  if (!r.ok) throw Object.assign(new Error(explain(j, r.status)), { down: r.status >= 500, status: r.status, code: j && j.code });
  return j;
}
const api = (path, body) => call('/' + path, { body });
const fetchSession = () => call('/get-session', { method: 'GET' });

// «Mantener la sesión»: si no se marca, se olvida al cerrar la app
function save(user, keep) {
  session = { email: user.email || '', name: user.name || '', keep };
  try {
    localStorage.removeItem(STORE); sessionStorage.removeItem(STORE);
    (keep ? localStorage : sessionStorage).setItem(STORE, JSON.stringify(session));
  } catch {}
}
function load() {
  try { return JSON.parse(localStorage.getItem(STORE) || sessionStorage.getItem(STORE) || 'null'); } catch { return null; }
}
function forget() {
  session = null; access = null;
  try { localStorage.removeItem(STORE); sessionStorage.removeItem(STORE); } catch {}
}

// ---------- Acceso a las tablas de la cuenta ----------
// La cookie de sesión no sirve para las tablas: se cambia por un permiso que dura 15 minutos, uno a la vez
let renewing = null;
async function token() {
  if (!session) throw new Error('Sin sesión');
  if (access && access.exp - Date.now() > 60000) return access.token;
  renewing = renewing || call('/token', { method: 'GET' }).then(j => {
    access = { token: j.token, exp: JSON.parse(atob(j.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000 };
  }).finally(() => renewing = null);
  await renewing;
  return access.token;
}
export const account = () => session && session.email;
export const cloudReady = () => !!(AUTH && DATA);
async function table(path, t, { method = 'GET', body, prefer } = {}) {
  let r;
  try {
    r = await fetch(DATA + '/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(prefer && { Prefer: prefer }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch { throw Object.assign(new Error('Sin conexión a internet'), { offline: true }); }
  const j = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(j && j.message || 'Error ' + r.status), { status: r.status, code: j && j.code });
  return j;
}
// rest('playlists?select=*') → filas de la tabla, solo las de esta cuenta (las reglas de la base de datos lo aseguran)
export async function rest(path, opts) { return table(path, await token(), opts); }

// ---------- Reglas de contraseña ----------
const RULES = [
  ['len', 'Al menos 8 caracteres', p => p.length >= 8],
  ['up', 'Una letra mayúscula', p => /\p{Lu}/u.test(p)],
  ['low', 'Una letra minúscula', p => /\p{Ll}/u.test(p)],
  ['num', 'Un número', p => /\d/.test(p)],
  ['sym', 'Un carácter especial (!@#$%…)', p => /[^\p{L}\d\s]/u.test(p)]
];
// Pinta la lista de reglas (✓ las que se cumplen) y dice si se cumplen todas
function checkRules(el, pass, again) {
  const rows = RULES.map(([k, txt, ok]) => [k, txt, ok(pass)]);
  if (again !== undefined) rows.push(['same', 'Las dos contraseñas coinciden', !!again && pass === again]);
  el.innerHTML = rows.map(([k, txt, ok]) => `<li class="${ok ? 'ok' : ''}">${txt}</li>`).join('');
  el.classList.toggle('typed', !!pass);
  return rows.every(r => r[2]);
}

// ---------- Pantalla de entrada ----------
function show(mode) {
  $('#auth').hidden = false;
  $('#authForm').hidden = false; $('#rec').hidden = true;
  $('#auth').dataset.mode = mode;
  $('#authT').textContent = mode === 'login' ? 'Inicia sesión' : 'Crea tu cuenta';
  $('#authGo').textContent = mode === 'login' ? 'Entrar' : 'Registrarme';
  $('#authSwap').textContent = mode === 'login' ? '¿No tienes cuenta? Regístrate' : 'Ya tengo cuenta';
  $('#authNameBox').hidden = mode === 'login';
  $('#authForgot').hidden = mode !== 'login';
  $('#authRules').hidden = mode === 'login';
  $('#authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  checkRules($('#authRules'), $('#authPass').value);
  say('');
}
function say(msg, ok = false, el = '#authMsg') {
  $(el).textContent = msg;
  $(el).classList.toggle('ok', ok);
}
function enter() {
  $('#auth').hidden = true;
  $('#authPass').value = '';
  $('#who').textContent = session.name ? session.name + ' · ' + session.email : session.email;
  $('#account').hidden = false;
  bus.dispatchEvent(new Event('login'));
}

async function submit(e) {
  e.preventDefault();
  const mode = $('#auth').dataset.mode, email = $('#authEmail').value.trim(), password = $('#authPass').value;
  const name = $('#authName').value.trim(), keep = $('#authKeep').checked;
  if (!email || !password) return say('Escribe tu correo y tu contraseña');
  if (mode === 'signup' && !checkRules($('#authRules'), password)) return say('La contraseña aún no cumple todas las reglas');
  $('#authGo').disabled = true;
  say(mode === 'login' ? 'Entrando…' : 'Creando la cuenta…', true);
  try {
    const s = mode === 'login'
      ? await api('sign-in/email', { email, password })
      : await api('sign-up/email', { email, password, name: name || email.split('@')[0] });
    save(s.user, keep);
    enter();
  } catch (err) { say(err.message); }
  $('#authGo').disabled = false;
}

// ---------- Olvidé mi contraseña ----------
// Pasos: correo → ¿existe la cuenta? → código al correo → verificar (círculo giratorio) → contraseña nueva
const R = { step: 'email', email: '', code: '', wait: 0, timer: 0 };
const rsay = (msg, ok) => say(msg, ok, '#recMsg');

function recStep(step) {
  R.step = step;
  document.querySelectorAll('#rec .rec-step').forEach(el => el.hidden = el.dataset.s !== step);
  $('#recT').textContent = { email: 'Recupera tu contraseña', code: 'Revisa tu correo', pass: 'Crea tu nueva contraseña' }[step];
  $('#recGo').textContent = { email: 'Enviar código', code: 'Verificar código', pass: 'Guardar y entrar' }[step];
  $('#recGo').disabled = step === 'pass';
  rsay('');
  const focus = { email: '#recEmail', code: '#recCode', pass: '#recPass' }[step];
  setTimeout(() => $(focus).focus(), 50);
}
function openRec() {
  $('#authForm').hidden = true; $('#rec').hidden = false;
  $('#recEmail').value = $('#authEmail').value.trim();
  $('#recCode').value = ''; $('#recPass').value = ''; $('#recPass2').value = '';
  spin(null);
  recStep('email');
}

// ¿Hay una cuenta con este correo? null = no se pudo saber
async function exists(email) {
  try {
    const { token: anon } = await call('/token/anonymous', { method: 'GET' });
    return await table('rpc/email_exists', anon, { method: 'POST', body: { p_email: email } }) === true;
  } catch (err) { if (err.offline) throw err; return null; }
}

// Cuenta regresiva para «Reenviar código»
function cooldown(sec) {
  clearInterval(R.timer);
  R.wait = sec;
  const paint = () => {
    $('#recResend').disabled = R.wait > 0;
    $('#recResend').textContent = R.wait > 0 ? 'Reenviar código en ' + R.wait + ' s' : 'Reenviar código';
  };
  paint();
  R.timer = setInterval(() => { R.wait--; paint(); if (R.wait <= 0) clearInterval(R.timer); }, 1000);
}

async function sendCode(again = false) {
  await api('email-otp/send-verification-otp', { email: R.email, type: 'forget-password' });
  $('#recSent').innerHTML = 'Enviamos un código a <b></b>. Vale 5 minutos y puede tardar uno en llegar; revisa también «Spam».';
  $('#recSent').querySelector('b').textContent = R.email;
  cooldown(60);
  if (again) rsay('Te enviamos un código nuevo.', true);
}

// Círculo giratorio sobre el código: null = oculto, 'run' = verificando, 'ok' = correcto, 'bad' = incorrecto
function spin(state) {
  const el = $('#recSpin');
  el.hidden = !state;
  el.className = 'verify ' + (state || '');
  $('#recSpinT').textContent = { run: 'Verificando código…', ok: 'Código correcto', bad: 'Código incorrecto' }[state] || '';
  $('#recCode').classList.toggle('dim', !!state);
}

async function verify() {
  const code = $('#recCode').value.replace(/\D/g, '');
  if (code.length < CODE_LEN) return rsay('Escribe todos los dígitos del código');
  $('#recGo').disabled = true; $('#recCode').disabled = true;
  rsay('');
  spin('run');
  const started = Date.now();
  let s = null, err = null;
  try { s = await api('email-otp/check-verification-otp', { email: R.email, type: 'forget-password', otp: code }); } catch (e) { err = e; }
  await new Promise(r => setTimeout(r, Math.max(0, 1200 - (Date.now() - started))));   // que el círculo se alcance a ver
  if (s && s.success) {
    R.code = code;
    spin('ok');
    setTimeout(() => { spin(null); recStep('pass'); }, 900);
  } else {
    spin('bad');
    setTimeout(() => {
      spin(null); rsay(err ? err.message : 'El código no es correcto o ya venció');
      $('#recCode').disabled = false; $('#recGo').disabled = false; $('#recCode').select();
    }, 900);
  }
}

function passTyped() {
  const ok = checkRules($('#recRules'), $('#recPass').value, $('#recPass2').value);
  $('#recGo').disabled = !ok;
  return ok;
}

async function recSubmit(e) {
  e.preventDefault();
  const btn = $('#recGo');
  if (R.step === 'email') {
    const email = $('#recEmail').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return rsay('Escribe un correo válido');
    btn.disabled = true; rsay('Buscando tu cuenta…', true);
    try {
      if (await exists(email) === false) { btn.disabled = false; return rsay('No hay ninguna cuenta con ese correo'); }
      R.email = email;
      rsay('Enviando el código a tu correo… (puede tardar unos segundos)', true);
      await sendCode();
      recStep('code');
    } catch (err) { rsay(err.message); }
    btn.disabled = false;
  } else if (R.step === 'code') verify();
  else if (passTyped()) {
    btn.disabled = true; rsay('Guardando…', true);
    try {
      const password = $('#recPass').value;
      await api('email-otp/reset-password', { email: R.email, otp: R.code, password });
      const s = await api('sign-in/email', { email: R.email, password });
      save(s.user, $('#authKeep').checked);
      R.code = '';
      $('#recPass').value = ''; $('#recPass2').value = '';
      enter();
      $('#log').textContent = 'Contraseña cambiada. ¡Bienvenido de nuevo!';
    } catch (err) { rsay(err.message); btn.disabled = false; }
  }
}

function initRec() {
  $('#authForgot').onclick = openRec;
  $('#recBack').onclick = () => { clearInterval(R.timer); show('login'); };
  $('#rec').onsubmit = recSubmit;
  $('#recResend').onclick = async () => {
    try { await sendCode(true); } catch (err) { rsay(err.message); }
  };
  // Al completar el código se verifica solo
  $('#recCode').oninput = e => {
    const v = e.target.value.replace(/\D/g, '').slice(0, CODE_LEN);
    if (e.target.value !== v) e.target.value = v;
    if (v.length === CODE_LEN && R.step === 'code') verify();
  };
  $('#recPass').oninput = passTyped;
  $('#recPass2').oninput = passTyped;
  document.querySelectorAll('.auth .eye').forEach(b => b.onclick = () => {
    const p = b.previousElementSibling;
    p.type = p.type === 'password' ? 'text' : 'password';
  });
}

// Las cuentas de antes de pasar a Neon no se pudieron traer: hay que registrarse otra vez.
// Sus listas siguen en el teléfono; una sola vez se marcan como pendientes para subirlas a la cuenta nueva con ese mismo correo.
function keepOldLists() {
  try {
    if (localStorage.getItem('adj_neon')) return;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith('adj_lists:')) continue;
      const j = JSON.parse(localStorage.getItem(k));
      Object.values(j.lists || {}).forEach(l => { l.dirty = true; });
      localStorage.setItem(k, JSON.stringify(j));
    }
    localStorage.setItem('adj_neon', '1');
  } catch {}
}
// Las sesiones anteriores a Neon traen «refresh»
function oldAccount(saved) {
  forget();
  show('signup');
  $('#authEmail').value = saved.email || '';
  say('Renovamos las cuentas. Regístrate otra vez con tu correo: tus listas de este teléfono se conservan.', true);
}

// Al abrir la app: si hay sesión guardada se valida con Neon. Si la cuenta fue borrada o bloqueada, vuelve al login.
// Sin internet se deja pasar con la sesión guardada (de todos modos sin red no hay música que buscar).
export async function initAuth() {
  if (!AUTH || !DATA) return;   // aún sin configurar: la app no pide sesión
  $('#authForm').onsubmit = submit;
  $('#authSwap').onclick = () => show($('#auth').dataset.mode === 'login' ? 'signup' : 'login');
  $('#authPass').oninput = e => { if ($('#auth').dataset.mode === 'signup') checkRules($('#authRules'), e.target.value); };
  $('#logout').onclick = () => {
    api('sign-out', {}).catch(() => {});
    forget(); $('#account').hidden = true;
    bus.dispatchEvent(new Event('logout'));
    show('login');
  };
  initRec();
  keepOldLists();

  session = load();
  if (!session) return show('login');
  if (session.refresh) return oldAccount(session);
  try {
    const s = await fetchSession();
    if (!s || !s.user) { forget(); show('login'); return say('Tu sesión terminó. Vuelve a entrar.'); }
    save(s.user, session.keep);
    enter();
  } catch (err) {
    if (err.offline || err.down) return enter();   // sin red o con Neon caído no se echa a nadie
    forget(); show('login'); say(err.message === ERRORS.BANNED_USER ? err.message : 'Tu sesión terminó. Vuelve a entrar.');
  }
}
