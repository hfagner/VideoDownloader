"""Análise de mídias: título + formatos + tamanhos (exato ou estimado).

Funções de parsing/estimativa são puras (testáveis); analyze_url() orquestra
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
