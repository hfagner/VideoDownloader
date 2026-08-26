<#
.SYNOPSIS
  Instalador do Edge Video Downloader (extensao + Motor Local) no Windows.

.DESCRIPTION
  - Instala a extensao MV3 em %LOCALAPPDATA%\EdgeVideoDownloader\extension
  - Configura o backend Python (venv + dependencias) servindo em http://127.0.0.1:5000
  - Configura o FFmpeg (necessario para streams HLS / Hotmart)
  - Adiciona/carrega a extensao no Edge e no Google Chrome por atalhos com --load-extension
  - Cria atalhos, registra auto-inicio do backend e o desinstalador

.PARAMETER SourceRoot
  Pasta raiz com 'manifest.json', 'background.js', 'libs', 'popup', 'options', 'icons' e
  a pasta 'backend'. Por padrao, a pasta pai deste script.

.PARAMETER InstallDir
  Diretorio de instalacao. Padrao: %LOCALAPPDATA%\EdgeVideoDownloader

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Setup-EdgeVideoDownloader.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Setup-EdgeVideoDownloader.ps1 -InstallDir "D:\EVD" -NoFfmpeg
#>
[CmdletBinding()]
param(
  [string]$SourceRoot,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'EdgeVideoDownloader'),
  [switch]$NoBackend,
  [switch]$NoFfmpeg,
  [switch]$NoShortcuts,
  [switch]$NoAutostart,
  [switch]$NoLaunch,
  [switch]$SkipUninstaller,
  [switch]$NoPause,
  [switch]$Quiet
)

# ---------------------------------------------------------------------------
# Config/estado globais
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$script:ExtensionDir  = Join-Path $InstallDir 'extension'
$script:BackendDir    = Join-Path $InstallDir 'backend'
$script:VenvDir       = Join-Path $InstallDir 'venv'
$script:LauncherDir   = Join-Path $InstallDir 'launchers'
$script:ToolsDir      = Join-Path $InstallDir 'tools'
$script:LogDir        = Join-Path $InstallDir 'logs'
$script:FFmpegBin     = $null
$script:EdgeExe       = $null
$script:ChromeExe     = $null
$script:BackendUrl    = 'http://127.0.0.1:5000'
$script:BackendExe    = $null
$script:PinnedVersion = '1.0.0'

if (-not $SourceRoot) {
  $SourceRoot = Split-Path -Parent $PSScriptRoot
}
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$script:SourceRoot = $SourceRoot

# ---------------------------------------------------------------------------
# Helpers de saida
# ---------------------------------------------------------------------------
function Write-Step  { param([string]$m) if (-not $Quiet) { Write-Host "`n==> $m" -ForegroundColor Cyan } }
function Write-Ok    { param([string]$m) if (-not $Quiet) { Write-Host "    [OK] $m" -ForegroundColor Green } }
function Write-Warn  { param([string]$m) Write-Warning $m }
function Write-Err   { param([string]$m) Write-Host "    [ERRO] $m" -ForegroundColor Red }

