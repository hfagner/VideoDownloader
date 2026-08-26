; -----------------------------------------------------------------------------
; Edge Video Downloader - Inno Setup script
; Gera um Setup.exe profissional (instalador/desinstalador do Windows).
; Compile com:  ISCC.exe VideoDownloaderSetup.iss  (ou use build-setup-exe.ps1)
; -----------------------------------------------------------------------------
#define MyAppName "Edge Video Downloader"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Edge Video Downloader Project"

[Setup]
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppId={{B7E2E6D1-8C42-4F9A-9C21-D3C2E0A9B4E1}
DefaultDirName={localappdata}\EdgeVideoDownloader
DefaultGroupName={#MyAppName}
; Instalacao por usuario, sem elevacao (UAC)
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=EdgeVideoDownloaderSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\extension\icons\icon-128.png
DisableProgramGroupPage=yes
UsePreviousAppDir=yes
ShowLanguageDialog=auto

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; --- Extensao MV3 ---
Source: "..\manifest.json"; DestDir: "{app}\extension"; Flags: ignoreversion
Source: "..\background.js"; DestDir: "{app}\extension"; Flags: ignoreversion
Source: "..\content.js"; DestDir: "{app}\extension"; Flags: ignoreversion
Source: "..\libs\*"; DestDir: "{app}\extension\libs"; Flags: ignoreversion recursesubdirs
Source: "..\popup\*"; DestDir: "{app}\extension\popup"; Flags: ignoreversion recursesubdirs
Source: "..\options\*"; DestDir: "{app}\extension\options"; Flags: ignoreversion recursesubdirs
Source: "..\icons\*"; DestDir: "{app}\extension\icons"; Flags: ignoreversion recursesubdirs

; --- Backend (Motor Local) ---
; server.py/requirements sao usados apenas no fallback via venv
Source: "..\backend\server.py"; DestDir: "{app}\backend"; Flags: ignoreversion
Source: "..\backend\requirements.txt"; DestDir: "{app}\backend"; Flags: ignoreversion
; EXE autonomo do backend (recomendado): dispensa Python no usuario final.
; So e incluido se ja foi compilado por build-backend-exe.ps1.
#if FileExists(AddBackslash(SourcePath) + "dist\backend\EdgeVideoDownloaderBackend.exe")
Source: "dist\backend\EdgeVideoDownloaderBackend.exe"; DestDir: "{app}\backend"; Flags: ignoreversion
#endif

; --- Ferramentas / instalador dinamico ---
Source: "Setup-EdgeVideoDownloader.ps1"; DestDir: "{app}\tools"; Flags: ignoreversion
Source: "Uninstall-EdgeVideoDownloader.ps1"; DestDir: "{app}\tools"; Flags: ignoreversion
Source: "Uninstall-EdgeVideoDownloader.cmd"; DestDir: "{app}\tools"; Flags: ignoreversion
Source: "requirements.txt"; DestDir: "{app}\tools"; Flags: ignoreversion

[Run]
; Configura backend (EXE autonomo ou venv), FFmpeg e atalhos do Edge/Chrome
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\Setup-EdgeVideoDownloader.ps1"" -SourceRoot ""{app}"" -InstallDir ""{app}"" -NoLaunch -SkipUninstaller"; \
  StatusMsg: "Configurando backend e extensao..." ; Flags: runhidden nowait

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\Uninstall-EdgeVideoDownloader.ps1"" -Q"; \
  Flags: runhidden; RunOnceId: "EVDUninstall"
