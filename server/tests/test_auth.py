import json
import os
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.app import app
from server.auth import COOKIE, LOGIN_ATTEMPTS, SESSION_SECONDS, login_store, password_hash

PASSWORD = "test-only-password-2026"
TOKEN = "internal-test-only-token-0123456789012345"


@pytest.fixture
def protected(tmp_path, monkeypatch):
    path = tmp_path / "login.json"
    salt = "11" * 16
    path.write_text(json.dumps({"version": 1, "username": "admin", "salt": salt, "passwordHash": password_hash(PASSWORD, salt), "internalToken": TOKEN}))
    monkeypatch.setenv("ENCLOSURE_AUTH_FILE", str(path))
    monkeypatch.setenv("ENCLOSURE_AUTH_REQUIRED", "1")
    return TestClient(app)


def login(client, password=PASSWORD, **kwargs):
    return client.post("/api/auth/login", json={"username": "admin", "password": password}, **kwargs)


def test_auth_guards_all_business_routes_and_does_not_return_secrets(protected):
    status = protected.get("/api/auth/status")
    assert status.json() == {"enabled": True, "authenticated": False, "username": None}
    assert status.headers["cache-control"] == "no-store"
    for path in ("/api/health", "/api/ai/config", "/docs", "/openapi.json"):
        assert protected.get(path).status_code == 401
    for path in ("/api/preview", "/api/validate", "/api/export", "/api/analyze", "/api/coupon", "/api/ai/chat", "/api/ai/annotate", "/api/ai/settings", "/api/ai/test"):
        assert protected.post(path, json={}).status_code == 401
    response = login(protected)
    assert response.status_code == 200
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie and "Max-Age=43200" in cookie
    assert PASSWORD not in response.text and TOKEN not in response.text
    assert protected.get("/api/health").status_code == 200
    assert protected.get("/api/auth/status").json()["username"] == "admin"
    assert protected.get("/.pi-state/login.json").text.find(TOKEN) == -1


def test_logout_and_expiry_revoke_cookie_replay(protected, monkeypatch):
    assert login(protected).status_code == 200
    token = protected.cookies.get(COOKIE)
    assert protected.post("/api/auth/logout").status_code == 200
    assert protected.get("/api/health").status_code == 401
    protected.cookies.set(COOKIE, token)
    assert protected.get("/api/health").status_code == 401
    assert login(protected).status_code == 200
    import time
    now = time.time()
    monkeypatch.setattr("server.auth.time.time", lambda: now + SESSION_SECONDS + 1)
    assert protected.get("/api/health").status_code == 401


def test_login_validation_limits_and_csrf(protected):
    for headers in ({"Origin": "http://foreign.example"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}, {"Origin": "https://testserver"}):
        assert login(protected, headers=headers).status_code == 403
    assert protected.post("/api/auth/login", content="{}", headers={"Content-Type": "text/plain"}).status_code == 415
    assert protected.post("/api/auth/login", content="x" * 5000, headers={"Content-Type": "application/json"}).status_code == 413
    for value in ({}, [], {"username": 1, "password": PASSWORD}):
        assert protected.post("/api/auth/login", json=value).status_code == 422
    assert login(protected, headers={"Origin": "http://testserver"}).status_code == 200
    assert protected.post("/api/validate", json={}, headers={"Origin": "http://foreign.example"}).status_code == 403
    assert protected.post("/api/auth/logout", headers={"Origin": "http://foreign.example"}).status_code == 403
    assert protected.get("/api/health").status_code == 200


def test_wrong_password_is_throttled_per_client(protected):
    for _ in range(LOGIN_ATTEMPTS):
        assert login(protected, password="wrong").status_code == 401
    response = login(protected)
    assert response.status_code == 429 and "Retry-After" in response.headers
    different_client = TestClient(app, client=("10.0.3.99", 1234))
    assert login(different_client).status_code == 200


def test_internal_token_is_required_even_on_loopback_and_blocked_on_lan(protected):
    local = TestClient(app, client=("127.0.0.1", 1234))
    assert local.get("/api/health").status_code == 401
    assert local.get("/api/health", headers={"X-Enclosure-Internal": "wrong"}).status_code == 401
    assert local.get("/api/health", headers={"X-Enclosure-Internal": TOKEN}).status_code == 200
    remote = TestClient(app, client=("10.0.3.99", 1234))
    assert remote.get("/api/health", headers={"X-Enclosure-Internal": TOKEN}).status_code == 401
    protected.cookies.set(COOKIE, "forged-cookie")
    assert protected.get("/api/health").status_code == 401


def test_https_sets_secure_cookie(protected):
    secure = TestClient(app, base_url="https://testserver")
    response = login(secure, headers={"Origin": "https://testserver"})
    assert response.status_code == 200
    assert "; Secure" in response.headers["set-cookie"]


def test_missing_or_invalid_required_config_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setenv("ENCLOSURE_AUTH_REQUIRED", "1")
    assert TestClient(app).get("/api/health").status_code == 503
    invalid = tmp_path / "invalid.json"
    invalid.write_text("{}")
    monkeypatch.setenv("ENCLOSURE_AUTH_FILE", str(invalid))
    assert TestClient(app).get("/api/auth/status").status_code == 503


def test_proxy_forwards_internal_auth_after_login(protected, monkeypatch):
    import httpx
    seen = []
    original = httpx.AsyncClient

    async def upstream(request):
        seen.append(request)
        return httpx.Response(200, json={"configured": True})

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(upstream), **kwargs))
    assert login(protected).status_code == 200
    response = protected.get("/api/ai/config")
    assert response.status_code == 200
    assert seen[0].headers["x-enclosure-internal"] == TOKEN
    assert TOKEN not in response.text


def test_local_setup_creates_hash_and_private_files_without_printing_password(tmp_path, monkeypatch):
    root = Path(__file__).parents[2]
    path = tmp_path / "config/login.json"
    monkeypatch.setenv("ENCLOSURE_AUTH_FILE", str(path))
    env = {**os.environ, "PYTHONPATH": str(root)}
    result = subprocess.run([str(root / ".venv/bin/python"), str(root / "scripts/setup_login.py")], env=env, cwd=root, capture_output=True, text=True, check=True)
    config = json.loads(path.read_text())
    password = path.with_name("login-password.txt").read_text().split("密码：")[1].strip()
    assert password not in result.stdout and password not in path.read_text()
    assert config["passwordHash"] == password_hash(password, config["salt"])
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700
    again = subprocess.run([str(root / ".venv/bin/python"), str(root / "scripts/setup_login.py")], env=env, cwd=root, capture_output=True, check=True)
    assert json.loads(path.read_text()) == config
