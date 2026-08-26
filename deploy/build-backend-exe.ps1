<#
.SYNOPSIS
  Gera o EXE autonomo do backend "Motor Local" com PyInstaller.

.DESCRIPTION
  Cria um venv de build, instala as dependencias do backend + PyInstaller e
  compila backend\server.py em deploy\dist\backend\EdgeVideoDownloaderBackend.exe.
  Isso permite que o usuario final rode o backend SEM precisar instalar Python.

.PARAMETER PythonVersion
  Versao do Python usada pelo launcher 'py' no build (padrao 3.11, bem suportado
  pelo PyInstaller). Use uma versao <= 3.13 se 3.14 falhar.

.PARAMETER Python
  Caminho/comando do Python a usar, ignorando a versao do launcher 'py'.
  Ex.: "-Python C:\Python311\python.exe".

.PARAMETER Rebuild
  Recria o venv de build do zero (ignora cache).

.PARAMETER TrustedHost
  Adiciona --trusted-host ao pip para contornar proxies com certificado
  self-signed (erro "certificate verify failed"), comum em redes corporativas.

.PARAMETER SkipInstall
  Pula a instalacao de dependencias. Use quando o venv de build ja esta
  populado (ex.: para recompilar so o EXE mais rapido).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\build-backend-exe.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\build-backend-exe.ps1 -TrustedHost
#>
[CmdletBinding()]
param(
  [string]$PythonVersion = '3.11',
  [string]$Python = '',
  [switch]$Rebuild,
  [switch]$TrustedHost,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$deployDir    = $PSScriptRoot
$projectRoot  = Split-Path -Parent $deployDir
$entry        = Join-Path $projectRoot 'backend\server.py'
$outDir       = Join-Path $deployDir 'dist\backend'
$outExe       = Join-Path $outDir 'EdgeVideoDownloaderBackend.exe'

if (-not (Test-Path -LiteralPath $entry)) { throw "server.py nao encontrado: $entry" }
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

# 1) Venv de build ----------------------------------------------------------
$buildVenv = Join-Path $deployDir '.pybuild-venv'
$venvPy    = Join-Path $buildVenv 'Scripts\python.exe'

if ($Rebuild -and (Test-Path -LiteralPath $buildVenv)) { Remove-Item -LiteralPath $buildVenv -Recurse -Force }

if (-not (Test-Path -LiteralPath $venvPy)) {
  Write-Host "Criando venv de build em $buildVenv (Python ${PythonVersion})..."
  if ($Python) {
    if ($LASTEXITCODE -ne 0) { throw "Falha ao criar o venv de build." }
    & $Python -m venv $buildVenv
  } elseif ($PythonVersion) {
    & py "-$PythonVersion" -m venv $buildVenv
  } else {
    & python -m venv $buildVenv
  }
  if ($LASTEXITCODE -ne 0) { throw "Falha ao criar o venv de build. Tente '-Python python' ou ajuste -PythonVersion." }
} else {
  Write-Host "Venv de build ja existe."
}

# 2) Dependencias de build --------------------------------------------------
$pipTrust = @()
if ($TrustedHost) {
  $pipTrust = @('--trusted-host','files.pythonhosted.org','--trusted-host','pypi.org','--trusted-host','pypi.python.org')
}
# Detecta se as dependencias de build ja estao presentes (evita baixar de novo).
# Importante: a checagem do yt-dlp tambem valida a versao MINIMA exigida em
# requirements.txt (>= 2026.08.19). Sem isso o PyInstaller poderia reempacotar
# um yt-dlp desatualizado e o erro "Requested format is not available" voltaria.
& $venvPy -c "import sys
for m in ('PyInstaller','flask','flask_cors','yt_dlp','requests','waitress','curl_cffi','pystray','PIL'):
    try: __import__(m)
    except Exception: sys.exit(1)
try:
    _ver = tuple(int(x) for x in __import__('yt_dlp').version.__version__.split('.')[:3])
except Exception:
    _ver = (0,0,0)
if _ver < (2026, 8, 19):
    sys.exit(1)
sys.exit(0)" 2>$null | Out-Null
$haveDeps = $LASTEXITCODE

if (-not $SkipInstall -and $haveDeps -ne 0) {
  Write-Host "Instalando dependencias de build (PyInstaller + backend)..."
  & $venvPy -m pip install @pipTrust --upgrade pip 2>&1 | Out-Null
  & $venvPy -m pip install @pipTrust -r (Join-Path $projectRoot 'backend\requirements.txt') pyinstaller 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar dependencias de build. Tente -TrustedHost se houver erro de certificado SSL." }
} elseif (-not $SkipInstall) {
  Write-Host "Dependencias de build ja instaladas."
} else {
  Write-Host "Pulando instalacao (-SkipInstall)."
}

# 3) PyInstaller ------------------------------------------------------------
Write-Host "Compilando o backend com PyInstaller..."
$workPath = Join-Path $deployDir 'dist\.work'
$specPath = Join-Path $deployDir 'dist\.spec'
New-Item -ItemType Directory -Path $workPath -Force | Out-Null
New-Item -ItemType Directory -Path $specPath -Force | Out-Null

$pyArgs = @(
  '--noconfirm','--clean','--onefile','--windowed',
  '--name','EdgeVideoDownloaderBackend',
  '--distpath',$outDir,
  '--workpath',$workPath,
  '--specpath',$specPath
)
# yt-dlp carrega os extractors dinamicamente: incluir o pacote inteiro
$pyArgs += '--collect-all=yt_dlp'
# pystray (bandeja) carrega backends dinamicamente: incluir o pacote inteiro
$pyArgs += '--collect-all=pystray'
# Dashboard web e ícones (dados usados em runtime via resource_path)
$pyArgs += '--add-data', ((Join-Path $projectRoot 'backend\web') + ';backend\web')
$pyArgs += '--add-data', ((Join-Path $projectRoot 'icons') + ';icons')
# curl-cffi (impersonacao de navegador do Instagram) inclui libcurl nativo e
# certificados: coleta todos os binarios/dados para o EXE suportar instagram.
$pyArgs += '--collect-all=curl_cffi'
# flask/template/static + deps dinamicas mais comuns do yt-dlp + waitress
foreach ($h in @('waitress','certifi','brotli','websockets','pysocks','Cryptodome','Crypto','brotlicffi','curl_cffi','curl_cffi.impersonate')) {
  $pyArgs += "--hidden-import=$h"
}
$pyArgs += $entry

& $venvPy -m PyInstaller @pyArgs
if ($LASTEXITCODE -ne 0) { throw "Falha ao compilar o backend. Veja a saida do PyInstaller acima." }

if (-not (Test-Path -LiteralPath $outExe)) { throw "EXE do backend nao foi gerado: $outExe" }
$sizeMb = [math]::Round((Get-Item -LiteralPath $outExe).Length / 1MB, 1)
Write-Host "`nBackend EXE gerado: $outExe ($sizeMb MB)" -ForegroundColor Green
