"""Pruebas de regresión de AutoDJ: lo que tiene que seguir funcionando después de cualquier cambio.

Corren en un navegador sin ventana contra dev_server.py con cuentas de prueba (no tocan Supabase ni YouTube).
En el PC:   py -m pytest pruebas
"""
import uuid

from playwright.sync_api import expect

STRONG = "Prueba#2026"


def fill(page, sel, value):
    page.locator(sel).fill(value)


def register(page, email=None, password=STRONG, name="Prueba"):
    email = email or f"p{uuid.uuid4().hex[:8]}@prueba.local"
    page.click("#authSwap")
    fill(page, "#authName", name)
    fill(page, "#authEmail", email)
    fill(page, "#authPass", password)
    page.click("#authGo")
    expect(page.locator("#auth")).to_be_hidden()
    return email


def login(page, email, password=STRONG):
    fill(page, "#authEmail", email)
    fill(page, "#authPass", password)
    page.click("#authGo")


def tab(page, name):
    page.click(f"#tabs [data-tab={name}]")


# Canciones de YouTube de mentira (no se reproducen; sirven para la cola y las listas)
FAKE = [{"vid": f"{c * 11}", "name": f"Artista {c.upper()} - Canción {c}", "len": 200} for c in "abcd"]


def add_fake(page, items=FAKE):
    return page.evaluate("async items => (await import('/js/library.js')).addTracks(items)", items)


# Canción sintética en WAV: bombo en cada tiempo al BPM pedido, platillo a contratiempo y un fondo suave
WAV_JS = """
(bpm, secs, name) => {
  const R = 22050, n = R * secs, beat = 60 / bpm, pcm = new Int16Array(n);
  let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / R, k = t % beat, h = (t + beat / 2) % beat;
    let v = .05 * Math.sin(2 * Math.PI * 220 * t);
    if (k < .15) v += Math.sin(2 * Math.PI * 55 * k) * Math.exp(-k * 25) * .9;
    if (h < .03) v += rnd() * .15 * Math.exp(-h * 120);
    pcm[i] = Math.max(-1, Math.min(1, v)) * 32767;
  }
  const buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf), s = (o, x) => [...x].forEach((c, j) => d.setUint8(o + j, c.charCodeAt(0)));
  s(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); s(8, 'WAVEfmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true);
  d.setUint16(22, 1, true); d.setUint32(24, R, true); d.setUint32(28, R * 2, true); d.setUint16(32, 2, true);
  d.setUint16(34, 16, true); s(36, 'data'); d.setUint32(40, n * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new File([buf], name + '.wav', { type: 'audio/wav' });
}
"""


# ---------- Arranque ----------

def test_la_app_carga_sin_errores(phone):
    page = phone.open()
    expect(page.locator("#auth")).to_be_visible()
    expect(page.locator("#authT")).to_have_text("Inicia sesión")


# ---------- Cuentas ----------

def test_registro_exige_las_reglas_de_contrasena(phone):
    page = phone.open()
    page.click("#authSwap")
    fill(page, "#authEmail", f"p{uuid.uuid4().hex[:8]}@prueba.local")
    fill(page, "#authPass", "hola123")
    expect(page.locator("#authRules li.ok")).to_have_count(2)        # minúscula y número
    page.click("#authGo")
    expect(page.locator("#authMsg")).to_contain_text("no cumple")
    expect(page.locator("#auth")).to_be_visible()
    fill(page, "#authPass", STRONG)
    expect(page.locator("#authRules li.ok")).to_have_count(5)
    page.click("#authGo")
    expect(page.locator("#auth")).to_be_hidden()


def test_entrar_y_salir(phone):
    page = phone.open()
    email = register(page)
    tab(page, "ajustes")
    expect(page.locator("#who")).to_contain_text(email)
    page.click("#logout")
    expect(page.locator("#auth")).to_be_visible()
    login(page, email, "Otra#2026")
    expect(page.locator("#authMsg")).to_have_text("Correo o contraseña incorrectos")
    login(page, email)
    expect(page.locator("#auth")).to_be_hidden()


def test_la_sesion_se_recuerda_al_reabrir(phone):
    page = phone.open()
    register(page)
    phone.open()
    expect(page.locator("#auth")).to_be_hidden()


