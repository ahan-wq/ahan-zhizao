@echo off
title 阿憨植造 服务守护
cd /d "%~dp0"
echo ============================================
echo   阿憨植造 服务守护已启动
echo   每 5 秒自动检查一次 8080 端口
echo   服务意外退出时会自动重新拉起
echo.
echo   本窗口请保持开启，按 Ctrl+C 停止守护
echo ============================================
echo.

:loop
netstat -ano | findstr ":8080" | findstr "LISTENING" >nul
if not errorlevel 1 (
    timeout /t 5 /nobreak >nul
    goto loop
)

echo [%date% %time%] 服务未运行，正在重新启动...
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
timeout /t 3 /nobreak >nul

netstat -ano | findstr ":8080" | findstr "LISTENING" >nul
if errorlevel 1 (
    echo [%date% %time%] 启动失败（请确认已安装 node），5 秒后重试
) else (
    echo [%date% %time%] 服务已恢复
)
timeout /t 5 /nobreak >nul
goto loop
