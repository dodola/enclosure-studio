"""Single local administrator, password hashes and revocable browser sessions."""
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import threading
import time
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

ROOT = Path(__file__).resolve().parent.parent
COOKIE = "enclosure_session"
SESSION_SECONDS = 12 * 60 * 60
LOGIN_WINDOW = 15 * 60
LOGIN_ATTEMPTS = 8


def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, dklen=32).hex()


class LoginStore:
    def __init__(self, path, required=False):
        self.config = json.loads(Path(path).read_text()) if Path(path).exists() else None
        if not self.config and required:
            raise ValueError("登录账户尚未配置，请先运行 npm run setup:login。")
        if self.config is not None:
            c = self.config
            if c.get("version") != 1 or not isinstance(c.get("username"), str) or not c["username"] or len(bytes.fromhex(c["salt"])) != 16 or len(bytes.fromhex(c["passwordHash"])) != 32 or len(c["internalToken"]) < 32:
                raise ValueError("登录配置无效。")
        self.sessions = {}
        self.failures = {}
        self.lock = threading.Lock()

    @property
    def enabled(self):
        return self.config is not None

    def internal(self, request):
        if not self.enabled or not request.client:
            return False
        try:
            local = ipaddress.ip_address(request.client.host).is_loopback
        except ValueError:
            local = False
        token = request.headers.get("x-enclosure-internal", "")
        return local and hmac.compare_digest(token.encode(), self.config["internalToken"].encode())

    def authenticated(self, request):
        if not self.enabled:
            return True
        token = request.cookies.get(COOKIE, "")
        key = hashlib.sha256(token.encode()).hexdigest()
        with self.lock:
            expiry = self.sessions.get(key, 0)
            if expiry <= time.time():
                self.sessions.pop(key, None)
                return False
            return True

    def login(self, username, password, client):
        now = time.time()
        with self.lock:
            self.failures = {ip: values for ip, values in self.failures.items() if now - values[0] < LOGIN_WINDOW}
            start, count = self.failures.get(client, (now, 0))
            if count >= LOGIN_ATTEMPTS:
                raise HTTPException(429, "尝试次数过多，请 15 分钟后重试。", headers={"Retry-After": str(max(1, int(LOGIN_WINDOW - now + start)))})
            # Count before hashing so concurrent attempts cannot bypass the limit.
            if len(self.failures) >= 4096 and client not in self.failures:
                raise HTTPException(429, "登录请求过多，请稍后重试。")
            self.failures[client] = (start, count + 1)
        valid_password = hmac.compare_digest(password_hash(password, self.config["salt"]), self.config["passwordHash"])
        valid_username = hmac.compare_digest(username.encode(), self.config["username"].encode())
        if not (valid_password and valid_username):
            raise HTTPException(401, "用户名或密码错误。")
        token = secrets.token_urlsafe(32)
        with self.lock:
            self.failures.pop(client, None)
            self.sessions = {key: expiry for key, expiry in self.sessions.items() if expiry > now}
            if len(self.sessions) >= 256:
                self.sessions.pop(next(iter(self.sessions)))
            self.sessions[hashlib.sha256(token.encode()).hexdigest()] = now + SESSION_SECONDS
        return token

    def logout(self, token):
        with self.lock:
            self.sessions.pop(hashlib.sha256(token.encode()).hexdigest(), None)


@lru_cache(maxsize=8)
def _store(path, required):
    return LoginStore(path, required)


def login_store():
    return _store(os.environ.get("ENCLOSURE_AUTH_FILE", str(ROOT / ".pi-state/login.json")), os.environ.get("ENCLOSURE_AUTH_REQUIRED") == "1")


def check_origin(request):
    origin = request.headers.get("origin")
    if request.headers.get("sec-fetch-site") in ("cross-site", "same-site") or (origin and origin != f"{request.url.scheme}://{request.headers.get('host')}"):
        raise HTTPException(403, "只接受同源请求。")
    if origin and urlsplit(origin).path:
        raise HTTPException(403, "请求来源无效。")


class LoginMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request = Request(scope)
        protected = request.url.path.startswith("/api/") or request.url.path in ("/docs", "/redoc", "/openapi.json")
        try:
            store = login_store()
            if protected and store.enabled:
                internal = store.internal(request)
                if request.method not in ("GET", "HEAD", "OPTIONS") and not internal:
                    check_origin(request)
                public = request.url.path in ("/api/auth/status", "/api/auth/login")
                if not public and not internal and not store.authenticated(request):
                    raise HTTPException(401, "请先登录。")
        except HTTPException as error:
            response = JSONResponse({"detail": error.detail}, error.status_code, headers={"Cache-Control": "no-store", **(error.headers or {})})
            return await response(scope, receive, send)
        except (ValueError, OSError, KeyError, TypeError):
            response = JSONResponse({"detail": "登录服务配置无效，请在服务器检查登录配置。"}, 503, headers={"Cache-Control": "no-store"})
            return await response(scope, receive, send)
        await self.app(scope, receive, send)


def install_auth(app):
    app.add_middleware(LoginMiddleware)

    @app.get("/api/auth/status")
    def status(request: Request):
        store = login_store()
        authenticated = store.authenticated(request)
        return JSONResponse({"enabled": store.enabled, "authenticated": authenticated,
                             "username": store.config["username"] if store.enabled and authenticated else None}, headers={"Cache-Control": "no-store"})

    @app.post("/api/auth/login")
    async def login(request: Request):
        store = login_store()
        if not store.enabled:
            raise HTTPException(409, "登录验证尚未启用。")
        if not request.headers.get("content-type", "").startswith("application/json"):
            raise HTTPException(415, "请使用 JSON 请求。")
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > 4096:
                raise HTTPException(413, "登录请求过大。")
            chunks.append(chunk)
        try:
            body = json.loads(b"".join(chunks))
            username, password = body["username"], body["password"]
            if not isinstance(username, str) or not isinstance(password, str) or not 1 <= len(username) <= 80 or not 1 <= len(password) <= 256:
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise HTTPException(422, "请输入有效用户名和密码。") from None
        token = await run_in_threadpool(store.login, username, password, request.client.host if request.client else "unknown")
        response = JSONResponse({"enabled": True, "authenticated": True, "username": store.config["username"]}, headers={"Cache-Control": "no-store"})
        response.set_cookie(COOKIE, token, max_age=SESSION_SECONDS, httponly=True, samesite="strict", secure=request.url.scheme == "https", path="/")
        return response

    @app.post("/api/auth/logout")
    def logout(request: Request):
        store = login_store()
        store.logout(request.cookies.get(COOKIE, ""))
        response = JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})
        response.delete_cookie(COOKIE, httponly=True, samesite="strict", secure=request.url.scheme == "https", path="/")
        return response
