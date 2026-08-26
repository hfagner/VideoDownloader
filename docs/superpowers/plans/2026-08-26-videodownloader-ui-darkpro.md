# Modernização Dark Pro (Popup + Motor Local) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernizar as interfaces da extensão Edge e do Motor Local com identidade Dark Pro, exibindo nome real da mídia e opções de download por resolução com tamanhos (exatos ou ≈ estimados), fila única no backend com dashboard web e fallback nativo offline.

**Architecture:** Análise de formatos centralizada no backend (`/api/analyze`: parse de m3u8 ou `yt_dlp.extract_info(download=False)`), consumida sob demanda pelo popup com cache de 30 min na extensão (`chrome.storage.session`). Com o motor online, todos os downloads passam pela fila dele (máx. 2 simultâneos, persistida em JSON); offline, arquivos diretos caem no `chrome.downloads`. O backend serve o dashboard Dark Pro em `/` e fica na bandeja (pystray).

**Tech Stack:** Manifest V3 (Edge), JS vanilla (sem build step), Flask + waitress + yt-dlp + ffmpeg, pystray/PIL, pytest (backend), node:test (helpers da extensão), PyInstaller (deploy).

**Spec:** `docs/superpowers/specs/2026-08-26-videodownloader-ui-modernizacao-design.md` — o plano argumenta a partir da spec; leia ambos.

## Global Constraints

- MV3 estrito; **nenhuma permissão nova** no `manifest.json` (as atuais já cobrem tudo).
- Motor Local em `127.0.0.1`, portas candidatas **5000 → 5001 → 5002**; extensão testa as 3 e memoriza a ativa.
- Fila do backend: **máx. 2 downloads simultâneos**, FIFO.
- Cache de análise na extensão: `chrome.storage.session`, **TTL 30 min**, chave = URL da mídia; erros nunca são cacheados.
- Timeout da análise no popup: **15 s** (AbortController).
- Ping de status do motor: `chrome.alarms` a cada **0.5 min** (30 s).
- Sanitização de filename no backend: `re.sub(r'[^\w\s.-]', '-', name).strip()[:120]`.
- Identidade **Dark Pro** (tokens na spec §4.3): fundo `#0E1116`, superfície `#171B22`, header `#141922`, bordas `#232A35`/`#3A4356`, texto `#E6E9EF`/`#C4CBD8`/`#9AA3B2`/`#6B7688`, accent gradiente `#6E56F8 → #8B5CF6` (botões) e `#6E56F8 → #00C2FF` (progresso), `#A79BFF` (acento texto), destaque `#221F3A`, sucesso `#00D68F`, erro `#FF7B7B`, tipografia `'Segoe UI Variable', 'Segoe UI', system-ui`. Modo claro via `prefers-color-scheme: light` (spec §4.3).
- Cópia da interface e comentários em **pt-BR**; mensagens de commit em pt-BR com prefixo convencional (`feat:`, `test:`, `chore:`).
- Python **>= 3.11** (build usa `py -3.11`); `yt-dlp>=2026.08.19`; Node >= 18 apenas para dev/testes.
- Tamanhos: exato sem prefixo; estimado com "≈"; ausente → "Tamanho indisponível"; nunca exibir 0/negativo.
- Popup: largura ~420 px, altura máx. 600 px com scroll interno; máx. 10 cards de mídia.
- Sem build step no dashboard (HTML/CSS/JS estáticos servidos pelo Flask).
- Downloads do motor gravam em `download_dir` da config (default `~/Downloads/EdgeVideoDownloader`).

## Estrutura de Arquivos

| Arquivo | Responsabilidade | Status |
|---|---|---|
| `backend/analyzer.py` | Análise: fetch/parse m3u8, extração yt-dlp, estimativa de tamanho, seleção do "melhor" | **Criar** |
| `backend/server.py` | App Flask, rotas, `TaskQueue`, persistência, bandeja, startup | **Modificar** (grande) |
| `backend/web/index.html` `style.css` `app.js` | Dashboard Dark Pro | **Criar** |
| `backend/requirements.txt` | + `pystray`, `pillow` | Modificar |
| `backend/requirements-dev.txt` | `pytest` | **Criar** |
| `backend/tests/test_analyzer.py` `test_api.py` `test_queue.py` | Testes pytest | **Criar** |
| `libs/formats.js` | Helpers puros de UI/decisão (bytes, duração, best, título, arquivo direto) | **Criar** |
| `libs/backend.js` | Ping/porta do motor, validação de cache TTL | **Criar** |
| `libs/messaging.js` | + `BACKEND_STATUS`, `ANALYZE_MEDIA` | Modificar |
| `libs/storage.js` | + cache de análise (session), porta ativa | Modificar |
| `tests/extension/*.mjs` | Testes node:test dos helpers | **Criar** |
| `background.js` | Status do motor, cache/relay de análise, roteamento unificado de download | Modificar |
| `popup/popup.html` `.css` `.js` | Redesign Dark Pro completo | Reescrever |
| `content.js` | + `ogTitle`/`pageTitle` nos itens | Modificar |
| `options/options.css` (e pequenos ajustes em `options.html`) | Tema Dark Pro | Reescrever CSS |
| `deploy/build-backend-exe.ps1` | Incluir `web/`, `icons/`, `pystray` no EXE | Modificar |
| `.gitignore` | Excluir venv, data/, dist parcial, `.superpowers/` | **Criar** |

---

### Task 0: Repositório git + estado inicial

**Files:**
- Create: `.gitignore`
- (git init; commit inicial de tudo)

**Interfaces:**
- Consumes: nada.
- Produces: repo git com commit base; `.gitignore` que o resto do plano assume.

- [ ] **Step 1: Criar `.gitignore`**

```gitignore
# Python
__pycache__/
*.pyc
backend/.venv/
backend/data/
deploy/.pybuild-venv/
deploy/dist/.work/
deploy/dist/.spec/

# Node
node_modules/

# Tooling do brainstorming
.superpowers/

# Artefatos de build final (opcional manter fora do git)
dist/
```

- [ ] **Step 2: Inicializar o repositório e fazer o commit inicial**

Run (PowerShell, na raiz do projeto):
```powershell
git init
git add .
git commit -m "chore: estado inicial do projeto (extensão MV3 + Motor Local)"
```
Expected: commit criado sem erros. Se o usuário preferir **não** versionar, os passos "Commit" dos demais tasks podem ser pulados — o critério de aceite de cada task é o teste/verificação, não o commit.

- [ ] **Step 3: Confirmar que `backend/data/` e `deploy/dist/.work/` estão ignorados**

Run: `git status --short` — Expected: working tree limpo após o commit.

---

### Task 1: `backend/analyzer.py` — análise de formatos (TDD)

**Files:**
- Create: `backend/analyzer.py`
- Test: `backend/tests/test_analyzer.py`
- Create: `backend/requirements-dev.txt`

**Interfaces:**
- Consumes: nada (módulo novo).
- Produces (usado pelos Tasks 2, 4, 5):
  - `AnalyzeError(message, status=502)` — exceção com status HTTP.
  - `fetch_playlist(url, referer=None, timeout=15) -> str`
  - `parse_m3u8_variants(text, base_url) -> list[dict]` — cada dict: `{'url': str, 'height': int|None, 'resolution': '1080p'|None, 'bandwidth': int|None}`
  - `media_duration_from_m3u8(text) -> float|None` — soma de `#EXTINF`.
  - `estimate_size_bytes(bandwidth_bps, duration_seconds) -> int|None`
  - `build_formats_from_ytdlp_info(info) -> {'title': str, 'duration': float|None, 'formats': list[dict]}` — linha: `{'id': 'h1080'|'mp3', 'resolution': str|None, 'height': int|None, 'ext': str, 'type': 'video'|'audio', 'size': int|None, 'size_estimated': bool, 'selector': str}`; selector de vídeo = `bestvideo[height<=H][ext=mp4]+bestaudio[ext=m4a]/best[height<=H]`; áudio = `bestaudio/best`.
  - `pick_best_id(formats, default_quality='1080p') -> str|None` — qualidades válidas: `'max'`, `'1080p'`, `'720p'`, `'480p'`; respeita o limite; se nenhuma ≤ limite, usa a menor.
  - `analyze_url(url, referer=None, cookies_list=None, default_quality='1080p') -> dict` — resultado: `{'title': str|None, 'duration': float|None, 'source': 'ytdlp'|'hls'|'direct', 'best_id': str|None, 'formats': list[dict]}` (linhas de HLS/direto também têm campo `'url'` e `'selector': None`).
  - `write_cookie_file(cookies_list, task_id) -> str|None` — arquivo Netscape temporário (movido de server.py).
  - `QUALITY_HEIGHTS = {'max': None, '1080p': 1080, '720p': 720, '480p': 480}`

- [ ] **Step 1: Criar venv de dev e instalar dependências de teste**

Run (PowerShell, raiz):
```powershell
python -m venv backend\.venv
backend\.venv\Scripts\pip install -r backend\requirements.txt
backend\.venv\Scripts\pip install pytest
```
Create `backend/requirements-dev.txt`:
```
pytest>=8.0
```

- [ ] **Step 2: Escrever os testes que falham**

Create `backend/tests/test_analyzer.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analyzer import (
    parse_m3u8_variants, media_duration_from_m3u8, estimate_size_bytes,
    build_formats_from_ytdlp_info, pick_best_id,
)

MASTER = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080
v1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
v720/index.m3u8
"""

MEDIA = """#EXTM3U
#EXTINF:10.0,
seg1.ts
#EXTINF:5.5,
seg2.ts
#EXT-X-ENDLIST
"""


def test_parse_m3u8_variants_extrai_url_resolucao_bandwidth():
    variants = parse_m3u8_variants(MASTER, "https://cdn.example.com/master.m3u8")
    assert len(variants) == 2
    assert variants[0]["height"] == 1080
    assert variants[0]["resolution"] == "1080p"
    assert variants[0]["bandwidth"] == 5500000
    assert variants[0]["url"] == "https://cdn.example.com/v1080/index.m3u8"
    assert variants[1]["height"] == 720


def test_parse_m3u8_variants_sem_variantes_retorna_lista_vazia():
    assert parse_m3u8_variants("#EXTM3U\n#EXTINF:3,\nx.ts\n", "http://x/a.m3u8") == []


def test_media_duration_soma_extinf():
    assert media_duration_from_m3u8(MEDIA) == 15.5
    assert media_duration_from_m3u8("#EXTM3U\n#EXT-X-ENDLIST\n") is None


def test_estimate_size_bytes():
    assert estimate_size_bytes(8000000, 10) == 10000000  # 8 Mbps * 10 s / 8
    assert estimate_size_bytes(None, 10) is None
    assert estimate_size_bytes(8000000, None) is None


FAKE_INFO = {
    "title": "Aula 1 - Introdução ao Curso",
    "duration": 504,
    "formats": [
        {"format_id": "137", "height": 1080, "ext": "mp4", "vcodec": "avc1", "acodec": "none",
         "filesize": 220200960},
        {"format_id": "136", "height": 720, "ext": "mp4", "vcodec": "avc1", "acodec": "none",
         "tbr": 1500},
        {"format_id": "135", "height": 480, "ext": "mp4", "vcodec": "avc1", "acodec": "none"},
        {"format_id": "140", "height": None, "ext": "m4a", "vcodec": "none", "acodec": "mp4a",
         "filesize_approx": 8390000},
    ],
}


def test_build_formats_agrupa_por_altura_e_audio():
    result = build_formats_from_ytdlp_info(FAKE_INFO)
    assert result["title"] == "Aula 1 - Introdução ao Curso"
    video_rows = [f for f in result["formats"] if f["type"] == "video"]
    assert [f["height"] for f in video_rows] == [1080, 720, 480]
    assert video_rows[0]["size"] == 220200960 and video_rows[0]["size_estimated"] is False
    assert video_rows[1]["size_estimated"] is True  # via tbr
    assert video_rows[2]["size"] is None
    audio = [f for f in result["formats"] if f["type"] == "audio"]
    assert audio[0]["id"] == "mp3" and audio[0]["selector"] == "bestaudio/best"
    assert video_rows[0]["selector"] == (
        "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]"
    )


def test_pick_best_id_respeita_qualidade():
    formats = build_formats_from_ytdlp_info(FAKE_INFO)["formats"]
    assert pick_best_id(formats, "1080p") == "h1080"
    assert pick_best_id(formats, "720p") == "h720"
    assert pick_best_id(formats, "480p") == "h480"
    assert pick_best_id(formats, "max") == "h1080"
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `backend\.venv\Scripts\python -m pytest backend\tests\test_analyzer.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'analyzer'`.

- [ ] **Step 4: Implementar `backend/analyzer.py`**

```python
"""Analise de midias: titulo + formatos + tamanhos (exato ou estimado).

Funcoes de parsing/estimativa sao puras (testaveis); analyze_url() orquestra
rede (m3u8 / yt-dlp) e delega a elas.
"""
import os
import re
import tempfile
from urllib.parse import urljoin

import requests as req

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"

QUALITY_HEIGHTS = {"max": None, "1080p": 1080, "720p": 720, "480p": 480}

DIRECT_EXTS = (".mp4", ".webm", ".mkv", ".avi", ".mov", ".flv",
               ".mp3", ".wav", ".ogg", ".aac", ".flac")
AUDIO_EXTS = (".mp3", ".wav", ".ogg", ".aac", ".flac")

AUDIO_SELECTOR = "bestaudio/best"


