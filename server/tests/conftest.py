import pytest


@pytest.fixture(autouse=True)
def isolated_login_settings(tmp_path, monkeypatch):
    # Geometry tests must never depend on the actual deployed administrator.
    monkeypatch.setenv("ENCLOSURE_AUTH_FILE", str(tmp_path / "login.json"))
    monkeypatch.setenv("ENCLOSURE_AUTH_REQUIRED", "0")
