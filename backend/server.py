import json
import os
import re
import shutil
import sys
import subprocess
import threading
import time
import uuid
from pathlib import Path

import requests as req
from flask import Flask, request, jsonify
from flask_cors import CORS
import yt_dlp
from waitress import create_server

import tkinter as tk
from tkinter import messagebox

import analyzer

DEFAULT_CONFIG = {
    "download_dir": str(Path.home() / "Downloads" / "EdgeVideoDownloader"),
    "default_quality": "1080p",
    "autostart": False,
    "notifications": True,
}


def data_dir():
    """Diretorio de dados (config/historico): backend/data em dev;
    %LOCALAPPDATA%/EdgeVideoDownloader quando congelado pelo PyInstaller."""
    if getattr(sys, "frozen", False):
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        d = Path(base) / "EdgeVideoDownloader"
    else:
        d = Path(__file__).resolve().parent / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_config():
    path = data_dir() / "config.json"
    if path.exists():
        try:
            return {**DEFAULT_CONFIG, **json.loads(path.read_text(encoding="utf-8"))}
        except Exception:
            pass
    return dict(DEFAULT_CONFIG)


def save_config(cfg):
    (data_dir() / "config.json").write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def download_dir():
    return load_config()["download_dir"]


def sanitize_filename(name, default="video"):
    safe = re.sub(r"[^\w\s.-]", "-", name or "").strip()[:120]
    return safe if safe.strip(" -") else default


def _outtmpl_for(filename):
    """Template de saida do yt-dlp: usa o nome escolhido pelo usuario SEM
    extensao (o yt-dlp adiciona a correta no download/pos-processamento);
    caso contrario, o titulo extraido pelo proprio yt-dlp."""
    if filename:
        return os.path.join(download_dir(), os.path.splitext(filename)[0])
    return os.path.join(download_dir(), "%(title)s.%(ext)s")


def _final_name_for(prepared, audio, info, had_filename):
    """Nome final no disco. Com nome do usuario: audio→.mp3; merge→.mp4;
    formato unico→ext do formato. Sem nome do usuario: o prepare_filename do
    template %(ext)s ja devolve o nome correto."""
    if not had_filename:
        return os.path.basename(prepared)
    base = os.path.splitext(os.path.basename(prepared))[0]
    if audio:
        return base + ".mp3"
    if info and info.get("requested_formats"):
        return base + ".mp4"
    return base + "." + ((info or {}).get("ext") or "mp4")


def apply_autostart(enabled):
    if sys.platform != "win32":
        return
    import winreg
    key = winreg.OpenKey(
        winreg.HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        0, winreg.KEY_SET_VALUE)
    try:
        if enabled:
            winreg.SetValueEx(key, "EdgeVideoDownloader", 0, winreg.REG_SZ,
                              f'"{sys.executable}"')
        else:
            try:
                winreg.DeleteValue(key, "EdgeVideoDownloader")
            except FileNotFoundError:
                pass
    finally:
        key.Close()


DOWNLOAD_DIR = download_dir()


