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

DEFAULT_CONFIG = {
    "download_dir": str(Path.home() / "Downloads" / "EdgeVideoDownloader"),
    "default_quality": "1080p",
    "autostart": False,
    "notifications": True,
}


def data_dir():
    """Diretório de dados (config/histórico): backend/data em dev;
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
    safe = re.sub(r"[^\w\s.-]", "-", name or "").strip(" -")[:120]
    return safe or default


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

app = Flask(__name__)
CORS(app)

HOST = '127.0.0.1'
PORT = 5000

downloads_status = {}

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


def download_via_ffmpeg(task_id, m3u8_url, output_name, referer=None):
    """
    Usa ffmpeg diretamente para baixar e decriptar um stream HLS AES-128.
    Mais robusto que o yt-dlp para streams diretos da Hotmart.
    """
    import subprocess

    safe_name = re.sub(r'[^\w\s-]', '', output_name)[:60] or 'hotmart_video'
    output_path = os.path.join(DOWNLOAD_DIR, safe_name + '.mp4')

    cmd = [
        'ffmpeg', '-y',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        '-allowed_extensions', 'ALL',
    ]

    if referer:
        cmd += ['-headers', f'Referer: {referer}\r\nOrigin: {"/".join(referer.split("/")[:3])}\r\n']

    cmd += [
        '-i', m3u8_url,
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        output_path
    ]

    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        downloads_status[task_id]['ffmpeg_pid'] = proc.pid

        # Monitorar progresso via stderr do ffmpeg
        duration_re = re.compile(r'Duration:\s*(\d+):(\d+):(\d+)')
        time_re = re.compile(r'time=(\d+):(\d+):(\d+)')
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
                downloads_status[task_id]['progress'] = f'{pct}%'

        proc.wait()
        if proc.returncode == 0:
            downloads_status[task_id]['status'] = 'completed'
            downloads_status[task_id]['progress'] = '100%'
            print(f"[ffmpeg] Download concluido: {output_path}")
        else:
            stderr = proc.stderr.read() if proc.stderr else ''
            raise RuntimeError(f"ffmpeg saiu com codigo {proc.returncode}")
    except Exception as e:
        downloads_status[task_id]['status'] = 'error'
        downloads_status[task_id]['error'] = str(e)

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


def download_video_task(task_id, url, referer=None, extra_headers=None, cookies_list=None, format_type='video'):
    """
    Orquestra o download. Detecta automaticamente o tipo de URL:
    - m3u8 direto (vod-akm.play.hotmart.com) → ffmpeg direto
    - cf-embed URL → erro com instrucao clara
    - youtube/vimeo → yt-dlp
    """
    downloads_status[task_id] = {
        'status': 'downloading',
        'progress': '0%',
        'url': url,
        'title': '',
        'error': None
    }

    is_hotmart_embed = 'cf-embed.play.hotmart.com/embed/' in url
    is_direct_hls = 'vod-akm.play.hotmart.com' in url or (('.m3u8' in url) and not is_hotmart_embed)

    # Caso 1: Embed iframe do Hotmart — nao temos como baixar sem session do browser
    if is_hotmart_embed:
        downloads_status[task_id]['status'] = 'error'
        downloads_status[task_id]['error'] = (
            'Nao e possivel baixar o embed diretamente. '
            'Pressione PLAY no video na pagina, aguarde carregar, '
            'depois reabra o popup e clique em "Baixar via Motor Local". '
            'O stream com token (.m3u8) aparecera na lista.'
        )
        return

    # Caso 2: URL m3u8 direta (interceptada pelo webRequest) — ffmpeg direto
    if is_direct_hls:
        downloads_status[task_id]['progress'] = 'Baixando stream...'
        download_via_ffmpeg(task_id, url, 'hotmart_video', referer=referer or 'https://hotmart.com/')
        return

    # Caso 3: YouTube, Vimeo, etc. — yt-dlp normal
    ydl_opts = {
        'outtmpl': os.path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s'),
        'noplaylist': True,
        'quiet': True,
        'no_warnings': True,
        'concurrent_fragment_downloads': 5,
    }
    
    if format_type == 'audio':
        ydl_opts['format'] = 'bestaudio*/best'
        ydl_opts['postprocessors'] = [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '192',
        }]
    else:
        # Prefere video MP4 (H.264) + audio M4A (AAC), ambos compativeis com
        # o container MP4, evitando que a melhor faixa de audio seja Opus/webm
        # e a mesclagem em MP4 falhe ("Stream #1:0 -> #0:1 (copy)").
        # O fallback cobre videos que so oferecem streams combinados ou webm
        # (ex: videos com restricao) e impede "Requested format is not available".
        ydl_opts['format'] = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best'
        ydl_opts['merge_output_format'] = 'mp4'

    http_headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9',
    }
    if referer:
        http_headers['Referer'] = referer
    if extra_headers:
        http_headers.update(extra_headers)
    ydl_opts['http_headers'] = http_headers

    # Robustez do YouTube no yt-dlp novo: habilita JS runtime (deno/node) e
    # remove os clientes 'tv' que geram "The page needs to be reloaded.".
    configure_ytdlp_youtube(ydl_opts)

    # Instagram: exige login (cookies) e impersonação; sem curl-cffi o yt-dlp
    # não consegue se passar por navegador e é bloqueado pelo Instagram.
    is_instagram = is_instagram_url(url)
    if is_instagram:
        configure_instagram(ydl_opts)
        try:
            import curl_cffi  # noqa: F401
        except ImportError:
            downloads_status[task_id]['status'] = 'error'
            downloads_status[task_id]['error'] = (
                'O download de Reels/Stories do Instagram requer o pacote "curl-cffi" '
                '(impersonação de navegador). Instale com:  pip install curl-cffi '
                'e reinicie o Motor Local.'
            )
            return

    # Se a extensão enviou cookies (agora usando a permissão "cookies" do manifest)
    cookie_file_path = None
    if cookies_list and isinstance(cookies_list, list) and len(cookies_list) > 0:
        import tempfile
        cookie_file_path = os.path.join(tempfile.gettempdir(), f"cookies_{task_id}.txt")
        try:
            with open(cookie_file_path, 'w', encoding='utf-8') as f:
                f.write("# Netscape HTTP Cookie File\n")
                f.write("# This file was generated by EdgeVideoDownloader\n\n")
                for c in cookies_list:
                    domain = c.get('domain', '')
                    include_subdomains = "TRUE" if domain.startswith('.') else "FALSE"
                    path = c.get('path', '/')
                    secure = "TRUE" if c.get('secure') else "FALSE"
                    expiration = str(int(c.get('expirationDate', 0))) if not c.get('session', False) else "0"
                    name = c.get('name', '')
                    value = c.get('value', '')
                    f.write(f"{domain}\t{include_subdomains}\t{path}\t{secure}\t{expiration}\t{name}\t{value}\n")
            ydl_opts['cookiefile'] = cookie_file_path
        except Exception as e:
            print(f"Erro ao salvar cookies: {e}")

    try:
        def my_hook(d):
            if d['status'] == 'downloading':
                percent = d.get('_percent_str', '0%').replace('\x1b[0;94m', '').replace('\x1b[0m', '').strip()
                downloads_status[task_id]['progress'] = percent
            elif d['status'] == 'finished':
                downloads_status[task_id]['progress'] = '100%'
                downloads_status[task_id]['status'] = 'merging'

        ydl_opts['progress_hooks'] = [my_hook]

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        downloads_status[task_id]['status'] = 'completed'
    except Exception as e:
        downloads_status[task_id]['status'] = 'error'
        downloads_status[task_id]['error'] = str(e)
    finally:
        if cookie_file_path and os.path.exists(cookie_file_path):
            try:
                os.remove(cookie_file_path)
            except:
                pass


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route('/api/ping')
def ping():
    return jsonify({'ok': True, 'service': 'edge-video-downloader'})


@app.route('/api/download', methods=['POST'])
def start_download():
    data = request.json
    url = data.get('url')
    referer = data.get('referer')
    extra_headers = data.get('headers')
    cookies = data.get('cookies')
    format_type = data.get('format_type', 'video')

    if not url:
        return jsonify({'error': 'URL nao fornecida'}), 400

    task_id = str(uuid.uuid4())
    thread = threading.Thread(target=download_video_task, args=(task_id, url, referer, extra_headers, cookies, format_type))
    thread.start()

    return jsonify({
        'message': 'Download iniciado',
        'task_id': task_id,
        'output_dir': DOWNLOAD_DIR
    }), 202


@app.route('/api/status/<task_id>', methods=['GET'])
def get_status(task_id):
    status = downloads_status.get(task_id)
    if not status:
        return jsonify({'error': 'Task ID nao encontrado'}), 404
    return jsonify(status)


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
    for task in list(downloads_status.values()):
        pid = task.get('ffmpeg_pid')
        if pid:
            try:
                subprocess.run(['taskkill', '/PID', str(pid), '/F', '/T'],
                               capture_output=True, timeout=10)
            except Exception:
                pass


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
