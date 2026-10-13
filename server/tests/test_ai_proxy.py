import httpx
from fastapi.testclient import TestClient
from server.app import app


def test_settings_proxy_preserves_json_without_exposing_credentials(monkeypatch):
    original = httpx.AsyncClient
    seen = []

    async def upstream(request):
        seen.append(request)
        return httpx.Response(200, json={"configured": True, "settings": [{"provider": "custom"}]})

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(upstream), **kwargs))
    client = TestClient(app)
    for path in ["settings", "test"]:
        response = client.post(f"/api/ai/{path}", json={"apiKey": "test-only-key"}, headers={"Origin": "http://testserver"})
        assert response.status_code == 200
        assert "test-only-key" not in response.text
        assert seen[-1].url.path == f"/api/ai/{path}"
        assert b"test-only-key" in seen[-1].content
    assert client.post("/api/ai/settings", json={}, headers={"Origin": "https://foreign.example"}).status_code == 403
    assert client.post("/api/ai/settings", content="{}", headers={"Content-Type": "text/plain"}).status_code == 415
    assert client.post("/api/ai/settings", json={"apiKey": "x" * 20000}).status_code == 413
    assert len(seen) == 2
