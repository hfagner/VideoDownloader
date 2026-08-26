# Design — Modernização das Interfaces do Edge Video Downloader

**Data:** 2026-08-26
**Status:** Aprovado em brainstorming (seções 1–3 validadas pelo usuário)
**Escopo:** Extensão Edge (popup/options) + aplicativo de backend (Motor Local, `backend/server.py`)

---

## 1. Visão Geral

Modernizar as interfaces do plugin e do aplicativo de backend com identidade visual **Dark Pro**, tornando o fluxo prático e robusto: ao detectar um vídeo ou áudio, o popup apresenta o **nome real** (quando possível) e opções de download com **resoluções diferentes e respectivos tamanhos** (exatos ou estimados). O backend ganha um **dashboard web** com fila, progresso em tempo real, histórico e configurações.

Decisões aprovadas no brainstorming:

| Tema | Decisão |
|---|---|
| Interface do backend | Dashboard web local (Flask serve página em `localhost`) |
| Apresentação das resoluções | Sob demanda ("Ver resoluções") com cache por URL |
| Tamanhos | Exato quando disponível; estimado com prefixo "≈"; omitido quando impossível |
| Escopo v1 da lista de formatos | YouTube, Vimeo, HLS/m3u8 diretos (incl. Hotmart) e arquivos diretos. Instagram e Panda Video: download único |
| Inicialização do backend | EXE abre dashboard no navegador + ícone na bandeja (pystray); fechar a aba não interrompe downloads |
| Roteamento de downloads | Com Motor Local online: tudo passa por ele (fila única). Offline: fallback para download nativo do navegador |
| Identidade visual | **Dark Pro** (padrão escuro; modo claro suportado via `prefers-color-scheme`) |
| Arquitetura de análise | Centralizada no backend: endpoint `/api/analyze` (yt-dlp + parse m3u8) |

---

## 2. Arquitetura e Componentes

```
┌─────────────────────────────────────────────────────────────┐
│  Extensão (MV3)                                             │
│  content.js ──► background.js ──► popup (Dark Pro)          │
│   detecta DOM    detecta rede,   lista mídias + formatos    │
│   (títulos,      cache análise,  pill status do motor       │
│   iframes)       roteia download                            │
│        │                │                                   │
└────────┼────────────────┼───────────────────────────────────┘
         │                │  HTTP localhost (127.0.0.1)
         ▼                ▼
┌─────────────────────────────────────────────────────────────┐
│  Motor Local (backend, Python)                              │
│  server.py (rotas, fila, dashboard)                         │
│  analyzer.py (análise yt-dlp/m3u8, estimativa de tamanho)   │
│  web/ (dashboard Dark Pro: fila, histórico, config)         │
│  + bandeja (pystray) + dados persistidos em JSON            │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 Componentes e responsabilidades

**`content.js`** — mantém detecção DOM atual e passa a capturar `pageTitle`, `og:title` e `document.title` nos itens de mídia (para o fallback de nome).

**`background.js`**
- Mantém detecção por `webRequest` e consolidação por aba (como hoje).
- Novo: **status do Motor Local** — ping a `http://127.0.0.1:5000/api/ping` (e portas 5001/5002 como fallback) a cada 30 s via `chrome.alarms`; memoriza a porta ativa e transmite o status ao popup (pill verde/vermelha).
- Novo: **cache de análises** — `chrome.storage.session`, chave = URL da mídia, TTL 30 min. Armazena a resposta de `/api/analyze` com timestamp. Erros nunca são cacheados.
- Novo: roteamento de download — se o motor está online, **todos** os downloads vão para `/api/download`; offline, arquivos diretos usam `chrome.downloads` (fallback).

**`popup/`** — redesign Dark Pro. Card de mídia com título, chips, botões "Ver resoluções" e "⬇ Baixar melhor", lista de formatos expandida, downloads em andamento, histórico e rodapé. Pill de status do motor no header. (Ver Seção 4.)