class TaskQueue:
    """Fila de downloads: max. N simultaneos, FIFO, estado em memoria +
    persistencia opcional em JSON."""

    def __init__(self, max_concurrent=2):
        self.max_concurrent = max_concurrent
        self._tasks = {}   # id -> dict da task
        self._fns = {}     # id -> funcao a executar
        self._queue = []   # ids aguardando slot
        self._active = set()
        self._lock = threading.Lock()

    def submit(self, fn, task):
        task.setdefault("id", str(uuid.uuid4()))
        task.setdefault("status", "queued")
        task.setdefault("progress", "0%")
        task.setdefault("created_at", time.time())
        with self._lock:
            self._tasks[task["id"]] = task
            self._fns[task["id"]] = fn
            if len(self._active) < self.max_concurrent:
                self._start(task["id"])
            else:
                self._queue.append(task["id"])
        return task["id"]

    def _start(self, task_id):
        task = self._tasks[task_id]
        if task.get("status") == "queued":
            task["status"] = "downloading"
        self._active.add(task_id)

        def runner():
            try:
                self._fns[task_id](task)
            except Exception as e:
                self.set(task_id, status="error", error=str(e))
            finally:
                self._finish(task_id)

        threading.Thread(target=runner, daemon=True).start()

    def _finish(self, task_id):
        with self._lock:
            self._active.discard(task_id)
            if self._queue:
                self._start(self._queue.pop(0))

    def set(self, task_id, **fields):
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return
            # Uma task cancelada nao pode voltar a outro estado: a thread pode
            # terminar depois do cancelamento e tentar sobrescrever o status.
            if task.get("status") == "cancelled" and fields.get("status") not in (None, "cancelled"):
                fields = {k: v for k, v in fields.items() if k != "status"}
            task.update(fields)

    def get(self, task_id):
        with self._lock:
            task = self._tasks.get(task_id)
            return dict(task) if task else {}

    def cancel(self, task_id):
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return False
            pid = task.get("ffmpeg_pid") or task.get("proc_pid")
            if pid:
                try:
                    subprocess.run(["taskkill", "/PID", str(pid), "/F", "/T"],
                                   capture_output=True, timeout=10)
                except Exception:
                    pass
            task["status"] = "cancelled"
            if task_id in self._queue:
                self._queue.remove(task_id)
            return True

    def snapshot(self, limit=50):
        with self._lock:
            tasks = sorted(self._tasks.values(),
                           key=lambda t: t.get("created_at", 0), reverse=True)
            return [dict(t) for t in tasks[:limit]]

    def history(self):
        with self._lock:
            done = [t for t in self._tasks.values()
                    if t.get("status") in ("completed", "error", "cancelled", "interrupted")]
            done.sort(key=lambda t: t.get("completed_at") or t.get("created_at") or 0,
                      reverse=True)
            return [dict(t) for t in done]

    def load(self, path):
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return
        with self._lock:
            for t in data:
                if t.get("status") in ("downloading", "queued", "merging"):
                    t["status"] = "interrupted"
                self._tasks.setdefault(t["id"], t)

    def persist(self, path):
        with self._lock:
            tasks = sorted(self._tasks.values(),
                           key=lambda t: t.get("created_at", 0))
            path.write_text(
                json.dumps(tasks[-500:], ensure_ascii=False, indent=2),
                encoding="utf-8")


QUEUE = TaskQueue(max_concurrent=2)


def _history_path():
    return data_dir() / "history.json"

app = Flask(__name__)
CORS(app)

HOST = '127.0.0.1'
PORT = 5000

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def extract_hotmart_m3u8(embed_url, referer=None):
    """
    Faz uma requisicao HTTP ao iframe do Hotmart Player e extrai a URL do .m3u8
    que esta hardcoded na configuracao do videojs no HTML da pagina.
    Retorna a URL do m3u8 ou None se nao encontrada.
    """
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
    }
    if referer:
        headers['Referer'] = referer

    try:
        response = req.get(embed_url, headers=headers, timeout=15)
        html = response.text

        # Procura por URLs de m3u8 no HTML/JavaScript da pagina
        patterns = [
            r'https://vod-akm\.play\.hotmart\.com[^\s\'"]+\.m3u8[^\s\'"]*',
            r'https://[a-z0-9.-]*hotmart[^\s\'"]+\.m3u8[^\s\'"]*',
            r'"src"\s*:\s*"(https://[^"]+\.m3u8[^"]*)"',
            r"'src'\s*:\s*'(https://[^']+\.m3u8[^']*)'",
            r'(https://vod[^\s\'"<>]+\.m3u8[^\s\'"<>]*)',
        ]

        for pattern in patterns:
            match = re.search(pattern, html)
            if match:
                url = match.group(1) if match.lastindex else match.group(0)
                url = url.replace('\\u0026', '&').replace('\\/', '/')
                print(f"[Hotmart] m3u8 encontrado: {url[:80]}...")
                return url

        print("[Hotmart] Nao foi possivel extrair m3u8 do HTML do player.")
        return None
    except Exception as e:
        print(f"[Hotmart] Erro ao buscar embed page: {e}")
        return None


def configure_ytdlp_youtube(ydl_opts):
    """
    Torna a extracao do YouTube robusta com o yt-dlp >= 2026.08.19:

    1) Habilita um JavaScript runtime (deno ou node) para que o yt-dlp consiga
       resolver o desafio po_token / parametro 'n' do player 'web'. Sem um
       runtime, o cliente 'web' (melhor qualidade) e omitido nao logado e a
       extracao fica instavel (bot-check frequente).
    2) Remove os clientes da familia 'tv' (tv, tv_downgraded, tv_simply): o
       YouTube os bloqueia com 'The page needs to be reloaded.' quando os
       demais clientes (web / web_embedded) sofrem bot-check. Com isso, mesmo
       que o 'web' falhe, o yt-dlp cai para clientes validos em vez do erro.
    """
    runtimes = {}
    for name in ('deno', 'node'):
        path = shutil.which(name)
        if path:
            runtimes[name] = {'path': path}
    if runtimes:
        ydl_opts['js_runtimes'] = runtimes

    ydl_opts.setdefault('extractor_args', {})['youtube'] = {
        'player_client': ['default', '-tv_downgraded', '-tv', '-tv_simply'],
    }


