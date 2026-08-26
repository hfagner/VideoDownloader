# Edge Video Downloader — Instalação no Windows

Material de *deploy* para **Windows (Edge + Google Chrome)**. Instala:

1. A **extensão MV3** (`manifest.json`, `background.js`, `libs`, `popup`, `options`, `icons`).
2. O **backend "Motor Local"** (servidor WSGI de produção **waitress**) em `http://127.0.0.1:5000`, empacotado como **EXE autônomo** — o usuário final **não precisa instalar Python**: ao abrir, o app sobe o servidor, abre o **dashboard web** no navegador e fica como **ícone na bandeja** (fechar a aba não interrompe downloads).
3. **Dependências verificadas/instaladas automaticamente**: **FFmpeg** (streams HLS/Hotmart) e **Deno** (robustez do YouTube, em `%USERPROFILE%\.deno\bin` — local que o backend já procura). A tela final do Setup mostra o **relatório de dependências** (✔/⚠) gerado em `tools\deps-report.json`.
4. **Atalhos** no Desktop e Menu Iniciar: **Motor Local** (abre o app), **Dashboard** (abre o painel web) e navegadores com a extensão via `--load-extension`.
5. **Tela final do Setup com instruções** passo a passo para ativar a extensão no Edge (`edge://extensions` → Modo de desenvolvedor → Carregar descompactada), com botão que abre a página direto.
6. **Auto-início** do backend no login (sobe discretamente na bandeja).
7. **Desinstalador** registrado no Windows (`Adicionar/Remover programas`). O Deno instalado é preservado (ferramenta de usuário compartilhada).

---

## Opção A — Instalador sem compilar (PowerShell + .cmd)

Não exige nada além de Windows. O instalador usa o **EXE autônomo do backend** (`EdgeVideoDownloaderBackend.exe`) se ele já tiver sido compilado em `deploy\dist\backend\`; caso contrário, cai em um **venv Python** (tenta instalar o Python via `winget` se precisar).

```
deploy\Setup-EdgeVideoDownloader.cmd
```

Ou, direto no PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\Setup-EdgeVideoDownloader.ps1
```

Parâmetros opcionais:

| Parâmetro | Efeito |
|---|---|
| `-InstallDir <pasta>` | Diretório de instalação (padrão `%LOCALAPPDATA%\EdgeVideoDownloader`) |
| `-SourceRoot <pasta>` | Pasta com a extensão e `backend\` (padrão: raiz do projeto) |
| `-NoBackend` | Não configura o backend nem cria venv |
| `-NoFfmpeg` | Não baixa o FFmpeg |
| `-NoDeno` | Não baixa o Deno |
| `-NoShortcuts` | Não cria atalhos |
| `-NoAutostart` | Não registra auto-início |
| `-NoLaunch` | Não abre o navegador ao final |
| `-SkipUninstaller` | Não registra o desinstalador (usado pelo Inno Setup) |
| `-Quiet` | Sem perguntas/pausas |

---

## Opção B — Instalador profissional (Inno Setup → `Setup.exe`)

Baixe/instale o [Inno Setup](https://jrsoftware.org/isdl.php) e rode:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\build-setup-exe.ps1
```

Gera `dist\EdgeVideoDownloaderSetup.exe` (instalador + desinstalador nativos, telas em PT-BR/EN) **já com o backend EXE embutido**. O próprio `build-setup-exe.ps1` compila o EXE do backend antes do Inno (use `-SkipBackend` para reutilizar o já gerado).

O Setup é **de um clique**: verifica e instala FFmpeg + Deno, cria os atalhos (Motor Local, Dashboard, navegadores) e, na **tela final**, mostra o relatório de dependências e o passo a passo para ativar a extensão no Edge (com botão "Abrir edge://extensions").

### Compilar apenas o EXE do backend

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\build-backend-exe.ps1
```

- Resultado: `deploy\dist\backend\EdgeVideoDownloaderBackend.exe`.
- Em redes com proxy/antivírus que usam certificado self-signed (erro `certificate verify failed` no pip), rode com `-TrustedHost`:
  `powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\build-backend-exe.ps1 -TrustedHost`
- Se o `py -3.11` não existir, use `-Python <caminho>` ou ajuste `-PythonVersion` (PyInstaller costuma atrasar o suporte a versões muito novas do Python; 3.14 pode falhar).

---

## Desinstalação

- Pelo Painel do Windows: **Adicionar/Remover programas → Edge Video Downloader → Desinstalar**, ou
- `deploy\Uninstall-EdgeVideoDownloader.cmd`

O desinstalador para o backend, remove atalhos, o auto-início, o registro e a pasta de instalação.

---

## Como funciona (limitações honestas)

> **Importante:** os navegadores Chromium **não** permitem instalação silenciosa e permanente de extensões *unpacked* via registro/chave de política. O método real é um **atalho** que abre o navegador com `--load-extension`. Por isso:

1. **Use os atalhos criados** ("Edge Video Downloader" / "Chrome Video Downloader", no Desktop e no Start Menu).
   Auto-iniciar o navegador pelo ícone comum *não* carregará a extensão.
2. **Feche o navegador antes** de reabrir pelo atalho. O Edge/Chrome reaproveita o processo já aberto e pode **ignorar** a extensão se houver uma janela existente.
3. **`--load-extension` foi removido no Chrome 137+**. O instalador injeta `--disable-features=DisableLoadExtensionCommandLineSwitch` como contorno. Isso pode deixar de funcionar em versões futuras do navegador.
4. A extensão depende do **backend rodando** (`http://127.0.0.1:5000`). Com a opção padrão, ele sobe automaticamente no login mostrando uma **janelinha de status**; é possível **parar** o Motor Local pelo botão da janela ou pelo atalho "Motor Local". Fechar a janela também encerra o serviço.
5. O **FFmpeg** pode falhar o download se a rede/GFW bloquear o GitHub. Nesse caso, baixe manualmente em <https://www.gyan.dev/ffmpeg/builds/> e adicione `bin` ao `PATH`, ou rode com `-NoFfmpeg`.

### Fallback manual (sempre funciona)

Se os atalhos/`--load-extension` falharem na sua versão do navegador:

1. Abra `edge://extensions` ou `chrome://extensions`.
2. Ative **Modo de desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação / Load unpacked**.
4. Selecione `%LOCALAPPDATA%\EdgeVideoDownloader\extension`.
5. Inicie o backend manualmente: `%LOCALAPPDATA%\EdgeVideoDownloader\launchers\start_backend.cmd`.

---

## Estrutura de instalação gerada

```
%LOCALAPPDATA%\EdgeVideoDownloader\
├── extension\          # arquivos da extensão MV3 (usada via Load unpacked / atalho)
├── backend\            # EdgeVideoDownloaderBackend.exe (Motor Local; + server.py/req se fallback venv)
├── venv\               # ambiente virtual Python (somente no fallback do venv)
├── ffmpeg\             # binários FFmpeg
├── launchers\          # start_backend.cmd / launch_edge.cmd / launch_chrome.cmd
├── tools\              # desinstalador (cópia) + deps-report.json/.txt (relatório da tela final)
└── logs\               # logs do pip
```

> O Deno (quando baixado pelo instalador) fica em `%USERPROFILE%\.deno\bin\deno.exe`.

> O backend salva os downloads em `%USERPROFILE%\Downloads\EdgeVideoDownloader`.
