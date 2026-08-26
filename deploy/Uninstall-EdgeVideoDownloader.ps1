<#
.SYNOPSIS
  Desinstala o Edge Video Downloader (extensao + Motor Local) do Windows.

.DESCRIPTION
  - Para o backend em execucao no diretorio de instalacao
  - Remove os atalhos (Desktop / Start Menu / auto-inicio)
  - Remove o registro de desinstalacao
  - Remove o diretorio de instalacao

.PARAMETER Q
  Modo silencioso (sem saida interativa).
#>
[CmdletBinding()]
param([switch]$Q)

function Write-Msg { if (-not $Q) { Write-Host $args } }

$installDir = Join-Path $env:LOCALAPPDATA 'EdgeVideoDownloader'

# 1) Parar o backend (EXE autonomo ou python.exe apontando para este instalacao)
Write-Msg "Parando o backend (se em execucao)..."
try {
  Get-Process -Name 'EdgeVideoDownloaderBackend' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$installDir*server.py*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch { }

# 2) Remover atalhos
$desktop = [Environment]::GetFolderPath('Desktop')
foreach ($f in @('Edge Video Downloader.lnk','Chrome Video Downloader.lnk','Motor Local.lnk')) {
  Remove-Item -LiteralPath (Join-Path $desktop $f) -Force -ErrorAction SilentlyContinue
}
$sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Edge Video Downloader'
Remove-Item -LiteralPath $sm -Recurse -Force -ErrorAction SilentlyContinue

# 3) Remover auto-inicio
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
Remove-Item -LiteralPath (Join-Path $startup 'Edge Video Downloader - Motor Local.lnk') -Force -ErrorAction SilentlyContinue

# 4) Remover registro de desinstalacao
$unreg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\EdgeVideoDownloader'
Remove-Item -LiteralPath $unreg -Recurse -Force -ErrorAction SilentlyContinue

# 5) Remover o diretorio de instalacao
if (Test-Path -LiteralPath $installDir) {
  Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Msg "Edge Video Downloader desinstalado com sucesso."
if (-not $Q) { Start-Sleep -Seconds 2 }
