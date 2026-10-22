"""Preparación de las pruebas: arranca el servidor de pruebas y un navegador Chromium sin ventana.

Cada prueba recibe una página nueva (con almacenamiento limpio, como un teléfono recién instalado)
y al final se revisa que no haya habido errores de JavaScript.
"""
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def base_url():
    port = free_port()
    proc = subprocess.Popen([sys.executable, str(ROOT / "dev_server.py"), str(port)], cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=.2).close()
            break
        except OSError:
            time.sleep(.1)
    yield f"http://127.0.0.1:{port}"
    proc.terminate()


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        yield b
        b.close()


class Phone:
    """Una página con tamaño de teléfono y un registro de los errores de JavaScript."""

    def __init__(self, browser, base_url):
        self.ctx = browser.new_context(viewport={"width": 390, "height": 800})
        self.ctx.set_default_timeout(10000)
        self.base = base_url
        self.errors = []
        self.page = self.new_page()

    def new_page(self):
        page = self.ctx.new_page()
        page.on("pageerror", lambda e: self.errors.append(str(e)))
        # Los «Failed to load resource» son respuestas de error esperadas (por ejemplo, código incorrecto)
        page.on("console", lambda m: m.type == "error" and "Failed to load resource" not in m.text
                and self.errors.append(m.text))
        return page

    def open(self):
        self.page.goto(self.base + "/?cuentas=prueba")
        self.page.wait_for_function("!!(window.autodj && document.querySelector('#authForm').onsubmit)")
        return self.page


@pytest.fixture
def phone(browser, base_url):
    ph = Phone(browser, base_url)
    yield ph
    ph.ctx.close()
    assert not ph.errors, "Errores de JavaScript: " + " | ".join(ph.errors)


@pytest.fixture
def new_phone(browser, base_url):
    """Para simular un segundo teléfono (otro almacenamiento) en la misma prueba."""
    made = []

    def make():
        ph = Phone(browser, base_url)
        made.append(ph)
        return ph
    yield make
    for ph in made:
        ph.ctx.close()
        assert not ph.errors, "Errores de JavaScript: " + " | ".join(ph.errors)
