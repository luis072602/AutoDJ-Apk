// Inicio de sesión obligatorio. Las cuentas viven en Supabase, que guarda las contraseñas cifradas (hash bcrypt):
// la app nunca las almacena, solo conserva la «sesión» que Supabase entrega al entrar.
// También: recuperar la contraseña con un código enviado al correo, y el acceso a las tablas de la cuenta (rest()).
import { $, bus } from './state.js';
import * as config from './config.js';

const STORE = 'adj_session';
// En el servidor de pruebas (dev_server.py) se puede forzar con ?cuentas=prueba para ver la pantalla sin Supabase
const MOCK = new URLSearchParams(location.search).get('cuentas') === 'prueba';
const URL_ = MOCK ? location.origin : config.SUPABASE_URL, KEY = MOCK ? 'mock' : config.SUPABASE_KEY;
const CODE_LEN = 6;   // dígitos del código que llega al correo (Supabase → Authentication → Email OTP Length)
let session = null;   // { refresh, email, name, keep } guardado en el teléfono
let access = null;    // { token, exp } solo en memoria: permiso de corta duración para leer y guardar listas

const ERRORS = [
  [/invalid login credentials/i, 'Correo o contraseña incorrectos'],
  [/already registered|already been registered|user already exists/i, 'Ya existe una cuenta con ese correo'],
  [/should be different from the old/i, 'La nueva contraseña debe ser distinta a la anterior'],
  [/password should be at least|weak password|password.*(contain|characters)/i, 'La contraseña es muy corta o muy fácil de adivinar'],
  [/valid email|invalid format|email address .* invalid/i, 'Escribe un correo válido'],
  [/email not confirmed/i, 'Confirma tu correo con el enlace que te enviamos y vuelve a entrar'],
  [/token has expired|otp.*(expired|invalid)|invalid.*(otp|token)/i, 'El código no es correcto o ya venció'],
  [/only request this after (\d+) seconds?/i, m => 'Espera ' + m[1] + ' segundos para pedir otro código'],
  [/error sending|smtp|unable to send/i, 'No se pudo enviar el correo. Inténtalo más tarde'],
  [/banned/i, 'Esta cuenta fue bloqueada'],
  [/rate limit|too many/i, 'Demasiados intentos; espera un momento'],
  [/signups? (are )?(not allowed|disabled)/i, 'El registro de cuentas nuevas está cerrado']
];
function explain(j, status) {
  const msg = (j && (j.msg || j.error_description || j.message || j.error)) || '';
  for (const [re, out] of ERRORS) { const m = msg.match(re); if (m) return typeof out === 'function' ? out(m) : out; }
  return msg || 'Error ' + status;
}

