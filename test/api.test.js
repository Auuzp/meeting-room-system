const http = require('http');

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    };

    const options = {
      hostname: '127.0.0.1',
      port: 3000,
      path: path,
      method: method,
      headers: headers
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
  console.log('🧪 Starting Verification for Company Meeting Room Booking System...\n');

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
    // -------------------------------------------------------------
    // ข้อ 2: ระบบเซ็ตห้องประชุมไว้ให้แล้ว + User ที่เป็นพนักงานของบริษัทเท่านั้น
    // -------------------------------------------------------------
    console.log('--- [ข้อ 2] ตรวจสอบห้องประชุมที่เซ็ตไว้ และการยืนยันพนักงานของบริษัท ---');
    const roomsRes = await request('GET', '/api/rooms');
    assert(roomsRes.status === 200, 'สามารถดึงรายชื่อห้องประชุมที่ระบบเซ็ตไว้ได้ (Status: 200)');
    assert(roomsRes.body.length >= 4, `มีห้องประชุมที่เซ็ตไว้พร้อมใช้งาน ${roomsRes.body.length} ห้อง`);
    
    // พนักงานยืนยันตัวตนด้วยรหัส EMP101
    const empRes = await request('POST', '/api/auth/employee-login', { keyword: 'EMP101' });
    assert(empRes.status === 200, 'พนักงานของบริษัทสามารถยืนยันตัวตนได้สำเร็จ');
    assert(empRes.body.employee.name === 'กิตติศักดิ์ พูลสวัสดิ์', 'ระบุชื่อพนักงานถูกต้อง: ' + empRes.body.employee.name);

    // คนที่ไม่ใช่พนักงาน ไม่สามารถยืนยันได้
    const fakeEmpRes = await request('POST', '/api/auth/employee-login', { keyword: 'STRANGER_999' });
    assert(fakeEmpRes.status === 404, 'ปฏิเสธบุคคลภายนอกที่ไม่ใช่พนักงานของบริษัท (Status: 404)');

    // -------------------------------------------------------------
    // ข้อ 1 & 3: จองห้องประชุม + วันที่, เวลา, ห้อง, ชื่อผู้จอง
    // *** กรณีที่มีคนจองห้อง A เวลา 13.00 น. แล้ว คนที่เข้ามาจองห้องเดียวกัน และเวลาเดียวกันจะไม่สามารถจองซ้ำได้
    // -------------------------------------------------------------
    console.log('\n--- [ข้อ 1 & 3] การจองห้องประชุม และการป้องกันการจองซ้ำซ้อนระดับเวลาและห้อง ---');
    const roomA = roomsRes.body.find(r => r.name.includes('ห้องประชุม A') || r.code === 'ROOM-A') || roomsRes.body[0];
    const targetDate = '2026-10-15';

    // คนแรก: จองห้อง A วันที่ targetDate เวลา 13:00 - 14:30 น.
    const booking1 = {
      room_id: roomA.id,
      emp_code: 'EMP101',
      title: 'ประชุมสรุปแผนงานประจำเดือน',
      booked_by: 'กิตติศักดิ์ พูลสวัสดิ์',
      department: 'ฝ่ายบริหาร & ยุทธศาสตร์',
      start_at: `${targetDate}T13:00:00`,
      end_at: `${targetDate}T14:30:00`,
      note: 'ใช้ห้องประชุม A เวลา 13.00 น.',
      pin: '1234'
    };

    const book1Res = await request('POST', '/api/bookings', booking1);
    assert(book1Res.status === 201, `คนแรกจองห้อง A เวลา 13:00 น. สำเร็จ (ID: ${book1Res.body.id})`);

    // คนที่สอง: พยายามจองห้อง A วันเดียวกัน และเวลา 13:00 น. ซ้ำ!
    const duplicateBooking = {
      room_id: roomA.id,
      emp_code: 'EMP102',
      title: 'ประชุมด่วนทีมพัฒนา',
      booked_by: 'สมชาย วิจิตรศิลป์',
      department: 'ฝ่าย IT',
      start_at: `${targetDate}T13:00:00`, // เวลาเดียวกันเป๊ะ!
      end_at: `${targetDate}T14:00:00`,
      pin: '5678'
    };

    const duplicateRes = await request('POST', '/api/bookings', duplicateBooking);
    assert(duplicateRes.status === 409, '⛔ คนที่สองจองห้อง A เวลา 13:00 น. ซ้ำ ไม่สามารถจองได้ (Status: 409 Conflict)');
    assert(!!duplicateRes.body.conflict, 'ระบบแจ้งเตือนชัดเจนว่าชนกับใครและช่วงเวลาใด: ' + duplicateRes.body.conflict?.time_range);

    // คนที่สาม: จองห้อง B (คนละห้อง) เวลา 13:00 น. (ห้องอื่นในเวลาเดียวกัน ต้องจองได้)
    const roomB = roomsRes.body.find(r => r.id !== roomA.id);
    const otherRoomBooking = {
      ...duplicateBooking,
      room_id: roomB.id
    };
    const otherRoomRes = await request('POST', '/api/bookings', otherRoomBooking);
    assert(otherRoomRes.status === 201, `จองห้องอื่น (ห้อง B) เวลา 13:00 น. ได้ตามปกติ (Status: 201)`);

    // -------------------------------------------------------------
    // ข้อ 4: User สามารถดูได้ว่ามีใครจองห้องไหน วันไหน กี่โมงบ้าง
    // -------------------------------------------------------------
    console.log('\n--- [ข้อ 4] ตรวจสอบว่า User สามารถดูได้ว่ามีใครจองห้องไหน วันไหน กี่โมงบ้าง ---');
    const getBookingsRes = await request('GET', `/api/bookings?date=${targetDate}`);
    assert(getBookingsRes.status === 200, 'ดึงรายการการจองห้องประชุมสำเร็จ (Status: 200)');
    assert(getBookingsRes.body.length >= 2, `พบรายการจองในวันที่ ${targetDate} จำนวน ${getBookingsRes.body.length} รายการ`);

    const sample = getBookingsRes.body[0];
    assert(!!sample.start_at && !!sample.end_at, `มีข้อมูลเวลาที่จอง: ${sample.start_at.slice(11,16)} - ${sample.end_at.slice(11,16)} น.`);
    assert(!!sample.room_name, `มีข้อมูลห้องประชุม: ${sample.room_name}`);
    assert(!!sample.booked_by, `มีข้อมูลใครเป็นคนจอง: ${sample.booked_by} (${sample.department})`);
    assert(!!sample.title, `มีข้อมูลหัวข้อการประชุม: ${sample.title}`);

    console.log('\n=============================================================');
    console.log(`สรุปผลการทดสอบ: ผ่าน ${passed} รายการ | ไม่ผ่าน ${failed} รายการ`);
    console.log('=============================================================\n');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('เกิดข้อผิดพลาดในการรันชุดทดสอบ:', err);
    process.exit(1);
  }
}

runTests();
