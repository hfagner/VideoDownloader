import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server as srv


class FakeServer:
    def __init__(self, ok=True):
        self.ok = ok
        self.closed = False

    def close(self):
        self.closed = True


def test_find_free_port_primeira_disponivel(monkeypatch):
    def fake_create(app, host, port):
        if port == 5000:
            return FakeServer()
        raise OSError("ocupada")

    monkeypatch.setattr(srv, "create_server", fake_create)
    server, port = srv.find_free_port()
    assert port == 5000


def test_find_free_port_pula_ocupadas(monkeypatch):
    def fake_create(app, host, port):
        if port in (5000, 5001):
            raise OSError("ocupada")
        return FakeServer()

    monkeypatch.setattr(srv, "create_server", fake_create)
    server, port = srv.find_free_port()
    assert port == 5002
    server.close()


def test_find_free_port_todas_ocupadas(monkeypatch):
    monkeypatch.setattr(srv, "create_server", lambda *a, **k: (_ for _ in ()).throw(OSError("x")))
    try:
        srv.find_free_port()
        assert False, "deveria lançar OSError"
    except OSError:
        pass


def test_is_running_confirma_service(monkeypatch):
    class FakeResp:
        def __init__(self, payload):
            self.status_code = 200 if payload else 404
            self._payload = payload

        def json(self):
            return self._payload

    monkeypatch.setattr(srv.req, "get",
                        lambda *a, **k: FakeResp({"ok": True, "service": "edge-video-downloader"}))
    assert srv.is_running(5000) is True
    monkeypatch.setattr(srv.req, "get",
                        lambda *a, **k: FakeResp({"ok": True, "service": "outro-app"}))
    assert srv.is_running(5000) is False
