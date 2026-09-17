if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch (_) {}
}

const crypto = require('crypto');
const { initFirestore } = require('../src/db/firestore');

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `$scrypt$${salt}$${hash}`;
}

async function seed() {
  console.log('🌱 Seeding initial records into Cloud Firestore...');
  const db = initFirestore();

  // 1. Settings
  await db.collection('settings').doc('org_name').set({
    value: 'ระบบจองห้องประชุมภายในองค์กร',
    updated_at: new Date().toISOString()
  }, { merge: true });

  await db.collection('settings').doc('admin_pin').set({
    value: hashPin(process.env.ADMIN_PIN || 'P@ssw0rd'),
    updated_at: new Date().toISOString()
  }, { merge: true });
  console.log('✅ Seeded settings (org_name, admin_pin)');

  // 2. Default Rooms
  const rooms = [
    {
      id: 1,
      code: 'ROOM-A',
      name: 'ห้องประชุมใหญ่ A (Boardroom)',
      capacity: 20,
      location: 'ชั้น 2 อาคารหลัก',
      color: '#ff6a00',
      amenities: JSON.stringify(['โปรเจกเตอร์', 'ระบบเสียง', 'Wi-Fi']),
      is_active: 1,
      created_at: new Date().toISOString()
    },
    {
      id: 2,
      code: 'ROOM-B',
      name: 'ห้องประชุมย่อย B (Brainstorm)',
      capacity: 8,
      location: 'ชั้น 2 อาคารหลัก',
      color: '#10b981',
      amenities: JSON.stringify(['ไวท์บอร์ด', 'ทีวี 55 นิ้ว', 'Wi-Fi']),
      is_active: 1,
      created_at: new Date().toISOString()
    },
    {
      id: 3,
      code: 'ROOM-C',
      name: 'ห้องประชุมออนไลน์ C (Video Conf)',
      capacity: 6,
      location: 'ชั้น 1 อาคารหลัก',
      color: '#3b82f6',
      amenities: JSON.stringify(['Webcam 4K', 'Speakerphone', 'Wi-Fi']),
      is_active: 1,
      created_at: new Date().toISOString()
    }
  ];

  for (const r of rooms) {
    await db.collection('rooms').doc(String(r.id)).set(r, { merge: true });
  }
  console.log('✅ Seeded 3 default rooms (ROOM-A, ROOM-B, ROOM-C)');

  // 3. Default Employees
  const employees = [
    {
      id: 1,
      emp_code: 'EMP101',
      name: 'กิตติศักดิ์ พูลสวัสดิ์',
      department: 'ฝ่ายบริหาร & ยุทธศาสตร์',
      position: 'ผู้จัดการ',
      is_active: 1,
      created_at: new Date().toISOString()
    },
    {
      id: 2,
      emp_code: 'EMP102',
      name: 'สมชาย วิจิตรศิลป์',
      department: 'ฝ่ายเทคโนโลยีสารสนเทศ',
      position: 'วิศวกรระบบ',
      is_active: 1,
      created_at: new Date().toISOString()
    }
  ];

  for (const emp of employees) {
    await db.collection('employees').doc(String(emp.id)).set(emp, { merge: true });
  }
  console.log('✅ Seeded 2 default employees (EMP101, EMP102)');

  console.log('\n🎉 Firestore Seeding Complete! Collections are now visible in Firebase Console.');
}

seed()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  });