**`backend/server.py`** — app Flask (waitress), rotas (Seção 5), fila de downloads (máx. 2 simultâneos, FIFO), persistência em JSON, serve o dashboard (`web/`), bandeja via pystray, abertura automática do dashboard no navegador ao iniciar.

**`backend/analyzer.py`** — funções puras e testáveis: parse de playlist m3u8 (variantes/resolução/bitrate), extração de formatos via `yt_dlp.extract_info(download=False)`, estimativa de tamanho (BANDWIDTH × duração), normalização da resposta `{title, formats[]}`.

**`backend/web/`** — dashboard estático (HTML/CSS/JS, sem build step) servido pelo Flask. Polling de 1,5 s em `/api/tasks` para progresso (decisão de substituir SSE da Seção 1 — mais simples e robusto no waitress).

**`options/`** — recebe apenas o tema Dark Pro (consistência visual); funcionalidades atuais permanecem.

### 2.2 Fluxo de dados principal

**"Ver resoluções":**
```
popup → cache? ──(hit)──► render direto
         │ (miss)
         ▼
POST /api/analyze {url, cookies?, referer?}
         │
         ├─ m3u8 direto  → parse da playlist (~1s)
         ├─ YouTube/Vimeo → yt_dlp.extract_info(download=False) (3–10s)
         └─ arquivo direto → 1 formato (tamanho via HEAD content-length)
         ▼
{title, formats: [{id, resolution, ext, size?, estimated, selector}]}
         ▼
popup renderiza linhas → grava no cache (sucesso apenas)
```

**Download (motor online):**
```
popup → POST /api/download {url, format_id?, filename?, referer?, cookies?}
        → entra na fila (máx. 2 simultâneos)
        → yt-dlp com selector do formato OU ffmpeg na variante m3u8 escolhida
        → grava na pasta configurada com filename sanitizado
        → dashboard/popup acompanham via /api/tasks e /api/status/<id>
```

**Download (motor offline):** diretos → `chrome.downloads`; streams/YouTube → aviso no card "inicie o Motor Local".

---

## 3. Regras de Análise e Tamanho

### 3.1 Cadeia de fallback do título
1. Título devolvido pelo `/api/analyze` (yt-dlp: título real do vídeo);
2. `og:title` da página (capturado pelo content script);
3. `document.title` / nome do arquivo derivado da URL;
4. `media_<timestamp>.<ext>` como último recurso.

### 3.2 Tamanho
| Fonte | Estratégia | Exibição |
|---|---|---|
| Arquivo direto | `content-length` (HEAD com referer) | exato |
| YouTube/Vimeo | `filesize`/`filesize_approx`/`tbr×duração` do yt-dlp | exato ou ≈ |
| HLS/m3u8 | `BANDWIDTH × duração` da playlist (quando duração obtível) | ≈ |
| Impossível | — | "Tamanho indisponível" |

Nunca exibir 0/negativo. Prefixo "≈" quando estimado, com legenda discreta "≈ tamanho estimado" na lista.

### 3.3 Agrupamento de formatos (YouTube/Vimeo)
- Uma linha por altura única (1080p, 720p, 480p, …) com melhor codec/ext disponível;
- Linha extra "MP3 · Áudio" (192kbps);
- Linha "MELHOR" = maior altura com tamanho/tbr conhecido, respeitando a `default_quality` configurada no dashboard — usada pelo botão "⬇ Baixar melhor"; a resposta da análise inclui `best_id` apontando essa linha;
- Cada linha carrega um **selector yt-dlp** pronto, ex.: `bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]`.

### 3.4 HLS direto (incl. Hotmart após play)
- Parse do m3u8 master: variantes `RESOLUTION=WxH` + `BANDWIDTH`;
- Cada variante vira uma linha (resolução + ≈ tamanho quando houver duração);
- Download = ffmpeg direto na URL da variante (mantém lógica atual de headers/Referer);
- Playlist sem variantes (m3u8 de mídia única) → download único.