// Petición a Supabase. Lanza Error con .offline si no hubo red, .down si el servicio falló y .status.
async function call(path, { method = 'POST', body, bearer } = {}) {
  let r;
  try {
    r = await fetch(URL_ + path, {
      method,
      headers: { apikey: KEY, 'Content-Type': 'application/json', ...(bearer && { Authorization: 'Bearer ' + bearer }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch { throw Object.assign(new Error('Sin conexión a internet'), { offline: true }); }
  const j = await r.json().catch(() => null);
  // .down: el servicio falló (5xx) o está en pausa; no es culpa de la cuenta
  if (!r.ok) throw Object.assign(new Error(explain(j, r.status)), { down: r.status >= 500, status: r.status, code: j && j.code });
  return j === null ? {} : j;
}
const api = (path, body) => call('/auth/v1/' + path, { body });

// «Mantener la sesión»: si no se marca, se olvida al cerrar la app
function save(s, keep) {
  const meta = s.user && s.user.user_metadata || {};
  session = { refresh: s.refresh_token, email: s.user && s.user.email || '', name: meta.name || '', keep };
  if (s.access_token) access = { token: s.access_token, exp: Date.now() + (s.expires_in || 3600) * 1000 };
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
// Supabase renueva la sesión en cada uso del permiso largo, así que se hace una sola renovación a la vez
let renewing = null;
async function token() {
  if (!session) throw new Error('Sin sesión');
  if (access && access.exp - Date.now() > 60000) return access.token;
  renewing = renewing || api('token?grant_type=refresh_token', { refresh_token: session.refresh })
    .then(s => save(s, session.keep)).finally(() => renewing = null);
  await renewing;
  return access.token;
}
export const account = () => session && session.email;
export const cloudReady = () => !!(URL_ && KEY);
// rest('playlists?select=*') → filas de la tabla, solo las de esta cuenta (las reglas de Supabase lo aseguran)
export async function rest(path, { method = 'GET', body, prefer } = {}) {
  const t = await token();
  let r;
  try {
    r = await fetch(URL_ + '/rest/v1/' + path, {
      method,
      headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(prefer && { Prefer: prefer }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch { throw Object.assign(new Error('Sin conexión a internet'), { offline: true }); }
  const j = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(j && j.message || 'Error ' + r.status), { status: r.status, code: j && j.code });
  return j;
}

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
      ? await api('token?grant_type=password', { email, password })
      : await api('signup', { email, password, data: { name } });
    if (s.refresh_token) { save(s, keep); enter(); }
    else { show('login'); say('Cuenta creada. Confirma tu correo con el enlace que te enviamos y luego entra.', true); }
  } catch (err) { say(err.message); }
  $('#authGo').disabled = false;
}

// ---------- Olvidé mi contraseña ----------
// Pasos: correo → ¿existe la cuenta? → código al correo → verificar (círculo giratorio) → contraseña nueva
const R = { step: 'email', email: '', s: null, wait: 0, timer: 0 };
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

// ¿Hay una cuenta con este correo? null = no se pudo saber (la función aún no existe en Supabase)
async function exists(email) {
  try { return await call('/rest/v1/rpc/email_exists', { body: { p_email: email } }) === true; }
  catch (err) { if (err.offline) throw err; return null; }
}

// Cuenta regresiva para «Reenviar código» (Supabase permite uno por minuto)
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
  await api('recover', { email: R.email });
  $('#recSent').innerHTML = 'Enviamos un código de ' + CODE_LEN + ' dígitos a <b></b>. Puede tardar un minuto; revisa también «Spam».';
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
  if (code.length < CODE_LEN) return rsay('Escribe los ' + CODE_LEN + ' dígitos del código');
  $('#recGo').disabled = true; $('#recCode').disabled = true;
  rsay('');
  spin('run');
  const started = Date.now();
  let s = null, err = null;
  try { s = await api('verify', { type: 'recovery', email: R.email, token: code }); } catch (e) { err = e; }
  await new Promise(r => setTimeout(r, Math.max(0, 1200 - (Date.now() - started))));   // que el círculo se alcance a ver
  if (s && s.access_token) {
    R.s = s;
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
      await sendCode();
      recStep('code');
    } catch (err) { rsay(err.message); }
    btn.disabled = false;
  } else if (R.step === 'code') verify();
  else if (passTyped()) {
    btn.disabled = true; rsay('Guardando…', true);
    try {
      await call('/auth/v1/user', { method: 'PUT', body: { password: $('#recPass').value }, bearer: R.s.access_token });
      save(R.s, $('#authKeep').checked);
      R.s = null;
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
  // Al completar los dígitos se verifica solo
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

// Al abrir la app: si hay sesión guardada se valida con Supabase. Si la cuenta fue borrada o bloqueada, vuelve al login.
// Sin internet se deja pasar con la sesión guardada (de todos modos sin red no hay música que buscar).
export async function initAuth() {
  if (!URL_ || !KEY) return;   // aún sin configurar: la app no pide sesión
  $('#authForm').onsubmit = submit;
  $('#authSwap').onclick = () => show($('#auth').dataset.mode === 'login' ? 'signup' : 'login');
  $('#authPass').oninput = e => { if ($('#auth').dataset.mode === 'signup') checkRules($('#authRules'), e.target.value); };
  $('#logout').onclick = () => {
    forget(); $('#account').hidden = true;
    bus.dispatchEvent(new Event('logout'));
    show('login');
  };
  initRec();

  session = load();
  if (!session) return show('login');
  try {
    save(await api('token?grant_type=refresh_token', { refresh_token: session.refresh }), session.keep);
    enter();
  } catch (err) {
    if (err.offline || err.down) return enter();   // sin red o con Supabase caído no se echa a nadie
    const blocked = err.message === 'Esta cuenta fue bloqueada';
    forget(); show('login'); say(blocked ? err.message : 'Tu sesión terminó. Vuelve a entrar.');
  }
}