def test_olvide_mi_contrasena(phone):
    page = phone.open()
    email = register(page)
    tab(page, "ajustes")
    page.click("#logout")

    page.click("#authForgot")
    fill(page, "#recEmail", "nadie@prueba.local")
    page.click("#recGo")
    expect(page.locator("#recMsg")).to_have_text("No hay ninguna cuenta con ese correo")

    fill(page, "#recEmail", email)
    page.click("#recGo")
    expect(page.locator("#recT")).to_have_text("Revisa tu correo")
    expect(page.locator("#recResend")).to_be_disabled()

    fill(page, "#recCode", "111111")                                  # código equivocado: se verifica solo
    expect(page.locator("#recSpin")).to_be_visible()
    expect(page.locator("#recMsg")).to_have_text("El código no es correcto o ya venció", timeout=8000)

    fill(page, "#recCode", "123456")                                  # el código de prueba
    expect(page.locator("#recT")).to_have_text("Crea tu nueva contraseña", timeout=8000)

    fill(page, "#recPass", "Nueva#2026")
    fill(page, "#recPass2", "Nueva#20")
    expect(page.locator("#recGo")).to_be_disabled()                   # no coinciden
    fill(page, "#recPass2", "Nueva#2026")
    expect(page.locator("#recGo")).to_be_enabled()
    page.click("#recGo")
    expect(page.locator("#auth")).to_be_hidden()

    tab(page, "ajustes")
    page.click("#logout")
    login(page, email, STRONG)                                        # la vieja ya no sirve
    expect(page.locator("#authMsg")).to_have_text("Correo o contraseña incorrectos")
    login(page, email, "Nueva#2026")
    expect(page.locator("#auth")).to_be_hidden()


# ---------- Navegación ----------

def test_pestanas_y_sonido_dentro_de_ajustes(phone):
    page = phone.open()
    register(page)
    for name in ["musica", "cola", "listas", "ajustes", "cabina"]:
        tab(page, name)
        expect(page.locator(f".view[data-view={name}]")).to_be_visible()
        expect(page.locator(".view:visible")).to_have_count(1)
    tab(page, "ajustes")
    page.click("#toSonido")
    expect(page.locator(".view[data-view=sonido]")).to_be_visible()
    expect(page.locator("#tabs [data-tab=ajustes]")).to_have_class("on")
    page.click("#sonBack")
    expect(page.locator(".view[data-view=ajustes]")).to_be_visible()


def test_modo_pro_abre_y_cierra(phone):
    page = phone.open()
    register(page)
    tab(page, "pro")
    expect(page.locator("#proAsk")).to_be_visible()
    page.click("#proNo")
    expect(page.locator("#proAsk")).to_be_hidden()
    expect(page.locator("#pro")).to_be_hidden()
    tab(page, "pro")
    page.click("#proYes")
    expect(page.locator("#pro")).to_be_visible()
    expect(page.locator(".pdeck")).to_have_count(2)
    page.click("#proExit")
    expect(page.locator("#pro")).to_be_hidden()


# ---------- Cola y listas ----------

def test_listas_guardar_cargar_agregar_borrar(phone):
    page = phone.open()
    register(page)
    assert add_fake(page) == 4
    tab(page, "listas")
    fill(page, "#lsName", "Fiesta")
    page.click("#lsSave")
    expect(page.locator("#lsList li[data-n='Fiesta'] small")).to_contain_text("4 canciones")
    expect(page.locator("#lsSync")).to_contain_text("Guardadas en tu cuenta")

    page.evaluate("() => { window.autodj.tracks = []; }")
    page.click("#lsList li[data-n='Fiesta'] [data-a=load]")
    assert page.evaluate("window.autodj.tracks.length") == 4
    page.click("#lsList li[data-n='Fiesta'] [data-a=add]")             # ya están: no se repiten
    assert page.evaluate("window.autodj.tracks.length") == 4

    page.click("#lsList li[data-n='Fiesta'] [data-a=del]")
    expect(page.locator("#lsList li[data-n='Fiesta'] [data-a=del]")).to_have_text("¿Borrar?")
    page.click("#lsList li[data-n='Fiesta'] [data-a=del]")
    expect(page.locator("#lsList li[data-n='Fiesta']")).to_have_count(0)