---

## 4. Design da Interface — Popup (Dark Pro)

Dimensões: largura ~420 px (popup), máx. altura 600 px com scroll interno; no modo Sidebar o mesmo HTML se adapta à largura maior.

### 4.1 Estados
1. **Card recolhido** — ícone ▶ (tile violeta), título real (editável — lápis), chips (plataforma · extensão · duração quando disponível), botões "▾ Ver resoluções" (outline) e "⬇ Baixar melhor" (gradiente), menu ⋮ (copiar URL, copiar URL da página, bloquear domínio).
2. **Card expandido** — lista de linhas de formato: ⬇, resolução, ext, tamanho à direita; melhor linha destacada (fundo `#221F3A`, borda esquerda violeta, badge "MELHOR"); clique na linha inicia o download daquele formato; "Analisando…" com spinner enquanto espera o probe.
3. **Motor Local offline** — pill vermelha no header; aviso no card; botão "⬇ Baixar direto (navegador)" em arquivos diretos; streams/YouTube exibem dica para iniciar o app.
4. **Vazio** — ícone, "Nenhuma mídia detectada nesta página", dica "Dê play no vídeo e reabra o painel", link de ajuda.

### 4.2 Demais áreas
- **Downloads em andamento** — nome, % (gradiente `#6E56F8→#00C2FF`), velocidade quando disponível;
- **Histórico** — recolhível, itens com ✓ e horário (dados da extensão; o histórico completo fica no dashboard);
- **Rodapé** — 📂 Abrir pasta · 🧹 Limpar · ⚙ Configurações;
- **Pill do motor** no header (verde "● Motor Local" / vermelho "● Motor Local offline").

### 4.3 Tokens visuais (Dark Pro)

Modo escuro (padrão):
| Token | Valor |
|---|---|
| fundo | `#0E1116` |
| superfície / cards | `#171B22` |
| header/rodapé | `#141922` |
| bordas | `#232A35` / `#3A4356` (hover) |
| texto primário | `#E6E9EF` |
| texto secundário | `#C4CBD8` / `#9AA3B2` / `#6B7688` |
| accent primário (botões) | gradiente `#6E56F8 → #8B5CF6` |
| accent progresso | gradiente `#6E56F8 → #00C2FF` |
| accent texto/ícones | `#A79BFF` |
| destaque linha | fundo `#221F3A`, borda `#6E56F8` |
| sucesso | `#00D68F` (pill fundo `#0F2B22`) |
| erro | `#FF7B7B` (pill fundo `#2B1618`), botão parar `#D93025` |
| tipografia | `'Segoe UI Variable', 'Segoe UI', system-ui` |

Modo claro (`prefers-color-scheme: light`): fundo `#FFFFFF`, superfície `#F7F8FA`, header `#FAFBFC`, bordas `#E5E7EB`, texto `#111827`/`#6B7280`, accent mantido `#6E56F8` (gradientes atenuados), sucesso `#059669`, erro `#DC2626`.

---

## 5. API do Backend

### 5.1 `POST /api/analyze`
Request: `{url, referer?, pageUrl?, cookies?: [Cookie...]}`
Response 200:
```json
{
  "title": "Aula 1 - Introdução ao Curso",
  "duration": 504,
  "source": "ytdlp | hls | direct",
  "best_id": "h1080",
  "formats": [
    {
      "id": "h1080",
      "resolution": "1080p",
      "height": 1080,
      "ext": "mp4",
      "type": "video",
      "size": 220200960,
      "size_estimated": false,
      "selector": "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]"
    },
    { "id": "mp3", "resolution": null, "ext": "mp3", "type": "audio",
      "size": 8390000, "size_estimated": true, "selector": "bestaudio/best" }
  ]
}
```
Erros: HTTP 400 (URL ausente), 422 (fonte não analisável), 502 (falha do yt-dlp/parse) com `{error: "<mensagem clara>"}`.