class AnalyzeError(Exception):
    """Falha de análise com status HTTP para a rota /api/analyze."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------------------
# Funções puras
# ---------------------------------------------------------------------------

def parse_m3u8_variants(text, base_url):
    """Extrai variantes (RESOLUTION/BANDWIDTH) de um m3u8 master."""
    variants = []
    pending = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#EXT-X-STREAM-INF"):
            res = re.search(r"RESOLUTION=(\d+)x(\d+)", line)
            bw = re.search(r"BANDWIDTH=(\d+)", line)
            pending = {
                "height": int(res.group(2)) if res else None,
                "bandwidth": int(bw.group(1)) if bw else None,
            }
        elif pending is not None and line and not line.startswith("#"):
            pending["url"] = urljoin(base_url, line)
            pending["resolution"] = f"{pending['height']}p" if pending["height"] else None
            variants.append(pending)
            pending = None
    return variants


def media_duration_from_m3u8(text):
    """Duração (s) de um m3u8 de mídia, somando #EXTINF; None se não houver."""
    total = 0.0
    for raw in text.splitlines():
        m = re.match(r"#EXTINF:([\d.]+)", raw.strip())
        if m:
            total += float(m.group(1))
    return total if total > 0 else None


def estimate_size_bytes(bandwidth_bps, duration_seconds):
    """Estimativa de tamanho: bitrate * duração / 8; None se faltar dado."""
    if not bandwidth_bps or not duration_seconds:
        return None
    return int(bandwidth_bps * duration_seconds / 8)


def _format_size(fmt, duration):
    if fmt.get("filesize"):
        return fmt["filesize"], False
    if fmt.get("filesize_approx"):
        return fmt["filesize_approx"], True
    if fmt.get("tbr") and duration:
        return int(fmt["tbr"] * 1000 * duration / 8), True
    return None, False


def build_formats_from_ytdlp_info(info):
    """Normaliza info_dict do yt-dlp em linhas de formato (uma por altura + MP3)."""
    duration = info.get("duration")
    formats = []
    seen_heights = set()
    for fmt in sorted(info.get("formats") or [], key=lambda f: -(f.get("height") or 0)):
        height = fmt.get("height")
        if not height or height in seen_heights or (fmt.get("vcodec") or "none") == "none":
            continue
        seen_heights.add(height)
        size, estimated = _format_size(fmt, duration)
        formats.append({
            "id": f"h{height}",
            "resolution": f"{height}p",
            "height": height,
            "ext": fmt.get("ext") or "mp4",
            "type": "video",
            "size": size,
            "size_estimated": estimated,
            "selector": (f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/"
                         f"best[height<={height}]"),
        })
    best_audio = next(
        (f for f in (info.get("formats") or [])
         if (f.get("acodec") or "none") != "none" and (f.get("vcodec") or "none") == "none"),
        None,
    )
    audio_size, audio_est = _format_size(best_audio, duration) if best_audio else (None, False)
    formats.append({
        "id": "mp3",
        "resolution": None,
        "height": None,
        "ext": "mp3",
        "type": "audio",
        "size": audio_size,
        "size_estimated": audio_est,
        "selector": AUDIO_SELECTOR,
    })
    return {"title": info.get("title") or "", "duration": duration, "formats": formats}


def pick_best_id(formats, default_quality="1080p"):
    """ID da linha MELHOR respeitando o limite de qualidade configurado."""
    videos = [f for f in formats if f.get("type") == "video"]
    if not videos:
        return formats[0]["id"] if formats else None
    limit = QUALITY_HEIGHTS.get(default_quality, QUALITY_HEIGHTS["1080p"])
    if limit is None:
        return max(videos, key=lambda f: f.get("height") or 0)["id"]
    eligible = [f for f in videos if (f.get("height") or 0) <= limit]
    chosen = (max(eligible, key=lambda f: f.get("height") or 0)
              if eligible else min(videos, key=lambda f: f.get("height") or 0))
    return chosen["id"]


# ---------------------------------------------------------------------------
# Rede e orquestração
# ---------------------------------------------------------------------------

def fetch_playlist(url, referer=None, timeout=15):
    headers = {"User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9"}
    if referer:
        headers["Referer"] = referer
    resp = req.get(url, headers=headers, timeout=timeout)
    resp.raise_for_status()
    return resp.text


