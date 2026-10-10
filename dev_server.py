"""Servidor de pruebas para la interfaz de la app, sin Android.

Imita en el PC las rutas /api/… que en el teléfono atiende YouTube.java, usando yt-dlp.
Solo sirve para revisar la interfaz en un navegador:   py dev_server.py   →  http://localhost:8095
"""
import json
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import yt_dlp

WWW = Path(__file__).resolve().parent / "app/src/main/assets/www"
CACHE = Path(__file__).resolve().parent / "cache"
QUIET = {"quiet": True, "no_warnings": True, "noprogress": True}
VID = re.compile(r"^[\w-]{11}$")
USERS = {}   # cuentas de mentira para probar la pantalla de entrada (?cuentas=prueba)


def items_of(info):
    out = []
    for e in info.get("entries") or [info]:
        if e and VID.match(e.get("id") or "") and e.get("title"):
            out.append({"vid": e["id"], "name": e["title"], "len": e.get("duration") or 0})
    return out


def listing(target):
    with yt_dlp.YoutubeDL({**QUIET, "extract_flat": "in_playlist", "skip_download": True}) as y:
        info = y.extract_info(target, download=False)
    return {"title": info.get("title") or "", "items": items_of(info)}


def audio(vid):
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
        if not u.path.startswith("/api/"):
            return super().do_GET()
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/api/search":
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

    # Imitación mínima de /auth/v1 de Supabase (cuentas en memoria)
    def do_POST(self):
        u = urlparse(self.path)
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        grant = parse_qs(u.query).get("grant_type", [""])[0]

        def session(email):
            self.send_json({"refresh_token": "r-" + email, "user": {"email": email, "user_metadata": {"name": USERS[email][1]}}})

        if u.path == "/auth/v1/signup":
            if body["email"] in USERS:
                return self.send_json({"msg": "User already registered"}, 422)
            USERS[body["email"]] = (body["password"], body.get("data", {}).get("name", ""))
            return session(body["email"])
        if u.path == "/auth/v1/token" and grant == "password":
            if USERS.get(body["email"], ("",))[0] != body["password"]:
                return self.send_json({"error_description": "Invalid login credentials"}, 400)
            return session(body["email"])
        if u.path == "/auth/v1/token" and grant == "refresh_token":
            email = body["refresh_token"][2:]
            return session(email) if email in USERS else self.send_json({"msg": "Invalid Refresh Token"}, 400)
        self.send_json({"error": "No existe"}, 404)

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
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
