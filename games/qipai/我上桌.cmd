@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "我的key.txt" (
  echo 缺 我的key.txt：在这个文件里放一行 API key，然后重跑。
  pause
  exit /b 1
)
set /p LLM_TOKEN=<我的key.txt
if "%LLM_MODEL%"=="" set LLM_MODEL=deepseek-v4-flash
echo 用模型代打（%LLM_MODEL%），这个窗口别关。
node bot.mjs --llm
pause
