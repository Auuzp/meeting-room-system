@echo off
chcp 65001 > nul
title ปิดระบบจองห้องประชุม

echo กำลังค้นหาและปิดโปรแกรมที่เปิดอยู่บนพอร์ต 3000...
powershell -NoProfile -Command "$p = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($p) { Stop-Process -Id $p -Force; Write-Host ' [OK] ปิดการทำงานของระบบเรียบร้อย' -ForegroundColor Green } else { Write-Host ' [i] ระบบไม่ได้เปิดทำงานอยู่' -ForegroundColor Yellow }"

timeout /t 3 >nul
