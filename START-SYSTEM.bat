@echo off
chcp 65001 > nul
title ระบบจองห้องประชุมสำหรับองค์กร (Meeting Room System)
color 0F

echo ===============================================================================
echo          ระบบจองห้องประชุมสำหรับองค์กร (Meeting Room Web Application)
echo ===============================================================================
echo.
echo  กำลังตรวจสอบและเริ่มต้นระบบ...
echo.

:: 1. ตรวจสอบ Node.js
set NODE_CMD=node
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "C:\Program Files\nodejs\node.exe" (
        set "NODE_CMD=C:\Program Files\nodejs\node.exe"
    ) else if exist "C:\Program Files (x86)\nodejs\node.exe" (
        set "NODE_CMD=C:\Program Files (x86)\nodejs\node.exe"
    ) else if exist "%LOCALAPPDATA%\Programs\node\node.exe" (
        set "NODE_CMD=%LOCALAPPDATA%\Programs\node\node.exe"
    ) else (
        color 0C
        echo [!] ตรวจพบปัญหา: ไม่พบโปรแกรม Node.js ในเครื่องคอมพิวเตอร์นี้
        echo.
        echo กรุณาดาวน์โหลดและติดตั้ง Node.js ฟรีที่:
        echo https://nodejs.org
        echo.
        echo หลังติดตั้งเสร็จแล้ว ให้ดับเบิลคลิกไฟล์นี้ใหม่อีกครั้ง
        echo ===============================================================================
        pause
        exit /b 1
    )
)

:: 2. ตรวจสอบ node_modules
if not exist "node_modules\" (
    echo [i] กำลังติดตั้งแพ็กเกจที่จำเป็นอัตโนมัติ...
    call npm install
    echo.
)

:: 3. เปิด Web Browser อัตโนมัติหลัง 2 วินาที
start /b "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"

:: 4. เริ่มต้นเซิร์ฟเวอร์
echo  [OK] เริ่มต้นระบบจองห้องประชุมเรียบร้อยแล้ว...
echo  (กด Ctrl + C เพื่อหยุดการทำงานของระบบ)
echo.
echo ===============================================================================
"%NODE_CMD%" server.js

pause
