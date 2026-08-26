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
UninstallDisplayIcon={app}\extension\icons\icon-128.png
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
; Configura backend (EXE autonomo), FFmpeg, Deno e atalhos — AGUARDA o fim
; para que o relatorio de dependencias exista antes da tela final.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\Setup-EdgeVideoDownloader.ps1"" -SourceRoot ""{app}"" -InstallDir ""{app}"" -NoLaunch -SkipUninstaller -Quiet"; \
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
    Exec(EdgePath, 'edge://extensions', '', SW_SHOWNORMAL, ewNoWait, Res)
  else
    MsgBox(CustomMessage('EdgeNotFound'), mbInformation, MB_OK);
end;

procedure OpenEdgeBtnClick(Sender: TObject);
begin
  OpenEdgeExtensions;
end;

procedure InitializeWizard;
begin
  OpenEdgeBtn := TNewButton.Create(WizardForm);
  OpenEdgeBtn.Parent := WizardForm;
  OpenEdgeBtn.Width := ScaleX(220);
  OpenEdgeBtn.Height := WizardForm.CancelButton.Height;
  OpenEdgeBtn.Caption := CustomMessage('OpenEdgeBtn');
  OpenEdgeBtn.OnClick := @OpenEdgeBtnClick;
  OpenEdgeBtn.Visible := False;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  ReportTxt: AnsiString;
  Lines: TStringList;
begin
  if CurPageID = wpFinished then
  begin
    Lines := TStringList.Create;
    try
      ReportTxt := '';
      if LoadStringFromFile(ExpandConstant('{app}\tools\deps-report.txt'), ReportTxt) then
        Lines.Add(ReportTxt)
      else
        Lines.Add('Consulte {app}\tools\deps-report.txt');
      Lines.Add('');
      Lines.Add(ExpandConstant(CustomMessage('EdgeSteps')));
      WizardForm.FinishedHeadingLabel.Caption := CustomMessage('FinishedHeading');
      WizardForm.FinishedLabel.Caption := 'Dependencias:' + #13#10 + Lines.Text;
      OpenEdgeBtn.Visible := True;
      OpenEdgeBtn.Top := WizardForm.CancelButton.Top;
      OpenEdgeBtn.Left := WizardForm.CancelButton.Left - OpenEdgeBtn.Width - ScaleX(10);
    finally
      Lines.Free;
    end;
  end
  else
    OpenEdgeBtn.Visible := False;
end;
