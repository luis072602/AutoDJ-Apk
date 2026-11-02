"""Servidor de pruebas para la interfaz de la app, sin Android.

Imita en el PC las rutas /api/… que en el teléfono atiende YouTube.java, usando yt-dlp.
Solo sirve para revisar la interfaz en un navegador:   py dev_server.py   →  http://localhost:8095
"""
import base64
import json
import re
import sys
import time
from http.cookies import Morsel, SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

WWW = Path(__file__).resolve().parent / "app/src/main/assets/www"
CACHE = Path(__file__).resolve().parent / "cache"
QUIET = {"quiet": True, "no_warnings": True, "noprogress": True}
VID = re.compile(r"^[\w-]{11}$")
USERS = {}   # cuentas de mentira para probar la pantalla de entrada (?cuentas=prueba)
CODES = {}   # códigos de «olvidé mi contraseña» (siempre 123456)
LISTS = {}   # listas guardadas: correo → {nombre: fila}


def fake_jwt(email):
    """Permiso con la forma de un JWT de Neon (sin firma real): dura 15 minutos."""
    part = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip("=")
    return ".".join([part({"alg": "none"}), part({"email": email, "exp": int(time.time()) + 900}), "prueba"])


def items_of(info):
    out = []
    for e in info.get("entries") or [info]:
        if e and VID.match(e.get("id") or "") and e.get("title"):
            out.append({"vid": e["id"], "name": e["title"], "len": e.get("duration") or 0})
    return out


def listing(target):
    import yt_dlp   # se carga solo si se busca música: las pruebas automáticas no lo necesitan
    with yt_dlp.YoutubeDL({**QUIET, "extract_flat": "in_playlist", "skip_download": True}) as y:
        info = y.extract_info(target, download=False)
    return {"title": info.get("title") or "", "items": items_of(info)}


def audio(vid):
    import yt_dlp
    hit = next(iter(CACHE.glob(vid + ".*")), None)
    if hit and hit.suffix != ".part":
        return hit
    opts = {**QUIET, "format": "140/251/bestaudio", "noplaylist": True, "outtmpl": str(CACHE / "%(id)s.%(ext)s")}
    with yt_dlp.YoutubeDL(opts) as y:
        return Path(y.prepare_filename(y.extract_info("https://www.youtube.com/watch?v=" + vid)))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WWW), **kw)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/rest/v1/playlists":
            return self.send_json(list(LISTS.get(self.who(), {}).values()))
        if u.path == "/auth/get-session":
            email = self.cookie_email()
            return self.send_json({"user": {"email": email, "name": USERS[email][1]}} if email in USERS else None)
        if u.path == "/auth/token":
            email = self.cookie_email()
            return self.send_json({"token": fake_jwt(email)} if email in USERS else {}, 200 if email in USERS else 401)
        if u.path == "/auth/token/anonymous":
            return self.send_json({"token": fake_jwt("")})
        if not u.path.startswith("/api/"):
            return super().do_GET()
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/api/latest":
                self.send_json({"latest": q.get("fake", "0.1.999")})
            elif u.path == "/api/search":
                r = listing("ytsearch20:" + q.get("q", ""))
                self.send_json({"items": r["items"]})
            elif u.path == "/api/playlist":
                self.send_json(listing(q.get("url", "")))
            elif u.path == "/api/audio" and VID.match(q.get("v", "")):
                p = audio(q["v"])
                self.send_response(200)
                self.send_header("Content-Type", "audio/mp4" if p.suffix == ".m4a" else "audio/webm")
                self.send_header("Content-Length", str(p.stat().st_size))
                self.end_headers()
                self.wfile.write(p.read_bytes())
            else:
                self.send_json({"error": "No existe"}, 404)
        except Exception as e:
            self.send_json({"error": str(e)[:140]}, 502)

    # Imitación mínima de Neon Auth (cuentas en memoria; la sesión es una cookie, como en Neon)
    def do_POST(self):
        u = urlparse(self.path)
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")

        def session(email):
            self.send_json({"token": "t-" + email, "user": {"email": email, "name": USERS[email][1]}},
                           cookie="sesion=" + email + "; Path=/")

        if u.path == "/auth/sign-up/email":
            if body["email"] in USERS:
                return self.send_json({"code": "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"}, 422)
            USERS[body["email"]] = (body["password"], body.get("name", ""))
            return session(body["email"])
        if u.path == "/auth/sign-in/email":
            if USERS.get(body["email"], ("",))[0] != body["password"]:
                return self.send_json({"code": "INVALID_EMAIL_OR_PASSWORD"}, 401)
            return session(body["email"])
        if u.path == "/auth/sign-out":
            return self.send_json({"success": True}, cookie="sesion=; Path=/; Max-Age=0")
        if u.path == "/auth/email-otp/send-verification-otp":
            if body["email"] in USERS:
                CODES[body["email"]] = "123456"
                print("Codigo para", body["email"], ": 123456", flush=True)
            return self.send_json({"success": True})
        if u.path == "/auth/email-otp/check-verification-otp":
            if CODES.get(body["email"]) != body["otp"]:
                return self.send_json({"code": "INVALID_OTP"}, 400)
            return self.send_json({"success": True})
        if u.path == "/auth/email-otp/reset-password":
            if CODES.get(body["email"]) != body["otp"]:
                return self.send_json({"code": "INVALID_OTP"}, 400)
            del CODES[body["email"]]
            USERS[body["email"]] = (body["password"], USERS[body["email"]][1])
            return self.send_json({"success": True})
        if u.path == "/rest/v1/rpc/email_exists":
            return self.send_json(body["p_email"].strip().lower() in USERS)
        if u.path == "/rest/v1/playlists":
            LISTS.setdefault(self.who(), {})[body["name"]] = body
            return self.send_json(None, 201)
        self.send_json({"error": "No existe"}, 404)

    def do_DELETE(self):
        u = urlparse(self.path)
        name = parse_qs(u.query).get("name", [""])[0].removeprefix("eq.")
        LISTS.get(self.who(), {}).pop(name, None)
        self.send_json(None, 204)

    # Correo de la cuenta según el permiso que manda la app
    def who(self):
        token = (self.headers.get("Authorization") or "").removeprefix("Bearer ")
        part = token.split(".")[1] if token.count(".") == 2 else ""
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)) or b"{}").get("email", "")

    def cookie_email(self):
        return SimpleCookie(self.headers.get("Cookie") or "").get("sesion", Morsel()).value or ""

    def send_json(self, obj, status=200, cookie=None):
        body = b"" if status == 204 else json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")   # que el navegador no sirva versiones viejas
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    CACHE.mkdir(exist_ok=True)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8095
    print(f"Interfaz de la app en  http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
