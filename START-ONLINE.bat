@echo off
chcp 65001 > nul
title ระบบจองห้องประชุม (โหมดออนไลน์เชื่อมต่อภายนอก)
color 0B

echo ===============================================================================
echo   ระบบจองห้องประชุม - โหมดออนไลน์ (รัน Local + เชื่อมต่อภายนอกผ่านเน็ต)
echo ===============================================================================
echo.
echo  กำลังตรวจสอบการติดตั้งและเริ่มต้นระบบ...

:: Check Node.js
set NODE_CMD=node
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "C:\Program Files\nodejs\node.exe" (
        set "NODE_CMD=C:\Program Files\nodejs\node.exe"
    ) else (
        echo [!] ไม่พบโปรแกรม Node.js กรุณาติดตั้ง Node.js จาก https://nodejs.org
        pause
        exit /b 1
    )
)

:: Auto open browser after 3 seconds in background
start /b "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"

:: Start online runner
"%NODE_CMD%" start-online.js

pause
