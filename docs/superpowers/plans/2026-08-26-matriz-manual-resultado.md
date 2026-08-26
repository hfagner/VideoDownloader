# Matriz manual end-to-end — Resultado (Task 15)

**Data:** 2026-08-26
**Branch:** `feat/ui-darkpro`
**Escopo:** parte automatizável da matriz da spec §9 (backend + headless); cenários que exigem o navegador do usuário (extensão carregada, cliques visuais, bandeja) ficam registrados como **pendente — checklist do usuário** abaixo, com o texto exato da spec §9 para conferência. Nenhuma evidência foi inventada para eles.

## Execução automatizada (itens do controller)

| # | Item | Resultado | Evidência curta |
|---|---|---|---|
| 1 | Suites automatizadas | OK | `pytest backend/tests -v` → **36 passed** (34 existentes + 2 novos do fix desta task); `node --test "tests/extension/*.test.mjs"` → **10 pass / 0 fail** |
| 2 | Motor Local (`--no-gui`) | OK | `GET /` → 200, markup do dashboard (`<title>Motor Local — Edge Video Downloader</title>`); `/api/ping` → `{"ok":true,"port":5000,"service":"edge-video-downloader"}`; `/api/config` → defaults (1080p, dir `%USERPROFILE%\Downloads\EdgeVideoDownloader`); `/api/tasks` e `/api/history` → vazios |
| 3 | Download direto real + fila + histórico + persistência | OK (1 bug encontrado e corrigido, ver abaixo) | `POST /api/download {url: BigBuckBunny 360 10s 1MB, filename:"matriz-teste"}` → `completed`; arquivo `C:\Users\Helton\Downloads\EdgeVideoDownloader\matriz-teste.mp4` com **991.017 bytes** (igual ao `Content-Length` da fonte); `/api/history` com `status: completed`, `size: 991017`, `filename: matriz-teste.mp4`; **restart do servidor** → histórico persistiu (`backend/data/history.json` com as tasks) |
| 3b | Cancel (guarda do T3) | OK | `POST /api/download` de arquivo de 10 MB → `POST /api/cancel` em ~0,5 s → status **`cancelled`**; após a thread terminar (aguardado 8 s), status permaneceu `cancelled` (não sobrescrito) e entrou no histórico como cancelled |
| 4 | `/api/analyze` (YouTube real) | OK (rede permitiu) | `POST /api/analyze {url: https://www.youtube.com/watch?v=dQw4w9WgXcQ}` → 200 com título real "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", `formats` com `h720`/`h1080`/`mp3`, `best_id: h1080`, `source: ytdlp` |
| 5 | Dashboard vivo (Edge headless) | OK | Edge headless (`--headless=new --virtual-time-budget=12000 --log-net-log`) carregou `/`; net log mostra polling repetido de `/api/tasks` + `/api/history` em pares intercalados (27 requisições por endpoint em 3 cargas de página × 9 polls por carga sobre 12 s de tempo virtual = 1 poll a cada ~1,5 s, batendo com `POLL_MS = 1500` em `backend/web/app.js`), `/api/config` só na carga; DOM renderizado com dados vivos (stats `0 / 1 / 968 KB`, pill "● Servidor ativo", linhas do histórico com os títulos dos downloads); stderr sem erros de JS (0 ocorrências de Uncaught/TypeError/ReferenceError/SyntaxError) |
| 6 | Persistência da config | OK | `POST /api/config {default_quality:"720p"}` → `GET /api/config` reflete 720p; `backend/data/config.json` criado. Restaurado para `1080p` após o teste (estado original preservado) |

## Bug encontrado e corrigido (com teste de reprodução)

**Sintoma (reproduzido em campo):** download direto de MP4 com `filename` do usuário — o histórico registrava `matriz-teste.mp4`, mas o arquivo no disco ficava **sem extensão** (`matriz-teste`, 991.017 bytes) e o campo `size` nunca era gravado na task.

**Causa:** o `outtmpl` para filename do usuário não tem `%(ext)s` (de propósito, para merge/áudio pós-processados decidirem a extensão). Para download de arquivo único, o yt-dlp grava o nome sem extensão e nada o renomeia; `_record_final_size` procurava `matriz-teste.mp4` (inexistente) e não gravava o tamanho.

**Teste de reprodução (red primeiro):**
- `backend/tests/test_api.py::test_finalize_file_renomeia_direto_sem_extensao` — cria arquivo `matriz-teste` no `download_dir` (como o yt-dlp deixa) e exige que, após o pós-processamento, exista `matriz-teste.mp4` com o conteúdo preservado e `size == 100` na task.
- `backend/tests/test_api.py::test_finalize_file_nao_renomeia_quando_nome_ja_correto` — caso sem rename necessário (merge/áudio), `size` gravado sem tocar no arquivo.

Ambos falharam com `AttributeError: no attribute '_finalize_file'` antes da correção.

**Correção:** `backend/server.py` — novo helper `_finalize_file(queue, task_id, prepared, final_name)`: se o arquivo com o nome final não existe mas o arquivo real (basename do `prepared`) existe, renomeia via `os.replace`; depois grava o size com `_record_final_size`. Chamado no `download_task` no lugar da gravação direta.

**Commit:** `c5321b8` — `fix: renameia arquivo direto para o nome final com extensao (size no historico)`

