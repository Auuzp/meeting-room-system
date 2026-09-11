const http = require('http');

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      ...headers
    };

    const options = {
      hostname: '127.0.0.1',
      port: 3000,
      path: path,
      method: method,
      headers: reqHeaders
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = res.headers['content-type']?.includes('application/json') 
            ? JSON.parse(data) 
            : data;
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Starting Verification for Admin Management (Rooms & Employee Permissions)...\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    const adminPin = '8888';

    // 1. Admin กำหนดห้องประชุมใหม่ (Add Room)
    console.log('--- 1. ทดสอบ Admin กำหนดชื่อห้องประชุม ---');
    const newRoomCode = 'ROOM-TEST-' + Math.floor(Math.random() * 1000);
    const createRoomRes = await request('POST', '/api/rooms', {
      admin_pin: adminPin,
      code: newRoomCode,
      name: 'ห้องสัมมนาใหญ่ Auditorium',
      capacity: 50,
      location: 'ชั้น 5 อาคารนวัตกรรม',
      color: '#e11d48',
      amenities: ['smart_tv', 'projector', 'mic', 'video_conf']
    });
    assert(createRoomRes.status === 201, 'Admin กำหนดห้องประชุมใหม่สำเร็จ (Status: 201)');
    const createdRoomId = createRoomRes.body.id;

    // Admin แก้ไขชื่อห้อง (Edit Room Name)
    const updateRoomRes = await request('PUT', `/api/rooms/${createdRoomId}`, {
      admin_pin: adminPin,
      code: newRoomCode,
      name: 'ห้องสัมมนาใหญ่และแถลงข่าว Grand Auditorium',
      capacity: 60,
      location: 'ชั้น 5 อาคารนวัตกรรม'
    });
    assert(updateRoomRes.status === 200, 'Admin แก้ไขชื่อห้องประชุมสำเร็จ (Status: 200)');

    // 2. Admin กำหนดรายชื่อพนักงานที่มีสิทธิ์ใช้ (Add Allowed Employee)
    console.log('\n--- 2. ทดสอบ Admin กำหนดรายชื่อพนักงานที่มีสิทธิ์ใช้ ---');
    const testEmpCode = 'EMP999';
    const addEmpRes = await request('POST', '/api/admin/employees', {
      admin_pin: adminPin,
      emp_code: testEmpCode,
      name: 'ทดสอบ พนักงานใหม่',
      department: 'ฝ่ายวิจัยและพัฒนา',
      position: 'Researcher'
    });
    assert(addEmpRes.status === 201, `Admin เพิ่มพนักงานที่มีสิทธิ์ใช้ (${testEmpCode}) สำเร็จ (Status: 201)`);
    const newEmpId = addEmpRes.body.id;

    // พนักงานคนใหม่ล็อกอินได้ปกติ
    const loginRes1 = await request('POST', '/api/auth/employee-login', { keyword: testEmpCode });
    assert(loginRes1.status === 200, 'พนักงานใหม่ที่ Admin เพิ่ม เข้าสู่ระบบได้สำเร็จ (Status: 200)');

    // 3. Admin ระงับสิทธิ์พนักงาน (Deactivate / Suspend)
    console.log('\n--- 3. ทดสอบ Admin ระงับสิทธิ์พนักงาน ---');
    const suspendRes = await request('PUT', `/api/admin/employees/${newEmpId}`, {
      admin_pin: adminPin,
      is_active: 0
    });
    assert(suspendRes.status === 200, 'Admin สั่งระงับสิทธิ์พนักงานสำเร็จ (is_active = 0)');

    // พนักงานที่ถูกระงับสิทธิ์ พยายามล็อกอิน
    const loginSuspendedRes = await request('POST', '/api/auth/employee-login', { keyword: testEmpCode });
    assert(loginSuspendedRes.status === 403, '⛔ พนักงานที่ถูกระงับสิทธิ์ ไม่สามารถเข้าใช้งานได้ (Status: 403 Forbidden)');

    // 4. Admin เปิดสิทธิ์คืนให้พนักงาน (Re-activate)
    console.log('\n--- 4. ทดสอบ Admin เปิดสิทธิ์คืนให้พนักงาน ---');
    const activateRes = await request('PUT', `/api/admin/employees/${newEmpId}`, {
      admin_pin: adminPin,
      is_active: 1
    });
    assert(activateRes.status === 200, 'Admin เปิดสิทธิ์การใช้งานคืนให้พนักงานสำเร็จ');

    const loginReactivatedRes = await request('POST', '/api/auth/employee-login', { keyword: testEmpCode });
    assert(loginReactivatedRes.status === 200, 'พนักงานที่เปิดสิทธิ์แล้ว เข้าสู่ระบบได้ตามปกติ');

    // 5. Cleanup: Admin ลบพนักงานและห้องทดสอบ
    console.log('\n--- 5. ทดสอบ Admin ลบพนักงานและห้องประชุม ---');
    const delEmpRes = await request('DELETE', `/api/admin/employees/${newEmpId}`, { admin_pin: adminPin });
    assert(delEmpRes.status === 200, 'Admin ลบพนักงานออกจากระบบสิทธิ์สำเร็จ');

    const delRoomRes = await request('DELETE', `/api/rooms/${createdRoomId}`, { admin_pin: adminPin });
    assert(delRoomRes.status === 200, 'Admin ลบห้องประชุมสำเร็จ');

    console.log('\n=============================================================');
    console.log(`สรุปผลการทดสอบ: ผ่าน ${passed} รายการ | ไม่ผ่าน ${failed} รายการ`);
    console.log('=============================================================\n');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Error running test:', err);
    process.exit(1);
  }
}

runTests();
