; -----------------------------------------------------------------------------
; Edge Video Downloader - Inno Setup script
; Gera um Setup.exe profissional (instalador/desinstalador do Windows).
; Compile com:  ISCC.exe VideoDownloaderSetup.iss  (ou use build-setup-exe.ps1)
; -----------------------------------------------------------------------------
#define MyAppName "Edge Video Downloader"
#define MyAppVersion "1.1.0"
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
UninstallDisplayIcon={app}\icons\icon.ico
DisableProgramGroupPage=yes
UsePreviousAppDir=yes
ShowLanguageDialog=auto

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
brazilianportuguese.FinishedHeading=Instalação concluída!
brazilianportuguese.EdgeSteps=Para ativar a extensão no Edge:%n1. Clique em "Abrir edge://extensions" abaixo%n2. Ative o "Modo de desenvolvedor" (canto superior direito)%n3. Clique em "Carregar descompactada"%n4. Selecione a pasta:%n   {app}\extension%n%nOs atalhos "Edge Video Downloader" do Menu Iniciar e Desktop continuam disponíveis como alternativa.
brazilianportuguese.OpenEdgeBtn=Abrir edge://extensions
brazilianportuguese.EdgeNotFound=Não foi possível localizar o Microsoft Edge. Abra manualmente edge://extensions no navegador.
english.FinishedHeading=Installation complete!
english.EdgeSteps=To enable the extension in Edge:%n1. Click "Open edge://extensions" below%n2. Enable "Developer mode" (top-right corner)%n3. Click "Load unpacked"%n4. Select the folder:%n   {app}\extension%n%nThe "Edge Video Downloader" shortcuts in the Start Menu and Desktop remain available as an alternative.
english.OpenEdgeBtn=Open edge://extensions
english.EdgeNotFound=Could not locate Microsoft Edge. Open edge://extensions manually in your browser.

[Files]
; --- Extensao MV3 ---
Source: "..\manifest.json"; DestDir: "{app}\extension"; Flags: ignoreversion
Source: "..\background.js"; DestDir: "{app}\extension"; Flags: ignoreversion
Source: "..\content.js"; DestDir: "{app}\extension"; Flags: ignoreversion
Source: "..\libs\*"; DestDir: "{app}\extension\libs"; Flags: ignoreversion recursesubdirs
Source: "..\popup\*"; DestDir: "{app}\extension\popup"; Flags: ignoreversion recursesubdirs
Source: "..\options\*"; DestDir: "{app}\extension\options"; Flags: ignoreversion recursesubdirs
Source: "..\icons\*"; DestDir: "{app}\extension\icons"; Flags: ignoreversion recursesubdirs
; Icone .ico para atalhos do Windows (shortcuts nao suportam PNG)
Source: "..\icons\icon.ico"; DestDir: "{app}\icons"; Flags: ignoreversion

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

[Icons]
; Atalho do backend (Motor Local) na Area de Trabalho
Name: "{userdesktop}\Motor Local - Edge Video Downloader"; Filename: "{app}\backend\EdgeVideoDownloaderBackend.exe"; \
  WorkingDir: "{app}\backend"; IconFilename: "{app}\icons\icon.ico"; \
  Comment: "Motor Local - Edge Video Downloader"

