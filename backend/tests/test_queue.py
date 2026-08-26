import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import TaskQueue


def test_submit_executa_com_slots_e_fila_fifo():
    q = TaskQueue(max_concurrent=1)
    order = []

    def make_fn(name, delay):
        def fn(task):
            order.append(name)
            time.sleep(delay)
            q.set(task["id"], status="completed", progress="100%")
        return fn

    q.submit(make_fn("a", 0.2), {"title": "A"})
    q.submit(make_fn("b", 0.05), {"title": "B"})
    time.sleep(0.5)
    assert order == ["a", "b"]
    assert q.get(q.snapshot()[1]["id"])["status"] == "completed"


def test_cancel_marca_cancelada():
    q = TaskQueue(max_concurrent=2)
    task_id = q.submit(lambda t: time.sleep(5), {"title": "X"})
    assert q.cancel(task_id) is True
    assert q.get(task_id)["status"] == "cancelled"
    assert q.cancel("inexistente") is False


def test_persist_load_interrompe_ativos(tmp_path):
    q = TaskQueue(max_concurrent=2)
    q.submit(lambda t: None, {"id": "t1", "title": "A", "status": "downloading"})
    q.submit(lambda t: None, {"id": "t2", "title": "B", "status": "completed"})
    path = tmp_path / "history.json"
    q.persist(path)

    q2 = TaskQueue()
    q2.load(path)
    assert q2.get("t1")["status"] == "interrupted"
    assert q2.get("t2")["status"] == "completed"


def test_history_so_terminal():
    q = TaskQueue()
    q.submit(lambda t: None, {"id": "a", "title": "A", "status": "downloading"})
    q.submit(lambda t: None, {"id": "b", "title": "B", "status": "completed"})
    q.submit(lambda t: None, {"id": "c", "title": "C", "status": "error"})
    ids = [t["id"] for t in q.history()]
    assert set(ids) == {"b", "c"}


def test_cancel_nao_e_sobrescrito_por_thread():
    q = TaskQueue(max_concurrent=2)
    task_id = q.submit(
        lambda t: (time.sleep(0.05), q.set(t["id"], status="completed"))[1],
        {"title": "X"},
    )
    q.cancel(task_id)
    time.sleep(0.3)
    assert q.get(task_id)["status"] == "cancelled"
