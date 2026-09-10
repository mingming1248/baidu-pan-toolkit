@echo off
rem 以远程调试模式启动 Edge（CDP 端口 9222），独立 profile 不影响日常浏览器
setlocal
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo [!] 未找到 Edge，请手动用以下参数启动 Chrome/Edge:
  echo     --remote-debugging-port=9222 --user-data-dir=%%LOCALAPPDATA%%\139-cdp-profile
  pause & exit /b 1
)
start "" "%EDGE%" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\139-cdp-profile" --no-first-run --no-default-browser-check --window-size=1100,780 "https://yun.139.com/w/#/index"
echo Edge 已启动（CDP 9222）。请在打开的窗口登录139网盘（yun.139.com，扫码/短信），登录一次后长期有效。
echo 注意：cloud.139.com 是云手机页，不是网盘；网盘入口是 yun.139.com
