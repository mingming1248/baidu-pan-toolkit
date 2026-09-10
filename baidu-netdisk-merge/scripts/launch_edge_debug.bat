@echo off
rem 以远程调试模式启动 Edge（CDP），独立 profile 不影响日常浏览器
rem 用法: launch_edge_debug.bat <端口> [profile名]
rem   例: launch_edge_debug.bat 9222 baidu-cdp-profile        (目标账号)
rem        launch_edge_debug.bat 9223 baidu-cdp-profile-mm    (源账号)
setlocal
set "PORT=%~1"
if "%PORT%"=="" set "PORT=9222"
set "PROFILE=%~2"
if "%PROFILE%"=="" set "PROFILE=baidu-cdp-profile"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo [!] 未找到 Edge，请手动用以下参数启动 Chrome/Edge:
  echo     --remote-debugging-port=%PORT% --user-data-dir=%%LOCALAPPDATA%%\%PROFILE%
  pause & exit /b 1
)
start "" "%EDGE%" --remote-debugging-port=%PORT% --user-data-dir="%LOCALAPPDATA%\%PROFILE%" --no-first-run --no-default-browser-check --window-size=1100,780 "https://pan.baidu.com/"
echo Edge 已启动（CDP %PORT%, profile %PROFILE%）。请在打开的窗口登录百度网盘，登录一次后长期有效。
