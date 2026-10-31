@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在起牌桌（本地 8765）……
start "" /min cmd /c "node server.cjs"
timeout /t 2 >nul
start "" "http://127.0.0.1:8765"
echo.
echo 开好了。
echo   1) 首页选「经典三人」→ 创建房间，把 4 位房间码发出去
echo   2) 别人在自己机器上输入房间码加入
echo   3) AI 座位：首页把「你的操作身份」切成 AI，再双击「我上桌.cmd」
Echo.
pause