def is_instagram_url(url):
    """True se a URL é de um post/reel/story do Instagram (suportado pelo yt-dlp)."""
    u = (url or '').lower()
    return ('instagram.com/' in u and any(p in u for p in ('/reel/', '/p/', '/stories/', '/tv/')))


def configure_instagram(ydl_opts):
    """Configura o yt-dlp para o Instagram.

    O Instagram exige login (cookies do navegador) e impersonação de navegador
    (curl-cffi) para não ser bloqueado. Aqui apenas garantimos que baixamos o
    item único (reel/post/story) e não a página inteira; a impersonação é
    ativada automaticamente pelo yt-dlp quando o curl-cffi está instalado.
    """
    ydl_opts['noplaylist'] = True


def download_task(queue, task, *, url, referer=None, extra_headers=None,
                  cookies_list=None, format_type="video", selector=None,
                  format_id=None, filename=None):
    """Orquestra um download escrevendo o progresso na task da fila."""
    task_id = task["id"]
    queue.set(task_id, status="downloading", progress="0%", url=url,
              filename=filename, error=None)

    is_hotmart_embed = "cf-embed.play.hotmart.com/embed/" in url
    is_direct_hls = ("vod-akm.play.hotmart.com" in url
                     or (".m3u8" in url and not is_hotmart_embed))

    if is_hotmart_embed:
        queue.set(task_id, status="error", error=(
            "Nao e possivel baixar o embed diretamente. Pressione PLAY no video, "
            "aguarde carregar e tente novamente."))
        return

    if is_direct_hls:
        queue.set(task_id, progress="Baixando stream...", format_label="HLS")
        _download_hls(queue, task, url, referer, format_id, filename)
        return

    ydl_opts = {
        "outtmpl": _outtmpl_for(filename),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "concurrent_fragment_downloads": 5,
    }
    format_label = "Audio (MP3)" if format_type == "audio" else (
        f"{format_id}" if format_id else "Melhor")
    queue.set(task_id, format_label=format_label)

    if format_type == "audio":
        ydl_opts["format"] = "bestaudio/best"
        ydl_opts["postprocessors"] = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }]
    elif selector:
        ydl_opts["format"] = selector
        ydl_opts["merge_output_format"] = "mp4"
    else:
        ydl_opts["format"] = ("bestvideo[ext=mp4]+bestaudio[ext=m4a]/"
                              "bestvideo+bestaudio/best")
        ydl_opts["merge_output_format"] = "mp4"

    http_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9",
    }
    if referer:
        http_headers["Referer"] = referer
    if extra_headers:
        http_headers.update(extra_headers)
    ydl_opts["http_headers"] = http_headers

    configure_ytdlp_youtube(ydl_opts)

    if is_instagram_url(url):
        configure_instagram(ydl_opts)
        try:
            import curl_cffi  # noqa: F401
        except ImportError:
            queue.set(task_id, status="error", error=(
                "O download de Reels/Stories do Instagram requer o pacote "
                '"curl-cffi". Instale com: pip install curl-cffi e reinicie o Motor Local.'))
            return

    cookie_file_path = analyzer.write_cookie_file(cookies_list, task_id)
    if cookie_file_path:
        ydl_opts["cookiefile"] = cookie_file_path

    try:
        def my_hook(d):
            if d["status"] == "downloading":
                percent = (d.get("_percent_str", "0%")
                           .replace("\x1b[0;94m", "").replace("\x1b[0m", "").strip())
                speed = d.get("speed")
                eta = d.get("eta")
                queue.set(task_id, progress=percent,
                          speed=f"{speed / 1024 / 1024:.1f} MB/s" if speed else None,
                          eta=eta)
            elif d["status"] == "finished":
                queue.set(task_id, progress="100%", status="merging")

        ydl_opts["progress_hooks"] = [my_hook]

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            title = (info or {}).get("title")
            if title:
                queue.set(task_id, title=title)
            ydl.download([url])

        try:
            prepared = ydl.prepare_filename(info)
            queue.set(task_id, filename=_final_name_for(
                prepared, format_type == "audio", info, bool(filename)))
        except Exception:
            pass

        queue.set(task_id, status="completed", progress="100%",
                  completed_at=time.time())
    except Exception as e:
        queue.set(task_id, status="error", error=str(e),
                  completed_at=time.time())
    finally:
        if cookie_file_path and os.path.exists(cookie_file_path):
            try:
                os.remove(cookie_file_path)
            except OSError:
                pass
        try:
            QUEUE.persist(_history_path())
        except Exception:
            pass


