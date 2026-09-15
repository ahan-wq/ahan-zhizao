@echo off
chcp 65001 >nul
title 阿憨植造 - 防火墙放行 8080
:: ===== 自动申请管理员权限 =====
>nul 2>&1 "%SYSTEMROOT%\system32\cacls.exe" "%SYSTEMROOT%\system32\config\system"
if '%errorlevel%' NEQ '0' (
    echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\getadmin.vbs"
    echo UAC.ShellExecute "%~s0", "", "", "runas", 1 >> "%temp%\getadmin.vbs"
    "%temp%\getadmin.vbs"
    exit /B
)
:: ===== 放行 8080 入站 =====
netsh advfirewall firewall delete rule name="阿憨植造服务8080" >nul 2>&1
netsh advfirewall firewall add rule name="阿憨植造服务8080" dir=in action=allow protocol=TCP localport=8080 profile=private,domain >nul 2>&1
echo.
echo  已放行 8080 端口（仅需执行这一次）
echo.
echo  现在手机 / 平板可以和电脑连同一个 WiFi，然后用手机浏览器打开：
echo.
echo     http://192.168.31.125:8080
echo.
echo  （具体地址以服务窗口打印的"局域网访问"那行为准）
echo.
pause