### 5.2 `POST /api/download` (estendido)
Request: `{url, referer?, headers?, cookies?, format_type?, format_id?, selector?, filename?}`
- `selector` presente → repassado ao yt-dlp (`format`);
- `format_id` de HLS → URL da variante para ffmpeg;
- `type: audio` (ou `format_id: mp3`) → aplica pós-processador `FFmpegExtractAudio` (mp3, 192k), como no fluxo atual de `format_type: audio`;
- `filename` → sanitizado (`[^\w\s.-]` → `-`, limite 120 chars) e usado no output;
- Retorno 202: `{message, task_id, output_dir}` (como hoje).

### 5.3 Demais
| Rota | Descrição |
|---|---|
| `GET /api/ping` | `{ok: true, service, port}` (já existe) |
| `GET /api/status/<task_id>` | status/progresso de uma tarefa (já existe; ganha `speed`, `eta` quando disponível) |
| `GET /api/tasks` | lista completa de tarefas (ativas + últimas concluídas) para o dashboard |
| `POST /api/cancel/<task_id>` | mata ffmpeg/yt-dlp da tarefa; marca como cancelada |
| `GET /api/history` | histórico persistido (`data/history.json`) |
| `GET/POST /api/config` | `{download_dir, default_quality, autostart, notifications}` |
| `POST /api/shutdown` | encerra motor (mata ffmpeg filhos, persiste estado) |
| `GET /` | dashboard Dark Pro |

### 5.4 Fila
- Máx. **2 downloads simultâneos**; demais aguardam em FIFO;
- Tarefas persistidas em `data/history.json` (estado, título, pasta, tamanho quando concluído);
- Ao reiniciar, tarefas não concluídas aparecem como "interrompidas" (sem auto-retomada na v1);
- Velocidade/ETA derivados dos hooks de progresso existentes (ffmpeg `time=` e yt-dlp `_percent_str`).

---

## 6. Dashboard do Motor Local (Dark Pro)

Servido em `/` (localhost). Mesmos tokens visuais do popup.

1. **Top bar** — logo, pill "● Servidor ativo", botões 📂 Abrir pasta · ⚙ Config · ■ Parar.
2. **Estatísticas** — tiles: Em andamento · Concluídos hoje · Baixado hoje.
3. **Em andamento** — fila com nome, resolução, velocidade, ETA, barra de progresso em gradiente, ✕ cancelar por item.
4. **Concluídos** — lista com ✓, meta (1080p · 210 MB), horário, 📂 abrir arquivo/pasta do item.
5. **Config** — pasta de destino (com "Alterar"), qualidade padrão (limita a linha MELHOR usada pelo "Baixar melhor"), iniciar com o Windows (toggle), notificações (toggle).