def _download_hls(queue, task, url, referer, format_id, filename):
    """Download de stream HLS direto via ffmpeg (variante format_id opcional)."""
    task_id = task["id"]
    target_url = format_id or url
    safe_name = sanitize_filename(filename or "hotmart_video", "hotmart_video")
    output_path = os.path.join(download_dir(), safe_name + ".mp4")
    queue.set(task_id, filename=safe_name + ".mp4")

    cmd = ["ffmpeg", "-y",
           "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
           "-allowed_extensions", "ALL"]
    if referer:
        cmd += ["-headers",
                f"Referer: {referer}\r\nOrigin: {'/'.join(referer.split('/')[:3])}\r\n"]
    cmd += ["-i", target_url, "-c", "copy", "-bsf:a", "aac_adtstoasc", output_path]

    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        queue.set(task_id, ffmpeg_pid=proc.pid)

        duration_re = re.compile(r"Duration:\s*(\d+):(\d+):(\d+)")
        time_re = re.compile(r"time=(\d+):(\d+):(\d+)")
        speed_re = re.compile(r"speed=\s*([\d.]+)x")
        total_secs = None

        for line in proc.stderr:
            d = duration_re.search(line)
            if d and total_secs is None:
                h, m, s = int(d.group(1)), int(d.group(2)), int(d.group(3))
                total_secs = h * 3600 + m * 60 + s
            t = time_re.search(line)
            if t and total_secs:
                h, m, s = int(t.group(1)), int(t.group(2)), int(t.group(3))
                elapsed = h * 3600 + m * 60 + s
                pct = min(100, int(elapsed * 100 / total_secs))
                queue.set(task_id, progress=f"{pct}%",
                          eta=max(0, total_secs - elapsed))
            sp = speed_re.search(line)
            if sp:
                queue.set(task_id, speed=f"{sp.group(1)}x")

        proc.wait()
        if proc.returncode == 0:
            queue.set(task_id, status="completed", progress="100%",
                      completed_at=time.time())
        else:
            raise RuntimeError(f"ffmpeg saiu com codigo {proc.returncode}")
    except Exception as e:
        queue.set(task_id, status="error", error=str(e),
                  completed_at=time.time())
    finally:
        try:
            QUEUE.persist(_history_path())
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route('/api/ping')
def ping():
    return jsonify({'ok': True, 'service': 'edge-video-downloader'})


@app.route("/api/tasks", methods=["GET"])
def list_tasks():
    return jsonify({"tasks": QUEUE.snapshot()})


@app.route("/api/history", methods=["GET"])
def list_history():
    return jsonify({"history": QUEUE.history()})


@app.route("/api/cancel/<task_id>", methods=["POST"])
def cancel_task(task_id):
    if not QUEUE.get(task_id):
        return jsonify({"error": "Task ID nao encontrado"}), 404
    return jsonify({"ok": QUEUE.cancel(task_id)})


@app.route("/api/download", methods=["POST"])
def start_download():
    data = request.json or {}
    url = data.get("url")
    if not url:
        return jsonify({"error": "URL nao fornecida"}), 400

    # Garante a pasta de destino antes do primeiro download (ruling Task 2).
    try:
        os.makedirs(download_dir(), exist_ok=True)
    except OSError:
        pass

    format_type = "audio" if data.get("audio") else data.get("format_type", "video")
    filename = sanitize_filename(data.get("filename") or "", "video")
    task = {
        "url": url,
        "filename": filename,
        "format_label": data.get("format_label") or "",
    }
    task_id = QUEUE.submit(
        lambda t: download_task(
            QUEUE, t,
            url=url,
            referer=data.get("referer"),
            extra_headers=data.get("headers"),
            cookies_list=data.get("cookies"),
            format_type=format_type,
            selector=data.get("selector"),
            format_id=data.get("format_id"),
            filename=filename,
        ),
        task,
    )
    return jsonify({
        "message": "Download iniciado",
        "task_id": task_id,
        "output_dir": download_dir(),
    }), 202


