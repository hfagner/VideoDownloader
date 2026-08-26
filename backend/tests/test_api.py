import sys
import threading
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


def test_analyze_ok(monkeypatch, client):
    fake = {"title": "T", "duration": 10, "source": "ytdlp", "best_id": "h1",
            "formats": [{"id": "h1", "resolution": "1080p"}]}
    monkeypatch.setattr(srv.analyzer, "analyze_url",
                        lambda url, referer=None, cookies_list=None, default_quality="1080p": fake)
    r = client.post("/api/analyze", json={"url": "https://www.youtube.com/watch?v=x"})
    assert r.status_code == 200
    assert r.get_json()["title"] == "T"


def test_analyze_sem_url_400(monkeypatch, client):
    monkeypatch.setattr(srv.analyzer, "analyze_url",
                        lambda **kw: (_ for _ in ()).throw(srv.analyzer.AnalyzeError("URL nao fornecida", 400)))
    r = client.post("/api/analyze", json={})
    assert r.status_code == 400
    assert "error" in r.get_json()


def test_analyze_falha_ytdlp_502(monkeypatch, client):
    monkeypatch.setattr(srv.analyzer, "analyze_url",
                        lambda **kw: (_ for _ in ()).throw(srv.analyzer.AnalyzeError("falhou")))
    r = client.post("/api/analyze", json={"url": "https://www.youtube.com/watch?v=x"})
    assert r.status_code == 502
    assert "falhou" in r.get_json()["error"]


def test_config_get_post_round_trip(client, tmp_path):
    r = client.get("/api/config")
    assert r.status_code == 200
    assert r.get_json()["default_quality"] == "1080p"
    r = client.post("/api/config", json={"default_quality": "720p",
                                         "download_dir": str(tmp_path / "dl")})
    assert r.status_code == 200
    assert client.get("/api/config").get_json()["default_quality"] == "720p"


def test_open_file_valida_caminho(client, tmp_path):
    # define a pasta de downloads como tmp_path para a validacao
    client.post("/api/config", json={"download_dir": str(tmp_path)})
    # fora da pasta (traversal) → 400
    assert client.post("/api/open-file",
                       json={"path": "C:\\Windows\\System32\\notepad.exe"}).status_code == 400
    # dentro da pasta mas inexistente → 404 (absoluto e relativo)
    assert client.post("/api/open-file", json={"path": str(tmp_path / "x.mp4")}).status_code == 404
    assert client.post("/api/open-file", json={"path": "video.mp4"}).status_code == 404


def test_shutdown_agenda(client, monkeypatch):
    called = {}
    monkeypatch.setattr(srv, "shutdown_app", lambda: called.setdefault("ok", True))
    r = client.post("/api/shutdown")
    assert r.status_code == 200 and r.get_json() == {"ok": True}


def test_download_sem_url_400(client):
    r = client.post("/api/download", json={})
    assert r.status_code == 400
    assert "error" in r.get_json()


def test_download_audio_mapeia_format_type(client, monkeypatch):
    calls = {}

    def fake_task(queue, task, **kwargs):
        calls.update(kwargs)
        queue.set(task["id"], status="completed")

    monkeypatch.setattr(srv, "download_task", fake_task)
    r = client.post("/api/download", json={"url": "https://x/v.mp4", "audio": True,
                                           "filename": "Aula/1.mp3"})
    assert r.status_code == 202
    assert r.get_json()["task_id"]
    assert calls["format_type"] == "audio"


def test_download_sanitiza_filename(client, monkeypatch):
    calls = {}

    def fake_task(queue, task, **kwargs):
        calls.update(kwargs)
        queue.set(task["id"], status="completed")

    monkeypatch.setattr(srv, "download_task", fake_task)
    client.post("/api/download", json={"url": "https://x/v.mp4", "filename": "A/B?C*"})
    assert calls["filename"] == "A-B-C-"


def test_status_le_da_fila(client):
    def fn(task):
        srv.QUEUE.set(task["id"], progress="50%")

    task_id = srv.QUEUE.submit(fn, {"title": "X"})
    r = client.get(f"/api/status/{task_id}")
    assert r.status_code == 200
    assert r.get_json()["title"] == "X"
    assert client.get("/api/status/nao-existe").status_code == 404


