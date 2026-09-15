"""Boots the real `apps/loan-app` and a stand-in identity provider.

The four tools are stateless clients, so the only honest test drives them
through the real API: `bun apps/loan-app/src/index.ts`, booted the way Render
boots it, with a fresh `loans.db` in a temp directory. Tokens are validated
against a tiny fake that serves `/oauth2/userinfo` for two known bearer
tokens — the one endpoint of `apps/idp` (#36) the API ever calls.
"""

import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from arcade_core.schema import ToolAuthorizationContext, ToolContext, ToolSecretItem

from loan import LOAN_APP_HOST_SECRET

REPO_ROOT = Path(__file__).resolve().parents[3]
LOAN_APP_ENTRYPOINT = REPO_ROOT / "apps" / "loan-app" / "src" / "index.ts"

DANA = "alice@example.test"
RILEY = "charlie@example.test"
TOKENS = {"tok-dana": DANA, "tok-riley": RILEY}


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Userinfo(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        token = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
        email = TOKENS.get(token)
        if self.path != "/oauth2/userinfo" or email is None:
            self.send_response(401)
            self.end_headers()
            return
        body = json.dumps({"sub": email, "email": email, "email_verified": True}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_: object) -> None:
        pass


@pytest.fixture(scope="session")
def idp_port() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Userinfo)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server.server_port
    server.shutdown()


@pytest.fixture(scope="session")
def loan_app_host(idp_port: int) -> str:
    bun = shutil.which("bun")
    if bun is None:
        pytest.skip("bun is not installed; the toolkit tests drive the real apps/loan-app")

    port = _free_port()
    tmp = Path(tempfile.mkdtemp(prefix="cg-loan-toolkit-"))
    env = {
        **os.environ,
        "PORT": str(port),
        "LOANS_DB_PATH": str(tmp / "loans.db"),
        "IDP_PUBLIC_HOST": f"localhost:{idp_port}",
    }
    child = subprocess.Popen(
        [bun, str(LOAN_APP_ENTRYPOINT)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )

    host = f"localhost:{port}"
    deadline = time.time() + 20
    while True:
        try:
            with urllib.request.urlopen(f"http://{host}/health", timeout=1) as r:
                if r.status == 200:
                    break
        except Exception:
            pass
        if child.poll() is not None:
            raise RuntimeError(f"loan-app exited: {child.stderr.read().decode()}")
        if time.time() > deadline:
            child.kill()
            raise RuntimeError("loan-app did not come up")
        time.sleep(0.05)

    yield host

    child.kill()
    child.wait()
    shutil.rmtree(tmp, ignore_errors=True)


def make_context(loan_app_host: str, token: str) -> ToolContext:
    """What the Arcade engine hands a tool at runtime: a token and a secret."""
    return ToolContext(
        authorization=ToolAuthorizationContext(token=token),
        secrets=[ToolSecretItem(key=LOAN_APP_HOST_SECRET, value=loan_app_host)],
        user_id=TOKENS.get(token),
    )


@pytest.fixture
def as_dana(loan_app_host: str) -> ToolContext:
    return make_context(loan_app_host, "tok-dana")


@pytest.fixture
def as_riley(loan_app_host: str) -> ToolContext:
    return make_context(loan_app_host, "tok-riley")


@pytest.fixture
def as_nobody(loan_app_host: str) -> ToolContext:
    return make_context(loan_app_host, "tok-forged")
