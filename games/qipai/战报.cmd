@echo off
chcp 65001 >nul
cd /d "%~dp0"
node 战报.js --tail 15
pause
