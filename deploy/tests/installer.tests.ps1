<#
Testes de integracao do instalador (TDD - RED/GREEN).

Roda o Setup-EdgeVideoDownloader.ps1 em diretorio temporario, com Desktop e
Menu Iniciar SOBREPOSTOS (pastas falsas, sem tocar nos atalhos reais do
usuario) e asserta o contrato do instalador de um clique:

  1. deps-report.json criado em <app>\tools com os campos
     backend / ffmpeg / deno / shortcuts / autostart
  2. Deno disponivel (instalado em ~\.deno\bin ou ja no PATH)
  3. Atalho "Dashboard" criado no Desktop e no Menu Iniciar sobrepostos
  4. Atalhos "Motor Local" e "Edge Video Downloader" preservados
  5. Desinstalador (com -InstallDir e overrides) remove tudo
  6. Desinstalador NAO remove o deno de ~\.deno\bin

Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\tests\installer.tests.ps1
Saida: OK/FAIL por assert; exit 1 se qualquer assert falhar.
#>
[CmdletBinding()]
param(
  [switch]$IncludeFfmpeg   # roda SEM -NoFfmpeg (download real ~150MB; lento)
)

$ErrorActionPreference = 'Stop'
$script:Failures = 0

function Assert {
  param([bool]$Cond, [string]$Name)
  if ($Cond) { Write-Host "    [OK] $Name" -ForegroundColor Green }
  else       { Write-Host "    [FAIL] $Name" -ForegroundColor Red; $script:Failures++ }
}

$proj    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # raiz do projeto
$tmp     = Join-Path ([System.IO.Path]::GetTempPath()) ("evd-installer-test-" + [guid]::NewGuid().ToString('N').Substring(0,8))
$appDir  = Join-Path $tmp 'app'
$desktop = Join-Path $tmp 'desktop'
$startMenu = Join-Path $tmp 'startmenu'
$setup   = Join-Path $PSScriptRoot '..\Setup-EdgeVideoDownloader.ps1'
$uninst  = Join-Path $PSScriptRoot '..\Uninstall-EdgeVideoDownloader.ps1'
New-Item -ItemType Directory -Path $desktop, $startMenu -Force | Out-Null

try {
  Write-Host "`n==> Rodando instalador em diretorio temporario ($appDir)" -ForegroundColor Cyan
  $setupArgs = @(
    '-NoProfile','-ExecutionPolicy','Bypass','-File',$setup,
    '-SourceRoot',$proj,'-InstallDir',$appDir,
    '-NoAutostart','-NoLaunch','-SkipUninstaller','-Quiet','-NoPause',
    '-DesktopOverride',$desktop,'-StartMenuOverride',$startMenu
  )
  if (-not $IncludeFfmpeg) { $setupArgs += '-NoFfmpeg' }
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $setupArgs -NoNewWindow -Wait -PassThru
  Assert ($p.ExitCode -eq 0) "Setup termina com exit code 0 (saiu $($p.ExitCode))"

  $reportPath = Join-Path $appDir 'tools\deps-report.json'
  Assert (Test-Path -LiteralPath $reportPath) "deps-report.json existe em tools\"

  if (Test-Path -LiteralPath $reportPath) {
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    foreach ($k in @('backend','ffmpeg','deno','shortcuts','autostart')) {
      $v = $report.$k
      Assert ($null -ne $v -and "$v" -ne '') "deps-report contem campo '$k' (valor: $v)"
    }
    Assert ("$($report.backend)" -eq 'exe') "backend instalado como EXE autonomo (report: $($report.backend))"
    Assert ("$($report.ffmpeg)" -like 'ok*' -or "$($report.ffmpeg)" -eq 'skipped') "ffmpeg registrado ok/skipped (report: $($report.ffmpeg))"
    Assert ("$($report.deno)" -like 'ok*') "deno registrado como ok (report: $($report.deno))"
    Assert ("$($report.shortcuts)" -eq 'ok') "shortcuts registrados como ok"
    Assert ("$($report.autostart)" -eq 'skipped') "autostart registrado como skipped"
  }

  $denoHome = Join-Path $env:USERPROFILE '.deno\bin\deno.exe'
  $denoCmd  = Get-Command deno -ErrorAction SilentlyContinue
  Assert ((Test-Path -LiteralPath $denoHome) -or ($null -ne $denoCmd)) "deno disponivel (~\.deno\bin\deno.exe ou PATH)"

  $smFolder = Join-Path $startMenu 'Edge Video Downloader'
  Assert (Test-Path -LiteralPath (Join-Path $desktop 'Dashboard.lnk')) "atalho Dashboard no Desktop"
  Assert (Test-Path -LiteralPath (Join-Path $smFolder 'Dashboard.lnk')) "atalho Dashboard no Menu Iniciar"
  Assert (Test-Path -LiteralPath (Join-Path $desktop 'Motor Local.lnk')) "atalho Motor Local preservado no Desktop"
  Assert (Test-Path -LiteralPath (Join-Path $desktop 'Edge Video Downloader.lnk')) "atalho Edge (extensao) preservado no Desktop"

  Write-Host "`n==> Caso Inno: SourceRoot == InstallDir (extensao ja copiada pelo Setup)" -ForegroundColor Cyan
  # O Inno copia os arquivos para {app} antes do [Run]; o Setup script e chamado
  # com -SourceRoot {app} -InstallDir {app} — nao pode falhar copiando sobre si.
  $setupArgs2 = @(
    '-NoProfile','-ExecutionPolicy','Bypass','-File',$setup,
    '-SourceRoot',$appDir,'-InstallDir',$appDir,
    '-NoAutostart','-NoLaunch','-SkipUninstaller','-Quiet','-NoPause',
    '-DesktopOverride',$desktop,'-StartMenuOverride',$startMenu,'-NoFfmpeg'
  )
  $p1b = Start-Process -FilePath 'powershell.exe' -ArgumentList $setupArgs2 -NoNewWindow -Wait -PassThru
  Assert ($p1b.ExitCode -eq 0) "Setup com SourceRoot==InstallDir termina com exit code 0 (saiu $($p1b.ExitCode))"
  Assert (Test-Path -LiteralPath (Join-Path $appDir 'tools\deps-report.json')) "deps-report.json ainda presente apos segunda chamada"

  Write-Host "`n==> Rodando desinstalador sobre a instalacao temporaria" -ForegroundColor Cyan
  $p2 = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile','-ExecutionPolicy','Bypass','-File',$uninst,
    '-Q','-InstallDir',$appDir,'-DesktopOverride',$desktop,'-StartMenuOverride',$startMenu
  ) -NoNewWindow -Wait -PassThru
  Assert ($p2.ExitCode -eq 0) "Uninstall termina com exit code 0 (saiu $($p2.ExitCode))"
  Assert (-not (Test-Path -LiteralPath $appDir)) "diretorio de instalacao removido"
  Assert (-not (Test-Path -LiteralPath (Join-Path $desktop 'Dashboard.lnk'))) "atalho Dashboard removido do Desktop"
  Assert (-not (Test-Path -LiteralPath $smFolder)) "pasta do Menu Iniciar removida"
  Assert ((Test-Path -LiteralPath $denoHome) -or ($null -ne $denoCmd)) "deno PRESERVADO apos desinstalar"
}
finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($script:Failures -eq 0) {
  Write-Host "RESULTADO: TODOS OS ASSERTS PASSARAM" -ForegroundColor Green
  exit 0
} else {
  Write-Host "RESULTADO: $($script:Failures) ASSERT(S) FALHARAM" -ForegroundColor Red
  exit 1
}
