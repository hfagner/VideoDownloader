import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server as srv


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(srv, "data_dir", lambda: tmp_path)
    monkeypatch.setattr(srv, "QUEUE", srv.TaskQueue(max_concurrent=1))
    srv.app.config["TESTING"] = True
    return srv.app.test_client()


def test_tasks_vazio(client):
    r = client.get("/api/tasks")
    assert r.status_code == 200
    assert r.get_json() == {"tasks": []}


def test_history_persistido(client, tmp_path):
    srv.QUEUE.submit(lambda t: None, {"id": "t1", "title": "Done", "status": "completed"})
    srv.QUEUE.persist(tmp_path / "history.json")
    r = client.get("/api/history")
    assert r.status_code == 200
    assert r.get_json()["history"][0]["title"] == "Done"


def test_cancel(client):
    srv.QUEUE.submit(lambda t: None, {"id": "t9", "title": "X"})
    r = client.post("/api/cancel/t9")
    assert r.status_code == 200 and r.get_json() == {"ok": True}
    assert client.post("/api/cancel/nao-existe").status_code == 404