def write_cookie_file(cookies_list, task_id):
    """Grava cookies em arquivo Netscape temporário (None se lista vazia)."""
    if not cookies_list:
        return None
    path = os.path.join(tempfile.gettempdir(), f"cookies_{task_id}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write("# Netscape HTTP Cookie File\n")
        f.write("# This file was generated by EdgeVideoDownloader\n\n")
        for c in cookies_list:
            domain = c.get("domain", "")
            include = "TRUE" if domain.startswith(".") else "FALSE"
            secure = "TRUE" if c.get("secure") else "FALSE"
            expiration = str(int(c.get("expirationDate", 0))) if not c.get("session", False) else "0"
            f.write(f"{domain}\t{include}\t{c.get('path', '/')}\t{secure}\t{expiration}\t"
                    f"{c.get('name', '')}\t{c.get('value', '')}\n")
    return path


def _analyze_m3u8(url, referer, default_quality):
    text = fetch_playlist(url, referer)
    variants = parse_m3u8_variants(text, url)
    if not variants:
        return {
            "title": None, "duration": None, "source": "hls",
            "formats": [{
                "id": "stream", "resolution": None, "height": None, "ext": "mp4",
                "type": "video", "size": None, "size_estimated": False,
                "selector": None, "url": url,
            }],
            "best_id": "stream",
        }
    duration = None
    try:
        duration = media_duration_from_m3u8(fetch_playlist(variants[0]["url"], referer))
    except Exception:
        duration = None
    formats = []
    for v in variants:
        size = estimate_size_bytes(v["bandwidth"], duration)
        formats.append({
            "id": f"h{v['height']}" if v["height"] else "stream",
            "resolution": v["resolution"],
            "height": v["height"],
            "ext": "mp4",
            "type": "video",
            "size": size,
            "size_estimated": size is not None,
            "selector": None,
            "url": v["url"],
        })
    result = {"title": None, "duration": duration, "source": "hls", "formats": formats}
    result["best_id"] = pick_best_id(formats, default_quality)
    return result


def _analyze_direct(url, referer, default_quality):
    size = None
    try:
        headers = {"User-Agent": UA}
        if referer:
            headers["Referer"] = referer
        resp = req.head(url, headers=headers, timeout=15, allow_redirects=True)
        size = int(resp.headers.get("content-length", 0)) or None
    except Exception:
        size = None
    ext = (os.path.splitext(url.split("?")[0])[1] or ".mp4").lstrip(".").lower()
    return {
        "title": None, "duration": None, "source": "direct",
        "formats": [{
            "id": "direct", "resolution": None, "height": None, "ext": ext,
            "type": "audio" if ext in AUDIO_EXTS else "video",
            "size": size, "size_estimated": False, "selector": None, "url": url,
        }],
        "best_id": "direct",
    }


def _analyze_ytdlp(url, referer, cookies_list, default_quality):
    import yt_dlp

    cookie_file = write_cookie_file(cookies_list, f"analyze_{os.getpid()}")
    ydl_opts = {"quiet": True, "no_warnings": True, "noplaylist": True}
    http_headers = {"User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9"}
    if referer:
        http_headers["Referer"] = referer
    ydl_opts["http_headers"] = http_headers
    if cookie_file:
        ydl_opts["cookiefile"] = cookie_file
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
        if info and info.get("entries"):
            info = list(info["entries"])[0]
        result = build_formats_from_ytdlp_info(info or {})
        result["source"] = "ytdlp"
        result["best_id"] = pick_best_id(result["formats"], default_quality)
        return result
    except Exception as e:
        raise AnalyzeError(f"Nao foi possivel analisar o video: {e}") from e
    finally:
        if cookie_file and os.path.exists(cookie_file):
            try:
                os.remove(cookie_file)
            except OSError:
                pass


def analyze_url(url, referer=None, cookies_list=None, default_quality="1080p"):
    """Despacha a análise conforme o tipo de URL. Lança AnalyzeError em falha."""
    lower = (url or "").lower()
    if not url:
        raise AnalyzeError("URL nao fornecida", 400)
    is_hotmart_embed = "cf-embed.play.hotmart.com/embed/" in lower
    if is_hotmart_embed:
        raise AnalyzeError(
            "De play no video primeiro para o stream (.m3u8) aparecer na lista.",
            422,
        )
    if ".m3u8" in lower:
        try:
            return _analyze_m3u8(url, referer, default_quality)
        except AnalyzeError:
            raise
        except Exception as e:
            raise AnalyzeError(f"Nao foi possivel analisar a playlist: {e}") from e
    if any(ext in lower.split("?")[0] for ext in DIRECT_EXTS):
        return _analyze_direct(url, referer, default_quality)
    return _analyze_ytdlp(url, referer, cookies_list, default_quality)
```

- [ ] **Step 5: Rodar os testes e ver passar**

Run: `backend\.venv\Scripts\python -m pytest backend\tests\test_analyzer.py -v`
Expected: PASS (7 testes).

- [ ] **Step 6: Commit**

```bash
git add backend/analyzer.py backend/tests/test_analyzer.py backend/requirements-dev.txt
git commit -m "feat: analyzer de formatos (m3u8, yt-dlp, estimativa de tamanho)"
```

---

### Task 2: Config e dados do backend (`data_dir`, config.json, autostart)

**Files:**
- Modify: `backend/server.py` (adicionar funções de config/data; nada de rotas ainda)
- Test: `backend/tests/test_config.py`

**Interfaces:**
- Consumes: nada do Task 1.
- Produces (Tasks 3–7):
  - `data_dir() -> Path` — `backend/data/` em dev; `%LOCALAPPDATA%/EdgeVideoDownloader` quando congelado (PyInstaller).
  - `DEFAULT_CONFIG = {'download_dir': str(Path.home()/'Downloads'/'EdgeVideoDownloader'), 'default_quality': '1080p', 'autostart': False, 'notifications': True}`
  - `load_config() -> dict` (merge com defaults), `save_config(cfg: dict) -> None`
  - `download_dir() -> str` — valor atual da config (substitui o `DOWNLOAD_DIR` global; em Task 4 todo uso de `DOWNLOAD_DIR` passa a ser `download_dir()`).
  - `apply_autostart(enabled: bool) -> None` — chave `EdgeVideoDownloader` em `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` com `"{sys.executable}"` (no-op fora do Windows).
  - `sanitize_filename(name, default='video') -> str` — `re.sub(r'[^\w\s.-]', '-', name).strip()[:120]`.

- [ ] **Step 1: Escrever os testes que falham**

Create `backend/tests/test_config.py`:

```python
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server as srv


def test_sanitize_filename_remove_invalidos_e_limita(monkeypatch):
    assert srv.sanitize_filename('Aula 1: Introdução "final"?.mp4') == 'Aula 1- Introdução -final--.mp4'
    assert srv.sanitize_filename('x' * 300) == 'x' * 120
    assert srv.sanitize_filename('///') == 'video'


def test_load_save_config_round_trip(monkeypatch, tmp_path):
    monkeypatch.setattr(srv, 'data_dir', lambda: tmp_path)
    cfg = srv.load_config()
    assert cfg == srv.DEFAULT_CONFIG
    cfg['default_quality'] = '720p'
    cfg['download_dir'] = str(tmp_path / 'dl')
    srv.save_config(cfg)
    loaded = srv.load_config()
    assert loaded['default_quality'] == '720p'
    assert loaded['download_dir'] == str(tmp_path / 'dl')
    assert loaded['autostart'] is False  # default preservado


def test_load_config_arquivo_corrompido_volta_default(monkeypatch, tmp_path):
    monkeypatch.setattr(srv, 'data_dir', lambda: tmp_path)
    (tmp_path / 'config.json').write_text('{corrompido', encoding='utf-8')
    assert srv.load_config() == srv.DEFAULT_CONFIG
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `backend\.venv\Scripts\python -m pytest backend\tests\test_config.py -v`
Expected: FAIL — `AttributeError: module 'server' has no attribute 'sanitize_filename'`.

- [ ] **Step 3: Implementar no topo de `backend/server.py`**

Adicionar imports no topo do arquivo:
```python
import json
import time
from pathlib import Path
```
E logo após os imports existentes (antes de `app = Flask(...)`), substituir o bloco atual `DOWNLOAD_DIR = ...`:

```python
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
```

Remover as linhas antigas:
```python
DOWNLOAD_DIR = os.path.join(os.path.expanduser("~"), "Downloads", "EdgeVideoDownloader")
if not os.path.exists(DOWNLOAD_DIR):
    os.makedirs(DOWNLOAD_DIR)
```
(Neste momento `download_via_ffmpeg` e `run_gui` vão referenciar `DOWNLOAD_DIR` inexistente — isso será corrigido nos Tasks 4 e 7; para não quebrar o import agora, adicione temporariamente logo após as novas funções: `DOWNLOAD_DIR = download_dir()` — será removido no Task 4.)

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `backend\.venv\Scripts\python -m pytest backend\tests\test_config.py -v`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add backend/server.py backend/tests/test_config.py
git commit -m "feat: config persistente e pasta de dados do Motor Local"
```

---

### Task 3: `TaskQueue` + rotas `/api/tasks`, `/api/history`, `/api/cancel` (TDD)

**Files:**
- Modify: `backend/server.py`
- Test: `backend/tests/test_queue.py`, `backend/tests/test_api.py` (novo; aqui só os testes de fila/histórico/cancel)

**Interfaces:**
- Consumes: `data_dir()` do Task 2.
- Produces (Tasks 4–7 e dashboard):
  - `class TaskQueue(max_concurrent=2)` com: `submit(fn, task: dict) -> str` (registra e dispara `fn(task)` em thread quando há slot; fn recebe o dict da task e pode chamar `queue.set(task_id, ...)`); `set(task_id, **fields)`; `get(task_id) -> dict|{}`; `cancel(task_id) -> bool` (taskkill no pid se houver, status `cancelled`); `snapshot(limit=50) -> list[dict]`; `history() -> list[dict]` (só concluídos/erro/cancelados/interrompidos); `load(path: Path)` (status ativos → `interrupted`); `persist(path: Path)` (cap 500).
  - `QUEUE = TaskQueue()` global em server.py.
  - Rotas: `GET /api/tasks` → `{"tasks": QUEUE.snapshot()}`; `GET /api/history` → `{"history": QUEUE.history()}`; `POST /api/cancel/<task_id>` → `{"ok": bool}` (404 se tarefa inexistente).

- [ ] **Step 1: Escrever os testes que falham**

Create `backend/tests/test_queue.py`:

```python
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
```

Create `backend/tests/test_api.py`:

```python
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `backend\.venv\Scripts\python -m pytest backend\tests\test_queue.py backend\tests\test_api.py -v`
Expected: FAIL — `ImportError: cannot import name 'TaskQueue'`.

- [ ] **Step 3: Implementar `TaskQueue` e rotas em `backend/server.py`**

Adicionar após as funções de config do Task 2:

```python
class TaskQueue:
    """Fila de downloads: max. N simultaneos, FIFO, estado em memoria +
    persistencia opcional em JSON."""

    def __init__(self, max_concurrent=2):
        self.max_concurrent = max_concurrent
        self._tasks = {}   # id -> dict da task
        self._fns = {}     # id -> função a executar
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
            if task_id in self._tasks:
                self._tasks[task_id].update(fields)

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
```

Adicionar as rotas na seção "Routes" (após `/api/ping`):

```python
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
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `backend\.venv\Scripts\python -m pytest backend\tests\test_queue.py backend\tests\test_api.py -v`
Expected: PASS (8 testes).

- [ ] **Step 5: Commit**

```bash
git add backend/server.py backend/tests/test_queue.py backend/tests/test_api.py
git commit -m "feat: fila de downloads com concorrência limitada e rotas de tarefas"
```

---

### Task 4: Rotas `/api/analyze`, `/api/config`, `/api/open-folder`, `/api/open-file`, `/api/shutdown` (TDD)

**Files:**
- Modify: `backend/server.py`
- Test: `backend/tests/test_api.py` (acrescentar)

**Interfaces:**
- Consumes: `analyzer.analyze_url` e `AnalyzeError` (Task 1); `data_dir/load_config/save_config/download_dir` (Task 2).
- Produces (popup/dashboard):
  - `POST /api/analyze` — body `{url, referer?, cookies?}` → 200 `{title, duration, source, best_id, formats}`; erros com o `status` de `AnalyzeError` e corpo `{error}`.
  - `GET /api/config` → config atual; `POST /api/config` → salva (merge) e reaplica autostart.
  - `POST /api/open-folder` → abre `download_dir()` no Explorer; `POST /api/open-file` — body `{path}` → valida que o caminho real está dentro de `download_dir()` (bloqueia traversal); 400/404 em falha.
  - `POST /api/shutdown` → responde `{ok: true}` e agenda `shutdown_app()` em 0.5 s.

- [ ] **Step 1: Escrever os testes que falham (acrescentar a `test_api.py`)**

```python
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
    # define a pasta de downloads como tmp_path para a validação
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `backend\.venv\Scripts\python -m pytest backend\tests\test_api.py -v`
Expected: FAIL — rotas retornam 404 (e `shutdown_app` não existe).

- [ ] **Step 3: Implementar as rotas em `backend/server.py`**

No topo, logo após os imports: `import analyzer` (o módulo do Task 1).

Na seção "Routes":

```python
@app.route("/api/analyze", methods=["POST"])
def analyze_media():
    data = request.json or {}
    url = data.get("url")
    try:
        result = analyzer.analyze_url(
            url,
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
```

(O dashboard envia apenas o **nome** do arquivo em `/api/open-file` — por isso nomes relativos são resolvidos contra `download_dir()`.)

E a função de shutdown (na seção de execução, junto das existentes):
```python
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
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `backend\.venv\Scripts\python -m pytest backend\tests\test_api.py -v`
Expected: PASS (todos; os 3 do Task 3 + 8 novos).

- [ ] **Step 5: Commit**

```bash
git add backend/server.py backend/tests/test_api.py
git commit -m "feat: rotas de análise, config, abrir pasta/arquivo e shutdown"
```

---

### Task 5: `/api/download` estendido (selector, format_id, filename, áudio) usando a fila

**Files:**
- Modify: `backend/server.py` (reescrever `download_video_task` e rota `/api/download`; migrar `downloads_status` para `QUEUE`)

**Interfaces:**
- Consumes: `analyzer.write_cookie_file`, `sanitize_filename`, `download_dir()`, `QUEUE`, `_history_path()`.
- Produces (popup/background):
  - `POST /api/download` — body: `{url, referer?, headers?, cookies?, format_type?, selector?, format_id?, audio?: bool, filename?}`. `audio: true` ⇒ `format_type='audio'` (MP3 via `FFmpegExtractAudio`). Retorno 202: `{message, task_id, output_dir}`.
  - `GET /api/status/<task_id>` — agora lê do `QUEUE` (campos mantidos: `status`, `progress`, `url`, `title`, `error`; extras `speed`, `eta`, `filename`, `format_label`). Compatível com o polling atual da extensão.
  - `download_task(queue, task, *, url, referer, extra_headers, cookies_list, format_type, selector, format_id, filename)` — preenche `title/format_label/speed/eta/progress` na task via `queue.set`.

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar a `backend/tests/test_api.py`:

```python
import threading


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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `backend\.venv\Scripts\python -m pytest backend\tests\test_api.py -v`
Expected: FAIL — `/api/download` atual não aceita `audio`/`filename` como esperado e `/api/status` lê de `downloads_status`.

- [ ] **Step 3: Reescrever a função de download em `backend/server.py`**

Substituir a função `download_video_task` inteira pela versão abaixo (mantém a lógica de casos 1–3 existente, mas recebe `queue`/`task` e grava tudo via `queue.set`):

```python
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
        "outtmpl": os.path.join(download_dir(), "%(title)s.%(ext)s"),
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
```

Substituir a rota `/api/download`:

```python
@app.route("/api/download", methods=["POST"])
def start_download():
    data = request.json or {}
    url = data.get("url")
    if not url:
        return jsonify({"error": "URL nao fornecida"}), 400

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
```

Substituir a rota `/api/status/<task_id>`:

```python
@app.route("/api/status/<task_id>", methods=["GET"])
def get_status(task_id):
    status = QUEUE.get(task_id)
    if not status:
        return jsonify({"error": "Task ID nao encontrado"}), 404
    return jsonify(status)
```

Remover a variável global `downloads_status = {}` e o parâmetro `task_id` das antigas funções (a função antiga `download_via_ffmpeg` é substituída por `_download_hls`). Atualizar `_kill_ffmpeg_children()` para varrer `QUEUE.snapshot()`:

```python
def _kill_ffmpeg_children():
    for task in QUEUE.snapshot():
        pid = task.get("ffmpeg_pid")
        if pid:
            try:
                subprocess.run(["taskkill", "/PID", str(pid), "/F", "/T"],
                               capture_output=True, timeout=10)
            except Exception:
                pass
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `backend\.venv\Scripts\python -m pytest backend\tests\test_api.py -v`
Expected: PASS (todos).

- [ ] **Step 5: Smoke manual rápido**

Run (PowerShell): `backend\.venv\Scripts\python -m backend.server --no-gui` em um terminal; em outro:
```powershell
curl.exe -X POST http://127.0.0.1:5000/api/analyze -H "Content-Type: application/json" -d "{\"url\":\"https://www.youtube.com/watch?v=dQw4w9WgXcQ\"}"
```
Expected: 200 com `formats` contendo linhas `h1080`... e `mp3`. Encerrar com Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add backend/server.py backend/tests/test_api.py
git commit -m "feat: download unificado com selector/format_id/filename via fila"
```

---

### Task 6: Dashboard web Dark Pro (`backend/web/`)

**Files:**
- Create: `backend/web/index.html`, `backend/web/style.css`, `backend/web/app.js`
- Modify: `backend/server.py` (servir o dashboard)

**Interfaces:**
- Consumes: `GET /api/tasks`, `GET /api/history`, `GET/POST /api/config`, `POST /api/open-folder`, `POST /api/open-file`, `POST /api/cancel/<id>`, `POST /api/shutdown` (Tasks 3–5).
- Produces: dashboard acessível em `http://127.0.0.1:<porta>/`. `resource_path(*parts) -> Path` novo helper do server.py (usado também pelo Task 7 para o ícone da bandeja): em dev resolve a partir da raiz do projeto; congelado, a partir de `sys._MEIPASS`.

- [ ] **Step 1: Criar `backend/web/index.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Motor Local — Edge Video Downloader</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark"></div>
      <span>⚡ Motor Local</span>
    </div>
    <div class="top-actions">
      <span id="status-pill" class="pill pill-ok">● Servidor ativo</span>
      <button id="btn-open-folder" class="btn ghost">📂 Abrir pasta</button>
      <button id="btn-config" class="btn ghost">⚙ Config</button>
      <button id="btn-stop" class="btn danger">■ Parar</button>
    </div>
  </header>

  <main>
    <section class="stats">
      <div class="stat"><div class="stat-value" id="stat-active">0</div><div class="stat-label">EM ANDAMENTO</div></div>
      <div class="stat"><div class="stat-value ok" id="stat-done">0</div><div class="stat-label">CONCLUÍDOS HOJE</div></div>
      <div class="stat"><div class="stat-value" id="stat-bytes">0 MB</div><div class="stat-label">BAIXADO HOJE</div></div>
    </section>

    <section id="queue-section">
      <h2>EM ANDAMENTO</h2>
      <div id="queue-list"></div>
      <div id="queue-empty" class="empty">Nenhum download em andamento.</div>
    </section>

    <section id="history-section">
      <h2>CONCLUÍDOS</h2>
      <div id="history-list"></div>
      <div id="history-empty" class="empty">Nenhum download concluído ainda.</div>
    </section>

    <section id="config-section" class="hidden">
      <h2>⚙ Configurações</h2>
      <div class="config-row">
        <div>
          <div class="config-title">Pasta de destino</div>
          <input type="text" id="cfg-dir" class="input">
        </div>
        <button id="btn-save-dir" class="btn ghost">Salvar</button>
      </div>
      <div class="config-row">
        <div>
          <div class="config-title">Qualidade padrão <span class="hint">(limita o botão "Baixar melhor")</span></div>
          <select id="cfg-quality" class="input">
            <option value="max">Máxima</option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
            <option value="480p">480p</option>
          </select>
        </div>
      </div>
      <div class="config-row">
        <div>
          <div class="config-title">Iniciar com o Windows</div>
          <div class="hint">Motor Local abre ao ligar o PC</div>
        </div>
        <label class="switch"><input type="checkbox" id="cfg-autostart"><span class="slider"></span></label>
      </div>
      <div class="config-row">
        <div>
          <div class="config-title">Notificações</div>
          <div class="hint">Avisos de conclusão e erro</div>
        </div>
        <label class="switch"><input type="checkbox" id="cfg-notifications"><span class="slider"></span></label>
      </div>
      <div id="config-saved" class="saved hidden">✓ Configurações salvas</div>
    </section>
  </main>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Criar `backend/web/style.css`**

```css
:root {
  --bg: #0E1116;
  --surface: #171B22;
  --header: #141922;
  --border: #232A35;
  --border-strong: #3A4356;
  --text: #E6E9EF;
  --text-2: #C4CBD8;
  --text-3: #9AA3B2;
  --text-4: #6B7688;
  --violet: #6E56F8;
  --violet-2: #A79BFF;
  --cyan: #00C2FF;
  --highlight-bg: #221F3A;
  --ok: #00D68F;
  --ok-bg: #0F2B22;
  --err: #FF7B7B;
  --err-bg: #2B1618;
  --danger: #D93025;
  --grad-btn: linear-gradient(135deg, #6E56F8, #8B5CF6);
  --grad-bar: linear-gradient(90deg, #6E56F8, #00C2FF);
  --font: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #FFFFFF;
    --surface: #F7F8FA;
    --header: #FAFBFC;
    --border: #E5E7EB;
    --border-strong: #D1D5DB;
    --text: #111827;
    --text-2: #374151;
    --text-3: #6B7280;
    --text-4: #9CA3AF;
    --highlight-bg: #EDE9FE;
    --ok: #059669;
    --ok-bg: #ECFDF5;
    --err: #DC2626;
    --err-bg: #FEF2F2;
  }
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  min-height: 100vh;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  background: var(--header);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
}

.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; }
.brand-mark { width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(135deg, #6E56F8, #00C2FF); }

.top-actions { display: flex; align-items: center; gap: 8px; }

.pill {
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 12px;
}
.pill-ok { background: var(--ok-bg); color: var(--ok); }
.pill-err { background: var(--err-bg); color: var(--err); }

.btn {
  border: 1px solid var(--border-strong);
  background: #202733;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
}
@media (prefers-color-scheme: light) { .btn { background: #fff; } }
.btn:hover { border-color: var(--violet-2); }
.btn.danger { background: var(--danger); border: none; color: #fff; }

main { max-width: 900px; margin: 0 auto; padding: 20px; }

.stats { display: flex; gap: 12px; margin-bottom: 22px; }
.stat {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 16px;
}
.stat-value { font-size: 22px; font-weight: 700; color: var(--violet-2); }
.stat-value.ok { color: var(--ok); }
.stat-label { font-size: 10px; letter-spacing: 0.6px; color: var(--text-3); margin-top: 2px; }

h2 { font-size: 11px; font-weight: 700; letter-spacing: 0.8px; color: var(--text-3); margin: 18px 0 8px; }

.task {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 8px;
}
.task-head { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
.task-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 480px; }
.task-pct { color: var(--violet-2); font-weight: 700; }
.task-meta { display: flex; gap: 6px; margin-top: 4px; font-size: 11px; color: var(--text-4); }
.task-cancel { margin-left: auto; color: var(--err); cursor: pointer; font-weight: 700; }

.bar { height: 5px; background: var(--border); border-radius: 3px; margin-top: 8px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--grad-bar); border-radius: 3px; transition: width 400ms ease; }

.history-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 6px 2px;
  border-bottom: 1px solid var(--border);
}
.history-check { color: var(--ok); font-weight: 700; }
.history-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-meta, .history-time { color: var(--text-4); }
.history-open { color: var(--text-3); cursor: pointer; }

.empty { color: var(--text-4); font-size: 12px; padding: 8px 2px; }

.hidden { display: none; }

.config-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.config-title { font-weight: 600; font-size: 13px; }
.hint { color: var(--text-4); font-size: 11px; font-weight: 400; }
.input {
  background: var(--surface);
  border: 1px solid var(--border-strong);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 6px;
  min-width: 320px;
}
.config-row .input { min-width: auto; }

.switch { position: relative; display: inline-block; width: 34px; height: 19px; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute;
  inset: 0;
  background: var(--border-strong);
  border-radius: 10px;
  transition: background 200ms;
}
.slider::before {
  content: "";
  position: absolute;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  top: 3px;
  left: 3px;
  transition: transform 200ms;
}
.switch input:checked + .slider { background: var(--violet); }
.switch input:checked + .slider::before { transform: translateX(15px); }

.saved { color: var(--ok); font-size: 12px; margin-top: 10px; }

::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; }
```

- [ ] **Step 3: Criar `backend/web/app.js`**

```js
// Dashboard do Motor Local — polling de /api/tasks e /api/history a cada 1,5 s
const POLL_MS = 1500;

const $ = (id) => document.getElementById(id);

function fmtBytes(bytes) {
  if (!bytes) return "0 MB";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

function fmtEta(eta) {
  if (eta == null) return null;
  const m = Math.floor(eta / 60);
  const s = Math.round(eta % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

function isToday(ts) {
  if (!ts) return false;
  const d = new Date(ts * 1000);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

function stateLabel(status) {
  return {
    downloading: "⏳ Baixando",
    queued: "🕓 Na fila",
    merging: "🎛️ Juntando áudio e vídeo",
    completed: "✓ Concluído",
    error: "❌ Erro",
    cancelled: "✕ Cancelado",
    interrupted: "⚠️ Interrompido",
  }[status] || status || "";
}

function renderQueue(tasks) {
  const list = $("queue-list");
  const active = (tasks || []).filter((t) =>
    ["downloading", "queued", "merging"].includes(t.status));
  list.innerHTML = "";
  $("queue-empty").classList.toggle("hidden", active.length > 0);
  $("stat-active").textContent = active.length;

  for (const t of active) {
    const pct = Math.max(0, Math.min(100, parseInt(t.progress, 10) || 0));
    const el = document.createElement("div");
    el.className = "task";
    el.innerHTML = `
      <div class="task-head">
        <span class="task-name" title="${t.title || t.filename || t.url || ""}">${t.title || t.filename || t.url || "..."}</span>
        <span class="task-pct">${pct}%</span>
      </div>
      <div class="task-meta">
        <span>${t.format_label || ""}</span>
        ${t.speed ? `<span>·</span><span>${t.speed}</span>` : ""}
        ${fmtEta(t.eta) ? `<span>·</span><span>restam ${fmtEta(t.eta)}</span>` : ""}
        <span class="task-cancel" data-id="${t.id}">✕ cancelar</span>
      </div>
      <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    `;
    list.appendChild(el);
  }
  list.querySelectorAll(".task-cancel").forEach((btn) =>
    btn.addEventListener("click", () => cancelTask(btn.dataset.id)));
}

function renderHistory(history) {
  const list = $("history-list");
  const rows = (history || []).filter((t) =>
    ["completed", "error", "cancelled", "interrupted"].includes(t.status));
  list.innerHTML = "";
  $("history-empty").classList.toggle("hidden", rows.length > 0);

  let doneToday = 0;
  let bytesToday = 0;
  for (const t of rows) {
    if (t.status === "completed" && isToday(t.completed_at || t.created_at)) {
      doneToday += 1;
      bytesToday += t.size || 0;
    }
    const el = document.createElement("div");
    el.className = "history-row";
    el.innerHTML = `
      <span class="history-check">${t.status === "completed" ? "✓" : t.status === "error" ? "❌" : t.status === "cancelled" ? "✕" : "⚠"}</span>
      <span class="history-name" title="${t.title || t.filename || t.url || ""}">${t.title || t.filename || t.url || "..."}</span>
      <span class="history-meta">${t.format_label ? t.format_label + " · " : ""}${t.size ? fmtBytes(t.size) : ""}</span>
      <span class="history-time">${t.completed_at ? new Date(t.completed_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
      ${t.status === "completed" && t.filename ? `<span class="history-open" data-path="${t.filename}">📂</span>` : ""}
    `;
    list.appendChild(el);
  }
  $("stat-done").textContent = doneToday;
  $("stat-bytes").textContent = fmtBytes(bytesToday);
  list.querySelectorAll(".history-open").forEach((btn) =>
    btn.addEventListener("click", () => openFile(btn.dataset.path)));
}

async function poll() {
  try {
    const [tasksRes, historyRes] = await Promise.all([
      fetch("/api/tasks"), fetch("/api/history"),
    ]);
    if (tasksRes.ok) renderQueue((await tasksRes.json()).tasks);
    if (historyRes.ok) renderHistory((await historyRes.json()).history);
  } catch (e) { /* servidor momentaneamente indisponível */ }
}

async function loadConfig() {
  const r = await fetch("/api/config");
  if (!r.ok) return;
  const cfg = await r.json();
  $("cfg-dir").value = cfg.download_dir || "";
  $("cfg-quality").value = cfg.default_quality || "1080p";
  $("cfg-autostart").checked = !!cfg.autostart;
  $("cfg-notifications").checked = cfg.notifications !== false;
}

async function saveConfig(patch) {
  const r = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (r.ok) {
    const saved = $("config-saved");
    saved.classList.remove("hidden");
    setTimeout(() => saved.classList.add("hidden"), 3000);
  }
}

async function cancelTask(id) {
  await fetch(`/api/cancel/${id}`, { method: "POST" });
}

async function openFile(path) {
  await fetch("/api/open-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

$("btn-open-folder").addEventListener("click", () => fetch("/api/open-folder", { method: "POST" }));
$("btn-stop").addEventListener("click", async () => {
  if (confirm("Parar o Motor Local? Downloads em andamento serão interrompidos.")) {
    await fetch("/api/shutdown", { method: "POST" });
    $("status-pill").className = "pill pill-err";
    $("status-pill").textContent = "● Encerrando...";
  }
});
$("btn-config").addEventListener("click", () => $("config-section").classList.toggle("hidden"));
$("btn-save-dir").addEventListener("click", () => saveConfig({ download_dir: $("cfg-dir").value.trim() }));
$("cfg-quality").addEventListener("change", () => saveConfig({ default_quality: $("cfg-quality").value }));
$("cfg-autostart").addEventListener("change", () => saveConfig({ autostart: $("cfg-autostart").checked }));
$("cfg-notifications").addEventListener("change", () => saveConfig({ notifications: $("cfg-notifications").checked }));

loadConfig();
poll();
setInterval(poll, POLL_MS);
```

- [ ] **Step 4: Servir o dashboard no `backend/server.py`**

Adicionar após as funções de config:
```python
def resource_path(*parts):
    """Caminho de recursos: raiz do projeto em dev; sys._MEIPASS congelado."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS).joinpath(*parts)
    return Path(__file__).resolve().parent.parent.joinpath(*parts)


WEB_DIR = resource_path("backend", "web")
```
E a rota raiz (na seção Routes):
```python
from flask import send_from_directory  # (adicionar ao import do flask no topo)

@app.route("/")
def dashboard():
    return send_from_directory(str(WEB_DIR), "index.html")


@app.route("/<path:filename>")
def web_assets(filename):
    target = WEB_DIR / filename
    if target.is_file() and WEB_DIR in target.resolve().parents:
        return send_from_directory(str(WEB_DIR), filename)
    return jsonify({"error": "Nao encontrado"}), 404
```

- [ ] **Step 5: Verificação manual**

Run: `backend\.venv\Scripts\python -m backend.server --no-gui`
Abra `http://127.0.0.1:5000/` no navegador. Expected: dashboard escuro (Dark Pro) com stats zeradas, listas vazias, Config abrindo/fechando, e "Parar" encerrando o servidor (a página exibe "Encerrando..."). Verifique também o modo claro (F12 → emular `prefers-color-scheme: light`).

- [ ] **Step 6: Commit**

```bash
git add backend/web backend/server.py
git commit -m "feat: dashboard web Dark Pro do Motor Local"
```

---

### Task 7: Startup moderno — portas, instância única, bandeja, abertura do dashboard

**Files:**
- Modify: `backend/server.py` (substituir `run_gui` tkinter e o bloco `__main__`; manter `--no-gui`)
- Modify: `backend/requirements.txt` (+ pystray, pillow)
- Test: `backend/tests/test_startup.py`

**Interfaces:**
- Consumes: `resource_path` (Task 6), `QUEUE`, `_history_path()`, `shutdown_app()`, `load_config()`.
- Produces: comportamento final do EXE: abre dashboard no navegador, bandeja com menu (Abrir dashboard / Abrir pasta de downloads / Parar Motor Local), segunda instância só abre o dashboard da primeira.
  - `find_free_port(candidates=(5000, 5001, 5002)) -> (server, port)` — usa `create_server`.
  - `is_running(port) -> bool` — ping `/api/ping` confirmando `{"ok": true, "service": "edge-video-downloader"}` (substitui `_is_running()`).
  - `run_tray(port) -> None` — cria `pystray.Icon` com `resource_path("icons", "icon-32.png")`, roda em thread daemon, guarda em global `TRAY`.
  - `GET /api/ping` passa a incluir `"port"`.

- [ ] **Step 1: Escrever os testes que falham**

Create `backend/tests/test_startup.py`:

```python
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `backend\.venv\Scripts\python -m pytest backend\tests\test_startup.py -v`
Expected: FAIL — `find_free_port` não existe.

- [ ] **Step 3: Atualizar `backend/requirements.txt`**

```
flask==3.0.0
flask-cors==4.0.0
yt-dlp>=2026.08.19
curl-cffi>=0.7.0
requests>=2.31.0
waitress>=3.0.0
pystray>=0.19.5
pillow>=10.0.0
```
Run: `backend\.venv\Scripts\pip install -r backend\requirements.txt`

- [ ] **Step 4: Implementar no `backend/server.py`**

Remover `import tkinter as tk` e `from tkinter import messagebox` do topo; adicionar `import webbrowser`.

Substituir `_is_running()` por:
```python
def is_running(port):
    """True se há um Motor Local (nosso) respondendo nesta porta."""
    try:
        r = req.get(f"http://{HOST}:{port}/api/ping", timeout=0.8)
        data = r.json()
        return r.status_code == 200 and data.get("ok") is True and \
            data.get("service") == "edge-video-downloader"
    except Exception:
        return False
```

Adicionar:
```python
def find_free_port(candidates=(5000, 5001, 5002)):
    """Cria o servidor na primeira porta livre; OSError se todas ocupadas."""
    last_error = None
    for port in candidates:
        try:
            return create_server(app, host=HOST, port=port), port
        except OSError as e:
            last_error = e
    raise last_error or OSError("Nenhuma porta disponivel")
```

Substituir `run_gui` inteira por:
```python
TRAY = None  # referência global para o coletor de lixo não derrubar o ícone


def run_tray(port):
    """Icone na bandeja: abrir dashboard, abrir pasta, parar o motor."""
    global TRAY
    import pystray
    from PIL import Image

    icon_path = resource_path("icons", "icon-32.png")
    try:
        image = Image.open(icon_path)
    except Exception:
        image = Image.new("RGB", (32, 32), "#6E56F8")

    def open_dashboard():
        webbrowser.open(f"http://127.0.0.1:{port}/")

    def open_downloads():
        try:
            folder = download_dir()
            os.makedirs(folder, exist_ok=True)
            os.startfile(folder)
        except Exception:
            pass

    menu = pystray.Menu(
        pystray.MenuItem("Abrir dashboard", lambda icon, item: open_dashboard(), default=True),
        pystray.MenuItem("Abrir pasta de downloads", lambda icon, item: open_downloads()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Parar Motor Local", lambda icon, item: shutdown_app()),
    )
    TRAY = pystray.Icon("EdgeVideoDownloader", image, "Edge Video Downloader - Motor Local", menu)
    threading.Thread(target=TRAY.run, daemon=True).start()
```

Substituir o bloco `if __name__ == '__main__':` inteiro por:
```python
if __name__ == "__main__":
    _setup_external_paths()
    no_gui = "--no-gui" in sys.argv

    # Segunda instância: apenas abre o dashboard da que já roda.
    if not no_gui:
        for port in (5000, 5001, 5002):
            if is_running(port):
                webbrowser.open(f"http://127.0.0.1:{port}/")
                sys.exit(0)

    QUEUE.load(_history_path())

    try:
        server, port = find_free_port()
    except OSError as e:
        if no_gui:
            raise
        print(f"Nao foi possivel iniciar o servidor: {e}")
        sys.exit(1)

    if no_gui:
        print(f"Backend EVD iniciado em http://{HOST}:{port} (servidor WSGI waitress).")
        print(f"Downloads serao salvos em: {download_dir()}")
        server.run()
    else:
        threading.Thread(target=server.run, daemon=True).start()
        webbrowser.open(f"http://127.0.0.1:{port}/")
        run_tray(port)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            shutdown_app()
```

Atualizar `/api/ping`:
```python
@app.route("/api/ping")
def ping():
    return jsonify({"ok": True, "service": "edge-video-downloader", "port": PORT_ATUAL})
```
Nota: `PORT_ATUAL` não existe como global — a porta é escolhida no `__main__`. Use `request.host`:
```python
@app.route("/api/ping")
def ping():
    host_port = request.host.split(":")[-1]
    return jsonify({"ok": True, "service": "edge-video-downloader",
                    "port": int(host_port) if host_port.isdigit() else None})
```

- [ ] **Step 5: Rodar os testes e ver passar**

Run: `backend\.venv\Scripts\python -m pytest backend\tests -v`
Expected: PASS (todos os testes de todos os tasks).

- [ ] **Step 6: Verificação manual**

Run: `backend\.venv\Scripts\python -m backend.server`
Expected: navegador abre o dashboard; ícone na bandeja com os 3 itens; "Parar Motor Local" encerra o app. Rodar o comando de novo com a instância ativa → apenas abre o dashboard e sai. `--no-gui` continua sem janela/bandeja.

- [ ] **Step 7: Commit**

```bash
git add backend/server.py backend/requirements.txt backend/tests/test_startup.py
git commit -m "feat: bandeja, porta dinâmica, instância única e abertura do dashboard"
```

---

### Task 8: Helpers da extensão — `libs/formats.js` e `libs/backend.js` (TDD com node:test)

**Files:**
- Create: `libs/formats.js`, `libs/backend.js`
- Test: `tests/extension/formats.test.mjs`, `tests/extension/backend.test.mjs`

**Interfaces:**
- Consumes: nada (módulos novos, mesmo padrão de export dos libs existentes: `module.exports` + `window.X`).
- Produces (Tasks 9–12):
  - `Formats.formatBytes(bytes, decimals=1) -> string`
  - `Formats.formatDuration(seconds) -> string|null` — `"8:24"`; horas → `"1:08:24"`.
  - `Formats.sizeLabel(size, estimated) -> string` — `"210 MB"` | `"≈ 95 MB"` | `"Tamanho indisponível"`.
  - `Formats.pickBest(formats, bestId) -> object|null` — linha de `bestId`; fallback: 1º vídeo; senão 1ª linha.
  - `Formats.fallbackTitle(item, analyzedTitle) -> string` — `analyzedTitle || item.ogTitle || item.pageTitle || item.filename || 'media'`.
  - `Formats.isDirectFile(item) -> boolean` — `!item.isEmbed && !item.isBlob && item.type !== 'stream'` e URL sem `.m3u8`/`.mpd` (regex `\.(m3u8|mpd)(\?|#|$)` case-insensitive).
  - `Backend.CANDIDATE_PORTS = [5000, 5001, 5002]`; `Backend.CACHE_TTL_MS = 30*60*1000`
  - `Backend.pingPort(port, timeoutMs=1500) -> Promise<boolean>` — GET `/api/ping`, valida `data.ok === true`.
  - `Backend.findActivePort(ports = Backend.CANDIDATE_PORTS) -> Promise<number|null>`
  - `Backend.isCacheValid(entry, now = Date.now(), ttlMs = Backend.CACHE_TTL_MS) -> boolean`

- [ ] **Step 1: Escrever os testes que falham**

Create `tests/extension/formats.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import Formats from "../../libs/formats.js";

test("formatBytes formata unidades", () => {
  assert.equal(Formats.formatBytes(0), "0 Bytes");
  assert.equal(Formats.formatBytes(1024), "1.0 KB");
  assert.equal(Formats.formatBytes(220200960), "210.0 MB");
});

test("sizeLabel exato, estimado e indisponível", () => {
  assert.equal(Formats.sizeLabel(220200960, false), "210.0 MB");
  assert.equal(Formats.sizeLabel(95000000, true), "≈ 90.6 MB");
  assert.equal(Formats.sizeLabel(null, false), "Tamanho indisponível");
  assert.equal(Formats.sizeLabel(0, false), "Tamanho indisponível");
});

test("formatDuration mm:ss e h:mm:ss", () => {
  assert.equal(Formats.formatDuration(504), "8:24");
  assert.equal(Formats.formatDuration(4080), "1:08:00");
  assert.equal(Formats.formatDuration(null), null);
});

test("pickBest usa bestId e cai para primeiro vídeo", () => {
  const formats = [
    { id: "h720", type: "video" },
    { id: "h1080", type: "video" },
    { id: "mp3", type: "audio" },
  ];
  assert.equal(Formats.pickBest(formats, "h1080").id, "h1080");
  assert.equal(Formats.pickBest(formats, null).id, "h720");
  assert.equal(Formats.pickBest([{ id: "mp3", type: "audio" }], null).id, "mp3");
  assert.equal(Formats.pickBest([], null), null);
});

test("fallbackTitle segue a cadeia definida na spec", () => {
  const item = { ogTitle: "OG", pageTitle: "Página", filename: "video.mp4" };
  assert.equal(Formats.fallbackTitle(item, "Título real"), "Título real");
  assert.equal(Formats.fallbackTitle(item, null), "OG");
  assert.equal(Formats.fallbackTitle({ pageTitle: "Página" }, null), "Página");
  assert.equal(Formats.fallbackTitle({}, null), "media");
});

test("isDirectFile exclui streams, embeds e blobs", () => {
  assert.equal(Formats.isDirectFile({ url: "https://x/v.mp4", type: "video" }), true);
  assert.equal(Formats.isDirectFile({ url: "https://x/a.m3u8", type: "stream" }), false);
  assert.equal(Formats.isDirectFile({ url: "https://x/master.m3u8?t=1", type: "video" }), false);
  assert.equal(Formats.isDirectFile({ url: "https://x/v.mp4", type: "video", isEmbed: true }), false);
  assert.equal(Formats.isDirectFile({ url: "blob:https://x/1", isBlob: true, type: "video" }), false);
});
```

Create `tests/extension/backend.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Backend from "../../libs/backend.js";

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("pingPort true para /api/ping ok", async () => {
  const srv = await startServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "edge-video-downloader" }));
  });
  try {
    assert.equal(await Backend.pingPort(srv.address().port), true);
  } finally {
    srv.close();
  }
});

test("pingPort false quando serviço não é o nosso", async () => {
  const srv = await startServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "outro" }));
  });
  try {
    assert.equal(await Backend.pingPort(srv.address().port), false);
  } finally {
    srv.close();
  }
});

test("findActivePort encontra a porta ativa entre candidatas", async () => {
  const srv = await startServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "edge-video-downloader" }));
  });
  try {
    assert.equal(await Backend.findActivePort([srv.address().port]), srv.address().port);
  } finally {
    srv.close();
  }
});

test("isCacheValid respeita TTL e dados mínimos", () => {
  const entry = { result: { title: "T" }, ts: 1000 };
  assert.equal(Backend.isCacheValid(entry, 1000 + 29 * 60 * 1000), true);
  assert.equal(Backend.isCacheValid(entry, 1000 + 31 * 60 * 1000), false);
  assert.equal(Backend.isCacheValid(null, 1000), false);
  assert.equal(Backend.isCacheValid({ result: null, ts: 1000 }, 1000), false);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/extension/`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (arquivos não existem).

- [ ] **Step 3: Implementar `libs/formats.js`**

```js
// Helpers puros de exibição/decisão compartilhados pelo popup e background.

const Formats = {
  formatBytes(bytes, decimals = 1) {
    if (!+bytes) return "0 Bytes";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  },

  formatDuration(seconds) {
    if (!seconds) return null;
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  },

  sizeLabel(size, estimated) {
    if (!size || size <= 0) return "Tamanho indisponível";
    return (estimated ? "≈ " : "") + Formats.formatBytes(size);
  },

  pickBest(formats, bestId) {
    if (!formats || formats.length === 0) return null;
    if (bestId) {
      const byId = formats.find((f) => f.id === bestId);
      if (byId) return byId;
    }
    return formats.find((f) => f.type === "video") || formats[0];
  },

  fallbackTitle(item, analyzedTitle) {
    if (analyzedTitle) return analyzedTitle;
    if (item && item.ogTitle) return item.ogTitle;
    if (item && item.pageTitle) return item.pageTitle;
    if (item && item.filename) return item.filename;
    return "media";
  },

  isDirectFile(item) {
    if (!item || item.isEmbed || item.isBlob || item.type === "stream") return false;
    return !/\.(m3u8|mpd)(\?|#|$)/i.test(item.url || "");
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = Formats;
} else if (typeof window !== "undefined") {
  window.Formats = Formats;
}
```

- [ ] **Step 4: Implementar `libs/backend.js`**

```js
// Status e comunicação com o Motor Local (servidor Flask 127.0.0.1).

const Backend = {
  CANDIDATE_PORTS: [5000, 5001, 5002],
  CACHE_TTL_MS: 30 * 60 * 1000,

  async pingPort(port, timeoutMs = 1500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ping`, {
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const data = await response.json().catch(() => null);
      return !!(data && data.ok === true);
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  },

  async findActivePort(ports = Backend.CANDIDATE_PORTS) {
    for (const port of ports) {
      if (await Backend.pingPort(port)) return port;
    }
    return null;
  },

  isCacheValid(entry, now = Date.now(), ttlMs = Backend.CACHE_TTL_MS) {
    return !!(entry && entry.result && typeof entry.ts === "number" && now - entry.ts < ttlMs);
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = Backend;
} else if (typeof window !== "undefined") {
  window.Backend = Backend;
}
```

- [ ] **Step 5: Rodar os testes e ver passar**

Run: `node --test tests/extension/`
Expected: PASS (11 testes).

- [ ] **Step 6: Commit**

```bash
git add libs/formats.js libs/backend.js tests/extension
git commit -m "feat: helpers de formato e status do Motor Local na extensão"
```

---

### Task 9: `libs/messaging.js` e `libs/storage.js` — novos tipos e cache

**Files:**
- Modify: `libs/messaging.js` (2 constantes novas)
- Modify: `libs/storage.js` (cache de análise + porta ativa)

**Interfaces:**
- Consumes: padrão atual dos arquivos.
- Produces (Tasks 10–11):
  - `MessageType.BACKEND_STATUS: 'BACKEND_STATUS'` — popup→background (consulta) e background→popup (broadcast).
  - `MessageType.ANALYZE_MEDIA: 'ANALYZE_MEDIA'` — popup→background `{url, referer}` → `{ok, result?, cached?, reason?, error?}`.
  - `Storage.getAnalysisCache() -> Promise<object>` / `Storage.setAnalysisCache(cache) -> Promise<void>` — `chrome.storage.session`, chave `analysisCache`.
  - `Storage.getBackendPort() -> Promise<number|null>` / `Storage.setBackendPort(port) -> Promise<void>` — `chrome.storage.local`, chave `backendPort`.

- [ ] **Step 1: Editar `libs/messaging.js`**

Em `MessageType`, após `GET_ACTIVE_DOWNLOADS`, adicionar:
```js
  BACKEND_STATUS: 'BACKEND_STATUS',         // popup <-> background: status/porta do Motor Local
  ANALYZE_MEDIA: 'ANALYZE_MEDIA',           // popup -> background: analisar URL (título+formatos, com cache)
```

- [ ] **Step 2: Editar `libs/storage.js`**

Após `setActiveDownloads`, adicionar:
```js
  /**
   * Cache de análises (chrome.storage.session) — TTL de 30 min por URL.
   * @returns {Promise<Object>} { [url]: { result: Object, ts: number } }
   */
  async getAnalysisCache() {
    return new Promise((resolve) => {
      chrome.storage.session.get(['analysisCache'], (r) => {
        resolve(r['analysisCache'] || {});
      });
    });
  },

  /**
   * Grava o cache de análises no storage de sessão.
   * @param {Object} cache
   * @returns {Promise<void>}
   */
  async setAnalysisCache(cache) {
    return new Promise((resolve) => {
      chrome.storage.session.set({ analysisCache: cache }, () => resolve());
    });
  },

  /**
   * Porta ativa do Motor Local (descoberta via ping).
   * @returns {Promise<number|null>}
   */
  async getBackendPort() {
    return this.get('backendPort', null);
  },

  /**
   * Memoriza a porta ativa do Motor Local.
   * @param {number|null} port
   * @returns {Promise<void>}
   */
  async setBackendPort(port) {
    await this.set('backendPort', port);
  },
```

- [ ] **Step 3: Verificação**

Run: `node --test tests/extension/` — Expected: PASS (nada quebrou). `node -e "const {MessageType} = require('./libs/messaging.js'); console.log(MessageType.BACKEND_STATUS)"` — Expected: `BACKEND_STATUS`. `node -e "const S = require('./libs/storage.js'); console.log(typeof S.getAnalysisCache)"` — Expected: `function`.

- [ ] **Step 4: Commit**

```bash
git add libs/messaging.js libs/storage.js
git commit -m "feat: mensagens de status do motor e cache de análise"
```

---

### Task 10: `background.js` — status do motor, relay de análise, roteamento unificado

**Files:**
- Modify: `background.js`

**Interfaces:**
- Consumes: `Formats`, `Backend`, `Storage.getAnalysisCache/setAnalysisCache/getBackendPort/setBackendPort`, `MessageType.BACKEND_STATUS/ANALYZE_MEDIA` (Tasks 8–9); API do backend (Tasks 4–5).
- Produces (popup):
  - `GET BACKEND_STATUS` → `{online: bool, port: number|null}`; broadcast `BACKEND_STATUS` a cada refresh (alarme `backend-ping`, 0.5 min) e no startup.
  - `ANALYZE_MEDIA {url, referer}` → `{ok, result?, cached?, reason?, error?}` — cache TTL 30 min, prune de entradas expiradas.
  - `START_DOWNLOAD` agora recebe `{item, filename, selector, formatUrl, audio}` → resposta `{ok, kind: 'advanced'|'native', taskId?}` ou `{ok: false, reason}`. Roteamento: motor online → `/api/download` (unificado); offline → nativo se `Formats.isDirectFile(item)`, senão `{ok:false, reason:'backend_offline'}`.
  - `getCookiesForDomain(url)` movido do popup para cá (mesma lógica atual).

- [ ] **Step 1: Ajustar o importScripts e o estado**

Trocar a linha 1 por:
```js
importScripts('libs/storage.js', 'libs/messaging.js', 'libs/formats.js', 'libs/backend.js');
```

Após `let activeDownloadsCache = null;` adicionar:
```js
// Status do Motor Local (cache em memória + ping periódico)
const BACKEND_PING_ALARM = 'backend-ping';
const BACKEND_PING_INTERVAL_MIN = 0.5; // mínimo suportado pelo chrome.alarms
let backendStatus = { online: false, port: null };
let backendStatusCheckedAt = 0;
```

- [ ] **Step 2: Implementar ping, refresh e broadcast**

Adicionar após `broadcastDownloadUpdate()`:

```js
function broadcastBackendStatus() {
  chrome.runtime.sendMessage({ type: MessageType.BACKEND_STATUS, payload: backendStatus }, () => {
    if (chrome.runtime.lastError) { /* nenhum listener aberto */ }
  });
}

async function refreshBackendStatus() {
  const port = await Backend.findActivePort();
  backendStatus = { online: port !== null, port };
  backendStatusCheckedAt = Date.now();
  await Storage.setBackendPort(port);
  broadcastBackendStatus();
}
```

No final do arquivo (junto ao listener de `chrome.alarms.onAlarm` existente), ampliar o handler:
```js
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ADVANCED_POLL_ALARM) {
    pollAdvancedTasks();
  } else if (alarm.name === BACKEND_PING_ALARM) {
    refreshBackendStatus();
  }
});

// Status inicial do motor + ping periódico
refreshBackendStatus();
chrome.alarms.create(BACKEND_PING_ALARM, { periodInMinutes: BACKEND_PING_INTERVAL_MIN });
```

- [ ] **Step 3: Mover `getCookiesForDomain` do popup para o background**

Adicionar (código idêntico ao que existe hoje em `popup/popup.js:23-43`):
```js
async function getCookiesForDomain(url) {
  return new Promise((resolve) => {
    if (!chrome.cookies) return resolve([]);
    try {
      const domain = new URL(url).hostname;
      const baseDomain = domain.split('.').slice(-2).join('.');
      chrome.cookies.getAll({ url: url }, (cookies) => {
        if (cookies && cookies.length > 0) return resolve(cookies);
        chrome.cookies.getAll({ domain: baseDomain }, (cookies2) => {
          resolve(cookies2 || []);
        });
      });
    } catch (e) {
      resolve([]);
    }
  });
}
```

- [ ] **Step 4: Implementar `handleAnalyze` e `handleStartDownload`**

Adicionar antes do listener central de mensagens:

```js
async function handleAnalyze({ url, referer }) {
  if (!backendStatus.online) {
    return { ok: false, reason: 'backend_offline' };
  }
  const cache = await Storage.getAnalysisCache();
  const entry = cache[url];
  if (Backend.isCacheValid(entry)) {
    return { ok: true, result: entry.result, cached: true };
  }
  const cookies = await getCookiesForDomain(url);
  // Timeout de 15 s (spec §7): análise demorada vira erro com "Tentar novamente".
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`http://127.0.0.1:${backendStatus.port}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, referer, cookies }),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) {
      return { ok: false, reason: 'analyze_error', error: data.error || 'Falha na analise' };
    }
    cache[url] = { result: data, ts: Date.now() };
    for (const key of Object.keys(cache)) {
      if (!Backend.isCacheValid(cache[key])) delete cache[key];
    }
    await Storage.setAnalysisCache(cache);
    return { ok: true, result: data, cached: false };
  } catch (e) {
    return { ok: false, reason: 'backend_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function handleStartDownload({ item, filename, selector, formatUrl, audio }) {
  const url = formatUrl || (item && item.url);
  if (!url) return { ok: false, reason: 'no_url' };

  if (backendStatus.online) {
    const cookies = await getCookiesForDomain(url);
    try {
      const response = await fetch(`http://127.0.0.1:${backendStatus.port}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          referer: item.pageUrl,
          cookies,
          audio: !!audio,
          selector: selector || null,
          format_id: selector ? null : (formatUrl || null),
          filename,
          format_label: (item && item.format_label) || ''
        })
      });
      const data = await response.json();
      if (response.ok && data.task_id) {
        startAdvancedDownloadTracking({ taskId: data.task_id, url, filename });
        return { ok: true, kind: 'advanced', taskId: data.task_id };
      }
      return { ok: false, reason: 'backend_error', error: data.error || 'Erro no Motor Local' };
    } catch (e) {
      return { ok: false, reason: 'backend_unreachable' };
    }
  }

  if (Formats.isDirectFile(item)) {
    const ok = await startDownload(url, filename, item.tabId);
    return ok ? { ok: true, kind: 'native' } : { ok: false, reason: 'native_failed' };
  }
  return { ok: false, reason: 'backend_offline' };
}
```

- [ ] **Step 5: Atualizar o listener central**

Dentro de `Messaging.addListener`, substituir o handler de `START_DOWNLOAD` e adicionar os dois novos:

```js
  if (message.type === MessageType.START_DOWNLOAD) {
    handleStartDownload(message.payload || {}).then(sendResponse);
    return true; // async
  }

  if (message.type === MessageType.BACKEND_STATUS) {
    if (Date.now() - backendStatusCheckedAt > 10000) {
      refreshBackendStatus().then(() => sendResponse(backendStatus));
      return true; // async
    }
    sendResponse(backendStatus);
    return false;
  }

  if (message.type === MessageType.ANALYZE_MEDIA) {
    handleAnalyze(message.payload || {}).then(sendResponse);
    return true; // async
  }
```
Remover o bloco antigo:
```js
  if (message.type === MessageType.START_DOWNLOAD) {
    const { url, filename } = message.payload;
    const tabId = message.payload.tabId || (sender.tab ? sender.tab.id : null);
    startDownload(url, filename, tabId).then(success => sendResponse({ success }));
    return true; // async
  }
```

- [ ] **Step 6: Verificação estática e manual**

Run: `node --check background.js` (sintaxe — o `importScripts`/`chrome` só existem no SW, mas a checagem de sintaxe funciona). Expected: sem saída de erro.

Manual (após Task 11, a matriz completa cobre este fluxo): carregar a extensão descompactada no Edge e conferir no console do service worker (`edge://extensions` → "service worker") que não há erros e que `backendStatus` alterna com o servidor ligado/desligado.

- [ ] **Step 7: Commit**

```bash
git add background.js
git commit -m "feat: status do motor, relay de análise e roteamento unificado no background"
```

---

### Task 11: Redesign do popup (Dark Pro)

**Files:**
- Rewrite: `popup/popup.html`, `popup/popup.css`, `popup/popup.js`

**Interfaces:**
- Consumes: `Formats`, `Backend` (scripts adicionados no HTML), `MessageType.BACKEND_STATUS/ANALYZE_MEDIA/START_DOWNLOAD/GET_MEDIA/GET_ACTIVE_DOWNLOADS`, `Storage` (histórico/blacklist).
- Produces: a UI final. Nenhum outro task depende do popup.

- [ ] **Step 1: Reescrever `popup/popup.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Edge Video Downloader</title>
  <link rel="stylesheet" href="popup.css">
  <script src="../libs/storage.js"></script>
  <script src="../libs/messaging.js"></script>
  <script src="../libs/formats.js"></script>
  <script src="../libs/backend.js"></script>
  <script src="popup.js" defer></script>
</head>
<body>
  <header class="header">
    <div class="logo">
      <div class="logo-mark"></div>
      <h1>Edge Video Downloader</h1>
    </div>
    <div class="actions">
      <span id="backend-pill" class="pill pill-off">● Motor Local offline</span>
      <button id="btn-sidebar" title="Abrir como Sidebar" class="icon-btn">
        <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
      </button>
      <button id="btn-settings" title="Configurações" class="icon-btn">
        <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
      </button>
    </div>
  </header>

  <main>
    <div id="empty-state" class="empty-state hidden">
      <div class="empty-icon">🎬</div>
      <p class="empty-title">Nenhuma mídia detectada nesta página</p>
      <p class="empty-hint">Dê play no vídeo e reabra o painel.</p>
      <a href="#" id="help-link" class="empty-link">Ajuda & solução de problemas →</a>
    </div>

    <div id="media-list" class="media-list"></div>

    <section id="active-downloads-section" class="hidden">
      <h3 class="section-title">⏳ DOWNLOADS EM ANDAMENTO</h3>
      <div id="active-downloads-list"></div>
    </section>
  </main>

  <section class="history-section">
    <div class="history-header" id="history-toggle">
      <span>📥 Downloads recentes</span>
      <span class="chevron">▾</span>
    </div>
    <div id="history-list" class="history-list collapsed"></div>
  </section>

  <footer class="footer">
    <button id="btn-open-folder" class="btn-text">📂 Abrir pasta</button>
    <button id="btn-clear-history" class="btn-text">🧹 Limpar</button>
    <button id="btn-open-dashboard" class="btn-text">🖥 Dashboard</button>
  </footer>

  <template id="media-card-template">
    <div class="media-card">
      <div class="media-header">
        <div class="media-icon">▶</div>
        <div class="media-name-container">
          <input type="text" class="media-filename" spellcheck="false" title="Clique para renomear">
          <span class="edit-icon">✏</span>
          <button class="icon-btn btn-more" title="Mais Opções">⋮</button>
        </div>
      </div>
      <div class="media-chips"></div>
      <div class="media-buttons">
        <button class="btn-outline btn-analyze">▾ Ver resoluções</button>
        <button class="btn-primary btn-best">⬇ Baixar melhor</button>
      </div>
      <div class="analyze-status hidden"></div>
      <div class="format-list hidden"></div>
      <div class="more-menu hidden">
        <button class="menu-item btn-copy-url">Copiar URL</button>
        <button class="menu-item btn-copy-page">Copiar URL da Página</button>
        <button class="menu-item btn-blacklist">Não detectar neste site</button>
      </div>
    </div>
  </template>
</body>
</html>
```

- [ ] **Step 2: Reescrever `popup/popup.css`**

```css
:root {
  --bg: #0E1116;
  --surface: #171B22;
  --header: #141922;
  --border: #232A35;
  --border-strong: #3A4356;
  --text: #E6E9EF;
  --text-2: #C4CBD8;
  --text-3: #9AA3B2;
  --text-4: #6B7688;
  --violet: #6E56F8;
  --violet-2: #A79BFF;
  --cyan: #00C2FF;
  --highlight-bg: #221F3A;
  --ok: #00D68F;
  --ok-bg: #0F2B22;
  --err: #FF7B7B;
  --err-bg: #2B1618;
  --grad-btn: linear-gradient(135deg, #6E56F8, #8B5CF6);
  --grad-bar: linear-gradient(90deg, #6E56F8, #00C2FF);
  --radius: 6px;
  --font: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #FFFFFF;
    --surface: #F7F8FA;
    --header: #FAFBFC;
    --border: #E5E7EB;
    --border-strong: #D1D5DB;
    --text: #111827;
    --text-2: #374151;
    --text-3: #6B7280;
    --text-4: #9CA3AF;
    --highlight-bg: #EDE9FE;
    --ok: #059669;
    --ok-bg: #ECFDF5;
    --err: #DC2626;
    --err-bg: #FEF2F2;
  }
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  width: 420px;
  max-height: 600px;
  font-family: var(--font);
  background-color: var(--bg);
  color: var(--text);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
}

/* Sidebar do Edge: ocupa a largura disponível quando maior que o popup */
@media (min-width: 500px) {
  body { width: 100%; }
}

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 3px; }

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 11px 14px;
  background-color: var(--header);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 10;
}
.logo { display: flex; align-items: center; gap: 9px; }
.logo-mark { width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(135deg, #6E56F8, #00C2FF); }
.logo h1 { font-size: 12.5px; font-weight: 600; }
.actions { display: flex; align-items: center; gap: 5px; }

.pill { font-size: 9.5px; font-weight: 600; padding: 3px 8px; border-radius: 10px; }
.pill-on { background: var(--ok-bg); color: var(--ok); }
.pill-off { background: var(--err-bg); color: var(--err); }

.icon-btn {
  background: transparent;
  border: none;
  color: var(--text-3);
  padding: 5px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.icon-btn:hover { background: var(--surface); color: var(--text); }

main { padding: 12px; display: flex; flex-direction: column; gap: 12px; flex: 1; }

.empty-state { text-align: center; padding: 30px 16px; color: var(--text-3); font-size: 12px; }
.empty-state.hidden, .hidden { display: none; }
.empty-icon { font-size: 26px; margin-bottom: 8px; }
.empty-title { font-weight: 600; color: var(--text); }
.empty-hint { margin-top: 5px; font-size: 10.5px; }
.empty-link { color: var(--violet-2); text-decoration: none; margin-top: 10px; display: inline-block; font-size: 10.5px; }
.empty-link:hover { text-decoration: underline; }

.media-list { display: flex; flex-direction: column; gap: 12px; }

.media-card {
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  position: relative;
}

.media-header { display: flex; gap: 9px; align-items: flex-start; }
.media-icon {
  width: 30px;
  height: 30px;
  border-radius: 7px;
  background: var(--highlight-bg);
  color: var(--violet-2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  flex-shrink: 0;
}
.media-name-container { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; }
.media-filename {
  flex: 1;
  background: transparent;
  border: 1px solid transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  padding: 4px;
  border-radius: 4px;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
  min-width: 0;
}
.media-filename:hover { background: var(--bg); }
.media-filename:focus { outline: none; border-color: var(--violet); background: var(--bg); }
.edit-icon { font-size: 11px; opacity: 0.5; cursor: pointer; }
.btn-more { font-size: 14px; padding: 2px 6px; }

.media-chips { display: flex; gap: 5px; margin-top: 8px; padding-left: 39px; flex-wrap: wrap; }
.chip { font-size: 9px; background: var(--border); color: var(--text-3); padding: 2px 6px; border-radius: 5px; }

.media-buttons { display: flex; gap: 7px; margin-top: 11px; }
.btn-outline {
  flex: 1;
  background: transparent;
  border: 1px solid var(--border-strong);
  color: var(--text-2);
  font: inherit;
  font-size: 10.5px;
  font-weight: 600;
  padding: 6px 0;
  border-radius: var(--radius);
  cursor: pointer;
}
.btn-outline:hover { border-color: var(--violet-2); }
.btn-outline:disabled { opacity: 0.6; cursor: default; }
.btn-primary {
  flex: 1.2;
  background: var(--grad-btn);
  border: none;
  color: #fff;
  font: inherit;
  font-size: 10.5px;
  font-weight: 600;
  padding: 6px 0;
  border-radius: var(--radius);
  cursor: pointer;
}
.btn-primary:disabled { opacity: 0.6; cursor: default; }

.analyze-status {
  margin-top: 10px;
  font-size: 10.5px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 8px;
}
.analyze-status .retry { color: var(--violet-2); cursor: pointer; font-weight: 600; }
.spinner {
  width: 11px;
  height: 11px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--violet-2);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.format-list { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; }
.format-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius);
  font-size: 10.5px;
  cursor: pointer;
  margin-bottom: 2px;
}
.format-row:hover { background: var(--bg); }
.format-row.best { background: var(--highlight-bg); border-left: 2px solid var(--violet); }
.format-row .dl { color: var(--violet-2); font-weight: 700; }
.format-row .res { font-weight: 700; color: var(--text); min-width: 42px; }
.format-row .ext { color: var(--text-3); }
.format-row .size { margin-left: auto; color: var(--text-2); font-weight: 500; }
.badge-best { font-size: 8px; background: var(--violet); color: #fff; padding: 1px 4px; border-radius: 4px; }
.format-legend { font-size: 8.5px; color: var(--text-4); margin-top: 6px; text-align: center; }

.warn-box {
  background: var(--err-bg);
  border: 1px solid #3A2326;
  border-radius: 7px;
  padding: 7px 9px;
  margin-top: 10px;
  font-size: 9.5px;
  color: var(--err);
}
.btn-plain {
  width: 100%;
  margin-top: 9px;
  background: var(--border);
  border: 1px solid var(--border-strong);
  color: var(--text);
  font: inherit;
  font-size: 10.5px;
  font-weight: 600;
  padding: 6px 0;
  border-radius: var(--radius);
  cursor: pointer;
}

.more-menu {
  position: absolute;
  right: 12px;
  top: 44px;
  background-color: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
  z-index: 100;
  display: flex;
  flex-direction: column;
  padding: 4px;
}
.menu-item {
  background: none;
  border: none;
  text-align: left;
  padding: 8px 12px;
  font-size: 11px;
  color: var(--text);
  cursor: pointer;
  border-radius: 4px;
  font-family: inherit;
}
.menu-item:hover { background: var(--bg); }

.section-title { font-size: 9.5px; font-weight: 700; color: var(--text-3); letter-spacing: 0.7px; }
#active-downloads-list { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.active-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  padding: 9px 11px;
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: 9px;
}
.active-item-head { display: flex; justify-content: space-between; gap: 8px; }
.active-item .filename {
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  max-width: 240px;
  font-weight: 600;
}
.active-item .pct { color: var(--violet-2); font-weight: 700; }
.progress-track { width: 100%; height: 5px; background-color: var(--border); border-radius: 3px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--grad-bar); border-radius: 3px; transition: width 300ms ease; }
.active-item .active-state { color: var(--text-4); font-size: 9.5px; }
.active-item .active-speed { color: var(--text-3); font-size: 9px; }

.history-section { border-top: 1px solid var(--border); background-color: var(--header); }
.history-header {
  padding: 11px 14px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-3);
  display: flex;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}
.history-header:hover { background-color: var(--surface); }
.history-list { padding: 0 14px 10px; display: flex; flex-direction: column; gap: 2px; }
.history-list.collapsed { display: none; }
.history-item {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  padding: 5px 4px;
  color: var(--text-2);
}
.history-item .filename { text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 270px; }
.history-item .time { color: var(--text-4); }

.footer {
  display: flex;
  justify-content: space-between;
  padding: 10px 14px;
  background-color: var(--header);
  border-top: 1px solid var(--border);
}
.btn-text {
  background: none;
  border: none;
  color: var(--text-3);
  font-size: 10px;
  cursor: pointer;
  font-family: inherit;
}
.btn-text:hover { color: var(--text); }
```

- [ ] **Step 3: Reescrever `popup/popup.js`**

```js
// DOM Elements
const mediaList = document.getElementById('media-list');
const emptyState = document.getElementById('empty-state');
const template = document.getElementById('media-card-template');
const btnSidebar = document.getElementById('btn-sidebar');
const btnSettings = document.getElementById('btn-settings');
const backendPill = document.getElementById('backend-pill');
const historyToggle = document.getElementById('history-toggle');
const historyList = document.getElementById('history-list');
const btnOpenFolder = document.getElementById('btn-open-folder');
const btnClearHistory = document.getElementById('btn-clear-history');
const btnOpenDashboard = document.getElementById('btn-open-dashboard');
const activeDownloadsSection = document.getElementById('active-downloads-section');
const activeDownloadsList = document.getElementById('active-downloads-list');

// State
let currentTabId = null;
let detectedItems = [];
let backendStatus = { online: false, port: null };

const PLATFORM_LABELS = {
  youtube: 'YouTube', vimeo: 'Vimeo', panda: 'Panda Video',
  hotmart: 'Hotmart', instagram: 'Instagram',
};

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function updateBackendPill() {
  if (backendStatus.online) {
    backendPill.className = 'pill pill-on';
    backendPill.textContent = '● Motor Local';
  } else {
    backendPill.className = 'pill pill-off';
    backendPill.textContent = '● Motor Local offline';
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabId = tab.id;
    loadMediaForTab(currentTabId);
  }
  backendStatus = (await Messaging.sendToBackground(MessageType.BACKEND_STATUS)) || backendStatus;
  updateBackendPill();
  loadHistory();
  loadActiveDownloads();
  setupEventListeners();
}

async function loadMediaForTab(tabId) {
  const items = await Messaging.sendToBackground(MessageType.GET_MEDIA, { tabId });
  detectedItems = items || [];
  renderMediaList(detectedItems);
}

function renderChips(card, item, analysis) {
  const container = card.querySelector('.media-chips');
  container.innerHTML = '';
  const chips = [];
  if (item.isEmbed && PLATFORM_LABELS[item.embedPlatform]) {
    chips.push(PLATFORM_LABELS[item.embedPlatform]);
  } else if (item.type === 'audio') {
    chips.push('Áudio');
  } else {
    chips.push('Vídeo');
  }
  chips.push((item.format || 'mp4').toUpperCase());
  const duration = Formats.formatDuration(analysis && analysis.duration);
  if (duration) chips.push(duration);
  container.innerHTML = chips.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('');
}

function renderFormatList(card, item, analysis) {
  const listEl = card.querySelector('.format-list');
  listEl.innerHTML = '';
  const formats = (analysis && analysis.formats) || [];
  if (formats.length === 0) {
    listEl.innerHTML = '<div class="analyze-status">Nenhum formato disponível.</div>';
    listEl.classList.remove('hidden');
    return;
  }

  formats.forEach((fmt) => {
    const row = document.createElement('div');
    row.className = 'format-row' + (fmt.id === analysis.best_id ? ' best' : '');
    const label = fmt.type === 'audio' ? 'MP3' : (fmt.resolution || (fmt.ext || '').toUpperCase());
    row.innerHTML = `
      <span class="dl">⬇</span>
      <span class="res">${escapeHtml(label)}</span>
      <span class="ext">${escapeHtml((fmt.type === 'audio' ? 'Áudio · 192kbps' : (fmt.ext || '').toUpperCase()))}</span>
      <span class="size">${escapeHtml(Formats.sizeLabel(fmt.size, fmt.size_estimated))}</span>
      ${fmt.id === analysis.best_id ? '<span class="badge-best">MELHOR</span>' : ''}
    `;
    row.addEventListener('click', () => downloadRow(card, item, fmt));
    listEl.appendChild(row);
  });

  listEl.innerHTML += '<div class="format-legend">≈ tamanho estimado · clique numa linha para baixar</div>';
  listEl.classList.remove('hidden');
}

async function downloadRow(card, item, fmt) {
  const input = card.querySelector('.media-filename');
  const res = await Messaging.sendToBackground(MessageType.START_DOWNLOAD, {
    item: { ...item, tabId: currentTabId },
    filename: input.value,
    selector: fmt.selector || null,
    formatUrl: fmt.url || null,
    audio: fmt.type === 'audio',
  });
  if (res && res.ok) {
    flashButton(card.querySelector('.btn-primary'), res.kind === 'advanced' ? 'No Motor Local!' : '✅ Iniciado');
  } else {
    const reason = res && res.reason;
    if (reason === 'backend_offline') {
      showWarn(card, 'Inicie o Motor Local para baixar este formato.');
    } else {
      showWarn(card, (res && res.error) || 'Falha ao iniciar o download.');
    }
  }
}

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2000);
}

function showWarn(card, message) {
  const status = card.querySelector('.analyze-status');
  status.classList.remove('hidden');
  status.innerHTML = `⚠ ${escapeHtml(message)}`;
}

async function expandFormats(card, item) {
  const status = card.querySelector('.analyze-status');
  const listEl = card.querySelector('.format-list');
  status.classList.remove('hidden');
  status.innerHTML = '<span class="spinner"></span> Analisando…';
  listEl.classList.add('hidden');

  const res = await Messaging.sendToBackground(MessageType.ANALYZE_MEDIA, {
    url: item.url,
    referer: item.pageUrl,
  });

  if (res && res.ok) {
    status.classList.add('hidden');
    const title = Formats.fallbackTitle(item, res.result.title);
    card.querySelector('.media-filename').value = title;
    renderChips(card, item, res.result);
    renderFormatList(card, item, res.result);
    card._analysis = res.result;
  } else {
    const reason = res && res.reason;
    if (reason === 'backend_offline') {
      status.innerHTML = '⚠ Motor Local offline. <span class="retry">Tentar novamente</span>';
    } else {
      status.innerHTML = `Não foi possível analisar. <span class="retry">Tentar novamente</span>`;
    }
    status.querySelector('.retry').addEventListener('click', () => expandFormats(card, item));
  }
}

async function downloadBest(card, item) {
  // Arquivo direto com motor offline: baixa direto no navegador (sem análise).
  if (!backendStatus.online && Formats.isDirectFile(item)) {
    await downloadRow(card, item, {});
    return;
  }
  if (!card._analysis) {
    await expandFormats(card, item);
  }
  const analysis = card._analysis;
  if (!analysis) return;
  const best = Formats.pickBest(analysis.formats, analysis.best_id);
  if (best) await downloadRow(card, item, best);
}

function renderMediaList(items) {
  mediaList.innerHTML = '';

  if (items.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  items.slice(0, 10).forEach((item) => {
    const clone = template.content.cloneNode(true);
    const card = clone.querySelector('.media-card');
    const input = clone.querySelector('.media-filename');
    const btnMore = clone.querySelector('.btn-more');
    const moreMenu = clone.querySelector('.more-menu');

    input.value = Formats.fallbackTitle(item, null);
    renderChips(card, item, null);

    if (item.size > 0 && Formats.isDirectFile(item)) {
      card.querySelector('.media-chips').innerHTML +=
        `<span class="chip">${escapeHtml(Formats.sizeLabel(item.size, false))}</span>`;
    }

    if (item.isEmbed) {
      const badge = document.createElement('span');
      const isHotmart = item.embedPlatform === 'hotmart';
      badge.className = 'chip';
      badge.style.cssText = isHotmart
        ? 'background:#F7A800;color:#000;font-weight:600;'
        : 'background:#E1306C;color:#fff;font-weight:600;';
      badge.textContent = isHotmart ? '▶ Play primeiro' : 'Embed';
      card.querySelector('.media-chips').appendChild(badge);
    }

    if (item.embedPlatform === 'hotmart' && !backendStatus.online) {
      showWarn(card, 'Dê play no vídeo e mantenha o Motor Local rodando para baixar.');
    }

    // Offline + arquivo direto: aviso e botão de fallback nativo (spec §4.1).
    if (!backendStatus.online && Formats.isDirectFile(item)) {
      const warn = document.createElement('div');
      warn.className = 'warn-box';
      warn.textContent = '⚠ Motor Local offline — o download usará o navegador.';
      card.querySelector('.media-buttons').insertAdjacentElement('afterend', warn);
      card.querySelector('.btn-best').textContent = '⬇ Baixar direto (navegador)';
    }

    card.querySelector('.btn-analyze').addEventListener('click', () => expandFormats(card, item));
    card.querySelector('.btn-best').addEventListener('click', () => downloadBest(card, item));

    btnMore.addEventListener('click', (e) => {
      e.stopPropagation();
      const visible = !moreMenu.classList.contains('hidden');
      document.querySelectorAll('.more-menu').forEach((m) => m.classList.add('hidden'));
      if (!visible) moreMenu.classList.remove('hidden');
    });

    clone.querySelector('.btn-copy-url').addEventListener('click', () => {
      navigator.clipboard.writeText(item.url);
      moreMenu.classList.add('hidden');
    });
    clone.querySelector('.btn-copy-page').addEventListener('click', () => {
      navigator.clipboard.writeText(item.pageUrl);
      moreMenu.classList.add('hidden');
    });
    clone.querySelector('.btn-blacklist').addEventListener('click', async () => {
      const urlObj = new URL(item.pageUrl);
      await Storage.addToBlacklist(urlObj.hostname);
      moreMenu.classList.add('hidden');
    });

    mediaList.appendChild(clone);
  });
}

async function loadHistory() {
  const history = await Storage.getHistory();
  historyList.innerHTML = '';
  if (history.length === 0) {
    historyList.innerHTML = '<div style="padding: 8px; text-align: center; color: var(--text-4); font-size: 10.5px;">Sem downloads recentes</div>';
    return;
  }
  history.slice(0, 5).forEach((item) => {
    const el = document.createElement('div');
    el.className = 'history-item';
    const timeStr = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const shortName = (item.filename || '').split('/').pop();
    el.innerHTML = `
      <span class="filename" title="${escapeHtml(item.filename)}">${escapeHtml(shortName)}</span>
      <span class="time">${item.state === 'complete' ? '✅' : '⏳'} ${timeStr}</span>
    `;
    historyList.appendChild(el);
  });
}

async function loadActiveDownloads() {
  const active = await Messaging.sendToBackground(MessageType.GET_ACTIVE_DOWNLOADS);
  renderActiveDownloads(active || []);
}

function activeStateLabel(item) {
  if (item.state === 'complete') return '✅ Concluído';
  if (item.state === 'error') return '❌ Erro';
  if (item.state === 'interrupted') return '⚠️ Interrompido';
  if (item.state === 'merging') return '🎛️ Juntando áudio e vídeo...';
  return '⏳ Baixando...';
}

function renderActiveDownloads(items) {
  if (!activeDownloadsSection || !activeDownloadsList) return;
  activeDownloadsList.innerHTML = '';
  if (!items || items.length === 0) {
    activeDownloadsSection.classList.add('hidden');
    return;
  }
  activeDownloadsSection.classList.remove('hidden');

  items.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'active-item';
    const short = (item.filename || item.url || '').split('/').pop();
    const pct = Math.max(0, Math.min(100, parseInt(item.progress, 10) || 0));
    el.innerHTML = `
      <div class="active-item-head">
        <span class="filename" title="${escapeHtml(item.url || '')}">${escapeHtml(short)}</span>
        <span class="pct">${pct}%</span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="active-state">${activeStateLabel(item)}${item.speed ? `<span class="active-speed"> · ${escapeHtml(item.speed)}</span>` : ''}</div>
    `;
    activeDownloadsList.appendChild(el);
  });
}

function setupEventListeners() {
  document.addEventListener('click', () => {
    document.querySelectorAll('.more-menu').forEach((m) => m.classList.add('hidden'));
  });

  btnSidebar.addEventListener('click', () => {
    chrome.sidePanel.setOptions({ tabId: currentTabId, path: 'popup/popup.html', enabled: true });
    chrome.sidePanel.open({ tabId: currentTabId });
    window.close();
  });

  btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

  btnOpenDashboard.addEventListener('click', () => {
    const port = backendStatus.port || 5000;
    chrome.tabs.create({ url: `http://127.0.0.1:${port}/` });
  });

  historyToggle.addEventListener('click', () => {
    historyList.classList.toggle('collapsed');
    const chevron = historyToggle.querySelector('.chevron');
    chevron.textContent = historyList.classList.contains('collapsed') ? '▾' : '▴';
  });

  btnOpenFolder.addEventListener('click', () => chrome.downloads.showDefaultFolder());
  btnClearHistory.addEventListener('click', async () => {
    await Storage.clearHistory();
    loadHistory();
  });

  Messaging.addListener((message) => {
    if (message.type === MessageType.DOWNLOAD_UPDATE) {
      loadHistory();
      loadActiveDownloads();
    } else if (message.type === MessageType.BACKEND_STATUS) {
      const next = message.payload || backendStatus;
      const changed = next.online !== backendStatus.online;
      backendStatus = next;
      updateBackendPill();
      // Re-renderiza apenas quando o estado muda (liga/desliga o motor)
      if (changed) renderMediaList(detectedItems);
    }
    return false;
  });
}

document.addEventListener('DOMContentLoaded', init);
```

- [ ] **Step 4: Verificação manual (pré-matriz)**

Carregar a extensão descompactada em `edge://extensions` (Desenvolvedor → "Carregar descompactada" → raiz do projeto). Expected: popup escuro com o novo header/pill; abrir em uma página sem mídia mostra o estado vazio; sem o Motor Local rodando, a pill fica vermelha.

- [ ] **Step 5: Commit**

```bash
git add popup/popup.html popup/popup.css popup/popup.js
git commit -m "feat: redesign Dark Pro do popup com lista de formatos"
```

---

### Task 12: `content.js` — capturar `og:title` e `pageTitle`

**Files:**
- Modify: `content.js`

**Interfaces:**
- Consumes: padrão atual.
- Produces: itens de mídia com `ogTitle` e `pageTitle` (usados por `Formats.fallbackTitle` no popup).

- [ ] **Step 1: Editar `content.js`**

Adicionar helper junto às demais funções (após `generateId`):
```js
  // Título da página para fallback de nome da mídia
  function getPageTitles() {
    const ogMeta = document.querySelector('meta[property="og:title"]');
    return {
      ogTitle: ogMeta ? ogMeta.getAttribute('content') || '' : '',
      pageTitle: document.title || ''
    };
  }
```

Em `extractMediaInfo`, no objeto retornado, adicionar após `pageTitle: document.title,`:
```js
        ogTitle: getPageTitles().ogTitle,
```
(manter `pageTitle: document.title` como está — o valor já existe no objeto atual.)

Em `buildInstagramMediaItem` e nos 4 builders de iframe (`youtube`, `vimeo`, `panda`, `hotmart`), adicionar `ogTitle: getPageTitles().ogTitle,` ao lado do `pageTitle` existente.

- [ ] **Step 2: Verificação**

Run: `node --check content.js` — Expected: sem erro de sintaxe.
Manual: abrir uma página com `og:title` (ex.: YouTube) e conferir no console do service worker (mensagem `MEDIA_DETECTED`) que os itens têm `ogTitle` preenchido.

- [ ] **Step 3: Commit**

```bash
git add content.js
git commit -m "feat: captura de og:title e pageTitle nos itens detectados"
```

---

### Task 13: Options — tema Dark Pro

**Files:**
- Rewrite: `options/options.css`
- Modify: `options/options.html` (remover emojis do título das seções para o visual clean — opcional; manter estrutura)

**Interfaces:**
- Consumes: `Storage` (sem mudança funcional).
- Produces: página de configurações com identidade Dark Pro. Nenhum task depende.

- [ ] **Step 1: Reescrever `options/options.css`**

```css
:root {
  --bg: #0E1116;
  --surface: #171B22;
  --header: #141922;
  --border: #232A35;
  --border-strong: #3A4356;
  --text: #E6E9EF;
  --text-2: #C4CBD8;
  --text-3: #9AA3B2;
  --violet: #6E56F8;
  --violet-2: #A79BFF;
  --grad-btn: linear-gradient(135deg, #6E56F8, #8B5CF6);
  --font: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #FFFFFF;
    --surface: #F7F8FA;
    --header: #FAFBFC;
    --border: #E5E7EB;
    --border-strong: #D1D5DB;
    --text: #111827;
    --text-2: #374151;
    --text-3: #6B7280;
  }
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
}

.container { max-width: 640px; margin: 0 auto; padding: 28px 20px; }

header { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
header img { width: 32px; height: 32px; }
header h1 { font-size: 17px; font-weight: 600; }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 18px;
  margin-bottom: 14px;
}
.card h2 { font-size: 13px; font-weight: 700; margin-bottom: 12px; color: var(--text); }

.form-group { margin-bottom: 14px; }
.form-group label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 5px; }
.form-group input[type="text"],
.form-group select {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border-strong);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  padding: 7px 10px;
  border-radius: 6px;
}
.hint { color: var(--text-3); font-size: 11px; margin-top: 4px; }

.checkbox-group { display: flex; align-items: center; gap: 8px; }
.checkbox-group input { accent-color: var(--violet); }
.checkbox-group label { margin: 0; font-weight: 400; }

.blacklist-controls { display: flex; gap: 8px; margin-bottom: 10px; }
.blacklist-controls input { flex: 1; }
.blacklist-list { list-style: none; }
.blacklist-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 7px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 6px;
  font-size: 12px;
}
.btn-remove {
  background: none;
  border: none;
  color: var(--violet-2);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
}

.btn-primary {
  background: var(--grad-btn);
  border: none;
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 8px 18px;
  border-radius: 6px;
  cursor: pointer;
}

footer { display: flex; align-items: center; justify-content: space-between; }
.status-msg { color: var(--violet-2); font-size: 12px; opacity: 0; transition: opacity 200ms; }
.status-msg.show { opacity: 1; }
```

(As classes `blacklist-item`, `status-msg`, `show` já são usadas por `options.js`/`options.html` atuais — nada funcional muda.)

- [ ] **Step 2: Verificação manual**

Abrir a página de opções (popup → ⚙). Expected: tema Dark Pro; salvar configurações continua funcionando; blacklist continua funcional.

- [ ] **Step 3: Commit**

```bash
git add options/
git commit -m "style: tema Dark Pro na página de opções"
```

---

### Task 14: Deploy — requirements, dados do PyInstaller e build

**Files:**
- Modify: `deploy/build-backend-exe.ps1`

**Interfaces:**
- Consumes: `backend/web/`, `icons/`, `backend/requirements.txt` (com pystray/pillow do Task 7).
- Produces: EXE com dashboard e bandeja funcionais.

- [ ] **Step 1: Atualizar `deploy/build-backend-exe.ps1`**

Na checagem de dependências (linha ~84), adicionar os módulos novos:
```powershell
for m in ('PyInstaller','flask','flask_cors','yt_dlp','requests','waitress','curl_cffi','pystray','PIL'):
```

Após o bloco `# yt-dlp carrega os extractors...` (linha ~122), adicionar:
```powershell
# pystray (bandeja) carrega backends dinamicamente: incluir o pacote inteiro
$pyArgs += '--collect-all=pystray'
# Dashboard web e ícones (dados usados em runtime via resource_path)
$pyArgs += '--add-data', ((Join-Path $projectRoot 'backend\web') + ';backend\web')
$pyArgs += '--add-data', ((Join-Path $projectRoot 'icons') + ';icons')
```

Remover do comentário da linha ~126 a menção a `tkinter` (não é mais usado).

- [ ] **Step 2: Build**

Run (PowerShell, raiz):
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\build-backend-exe.ps1 -Rebuild
```
Expected: `Backend EXE gerado: ...\deploy\dist\backend\EdgeVideoDownloaderBackend.exe`.

- [ ] **Step 3: Smoke do EXE**

Run: `.\deploy\dist\backend\EdgeVideoDownloaderBackend.exe`
Expected: navegador abre o dashboard (Dark Pro), bandeja aparece, "Parar Motor Local" encerra. Conferir que `%LOCALAPPDATA%\EdgeVideoDownloader\config.json` foi criado ao salvar uma config.

- [ ] **Step 4: Commit**

```bash
git add deploy/build-backend-exe.ps1
git commit -m "build: incluir dashboard web, ícones e pystray no EXE"
```

---

### Task 15: Matriz manual end-to-end + correções

**Files:**
- Modify: arquivos conforme bugs encontrados.
- Create: `docs/superpowers/plans/2026-08-26-matriz-manual-resultado.md` (registro do resultado)

**Interfaces:**
- Consumes: tudo dos Tasks 1–14.
- Produces: matriz da spec §9 executada e registrada; bugs corrigidos com commits próprios.

- [ ] **Step 1: Subir o ambiente**

Iniciar o Motor Local (EXE do Task 14 ou `python -m backend.server`) e carregar a extensão descompactada no Edge.

- [ ] **Step 2: Executar cada cenário da spec §9 e registrar**

Para cada item, marcar ✓/✗ com evidência curta (arquivo criado, tamanho conferido):

1. **YouTube** — "Ver resoluções" lista formatos com título real; baixar 1080p e MP3; conferir nome e tamanho na pasta.
2. **Hotmart** — dar play → m3u8 na lista → variantes com resolução → download via ffmpeg conclui.
3. **Arquivo direto MP4** — tamanho exato no card; com motor offline, "Baixar melhor" usa o navegador (fallback nativo).
4. **Instagram** — download único via yt-dlp com cookies.
5. **Vimeo** — lista e download.
6. **Página sem mídia** — estado vazio com dica.
7. **Motor Local offline** — pill vermelha no popup; avisos e fallback corretos.
8. **Dashboard** — download de teste → progresso ao vivo → histórico persistido após reiniciar o servidor (conferir `backend/data/history.json` e a aba "Concluídos").

- [ ] **Step 3: Corrigir bugs encontrados**

Cada correção: primeiro um teste que reproduza (pytest/node:test quando aplicável), depois a correção, commit próprio com mensagem `fix: <descrição>`.

- [ ] **Step 4: Registrar o resultado e commit final**

Preencher `docs/superpowers/plans/2026-08-26-matriz-manual-resultado.md` com a tabela dos 8 cenários e notas.
```bash
git add -A
git commit -m "docs: resultado da matriz manual end-to-end"
```

---

## Self-Review (checklist executado pelo autor do plano)

- [x] **Spec coverage:** §2 arquitetura → T8–T11; §3 título/tamanho/agrupamento → T1 (analyzer) + T8 (formats) + T12; §4 popup → T11; §5 API → T2–T5; §6 dashboard → T6; §7 robustez (portas/instância/fila/persistência) → T2, T3, T7; §8 arquivos → estrutura acima; §9 testes → T1/T2/T3/T4/T7 (pytest), T8 (node), T15 (matriz); §10/§11 riscos → T14 (PyInstaller) e mensagens de erro em T1/T5.
- [x] **Placeholder scan:** nenhum "TBD"/"similar to"; todo passo de código tem o código completo.
- [x] **Type consistency:** `analyze_url(url, referer, cookies_list, default_quality)` consistente entre T1 (definição) e T4 (uso); `Formats.sizeLabel(size, estimated)` entre T8 e T11; `handleStartDownload({item, filename, selector, formatUrl, audio})` entre T10 e T11; `QUEUE.submit(fn, task)` entre T3 e T5; nomes de `MessageType` entre T9, T10 e T11.
