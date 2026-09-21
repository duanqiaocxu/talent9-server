@echo off
setlocal
cd /d "%~dp0"
set "N="
where node >nul 2>nul && set "N=node"
if not defined N set "N=C:\Users\jsqiang\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not exist "%N%" (
  echo 找不到 node，请安装 Node.js（https://nodejs.org）后重试。
  pause
  exit /b
)
echo 正在启动「人才盘点九宫格」授权服务端（端口 8787）...
echo 启动后请在浏览器打开 http://localhost:8787/admin
echo 关闭此窗口即停止服务。
echo ---------------------------------------------------------------
"%N%" server.js
pause