Comportamento do app:
- EXE inicia servidor (porta 5000 → 5001 → 5002 se ocupada), abre dashboard no navegador padrão, ícone na **bandeja** (pystray): Abrir dashboard · Abrir pasta · Parar Motor Local;
- Fechar a aba do navegador não para o servidor nem os downloads;
- Abrir o EXE novamente com instância ativa → apenas abre o dashboard da instância existente;
- "Iniciar com o Windows" = chave `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (criada/removida pela config do dashboard).

---

## 7. Robustez e Tratamento de Erros

| Situação | Comportamento |
|---|---|
| Motor Local offline | Pill vermelha (ping 30 s via alarms); diretos → fallback nativo; streams/YouTube → dica para iniciar |
| Análise demorada (>15 s) | Timeout no popup (AbortController); botão volta; erro inline com "Tentar novamente" |
| Análise falha | Erro claro no card; nunca entra no cache |
| Porta ocupada | Backend sobe em 5001/5002 e grava porta real; extensão testa as 3 e memoriza a ativa |
| Instância dupla | Segundo EXE detecta `_is_running()` e apenas abre o dashboard existente |
| Parar durante download | Mata ffmpeg/yt-dlp filhos, persiste estado, encerra |
| Reinício do servidor | Tarefas incompletas marcadas "interrompidas" no dashboard |
| Cookies do Instagram | Fluxo atual mantido; erro claro se `curl-cffi` ausente |
| DRM (Netflix/Prime etc.) | Aviso amigável de limitação (fora de escopo) |
| Nome inválido | Sanitização no backend; nunca quebra o download |
| CORS | `CORS(app)` mantido para fetch da extensão; dashboard é mesma origem (sem CORS) |
| Muitas mídias na página | Popup limita a 10 cards, com scroll interno |

---

## 8. Estrutura de Arquivos (arquivos tocados)

**Extensão:**
- `popup/popup.html` — nova estrutura (estados, linhas de formato, pill)
- `popup/popup.css` — tokens Dark Pro, claro/escuro
- `popup/popup.js` — render novo, fluxo analisar→expandir→baixar, fallback offline
- `background.js` — status do motor (ping/alarms), cache de análises, roteamento de download
- `content.js` — captura de `og:title`/`document.title` nos itens
- `libs/messaging.js` — novos `MessageType` (ANALYZE_MEDIA, BACKEND_STATUS, etc.)
- `libs/storage.js` — cache de análise (storage.session) e porta ativa do motor
- `options/options.*` — tema Dark Pro (sem mudança funcional)
- `manifest.json` — sem novas permissões previstas (as atuais já cobrem)

**Backend:**
- `backend/server.py` — rotas novas, fila, persistência, bandeja, abertura do dashboard
- `backend/analyzer.py` — **novo**: parse m3u8, extração yt-dlp, estimativa de tamanho (funções puras)
- `backend/web/` — **novo**: dashboard (index.html + style.css + app.js), Dark Pro
- `backend/requirements.txt` — + `pystray`, `pillow`
- `backend/test_hotmart.py` — mantido; novos scripts de teste em `test_rl/`

---

## 9. Testes

**Matriz manual por fonte (obrigatória antes de considerar concluído):**
1. YouTube — "Ver resoluções" lista formatos; baixar 1080p e MP3; conferir nome real e tamanho na pasta;
2. Hotmart — dar play → m3u8 aparece → lista de variantes → download via ffmpeg;
3. Arquivo direto MP4 — tamanho exato; com motor offline, fallback nativo funciona;
4. Instagram — download único via yt-dlp com cookies;
5. Vimeo — lista e download;
6. Página sem mídia — estado vazio;
7. Motor Local offline — pill vermelha, avisos e fallback;
8. Dashboard — download de teste → progresso ao vivo → histórico persistido após reiniciar o servidor.

**Automatizados:**
- Unit tests (pytest) para `analyzer.py`: parse m3u8 (com/sem variantes), estimativa de tamanho, normalização de formatos;
- Teste de API (`test_rl/`): `/api/analyze` com URL de teste pequena, `/api/download` + `/api/status` até concluir, `/api/config` round-trip.

---

## 10. Fora de Escopo (v1)

- Auto-retomada de downloads interrompidos;
- Conversão pós-download além do MP3 (YouTube);
- Controles de fila (reordenar) no popup — cancelar fica no dashboard;
- Internacionalização;
- Lista de resoluções para Instagram/Panda Video (download único);
- Conteúdo protegido por DRM.

## 11. Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Mudanças do YouTube quebram o yt-dlp | Pin de versão mínima no requirements; mensagens de erro com orientação de atualização; botão "Tentar novamente" |
| Bloqueio do Instagram (login/impersonação) | Fluxo atual com cookies; erro claro com instrução (`curl-cffi`) |
| Token m3u8 do Hotmart expira rápido | Análise/download próximos do momento do play; nova análise refaz o token |
| Popup lento com muitas mídias | Limite de 10 cards + scroll; análise só sob demanda |
| Bandeja indisponível (headless/CI) | Flag `--no-gui` mantida (servidor sem bandeja/janela) |
| PyInstaller + templates do dashboard | Templates/static como data files no build (ajuste no `deploy/`) |
