const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const CLOUDFLARED_BIN = path.join(__dirname, 'bin', 'cloudflared.exe');
const PUBLIC_URL_FILE = path.join(__dirname, 'data', 'public_url.txt');

// 1. Start Web Server
console.log('=============================================================');
console.log('   🚀 กำลังเริ่มต้นระบบจองห้องประชุม + เปิดระบบเชื่อมต่อภายนอก   ');
console.log('=============================================================\n');

const serverProcess = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  cwd: __dirname,
  stdio: ['inherit', 'pipe', 'inherit']
});

serverProcess.stdout.on('data', (data) => {
  process.stdout.write(data);
});

// 2. Start Cloudflare Tunnel for External Access
setTimeout(() => {
  if (!fs.existsSync(CLOUDFLARED_BIN)) {
    console.log('[!] ไม่พบไฟล์ bin/cloudflared.exe กำลังใช้งานระบบแบบ Local Wi-Fi เท่านั้น');
    return;
  }

  console.log('\n[🌐 กำลังเชื่อมต่อ Cloudflare Secure Tunnel เพื่อสร้าง Public URL...]');

  const tunnel = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', 'http://localhost:3000'], {
    cwd: __dirname
  });

  let urlFound = false;

  const handleTunnelOutput = (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !urlFound) {
      urlFound = true;
      const publicUrl = match[0];

      // Save to file for server.js to read
      try {
        fs.writeFileSync(PUBLIC_URL_FILE, publicUrl, 'utf8');
      } catch (e) {}

      console.log('\n=============================================================');
      console.log('   🎉 ระบบเปิดให้บุคคลภายนอกเข้าใช้งานได้สำเร็จแล้ว! (Online)   ');
      console.log('=============================================================');
      console.log(` 🌐 Public Internet URL (จากภายนอก/เน็ต 4G/5G/WFH):`);
      console.log(`    👉 ${publicUrl}`);
      console.log('-------------------------------------------------------------');
      console.log(' 📲 สแกน QR Code ด้านล่างนี้จากมือถือหรืออุปกรณ์นอกออฟฟิศ:');
      console.log('=============================================================\n');

      QRCode.toString(publicUrl, { type: 'terminal', small: true }, (err, qrStr) => {
        if (!err) console.log(qrStr);
        console.log(`\n📌 พนักงานที่อยู่ข้างนอก หรือ WFH สามารถเปิดเข้าผ่านลิงก์นี้ได้ตลอดเวลาที่เครื่องนี้เปิดอยู่\n`);
      });
    }
  };

  tunnel.stdout.on('data', handleTunnelOutput);
  tunnel.stderr.on('data', handleTunnelOutput);

  tunnel.on('error', (err) => {
    console.error('[!] เกิดข้อผิดพลาดกับ tunnel:', err.message);
  });

  process.on('SIGINT', () => {
    tunnel.kill();
    serverProcess.kill();
    try { fs.unlinkSync(PUBLIC_URL_FILE); } catch (e) {}
    process.exit();
  });
}, 1500);