function New-EmptyDir([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}

# ---------------------------------------------------------------------------
# Executa um processo e retorna o codigo de saida
# ---------------------------------------------------------------------------
function Invoke-Process {
  param([string]$Exe, [string[]]$Args, [string]$WorkingDir, [string]$LogFile)
  New-EmptyDir (Split-Path -Parent $LogFile)
  $p = Start-Process -FilePath $Exe -ArgumentList $Args -WorkingDirectory $WorkingDir `
       -NoNewWindow -Wait -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err"
  return $p.ExitCode
}

# ---------------------------------------------------------------------------
# Deteccao de navegadores (Edge / Chrome)
# ---------------------------------------------------------------------------
function Resolve-BrowserPath {
  param([Parameter(Mandatory=$true)][string]$AppPathKey, [string[]]$CommonPaths)
  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths'
  )
  foreach ($r in $roots) {
    $key = Join-Path $r $AppPathKey
    if (Test-Path -LiteralPath $key) {
      $v = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).'(default)'
      if ($v -and (Test-Path -LiteralPath $v)) { return $v }
    }
  }
  foreach ($c in $CommonPaths) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

function Resolve-EdgeExe {
  return Resolve-BrowserPath -AppPathKey 'msedge.exe' -CommonPaths @(
    (Join-Path $env:ProgramFiles  'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LocalAppData 'Microsoft\Edge\Application\msedge.exe')
  )
}

function Resolve-ChromeExe {
  return Resolve-BrowserPath -AppPathKey 'chrome.exe' -CommonPaths @(
    (Join-Path $env:ProgramFiles  'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LocalAppData 'Google\Chrome\Application\chrome.exe')
  )
}

# ---------------------------------------------------------------------------
# Python
# ---------------------------------------------------------------------------
function Get-PythonInfo {
  foreach ($c in @('python3','python','py')) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) {
      if ($cmd.CommandType -eq 'Application' -and $cmd.Source -match '\\WindowsApps\\') { continue }
      if ($c -eq 'py') { return @{ Exe=$c; Prefix=@('-3') } }
      return @{ Exe=$c; Prefix=@() }
    }
  }
  return $null
}

function Ensure-Python {
  $pi = Get-PythonInfo
  if ($pi) { return $pi }
  Write-Warn "Python 3 nao encontrado. Tentando instalar via winget..."
  try {
    $w = Get-Command winget -ErrorAction SilentlyContinue
    if ($w) {
      & winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Null
      Start-Sleep -Seconds 3
      $pi = Get-PythonInfo
      if ($pi) { return $pi }
    }
  } catch { }
  throw "Nao foi possivel localizar/instalar o Python 3. Instale-o em https://www.python.org/downloads/ e rode o instalador novamente."
}

function Setup-Backend {
  if ($NoBackend) { Write-Warn "Backend ignorado (-NoBackend)."; return }
  Write-Step "Configurando backend (Motor Local) na porta 5000"
  New-EmptyDir $script:BackendDir
  $backendSrc = Join-Path $script:SourceRoot 'backend'

  # Copia server.py / requirements apenas se vierem de outro lugar (nao auto-copiar)
  foreach ($f in @('server.py','requirements.txt')) {
    $src = Join-Path $backendSrc $f
    if ($f -eq 'requirements.txt' -and -not (Test-Path -LiteralPath $src)) { $src = Join-Path $PSScriptRoot 'requirements.txt' }
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $dst = Join-Path $script:BackendDir $f
    if (-not $src.Equals($dst, [System.StringComparison]::OrdinalIgnoreCase)) {
      Copy-Item -LiteralPath $src -Destination $dst -Force
    }
  }

  # --- 1) Backend como EXE autonomo (recomendado): nao exige Python no usuario final
  $destExe = Join-Path $script:BackendDir 'EdgeVideoDownloaderBackend.exe'
  foreach ($cand in @(
      (Join-Path $backendSrc 'EdgeVideoDownloaderBackend.exe'),
      (Join-Path $PSScriptRoot 'dist\backend\EdgeVideoDownloaderBackend.exe')
  )) {
    if (Test-Path -LiteralPath $cand) {
      $srcFull = [System.IO.Path]::GetFullPath($cand)
      $dstFull = [System.IO.Path]::GetFullPath($destExe)
      if (-not $srcFull.Equals($dstFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        Copy-Item -LiteralPath $cand -Destination $destExe -Force
      }
      $script:BackendExe = $destExe
      Write-Ok "Backend instalado como EXE autonomo (sem exigir Python no usuario)."
      return
    }
  }

  # --- 2) Fallback: via virtualenv (exige Python no usuario final) ----------
  Write-Warn "EXE do backend nao encontrado; usando ambiente Python (venv)."
  $pi = Ensure-Python
  $venvPy = Join-Path $script:VenvDir 'Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $venvPy)) {
    Write-Ok "Criando ambiente virtual em $($script:VenvDir)"
    New-EmptyDir $script:VenvDir
    & $pi.Exe @($pi.Prefix + @('-m','venv', $script:VenvDir)) | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o ambiente virtual (venv).' }
  } else {
    Write-Ok "Ambiente virtual ja existe."
  }
  Write-Ok "Instalando dependencias (flask, flask-cors, yt-dlp, requests)..."
  $log = Join-Path $script:LogDir 'pip.log'
  $c1 = Invoke-Process -Exe $venvPy -Args @('-m','pip','install','--upgrade','pip') -WorkingDir $script:BackendDir -LogFile $log
  $c2 = Invoke-Process -Exe $venvPy -Args @('-m','pip','install','-r',(Join-Path $script:BackendDir 'requirements.txt')) -WorkingDir $script:BackendDir -LogFile $log
  if ($c1 -ne 0 -or $c2 -ne 0) { throw "Falha ao instalar dependencias do backend. Veja $log" }
}

# ---------------------------------------------------------------------------
# FFmpeg (opcional, para streams HLS)
# ---------------------------------------------------------------------------
function Get-OrInstall-Ffmpeg {
  if ($NoFfmpeg) { Write-Warn "FFmpeg ignorado (-NoFfmpeg)."; return }
  $ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($ff) {
    $script:FFmpegBin = Split-Path -Parent $ff.Source
    Write-Ok "FFmpeg encontrado no PATH: $($script:FFmpegBin)"
    return
  }
  Write-Step "Baixando FFmpeg (necessario para streams HLS / Hotmart)"
  $zipDir = Join-Path $InstallDir 'tmp'
  New-EmptyDir $zipDir
  $zip = Join-Path $zipDir 'ffmpeg.zip'
  $url = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip'
  try {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    $extract = Join-Path $InstallDir 'ffmpeg'
    if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
    $exe = Get-ChildItem -LiteralPath $extract -Recurse -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($exe) {
      $script:FFmpegBin = $exe.DirectoryName
      Write-Ok "FFmpeg instalado em $($script:FFmpegBin)"
    } else {
      Write-Warn 'FFmpeg extraido mas binario nao localizado.'
    }
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  } catch {
    Write-Warn "Nao foi possivel baixar o FFmpeg automaticamente. Baixe em https://www.gyan.dev/ffmpeg/builds/ e adicione o bin ao PATH, ou rode com -NoFfmpeg."
  }
}

# ---------------------------------------------------------------------------
# Copia dos arquivos da extensao
# ---------------------------------------------------------------------------
function Install-ExtensionFiles {
  Write-Step "Instalando os arquivos da extensao em $($script:ExtensionDir)"
  New-EmptyDir $script:ExtensionDir
  # A extensao pode estar na raiz do SourceRoot (projeto) ou em SourceRoot\extension
  $extRoot = Join-Path $script:SourceRoot 'extension'
  if (-not (Test-Path -LiteralPath $extRoot)) { $extRoot = $script:SourceRoot }
  foreach ($f in @('manifest.json','background.js','content.js')) {
    $srcFile = Join-Path $extRoot $f
    if (Test-Path -LiteralPath $srcFile) { Copy-Item -LiteralPath $srcFile -Destination $script:ExtensionDir -Force }
  }
  foreach ($d in @('libs','popup','options','icons')) {
    $src = Join-Path $extRoot $d
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $script:ExtensionDir -Recurse -Force }
  }
  Write-Ok "Extensao copiada para $($script:ExtensionDir)"
}
# ---------------------------------------------------------------------------
# Scripts de inicializacao do backend + launchers dos navegadores
# ---------------------------------------------------------------------------
function Write-StartScripts {
  New-EmptyDir $script:LauncherDir
  $venvPy = Join-Path $script:VenvDir 'Scripts\python.exe'
  $server = Join-Path $script:BackendDir 'server.py'
  $ffPath = if ($script:FFmpegBin) { "set `"PATH=$($script:FFmpegBin);%PATH%`"`r`n" } else { '' }

  if ($script:BackendExe) {
    # start "" /B: abre o EXE (windowed) em segundo plano e fecha o console do .cmd
    $backendRun = 'start "" /B "' + $script:BackendExe + '"' + "`r`n"
  } else {
    $backendRun = "`"$venvPy`" `"$server`"`r`n"
  }
  $startCmd = "@echo off`r`n" +
              "title Edge Video Downloader - Motor Local`r`n" +
              $ffPath +
              "cd /d `"$($script:BackendDir)`"`r`n" +
              $backendRun
  $startCmd | Set-Content -LiteralPath (Join-Path $script:LauncherDir 'start_backend.cmd') -Encoding ASCII

  $ext = $script:ExtensionDir
  $workaround = '--disable-features=DisableLoadExtensionCommandLineSwitch'
  foreach ($pair in @(
      @{ Name='edge';   Exe=$script:EdgeExe },
      @{ Name='chrome'; Exe=$script:ChromeExe }
  )) {
    if (-not $pair.Exe) { continue }
    $content = "@echo off`r`nstart `"`" `"$($pair.Exe)`" --load-extension=`"$ext`" $workaround`r`n"
    $content | Set-Content -LiteralPath (Join-Path $script:LauncherDir "launch_$($pair.Name).cmd") -Encoding ASCII
    Write-Ok "Launcher $($pair.Name) criado."
  }
}

# ---------------------------------------------------------------------------
# Atalhos no Desktop / Start Menu
# ---------------------------------------------------------------------------
function New-BrowserShortcut {
  param([string]$Name, [string]$TargetExe, [string]$Arguments, [string]$Icon, [string]$Folder)
  if (-not $TargetExe) { return }
  New-EmptyDir $Folder
  $lnk = Join-Path $Folder "$Name.lnk"
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnk)
  $sc.TargetPath = $TargetExe
  $sc.Arguments  = $Arguments
  $sc.WorkingDirectory = Split-Path $TargetExe
  if ($Icon -and (Test-Path -LiteralPath $Icon)) { $sc.IconLocation = "$Icon,0" }
  $sc.Description = "$Name - Edge Video Downloader"
  $sc.Save()
  Write-Ok "Atalho criado em $lnk"
}

function New-BackendShortcut {
  param([string]$LnkPath)
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($LnkPath)
  if ($script:BackendExe) {
    $sc.TargetPath = $script:BackendExe
    $sc.WindowStyle = 1   # abre a janela de status do EXE (sem console)
  } else {
    $sc.TargetPath = (Join-Path $script:LauncherDir 'start_backend.cmd')
    $sc.WindowStyle = 7
  }
  $sc.WorkingDirectory = $script:BackendDir
  $sc.IconLocation = "$(Join-Path $script:ExtensionDir 'icons\icon-128.png'),0"
  $sc.Description = "Motor Local - Edge Video Downloader"
  $sc.Save()
  Write-Ok "Atalho criado em $LnkPath"
}

function Create-Shortcuts {
  if ($NoShortcuts) { Write-Warn "Atalhos ignorados (-NoShortcuts)."; return }
  Write-Step "Criando atalhos"
  $ext = $script:ExtensionDir
  $workaround = '--disable-features=DisableLoadExtensionCommandLineSwitch'
  $icon = Join-Path $ext 'icons\icon-128.png'
  $desktop = [Environment]::GetFolderPath('Desktop')
  $sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Edge Video Downloader'
  New-EmptyDir $sm

  if ($script:EdgeExe) {
    New-BrowserShortcut -Name 'Edge Video Downloader' -TargetExe $script:EdgeExe `
      -Arguments "--load-extension=`"$ext`" $workaround" -Icon $icon -Folder $desktop
    New-BrowserShortcut -Name 'Edge Video Downloader' -TargetExe $script:EdgeExe `
      -Arguments "--load-extension=`"$ext`" $workaround" -Icon $icon -Folder $sm
  }
  if ($script:ChromeExe) {
    New-BrowserShortcut -Name 'Chrome Video Downloader' -TargetExe $script:ChromeExe `
      -Arguments "--load-extension=`"$ext`" $workaround" -Icon $icon -Folder $desktop
    New-BrowserShortcut -Name 'Chrome Video Downloader' -TargetExe $script:ChromeExe `
      -Arguments "--load-extension=`"$ext`" $workaround" -Icon $icon -Folder $sm
  }
  if (-not $NoBackend) {
    # Atalho do Motor Local (aplicacao backend): no Menu Iniciar e na Area de Trabalho
    New-BackendShortcut -LnkPath (Join-Path $sm 'Motor Local.lnk')
    New-BackendShortcut -LnkPath (Join-Path $desktop 'Motor Local.lnk')
  }
}

# ---------------------------------------------------------------------------
# Auto-inicio do backend
# ---------------------------------------------------------------------------
function Register-Autostart {
  if ($NoBackend -or $NoAutostart) { Write-Warn "Auto-inicio ignorado."; return }
  Write-Step "Registrando auto-inicio do backend"
  $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
  New-EmptyDir $startup
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut((Join-Path $startup 'Edge Video Downloader - Motor Local.lnk'))
  if ($script:BackendExe) {
    $sc.TargetPath = $script:BackendExe
    $sc.WindowStyle = 1
  } else {
    $sc.TargetPath = (Join-Path $script:LauncherDir 'start_backend.cmd')
    $sc.WindowStyle = 7
  }
  $sc.WorkingDirectory = $script:BackendDir
  $sc.IconLocation = "$(Join-Path $script:ExtensionDir 'icons\icon-128.png'),0"
  $sc.Save()
  Write-Ok "Backend iniciara automaticamente no login (janela de status)."
}

# ---------------------------------------------------------------------------
# Registro do desinstalador
# ---------------------------------------------------------------------------
function Register-Uninstaller {
  Write-Step "Registrando o desinstalador"
  $unregKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\EdgeVideoDownloader'
  $uninstallCmd = Join-Path $script:ToolsDir 'Uninstall-EdgeVideoDownloader.cmd'
  if (-not (Test-Path -LiteralPath $uninstallCmd)) { $uninstallCmd = Join-Path $PSScriptRoot 'Uninstall-EdgeVideoDownloader.cmd' }
  New-EmptyDir (Split-Path -Parent $unregKey)
  if (Test-Path -LiteralPath $unregKey) { Remove-Item -LiteralPath $unregKey -Recurse -Force }
  New-Item -LiteralPath $unregKey -Force | Out-Null
  $str = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\EdgeVideoDownloader'
  New-ItemProperty -LiteralPath $str -Name 'DisplayName' -Value 'Edge Video Downloader' -PropertyType String -Force | Out-Null
  New-ItemProperty -LiteralPath $str -Name 'DisplayVersion' -Value $script:PinnedVersion -PropertyType String -Force | Out-Null
  New-ItemProperty -LiteralPath $str -Name 'Publisher' -Value 'Edge Video Downloader Project' -PropertyType String -Force | Out-Null
  New-ItemProperty -LiteralPath $str -Name 'DisplayIcon' -Value (Join-Path $script:ExtensionDir 'icons\icon-128.png') -PropertyType String -Force | Out-Null
  New-ItemProperty -LiteralPath $str -Name 'InstallLocation' -Value $InstallDir -PropertyType String -Force | Out-Null
  New-ItemProperty -LiteralPath $str -Name 'InstallDate' -Value (Get-Date -Format 'yyyyMMdd') -PropertyType String -Force | Out-Null
  New-ItemProperty -LiteralPath $str -Name 'UninstallString' -Value "`"$uninstallCmd`"" -PropertyType String -Force | Out-Null
  New-ItemProperty -LiteralPath $str -Name 'QuietUninstallString' -Value "`"$uninstallCmd`" -Q" -PropertyType String -Force | Out-Null
  New-ItemProperty -LiteralPath $str -Name 'NoModify' -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -LiteralPath $str -Name 'NoRepair' -Value 1 -PropertyType DWord -Force | Out-Null
  Write-Ok "Desinstalador registrado."
}

# ---------------------------------------------------------------------------
# Resumo / abertura dos navegadores
# ---------------------------------------------------------------------------
function Show-Summary {
  Write-Host "`n============================================================" -ForegroundColor Magenta
  Write-Host "  Edge Video Downloader - Instalacao concluida!" -ForegroundColor Magenta
  Write-Host "============================================================" -ForegroundColor Magenta
  Write-Host "  Extensao : $($script:ExtensionDir)"
  Write-Host "  Backend  : $($script:BackendUrl)  (Motor Local)"
  Write-Host "  Downloads: %USERPROFILE%\Downloads\EdgeVideoDownloader"
  if ($script:EdgeExe)   { Write-Host "  Edge   : atalho criado com a extensao carregada." }
  if ($script:ChromeExe) { Write-Host "  Chrome : atalho criado com a extensao carregada." }
  if (-not $script:EdgeExe -and -not $script:ChromeExe) { Write-Warn "Nenhum navegador Edge/Chrome detectado." }
  Write-Host "`n  Clique nos atalhos 'Edge/Chrome Video Downloader' para abrir o navegador"
  Write-Host "  com a extensao ja ativa. Feche o navegador antes de reabrir, se ele ja estava aberto."
  Write-Host "============================================================" -ForegroundColor Magenta
  if (-not $Quiet -and -not $NoPause) { Read-Host "`nPressione Enter para sair" | Out-Null }
}

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
Write-Step "Iniciando instalacao do Edge Video Downloader"
Write-Host "    Diretorio de instalacao: $InstallDir"

New-EmptyDir $script:ToolsDir
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Uninstall-EdgeVideoDownloader.ps1') -Destination $script:ToolsDir -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Uninstall-EdgeVideoDownloader.cmd') -Destination $script:ToolsDir -Force -ErrorAction SilentlyContinue

$script:EdgeExe   = Resolve-EdgeExe
$script:ChromeExe = Resolve-ChromeExe

Install-ExtensionFiles
if (-not $NoBackend) { Setup-Backend }
Get-OrInstall-Ffmpeg
Write-StartScripts
Create-Shortcuts
Register-Autostart
if (-not $SkipUninstaller) { Register-Uninstaller }

Show-Summary

if ($NoLaunch) { exit 0 }
$ext = $script:ExtensionDir
if ($script:EdgeExe)   { Start-Process -FilePath $script:EdgeExe   -ArgumentList "--load-extension=`"$ext`" --disable-features=DisableLoadExtensionCommandLineSwitch" }
if ($script:ChromeExe) { Start-Process -FilePath $script:ChromeExe -ArgumentList "--load-extension=`"$ext`" --disable-features=DisableLoadExtensionCommandLineSwitch" }


