const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function findServiceAccountKey() {
  const rootDir = path.join(__dirname, '..');
  const targetKey = path.join(rootDir, 'serviceAccountKey.json');
  if (fs.existsSync(targetKey)) {
    return targetKey;
  }

  // Check downloads
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  if (fs.existsSync(downloadsDir)) {
    const files = fs.readdirSync(downloadsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(downloadsDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    for (const f of files) {
      try {
        const json = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (json.type === 'service_account' && json.project_id && json.private_key) {
          fs.copyFileSync(f, targetKey);
          console.log('✅ พบไฟล์ Service Account ใน Downloads และคัดลอกมาที่: serviceAccountKey.json');
          return targetKey;
        }
      } catch (e) {}
    }
  }
  return null;
}

const keyPath = findServiceAccountKey();
if (!keyPath) {
  console.log(JSON.stringify({
    success: false,
    message: 'ยังไม่พบไฟล์ Service Account (.json) ในโฟลเดอร์โปรเจกต์หรือใน Downloads'
  }));
  process.exit(1);
}

// 2. Update .env
const envPath = path.join(__dirname, '..', '.env');
let envContent = '';
if (fs.existsSync(envPath)) {
  envContent = fs.readFileSync(envPath, 'utf8');
}

if (/^DB_PROVIDER=/m.test(envContent)) {
  envContent = envContent.replace(/^DB_PROVIDER=.*$/m, 'DB_PROVIDER=firestore');
} else {
  envContent += '\nDB_PROVIDER=firestore';
}

if (/^FIREBASE_SERVICE_ACCOUNT_KEY=/m.test(envContent)) {
  envContent = envContent.replace(/^FIREBASE_SERVICE_ACCOUNT_KEY=.*$/m, 'FIREBASE_SERVICE_ACCOUNT_KEY=./serviceAccountKey.json');
} else {
  envContent += '\nFIREBASE_SERVICE_ACCOUNT_KEY=./serviceAccountKey.json';
}

fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');
console.log('✅ อัปเดตไฟล์ .env ให้ใช้ Firestore เรียบร้อยแล้ว');

// 3. Run migration
console.log('\n🚀 กำลังโอนย้ายข้อมูลจาก SQLite ไปยัง Cloud Firestore...');
try {
  execSync('node scripts/migrate-to-firestore.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  console.log('\n🎉 เชื่อมต่อและโอนย้ายข้อมูลสู่ Firebase Firestore สำเร็จสมบูรณ์!');
} catch (e) {
  console.error('❌ เกิดข้อผิดพลาดขณะโอนย้ายข้อมูล:', e.message);
  process.exit(1);
}
