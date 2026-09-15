@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   阿憨植造服务启动中...
echo   稍后会自动打开浏览器
echo   重要：本窗口请保持开启，关闭窗口即停止服务
echo.
echo   手机/平板访问（同一WiFi）：先运行一次「防火墙放行8080.bat」
echo ============================================
start "" "http://localhost:8080"
node server.js
pause
