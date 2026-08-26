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


def test_cookie_file_ids_distintos_por_chamada():
    from analyzer import write_cookie_file
    cookies = [{"name": "a", "value": "b", "domain": ".ex.com", "path": "/"}]
    p1 = write_cookie_file(cookies, "analyze_aaaa")
    p2 = write_cookie_file(cookies, "analyze_bbbb")
    assert p1 and p2 and p1 != p2
    import os as _os
    for p in (p1, p2):
        if _os.path.exists(p):
            _os.remove(p)
