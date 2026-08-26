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