[Run]
; Configura backend (EXE autonomo), FFmpeg, Deno — SEM atalhos (criados pela secao [Icons] acima).
; AGUARDA o fim para que o relatorio de dependencias exista antes da tela final.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\Setup-EdgeVideoDownloader.ps1"" -SourceRoot ""{app}"" -InstallDir ""{app}"" -NoLaunch -SkipUninstaller -NoShortcuts -Quiet"; \
  StatusMsg: "Configurando backend e dependencias (FFmpeg/Deno)..." ; Flags: runhidden

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\Uninstall-EdgeVideoDownloader.ps1"" -Q -InstallDir ""{app}"""; \
  Flags: runhidden; RunOnceId: "EVDUninstall"

; -----------------------------------------------------------------------------
; Pagina final personalizada: relatorio de dependencias + instrucoes da extensao
; -----------------------------------------------------------------------------
[Code]
var
  OpenEdgeBtn: TNewButton;
  CopyPathBtn: TNewButton;

(* Texto de instrucoes para a tela final do instalador.
   Construido com #13#10 reais porque %n do CustomMessage
   nao e convertido em newline dentro de [Code]. *)
function GetEdgeStepsText: string;
begin
  Result :=
    'Para ativar a extensao no Edge:' + #13#10 + #13#10 +
    '1. Abra edge://extensions no Microsoft Edge' + #13#10 +
    '2. Ative o "Modo de desenvolvedor" (canto superior direito)' + #13#10 +
    '3. Clique em "Carregar sem compactacao / Load unpacked"' + #13#10 +
    '4. Selecione a pasta (use o botao Copiar abaixo):' + #13#10 +
    '   ' + ExpandConstant('{app}\extension');
end;

procedure CopyExtensionPath;
var
  Res: Integer;
  ExtPath: string;
begin
  ExtPath := ExpandConstant('{app}\extension');
  { Copia o caminho para a area de transferencia via cmd + clip }
  Exec('cmd.exe', '/c echo ' + ExtPath + '| clip', '', SW_HIDE, ewWaitUntilTerminated, Res);
end;

procedure CopyPathBtnClick(Sender: TObject);
begin
  CopyExtensionPath;
  CopyPathBtn.Caption := 'Copiado!';
end;

procedure OpenEdgeExtensions;
var
  EdgePath: string;
  Res: Integer;
begin
  EdgePath := '';
  if RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe', '', EdgePath) then
    if not FileExists(EdgePath) then EdgePath := '';
  if EdgePath = '' then
  begin
    EdgePath := ExpandConstant('{localappdata}\Microsoft\Edge\Application\msedge.exe');
    if not FileExists(EdgePath) then EdgePath := '';
  end;
  if EdgePath = '' then
  begin
    EdgePath := ExpandConstant('{pf}\Microsoft\Edge\Application\msedge.exe');
    if not FileExists(EdgePath) then EdgePath := '';
  end;
  if EdgePath <> '' then
    { ShellExec suporta URLs de protocolo (edge://) via ShellExecuteEx }
    ShellExec('open', EdgePath, 'edge://extensions', '', SW_SHOWNORMAL, ewNoWait, Res)
  else
    MsgBox(CustomMessage('EdgeNotFound'), mbInformation, MB_OK);
end;

procedure OpenEdgeBtnClick(Sender: TObject);
begin
  OpenEdgeExtensions;
end;

procedure InitializeWizard;
begin
  { Botao "Abrir edge://extensions" }
  OpenEdgeBtn := TNewButton.Create(WizardForm);
  OpenEdgeBtn.Parent := WizardForm.FinishedPage;
  OpenEdgeBtn.Width := ScaleX(200);
  OpenEdgeBtn.Height := ScaleY(30);
  OpenEdgeBtn.Caption := CustomMessage('OpenEdgeBtn');
  OpenEdgeBtn.OnClick := @OpenEdgeBtnClick;
  OpenEdgeBtn.Visible := False;

  { Botao "Copiar caminho" }
  CopyPathBtn := TNewButton.Create(WizardForm);
  CopyPathBtn.Parent := WizardForm.FinishedPage;
  CopyPathBtn.Width := ScaleX(160);
  CopyPathBtn.Height := ScaleY(30);
  CopyPathBtn.Caption := 'Copiar caminho';
  CopyPathBtn.OnClick := @CopyPathBtnClick;
  CopyPathBtn.Visible := False;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  ReportTxt: AnsiString;
  FinalText: string;
begin
  if CurPageID = wpFinished then
  begin
    ReportTxt := '';
    if LoadStringFromFile(ExpandConstant('{app}\tools\deps-report.txt'), ReportTxt) then
      FinalText := 'Dependencias:' + #13#10 + String(ReportTxt)
    else
      FinalText := 'Consulte ' + ExpandConstant('{app}\tools\deps-report.txt');

    FinalText := FinalText + #13#10 + #13#10 + GetEdgeStepsText;

    WizardForm.FinishedHeadingLabel.Caption := CustomMessage('FinishedHeading');

    { Expande a altura do label para caber todo o texto sem truncar }
    WizardForm.FinishedLabel.AutoSize := True;
    WizardForm.FinishedLabel.WordWrap := True;
    WizardForm.FinishedLabel.Caption := FinalText;

    { Posiciona os botoes lado a lado abaixo do texto }
    OpenEdgeBtn.Left := WizardForm.FinishedLabel.Left;
    OpenEdgeBtn.Top := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(12);
    OpenEdgeBtn.Visible := True;

    CopyPathBtn.Left := OpenEdgeBtn.Left + OpenEdgeBtn.Width + ScaleX(10);
    CopyPathBtn.Top := OpenEdgeBtn.Top;
    CopyPathBtn.Caption := 'Copiar caminho';
    CopyPathBtn.Visible := True;
  end
  else
  begin
    OpenEdgeBtn.Visible := False;
    CopyPathBtn.Visible := False;
  end;
end;