**Verificação pós-fix (execução real):** `matriz-teste.mp4` no disco (991.017 B, sem cópia sem extensão) e `size: 991017` no histórico.

## Matriz da spec §9 — 8 cenários

Legenda: **✓** executado · **✓\*** parcial (parte automatizável executada; parte interativa pendente) · **pendente — checklist do usuário** (exige navegador/extensão/bandeja do usuário)

| # | Cenário (texto da spec §9) | Status | Evidência | O que o usuário deve conferir (checklist) |
|---|---|---|---|---|
| 1 | **YouTube** — "Ver resoluções" lista formatos; baixar 1080p e MP3; conferir nome real e tamanho na pasta | pendente — checklist do usuário (parte de API executada) | `POST /api/analyze` → 200: título real, formats `h1080`/`h720`/`mp3`, `best_id: h1080` | Com a extensão carregada e o motor rodando, abrir um vídeo do YouTube no Edge: clicar em "Ver resoluções" e conferir que lista os formatos com o título real do vídeo; baixar 1080p e MP3 pelo popup; conferir na pasta de downloads o nome real e o tamanho de cada arquivo. |
| 2 | **Hotmart** — dar play → m3u8 aparece → lista de variantes → download via ffmpeg | pendente — checklist do usuário | — | Em uma aula da Hotmart (produto com acesso do usuário), dar play no vídeo, conferir que o `.m3u8` aparece na lista, que as variantes de resolução são listadas e que o download via ffmpeg conclui com arquivo `.mp4` na pasta. |
| 3 | **Arquivo direto MP4** — tamanho exato; com motor offline, fallback nativo funciona | ✓\* | Parte de backend executada (ver item 3 acima): `matriz-teste.mp4` com 991.017 bytes = `Content-Length` exato da fonte (`https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4`) | Parte interativa pendente: abrir uma página com MP4 direto e conferir o tamanho exato no card do popup; com o Motor Local desligado, clicar em "Baixar melhor" e conferir que o navegador faz o fallback nativo (download direto pelo Edge). |
| 4 | **Instagram** — download único via yt-dlp com cookies | pendente — checklist do usuário | — | Com o usuário logado (cookies), abrir um Reel/Story no Instagram, clicar para baixar e conferir download único concluído via yt-dlp. |
| 5 | **Vimeo** — lista e download | pendente — checklist do usuário | — | Abrir um vídeo do Vimeo, conferir a lista de formatos no popup e executar um download completo. |
| 6 | **Página sem mídia** — estado vazio | pendente — checklist do usuário | — | Abrir no Edge uma página sem nenhuma mídia (ex.: uma página de texto) e conferir que o popup mostra o estado vazio com a dica. |
| 7 | **Motor Local offline** — pill vermelha, avisos e fallback | pendente — checklist do usuário | — | Com o Motor Local desligado, abrir o popup e conferir a pill vermelha, os avisos e o fallback correto (diretos → fallback nativo; streams/YouTube → dica para iniciar o motor). |
| 8 | **Dashboard** — download de teste → progresso ao vivo → histórico persistido após reiniciar o servidor | ✓\* | Parte de backend/headless executada: download de teste via API com progresso 0%→100% no `/api/status`; polling `/api/tasks`+`/api/history` a cada ~1,5 s comprovado em Edge headless com dados vivos renderizados; após restart do servidor o histórico permaneceu em `backend/data/history.json` (2 tasks: completed e cancelled) | Conferência visual pendente: no navegador do usuário, abrir o dashboard (`/`), disparar um download e ver o progresso ao vivo na aba de fila; após reiniciar o Motor Local, conferir a aba "Concluídos" com o item persistido; conferir a bandeja (menu do ícone) abrindo o dashboard e a pasta de downloads. |

## Observações e ressalvas

- **Cancel deixou arquivo no disco:** ao cancelar o download de 10 MB (item 3b), a task ficou `cancelled` (guarda do T3 OK), mas a thread do yt-dlp não é morta (não há pid de subprocesso para download via yt-dlp), então o arquivo terminou de baixar e ficou no disco; o histórico mostra a task como cancelled. Isso não viola a spec §7 (o "mata filhos" refere-se ao encerramento do motor; o cancel promete apenas "taskkill no pid se houver") e não foi corrigido por falta de teste-falha/escopo — registrado aqui para o controller decidir. O arquivo `matriz-cancel.mp4` (10 MB) foi removido da pasta de downloads; `matriz-teste.mp4` (991 KB) foi mantido como evidência.
- **Net log headless:** em Edge headless a aba fica em segundo plano e os timers são comprimidos em tempo virtual (artefato do ambiente, não do app). A cadência de ~1,5 s foi comprovada pela contagem de polls sobre o orçamento virtual de 12 s (9 polls/carga = 1 inicial + 8 × 1,5 s) e pela constante `POLL_MS = 1500` em `backend/web/app.js`.
- **Arquivos de teste do histórico:** `backend/data/history.json` ficou com as 2 tasks da matriz (completed + cancelled), servindo como evidência persistida do teste.
- **Suites finais:** 36/36 pytest e 10/10 node após o fix (sem regressões).
- A spec `docs/superpowers/specs/2026-08-26-videodownloader-ui-modernizacao-design.md` tem uma alteração de espaçamento pré-existente não relacionada (não cometida nesta task).