def test_outtmpl_remove_extensao_do_usuario(monkeypatch, tmp_path):
    monkeypatch.setattr(srv, "download_dir", lambda: str(tmp_path))
    assert srv._outtmpl_for("Aula 1.mp4") == str(tmp_path / "Aula 1")
    assert srv._outtmpl_for("").endswith("%(title)s.%(ext)s")


def test_final_name_audio_e_video():
    assert srv._final_name_for("C:/dl/Aula 1", True, {}, True) == "Aula 1.mp3"
    assert srv._final_name_for("C:/dl/Aula 1", False, {"requested_formats": [{}, {}]}, True) == "Aula 1.mp4"
    assert srv._final_name_for("C:/dl/Aula 1", False, {"ext": "webm"}, True) == "Aula 1.webm"
    assert srv._final_name_for("C:/dl/Titulo Extraido.mp4", False, {}, False) == "Titulo Extraido.mp4"
    assert srv._final_name_for("C:/dl/Titulo.webm", True, {}, False) == "Titulo.mp3"


def test_record_final_size_grava_tamanho(monkeypatch):
    q = srv.TaskQueue()
    task_id = q.submit(lambda t: None, {"title": "X"})
    monkeypatch.setattr(srv.os.path, "isfile", lambda p: True)
    monkeypatch.setattr(srv.os.path, "getsize", lambda p: 12345)
    srv._record_final_size(q, task_id, "Aula 1.mp4")
    assert q.get(task_id)["size"] == 12345


def test_finalize_file_renomeia_direto_sem_extensao(monkeypatch, tmp_path):
    """Reproduz o bug do download direto com filename do usuario: o outtmpl
    sem %(ext)s faz o yt-dlp gravar 'matriz-teste' (sem extensao) no disco,
    enquanto o historico registra 'matriz-teste.mp4'. O _finalize_file deve
    renomear o arquivo real para o nome final e gravar o size na task."""
    q = srv.TaskQueue()
    task_id = q.submit(lambda t: None, {"title": "X"})
    monkeypatch.setattr(srv, "download_dir", lambda: str(tmp_path))
    (tmp_path / "matriz-teste").write_bytes(b"x" * 100)

    srv._finalize_file(q, task_id,
                       str(tmp_path / "matriz-teste"), "matriz-teste.mp4")

    assert (tmp_path / "matriz-teste.mp4").exists()
    assert (tmp_path / "matriz-teste.mp4").read_bytes() == b"x" * 100
    assert not (tmp_path / "matriz-teste").exists()
    assert q.get(task_id).get("size") == 100


def test_finalize_file_nao_renomeia_quando_nome_ja_correto(monkeypatch, tmp_path):
    q = srv.TaskQueue()
    task_id = q.submit(lambda t: None, {"title": "X"})
    monkeypatch.setattr(srv, "download_dir", lambda: str(tmp_path))
    (tmp_path / "Titulo.mp4").write_bytes(b"y" * 50)

    srv._finalize_file(q, task_id, str(tmp_path / "Titulo.mp4"), "Titulo.mp4")

    assert (tmp_path / "Titulo.mp4").exists()
    assert q.get(task_id).get("size") == 50


def test_cors_permite_extensao_e_bloqueia_web(client):
    r_ok = client.get("/api/ping", headers={"Origin": "chrome-extension://abcdefghijklmnop"})
    assert r_ok.headers.get("Access-Control-Allow-Origin") == "chrome-extension://abcdefghijklmnop"
    r_bad = client.get("/api/ping", headers={"Origin": "https://evil.example.com"})
    assert "Access-Control-Allow-Origin" not in r_bad.headers


def test_hls_output_name_remove_extensao_da_fonte():
    assert srv._hls_output_name("hotmart_abc.mp4") == "hotmart_abc.mp4"
    assert srv._hls_output_name("stream.m3u8") == "stream.mp4"
    assert srv._hls_output_name(None) == "hotmart_video.mp4"
