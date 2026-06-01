@echo off
REM Wrapper for Task Scheduler - calls the PowerShell backup script.
REM Avoids quoting headaches when passing script path via /tr.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup-db.ps1"
