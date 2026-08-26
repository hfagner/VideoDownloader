@echo off
setlocal
title Edge Video Downloader - Instalador
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-EdgeVideoDownloader.ps1" %*
endlocal