def test_cola_y_listas_llegan_a_otro_telefono(phone, new_phone):
    page = phone.open()
    email = register(page)
    add_fake(page)
    tab(page, "listas")
    fill(page, "#lsName", "Gym")
    page.click("#lsSave")
    page.wait_for_timeout(3800)                                       # la cola se guarda sola a los 3 s

    other = new_phone()
    p2 = other.open()
    login(p2, email)
    expect(p2.locator("#log")).to_contain_text("Recuperé tu cola: 4 canciones")
    tab(p2, "listas")
    expect(p2.locator("#lsList li[data-n='Gym']")).to_have_count(1)


def test_orden_de_la_cola(phone):
    page = phone.open()
    register(page)
    add_fake(page)
    order = page.evaluate("""async () => {
      const lib = await import('/js/library.js'), S = window.autodj;
      S.last = S.tracks[1];
      const next = lib.upcoming(3).map(t => t.vid[0]);
      S.loop = false; S.last = S.tracks[3];
      const end = lib.upcoming(3).length;
      S.loop = true;
      const wrap = lib.upcoming(1).map(t => t.vid[0]);
      return { next, end, wrap };
    }""")
    assert order == {"next": ["c", "d", "a"], "end": 0, "wrap": ["a"]}


# ---------- Motor de mezcla ----------

def test_analisis_mide_el_bpm(phone):
    page = phone.open()
    register(page)
    bpms = page.evaluate("""async wavJs => {
      const wav = eval(wavJs), { analyze } = await import('/js/analyze.js');
      const ctx = new OfflineAudioContext(1, 1, 22050), out = [];
      for (const bpm of [124, 128]) {
        const f = wav(bpm, 40, 'x'), t = { buffer: await ctx.decodeAudioData(await f.arrayBuffer()) };
        await analyze(t);
        out.push([t.bpm, t.weak, t.b0 >= 0 && t.drop >= t.b0 && t.out >= t.drop && t.end <= t.dur + .01]);
      }
      return out;
    }""", WAV_JS)
    for (bpm, weak, coherent), want in zip(bpms, [124, 128]):
        assert abs(bpm - want) < 1, f"BPM medido {bpm} en vez de {want}"
        assert not weak and coherent


def test_mezcla_automatica_cruza_a_la_siguiente(phone):
    page = phone.open()
    register(page)
    # Ambiente normal («Variado»): iguala el BPM. «Mezclar ya» hace un cruce corto, así la prueba es rápida
    result = page.evaluate("""async wavJs => {
      const wav = eval(wavJs), lib = await import('/js/library.js'), mx = await import('/js/mixer.js'), S = window.autodj;
      await lib.addFiles([wav(128, 45, 'Uno'), wav(124, 45, 'Dos'), wav(108, 45, 'Tres')]);
      if (S.tracks.length !== 3 || !S.tracks.every(t => t.an)) return { error: 'no se cargaron las canciones' };
      const wait = (ok, ms) => new Promise((res, rej) => {
        const t0 = Date.now(), iv = setInterval(() => {
          if (ok()) { clearInterval(iv); res(); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('tiempo agotado')); }
        }, 50);
      });
      mx.togglePlay();
      await wait(() => S.cur && S.ctx.state === 'running', 5000);
      await new Promise(r => setTimeout(r, 1500));
      const playing = mx.pos(S.cur) > .5;
      mx.skip();                                                     // «Mezclar ya»
      await wait(() => S.mix, 5000);
      const rate = S.mix.nd.rate;
      await wait(() => !S.mix && S.cur.t.name === 'Dos', 20000);
      const after = S.cur.rate, now = S.cur.t.name;
      mx.skip();                                                     // 124 → 108 BPM: igualar cambiaría la voz
      await wait(() => S.mix, 5000);
      return { playing, rate, after, now, far: S.mix.nd.rate };
    }""", WAV_JS)
    assert "error" not in result, result
    assert result["playing"], "La primera canción no avanzaba"
    assert abs(result["rate"] - 128 / 124) < .01, f"No igualó el BPM: velocidad {result['rate']}"
    assert abs(result["rate"] - 1) <= .05, "Cambió la velocidad más de 5 % (deforma la voz)"
    assert result["after"] == 1, "Tras la mezcla la canción no volvió a su velocidad original"
    assert result["now"] == "Dos"
    assert result["far"] == 1, f"Aceleró {abs(result['far'] - 1):.0%} una canción de BPM muy distinto (deforma la voz)"