@app.route("/api/status/<task_id>", methods=["GET"])
def get_status(task_id):
    status = QUEUE.get(task_id)
    if not status:
        return jsonify({"error": "Task ID nao encontrado"}), 404
    return jsonify(status)


@app.route("/api/analyze", methods=["POST"])
def analyze_media():
    data = request.json or {}
    url = data.get("url")
    try:
        result = analyzer.analyze_url(
            url=url,
            referer=data.get("referer"),
            cookies_list=data.get("cookies"),
            default_quality=load_config()["default_quality"],
        )
        return jsonify(result)
    except analyzer.AnalyzeError as e:
        return jsonify({"error": str(e)}), e.status
    except Exception as e:
        return jsonify({"error": f"Erro inesperado na analise: {e}"}), 502


@app.route("/api/config", methods=["GET", "POST"])
def config_route():
    if request.method == "POST":
        cfg = load_config()
        cfg.update(request.json or {})
        cfg["download_dir"] = str(Path(cfg.get("download_dir", "")).expanduser())
        save_config(cfg)
        try:
            apply_autostart(bool(cfg["autostart"]))
        except Exception:
            pass
        return jsonify({"ok": True, "config": cfg})
    return jsonify(load_config())


@app.route("/api/open-folder", methods=["POST"])
def open_folder():
    try:
        folder = download_dir()
        os.makedirs(folder, exist_ok=True)
        os.startfile(folder)
        return jsonify({"ok": True, "path": folder})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/open-file", methods=["POST"])
def open_file():
    """Abre um arquivo (nome relativo a pasta de downloads ou caminho
    absoluto) — bloqueia qualquer caminho fora da pasta (path traversal)."""
    path = (request.json or {}).get("path")
    if not path:
        return jsonify({"error": "path obrigatorio"}), 400
    if not os.path.isabs(path):
        path = os.path.join(download_dir(), path)
    base = os.path.realpath(download_dir())
    target = os.path.realpath(path)
    if target != base and not target.startswith(base + os.sep):
        return jsonify({"error": "Caminho fora da pasta de downloads"}), 400
    if not os.path.isfile(target):
        return jsonify({"error": "Arquivo nao encontrado"}), 404
    try:
        os.startfile(target)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# Execucao: servidor WSGI (waitress) + janela de status (tkinter)
# ---------------------------------------------------------------------------

def _setup_external_paths():
    """Garante que ffmpeg e deno estejam no PATH do processo.
    
    Quando o PyInstaller empacota o EXE, o PATH do processo pode nao 
    incluir os caminhos do usuario. Precisamos re-adicionar:
    - ffmpeg (instalado junto ao app)
    - deno (necessario pelo yt-dlp para extrair formatos do YouTube)
    """
    try:
        current_path = os.environ.get('PATH', '')

        # 1. ffmpeg bundled com o app
        if getattr(sys, 'frozen', False):
            install_dir = os.path.dirname(os.path.dirname(sys.executable))
            ff_root = os.path.join(install_dir, 'ffmpeg')
            if os.path.isdir(ff_root):
                for root, _dirs, files in os.walk(ff_root):
                    if 'ffmpeg.exe' in files:
                        current_path = root + os.pathsep + current_path
                        break

        # 2. Deno — verificar locais comuns no Windows
        deno_paths = [
            os.path.join(os.path.expanduser('~'), '.deno', 'bin'),
            os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Microsoft', 'WinGet', 'Links'),
            os.path.join(os.environ.get('USERPROFILE', ''), '.deno', 'bin'),
        ]
        for dp in deno_paths:
            if os.path.isdir(dp) and dp not in current_path:
                current_path = dp + os.pathsep + current_path

        # 3. Re-importar PATH do usuario (PyInstaller pode ter removido)
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Environment') as key:
                user_path, _ = winreg.QueryValueEx(key, 'Path')
                for p in user_path.split(os.pathsep):
                    if p and p not in current_path:
                        current_path += os.pathsep + p
        except Exception:
            pass

        os.environ['PATH'] = current_path
    except Exception:
        pass


def _is_running():
    """True se ja existe um Motor Local respondendo (evita duas instancias)."""
    try:
        r = req.get(f"http://{HOST}:{PORT}/api/ping", timeout=0.8)
        return r.status_code == 200 and r.json().get('ok') is True
    except Exception:
        return False


