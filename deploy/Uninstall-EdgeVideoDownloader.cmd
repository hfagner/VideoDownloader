@echo off
setlocal
title Edge Video Downloader - Desinstalador
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall-EdgeVideoDownloader.ps1" %*
endlocal
