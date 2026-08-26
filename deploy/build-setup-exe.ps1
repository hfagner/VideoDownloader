<#
.SYNOPSIS
  Compila o instalador profissional (Setup.exe) com o Inno Setup.

.DESCRIPTION
  Localiza o compilador ISCC.exe do Inno Setup (qualquer versao: 6, 7, ...) e
  compila deploy\VideoDownloaderSetup.iss.
  O resultado sera gravado em dist\EdgeVideoDownloaderSetup.exe na raiz do projeto.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\build-setup-exe.ps1
#>
[CmdletBinding()]
param(
  [switch]$SkipBackend
)

$ErrorActionPreference = 'Stop'
$iss = Join-Path $PSScriptRoot 'VideoDownloaderSetup.iss'
if (-not (Test-Path -LiteralPath $iss)) { throw "Arquivo .iss nao encontrado: $iss" }

# Compila primeiro o EXE autonomo do backend (PyInstaller), para ser empacotado
if (-not $SkipBackend) {
  $backend = Join-Path $PSScriptRoot 'build-backend-exe.ps1'
  if (Test-Path -LiteralPath $backend) {
    Write-Host "Gerando EXE do backend (PyInstaller)..."
    & $backend
    if ($LASTEXITCODE -ne 0) { throw "Falha ao gerar o EXE do backend." }
  }
}

function Find-Iscc {
  # Pastas onde o Inno Setup normalmente instala ("Inno Setup 6", "Inno Setup 7", ...)
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs'))
  $folders = @()
  foreach ($r in $roots) {
    if (-not $r -or -not (Test-Path -LiteralPath $r)) { continue }
    $folders += Get-ChildItem -LiteralPath $r -Directory -Filter 'Inno Setup*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
  }
  # Da versao mais alta para a mais baixa ("Inno Setup 7" antes de "Inno Setup 6")
  $ordered = $folders | Where-Object { $_ } | Sort-Object { [int]((($_ -split ' ')[-1]) -replace '\D','0') } -Descending
  foreach ($f in $ordered) {
    $exe = Join-Path $f 'ISCC.exe'
    if (Test-Path -LiteralPath $exe) { return $exe }
  }
  # Fallback: registro
  foreach ($k in @('HKCU:\Software\Inno Setup', 'HKLM:\Software\Inno Setup', 'HKLM:\Software\WOW6432Node\Inno Setup')) {
    if (Test-Path -LiteralPath $k) {
      $p = (Get-ItemProperty -LiteralPath $k -ErrorAction SilentlyContinue).'Installation Path'
      if ($p) {
        $exe = Join-Path $p 'ISCC.exe'
        if (Test-Path -LiteralPath $exe) { return $exe }
      }
    }
  }
  # Fallback: PATH
  $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$iscc = Find-Iscc

if (-not $iscc) {
  Write-Warning 'Inno Setup nao encontrado. Instale em: https://jrsoftware.org/isdl.php'
  Write-Warning 'Enquanto isso, voce pode usar o instalador sem compilador:'
  Write-Warning '   .\Setup-EdgeVideoDownloader.cmd'
  exit 1
}

Write-Host "Compilando com: $iscc"
& $iscc $iss
if ($LASTEXITCODE -ne 0) { throw "Falha ao compilar (codigo $LASTEXITCODE)." }

$exe = Join-Path (Split-Path (Split-Path $iss -Parent) -Parent) 'dist\EdgeVideoDownloaderSetup.exe'
Write-Host "`nInstalador gerado: $exe" -ForegroundColor Green
