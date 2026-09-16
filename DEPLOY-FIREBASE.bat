@echo off
chcp 65001 >nul
title Deploy to Firebase
cls
echo =============================================================
echo        🔥 ระบบ Deploy อัตโนมัติขึ้นสู่ Firebase (24/7)
echo =============================================================
echo.
echo [1/3] เข้าสู่ระบบ Google Firebase ผ่านเบราว์เซอร์...
call npx -y firebase-tools login
echo.
echo [2/3] เลือกหรือสร้าง Firebase Project...
echo (หากมี Project อยู่แล้วให้เลือก Use an existing project)
call npx -y firebase-tools init hosting
echo.
echo [3/3] กำลัง Deploy ไฟล์และระบบขึ้นสู่ Firebase Hosting...
call npx -y firebase-tools deploy
echo.
echo =============================================================
echo   🎉 Deploy สำเร็จ! คุณจะได้ URL https://your-project.web.app
echo =============================================================
pause