def _kill_ffmpeg_children():
    """Encerra processos ffmpeg em andamento (se houver download ativo)."""
    for task in QUEUE.snapshot():
        pid = task.get("ffmpeg_pid")
        if pid:
            try:
                subprocess.run(["taskkill", "/PID", str(pid), "/F", "/T"],
                               capture_output=True, timeout=10)
            except Exception:
                pass


def shutdown_app():
    """Encerra o Motor Local de forma segura (mata ffmpeg filhos, persiste)."""
    _kill_ffmpeg_children()
    try:
        QUEUE.persist(_history_path())
    except Exception:
        pass
    threading.Timer(0.3, lambda: os._exit(0)).start()


@app.route("/api/shutdown", methods=["POST"])
def shutdown_route():
    threading.Timer(0.5, shutdown_app).start()
    return jsonify({"ok": True})


def _shutdown(server, root):
    _kill_ffmpeg_children()
    try:
        if server is not None:
            server.close()
    except Exception:
        pass
    try:
        if root is not None:
            root.destroy()
    except Exception:
        pass
    os._exit(0)


def run_gui(server):
    """Janela de status: mostra que o servidor esta rodando e permite parar."""
    root = tk.Tk()
    root.title("Edge Video Downloader - Motor Local")
    root.geometry("440x240")
    root.resizable(False, False)

    root.protocol("WM_DELETE_WINDOW", lambda: _shutdown(server, root))

    body = tk.Frame(root, padx=18, pady=14)
    body.pack(fill="both", expand=True)

    tk.Label(body, text="Edge Video Downloader", font=("Segoe UI", 15, "bold")).pack()
    tk.Label(body, text="Motor Local", font=("Segoe UI", 10, "italic"), fg="#555").pack(pady=(0, 10))
    tk.Label(body, text="\u25cf Servidor rodando", fg="#1a7f37", font=("Segoe UI", 10, "bold")).pack()
    tk.Label(body, text=f"http://{HOST}:{PORT}", font=("Consolas", 11), fg="#1a73e8").pack(pady=(2, 10))

    tk.Label(body, text="Pasta de downloads:", font=("Segoe UI", 9)).pack(anchor="w")
    tk.Label(body, text=DOWNLOAD_DIR, font=("Segoe UI", 9), fg="#444",
             wraplength=400, justify="left").pack(anchor="w")

    btns = tk.Frame(body)
    btns.pack(pady=14)

    def open_downloads():
        try:
            os.makedirs(DOWNLOAD_DIR, exist_ok=True)
            os.startfile(DOWNLOAD_DIR)
        except Exception as e:
            messagebox.showerror("Edge Video Downloader", f"Nao foi possivel abrir a pasta:\n{e}")

    tk.Button(btns, text="Abrir pasta de downloads", command=open_downloads, padx=6).pack(side="left", padx=6)
    tk.Button(btns, text="Parar Motor Local", command=lambda: _shutdown(server, root),
              bg="#d93025", fg="white", padx=6).pack(side="left", padx=6)

    tk.Label(root, text="A extensao do navegador usa este servidor para baixar os videos.",
             font=("Segoe UI", 8), fg="gray").pack(side="bottom", pady=(0, 8))

    try:
        root.mainloop()
    finally:
        _shutdown(server, root)


if __name__ == '__main__':
    _setup_external_paths()
    no_gui = '--no-gui' in sys.argv

    # Evita abrir uma segunda instancia (ex.: auto-inicio duplicado)
    if not no_gui and _is_running():
        sys.exit(0)

    try:
        server = create_server(app, host=HOST, port=PORT)
    except OSError as e:
        if no_gui:
            raise
        rk = tk.Tk()
        rk.withdraw()
        messagebox.showerror("Edge Video Downloader",
                             f"Nao foi possivel iniciar o servidor na porta {PORT}.\n\nDetalhe: {e}")
        rk.destroy()
        sys.exit(1)

    if no_gui:
        print(f"Backend EVD iniciado em http://{HOST}:{PORT} (servidor WSGI waitress).")
        print(f"Downloads serao salvos em: {DOWNLOAD_DIR}")
        server.run()
    else:
        # Servidor em thread de fundo + janela de status na thread principal
        threading.Thread(target=server.run, daemon=True).start()
        run_gui(server)
