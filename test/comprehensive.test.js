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

async function runComprehensiveTests() {
  console.log('=============================================================');
  console.log('   🔍 ตรวจสอบความถูกต้องของทุกฟังก์ชันในระบบ (Comprehensive Audit) ');
  console.log('=============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, detail = '') {
    if (condition) {
      console.log(`  ✅ [PASS] ${testName} ${detail ? '-> ' + detail : ''}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName} ${detail ? '-> ' + detail : ''}`);
      failed++;
    }
  }

  const adminPin = '8888';
  const testDate = '2026-11-20';

  try {
    // -----------------------------------------------------------------
    // 1. ตรวจสอบหน้าเว็บและไฟล์ Static Asset ทั้งหมด
    // -----------------------------------------------------------------
    console.log('--- 1. ตรวจสอบหน้าเว็บและ Static Assets ---');
    const indexRes = await request('GET', '/');
    assert(indexRes.status === 200, 'หน้าหลัก Dashboard (index.html) เปิดได้สมบูรณ์');

    const adminPageRes = await request('GET', '/admin.html');
    assert(adminPageRes.status === 200, 'หน้าผู้ดูแลระบบ (admin.html) เปิดได้สมบูรณ์');

    const kioskPageRes = await request('GET', '/kiosk.html');
    assert(kioskPageRes.status === 200, 'หน้าจอหน้าห้อง (kiosk.html) เปิดได้สมบูรณ์');

    const cssRes = await request('GET', '/css/style.css');
    assert(cssRes.status === 200 && cssRes.body.includes('.modal-overlay'), 'CSS โหลดสมบูรณ์ พร้อม Modal Styling');

    // -----------------------------------------------------------------
    // 2. ตรวจสอบระบบ Network & QR Code
    // -----------------------------------------------------------------
    console.log('\n--- 2. ตรวจสอบ Network Info & QR Code ---');
    const sysRes = await request('GET', '/api/system/info');
    assert(sysRes.status === 200, 'API ข้อมูลระบบทำงานถูกต้อง');
    assert(!!sysRes.body.localIp, 'ตรวจพบ Local IP เครือข่าย Wi-Fi/LAN', sysRes.body.localIp);
    assert(sysRes.body.qrDataUrl?.startsWith('data:image/png;base64,'), 'สร้างภาพ QR Code Base64 สมบูรณ์');

    // -----------------------------------------------------------------
    // 3. ตรวจสอบระบบยืนยันสิทธิ์พนักงาน (Employee Auth)
    // -----------------------------------------------------------------
    console.log('\n--- 3. ตรวจสอบระบบพนักงานบริษัท (Employee Authentication) ---');
    // พนักงานที่มีสิทธิ์
    const empLoginOk = await request('POST', '/api/auth/employee-login', { keyword: 'EMP101' });
    assert(empLoginOk.status === 200, 'พนักงานของบริษัท (EMP101) ยืนยันตัวตนสำเร็จ', empLoginOk.body.employee?.name);

    // ค้นหาด้วยชื่อภาษาไทย
    const empLoginName = await request('POST', '/api/auth/employee-login', { keyword: 'สมชาย' });
    assert(empLoginName.status === 200, 'พนักงานค้นหาด้วยชื่อภาษาไทยสำเร็จ', empLoginName.body.employee?.name);

    // คนที่ไม่มีสิทธิ์ / คนภายนอก
    const empLoginFail = await request('POST', '/api/auth/employee-login', { keyword: 'UNKNOWN_PERSON' });
    assert(empLoginFail.status === 404, 'ปฏิเสธบุคคลภายนอกที่ไม่มีรายชื่อในระบบ');

    // -----------------------------------------------------------------
    // 4. ตรวจสอบระบบห้องประชุมและสถานะสด (Real-time Rooms)
    // -----------------------------------------------------------------
    console.log('\n--- 4. ตรวจสอบระบบห้องประชุมและสถานะสด ---');
    const roomsRes = await request('GET', '/api/rooms');
    assert(roomsRes.status === 200, 'ดึงรายชื่อห้องประชุมที่เซ็ตไว้สำเร็จ', `พบ ${roomsRes.body.length} ห้อง`);
    const roomA = roomsRes.body.find(r => r.name.includes('ห้องประชุม A') || r.code === 'ROOM-A') || roomsRes.body[0];
    assert(typeof roomA.is_busy === 'boolean', 'มีระบบตรวจจับสถานะ is_busy แบบ Real-time');

    // -----------------------------------------------------------------
    // 5. ตรวจสอบการจองห้องประชุม (Booking Creation)
    // -----------------------------------------------------------------
    console.log('\n--- 5. ตรวจสอบการจองห้องประชุม ---');
    const bookPayload1 = {
      room_id: roomA.id,
      emp_code: 'EMP101',
      title: 'ประชุมทดสอบระบบ 1',
      booked_by: 'กิตติศักดิ์ พูลสวัสดิ์',
      department: 'ฝ่ายบริหาร',
      start_at: `${testDate}T13:00:00`,
      end_at: `${testDate}T14:30:00`,
      note: 'ทดสอบจองห้อง A เวลา 13:00 น.',
      pin: '1234'
    };
    const bookRes1 = await request('POST', '/api/bookings', bookPayload1);
    assert(bookRes1.status === 201, 'สร้างรายการจองห้อง A เวลา 13:00 น. สำเร็จ', `ID: ${bookRes1.body.id}`);
    const booking1Id = bookRes1.body.id;

    // -----------------------------------------------------------------
    // 6. ตรวจสอบการป้องกันการจองเวลาซ้ำ (Conflict Detection)
    // -----------------------------------------------------------------
    console.log('\n--- 6. ตรวจสอบการป้องกันการจองซ้ำ (Conflict Detection) ---');
    const duplicatePayload = {
      room_id: roomA.id,
      emp_code: 'EMP102',
      title: 'พยายามจองห้อง A ซ้ำเวลาเดิม',
      booked_by: 'สมชาย วิจิตรศิลป์',
      department: 'ฝ่าย IT',
      start_at: `${testDate}T13:00:00`,
      end_at: `${testDate}T14:00:00`,
      pin: '5678'
    };
    const dupRes = await request('POST', '/api/bookings', duplicatePayload);
    assert(dupRes.status === 409, '⛔ ป้องกันการจองห้องซ้ำในเวลาเดียวกันสำเร็จ (HTTP 409 Conflict)');
    assert(!!dupRes.body.conflict, 'แจ้งเตือนรายละเอียดห้องและเวลาที่ติดจองเดิมชัดเจน');

    // จองห้องอื่นในเวลาเดียวกัน (ต้องทำได้)
    const roomB = roomsRes.body.find(r => r.id !== roomA.id);
    const bookOtherRoom = { ...duplicatePayload, room_id: roomB.id };
    const bookOtherRes = await request('POST', '/api/bookings', bookOtherRoom);
    assert(bookOtherRes.status === 201, 'จองห้องอื่นในเวลาเดียวกันได้ตามปกติ');
    const booking2Id = bookOtherRes.body.id;

    // -----------------------------------------------------------------
    // 7. ตรวจสอบการดูรายการจอง (Read Schedule)
    // -----------------------------------------------------------------
    console.log('\n--- 7. ตรวจสอบการดูรายการจอง (Schedule Table) ---');
    const viewBookings = await request('GET', `/api/bookings?date=${testDate}`);
    assert(viewBookings.status === 200, 'ดึงรายการตารางการจองสำเร็จ');
    assert(viewBookings.body.length >= 2, `แสดงรายการจองถูกต้อง (${viewBookings.body.length} รายการ)`);

    // -----------------------------------------------------------------
    // 8. ตรวจสอบการยกเลิกการจองด้วย PIN (Cancel Booking Security)
    // -----------------------------------------------------------------
    console.log('\n--- 8. ตรวจสอบระบบความปลอดภัยการยกเลิกด้วย PIN ---');
    // ผิด PIN
    const wrongPin = await request('DELETE', `/api/bookings/${booking1Id}`, { pin: '9999' });
    assert(wrongPin.status === 401, 'ปฏิเสธการยกเลิกเมื่อรหัส PIN ไม่ถูกต้อง (HTTP 401)');

    // ถูก PIN
    const rightPin = await request('DELETE', `/api/bookings/${booking1Id}`, { pin: '1234' });
    assert(rightPin.status === 200, 'ยกเลิกการจองสำเร็จเมื่อรหัส PIN ถูกต้อง');

    // -----------------------------------------------------------------
    // 9. ตรวจสอบระบบผู้ดูแลระบบ (Admin Console: Rooms & Employees)
    // -----------------------------------------------------------------
    console.log('\n--- 9. ตรวจสอบระบบผู้ดูแลระบบ (Admin Management) ---');
    // ตรวจสอบ Admin PIN
    const verifyAdminRes = await request('POST', '/api/admin/verify', { pin: adminPin });
    assert(verifyAdminRes.status === 200, 'ยืนยันรหัส Master Admin PIN (8888) สำเร็จ');

    // Admin เพิ่มห้องประชุมใหม่
    const addRoomRes = await request('POST', '/api/rooms', {
      admin_pin: adminPin,
      code: 'ROOM-AUDIT',
      name: 'ห้องประชุมทดสอบระบบ Audit',
      capacity: 15,
      location: 'ชั้น 2',
      amenities: ['smart_tv', 'whiteboard']
    });
    assert(addRoomRes.status === 201, 'Admin กำหนดห้องประชุมใหม่สำเร็จ');
    const auditRoomId = addRoomRes.body.id;

    // Admin แก้ไขห้องประชุม
    const editRoomRes = await request('PUT', `/api/rooms/${auditRoomId}`, {
      admin_pin: adminPin,
      code: 'ROOM-AUDIT-V2',
      name: 'ห้องประชุมทดสอบระบบ Audit (แก้ไขแล้ว)',
      capacity: 18,
      location: 'ชั้น 2'
    });
    assert(editRoomRes.status === 200, 'Admin แก้ไขข้อมูลห้องประชุมสำเร็จ');

    // Admin เพิ่มพนักงานที่มีสิทธิ์
    const addEmpRes = await request('POST', '/api/admin/employees', {
      admin_pin: adminPin,
      emp_code: 'EMP-AUDIT',
      name: 'พนักงานทดสอบ สิทธิ์การใช้งาน',
      department: 'ฝ่ายตรวจสอบระบบ'
    });
    assert(addEmpRes.status === 201, 'Admin เพิ่มพนักงานที่มีสิทธิ์ใช้งานสำเร็จ');
    const auditEmpId = addEmpRes.body.id;

    // Admin ระงับสิทธิ์พนักงาน
    const suspendRes = await request('PUT', `/api/admin/employees/${auditEmpId}`, {
      admin_pin: adminPin,
      is_active: 0
    });
    assert(suspendRes.status === 200, 'Admin สั่งระงับสิทธิ์พนักงานสำเร็จ');

    // พนักงานที่ถูกระงับสิทธิ์ ไม่สามารถเข้าใช้งานได้
    const testSuspendedLogin = await request('POST', '/api/auth/employee-login', { keyword: 'EMP-AUDIT' });
    assert(testSuspendedLogin.status === 403, 'ระบบบล็อกพนักงานที่ถูกระงับสิทธิ์ (HTTP 403)');

    // Admin เปิดสิทธิ์คืน
    const restoreRes = await request('PUT', `/api/admin/employees/${auditEmpId}`, {
      admin_pin: adminPin,
      is_active: 1
    });
    assert(restoreRes.status === 200, 'Admin คืนสิทธิ์การใช้งานพนักงานสำเร็จ');

    // Cleanup Admin test data
    await request('DELETE', `/api/admin/employees/${auditEmpId}`, { admin_pin: adminPin });
    await request('DELETE', `/api/rooms/${auditRoomId}`, { admin_pin: adminPin });
    await request('DELETE', `/api/bookings/${booking2Id}`, { pin: '5678' });

    // -----------------------------------------------------------------
    // 10. ตรวจสอบการจองด่วนหน้าห้อง (Kiosk Quick Book)
    // -----------------------------------------------------------------
    console.log('\n--- 10. ตรวจสอบการจองด่วนผ่านหน้าจอ Kiosk ---');
    const kioskRes = await request('POST', '/api/kiosk/quick-book', {
      room_id: roomA.id,
      minutes: 15,
      booked_by: 'ผู้ใช้งานหน้าห้อง',
      title: 'จองด่วนหน้าห้อง'
    });
    assert(kioskRes.status === 201 || kioskRes.status === 409, 'ฟังก์ชันจองด่วนหน้าจอ Kiosk ทำงานได้ถูกต้อง', `Status: ${kioskRes.status}`);

    // -----------------------------------------------------------------
    // 11. ตรวจสอบการส่งออกข้อมูล Excel / CSV
    // -----------------------------------------------------------------
    console.log('\n--- 11. ตรวจสอบการส่งออกรายงาน Excel/CSV ---');
    const exportRes = await request('GET', '/api/bookings/export');
    assert(exportRes.status === 200, 'ดาวน์โหลดไฟล์รายงานสำเร็จ (HTTP 200)');
    assert(exportRes.headers['content-type']?.includes('text/csv'), 'ประเภทไฟล์เป็น text/csv สำหรับ Excel');
    assert(exportRes.body.includes('รหัสจอง'), 'มีส่วนหัวตารางภาษาไทยสมบูรณ์');

    console.log('\n=============================================================');
    console.log(`🎉 สรุปผลการตรวจสอบ: ผ่าน ${passed} รายการ | ไม่ผ่าน ${failed} รายการ`);
    console.log('=============================================================\n');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Audit Error:', err);
    process.exit(1);
  }
}

runComprehensiveTests();
