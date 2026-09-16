const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 1. Configure isolated temporary test database and environment variables
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-test-'));
const tempDbPath = path.join(tempDir, 'test_meeting_rooms.db');

process.env.DB_PATH = tempDbPath;
process.env.ADMIN_PIN = 'admin_super_secret_pin';
process.env.KIOSK_SECRET = 'kiosk_super_secret_token';
process.env.PORT = '0'; // Ephemeral port

// 2. Import server (Database and routes initialize using tempDbPath)
const { app, db, resetAdminAuthRateLimit } = require('../server');

// Baseline SHA256 of production database data/meeting_rooms.db
const BASELINE_PROD_DB_HASH = '52A371445CE0812CA930AEA418E7D7E9D6459F1778A6E14CB56592F08F5A08AF';
const PROD_DB_PATH = path.join(__dirname, '..', 'data', 'meeting_rooms.db');

let server;
let serverPort;

function request(method, reqPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      ...headers
    };

    const options = {
      hostname: '127.0.0.1',
      port: serverPort,
      path: reqPath,
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
  console.log('================================================================');
  console.log('   🧪 Running Security, Integrity & Authorization Test Suite');
  console.log('   Isolated Test DB:', tempDbPath);
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message, detail = '') {
    if (condition) {
      console.log(`  ✅ [PASS] ${message} ${detail ? '(' + detail + ')' : ''}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${message} ${detail ? '(' + detail + ')' : ''}`);
      failed++;
    }
  }

  // Seed test database
  db.exec(`
    INSERT INTO rooms (code, name, capacity, location, color, amenities, is_active)
    VALUES 
      ('ROOM-A', 'ห้องประชุม A (Smart Board)', 12, 'ชั้น 2 อาคาร A', '#ff6a00', '["tv","wifi"]', 1),
      ('ROOM-B', 'ห้องประชุม B (Boardroom)', 20, 'ชั้น 3 อาคาร A', '#2563eb', '["projector","mic"]', 1),
      ('ROOM-OFF', 'ห้องปิดปรับปรุง (Inactive)', 6, 'ชั้น 1 อาคาร B', '#64748b', '[]', 0);

    INSERT INTO employees (emp_code, name, department, position, is_active)
    VALUES
      ('EMP101', 'กิตติศักดิ์ พูลสวัสดิ์', 'ฝ่ายบริหาร & ยุทธศาสตร์', 'Lead Engineer', 1),
      ('EMP102', 'สมชาย วิจิตรศิลป์', 'ฝ่าย IT', 'Developer', 1),
      ('EMP999', 'พนักงานถูกระงับสิทธิ์', 'ฝ่ายบุคคล', 'Staff', 0);

    INSERT INTO settings (key, value) VALUES ('line_enabled', '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    INSERT INTO settings (key, value) VALUES ('line_token', 'SECURE_LINE_SECRET_TOKEN_12345')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    INSERT INTO settings (key, value) VALUES ('line_dest_id', 'DEST_LINE_GROUP_001')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);

  // Start HTTP server on ephemeral port
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    });
  });

  try {
    const adminPin = 'admin_super_secret_pin';
    const kioskSecret = 'kiosk_super_secret_token';

    // -----------------------------------------------------------------
    // 1. Employee Authentication & Access Control
    // -----------------------------------------------------------------
    console.log('--- 1. Employee Authentication & Access Control ---');
    const loginActive = await request('POST', '/api/auth/employee-login', { keyword: 'EMP101' });
    assert(loginActive.status === 200, 'Active employee (EMP101) can log in', loginActive.body.employee?.name);

    const loginByName = await request('POST', '/api/auth/employee-login', { keyword: 'สมชาย' });
    assert(loginByName.status === 200, 'Employee can log in by name search', loginByName.body.employee?.name);

    const loginSuspended = await request('POST', '/api/auth/employee-login', { keyword: 'EMP999' });
    assert(loginSuspended.status === 403, 'Suspended employee (is_active=0) is denied (403)');

    const loginUnknown = await request('POST', '/api/auth/employee-login', { keyword: 'UNKNOWN_999' });
    assert(loginUnknown.status === 404, 'Nonexistent employee is rejected (404)');

    const loginEmpty = await request('POST', '/api/auth/employee-login', { keyword: '   ' });
    assert(loginEmpty.status === 400, 'Empty keyword rejected (400)');

    // -----------------------------------------------------------------
    // 2. Booking Data Integrity & Anti-Spoofing
    // -----------------------------------------------------------------
    console.log('\n--- 2. Booking Data Integrity & Anti-Spoofing ---');
    const roomA = db.prepare("SELECT * FROM rooms WHERE code = 'ROOM-A'").get();
    const roomOff = db.prepare("SELECT * FROM rooms WHERE code = 'ROOM-OFF'").get();

    // Missing emp_code
    const noEmpRes = await request('POST', '/api/bookings', {
      room_id: roomA.id,
      title: 'ประชุมลับ',
      start_at: '2026-11-10T09:00:00',
      end_at: '2026-11-10T10:00:00'
    });
    assert(noEmpRes.status === 400, 'Booking without emp_code rejected (400)');

    // Suspended emp_code
    const suspendedBooking = await request('POST', '/api/bookings', {
      room_id: roomA.id,
      emp_code: 'EMP999',
      title: 'ประชุมของผู้ถูกระงับสิทธิ์',
      start_at: '2026-11-10T09:00:00',
      end_at: '2026-11-10T10:00:00'
    });
    assert(suspendedBooking.status === 403, 'Booking with suspended employee rejected (403)');

    // Inactive room
    const inactiveRoomBooking = await request('POST', '/api/bookings', {
      room_id: roomOff.id,
      emp_code: 'EMP101',
      title: 'ประชุมห้องปิดปรับปรุง',
      start_at: '2026-11-10T09:00:00',
      end_at: '2026-11-10T10:00:00'
    });
    assert(inactiveRoomBooking.status === 400, 'Booking in inactive room rejected (400)');

    // Spoofing attempt: client supplies fake booked_by and department
    const spoofBooking = await request('POST', '/api/bookings', {
      room_id: roomA.id,
      emp_code: 'EMP101',
      booked_by: 'แฮกเกอร์ ปลอมแปลงชื่อ',
      department: 'แผนกปลอม',
      title: 'ประชุมทดสอบความถูกต้องของข้อมูล',
      start_at: '2026-11-10T09:00:00',
      end_at: '2026-11-10T10:00:00'
    });
    assert(spoofBooking.status === 201, 'Booking created successfully (201)');

    const createdBooking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(spoofBooking.body.id);
    assert(createdBooking.booked_by === 'กิตติศักดิ์ พูลสวัสดิ์', 'Server overrides client booked_by with verified DB name', createdBooking.booked_by);
    assert(createdBooking.department === 'ฝ่ายบริหาร & ยุทธศาสตร์', 'Server overrides client department with verified DB department', createdBooking.department);

    // -----------------------------------------------------------------
    // 3. Strict Date & Calendar Validation (No JS Rollover)
    // -----------------------------------------------------------------
    console.log('\n--- 3. Strict Date & Calendar Validation ---');
    // Feb 31 does not exist
    const feb31Booking = await request('POST', '/api/bookings', {
      room_id: roomA.id,
      emp_code: 'EMP101',
      title: 'ประชุมวันที่ 31 ก.พ.',
      start_at: '2026-02-31T10:00:00',
      end_at: '2026-02-31T11:00:00'
    });
    assert(feb31Booking.status === 400, 'Rejects nonexistent calendar date 2026-02-31 (400)');

    // Apr 31 does not exist (April has 30 days)
    const apr31Booking = await request('POST', '/api/bookings', {
      room_id: roomA.id,
      emp_code: 'EMP101',
      title: 'ประชุมวันที่ 31 เม.ย.',
      start_at: '2026-04-31T10:00:00',
      end_at: '2026-04-31T11:00:00'
    });
    assert(apr31Booking.status === 400, 'Rejects nonexistent calendar date 2026-04-31 (400)');

    // Feb 29 on non-leap year (2026 is not a leap year)
    const feb29NonLeap = await request('POST', '/api/bookings', {
      room_id: roomA.id,
      emp_code: 'EMP101',
      title: 'ประชุม 29 ก.พ. ปีไม่ก้าวกระโดด',
      start_at: '2026-02-29T10:00:00',
      end_at: '2026-02-29T11:00:00'
    });
    assert(feb29NonLeap.status === 400, 'Rejects 2026-02-29 non-leap year date (400)');

    // Start time >= End time
    const invalidOrderBooking = await request('POST', '/api/bookings', {
      room_id: roomA.id,
      emp_code: 'EMP101',
      title: 'เวลาเริ่มหลังเวลาสิ้นสุด',
      start_at: '2026-11-10T15:00:00',
      end_at: '2026-11-10T14:00:00'
    });
    assert(invalidOrderBooking.status === 400, 'Rejects start_at >= end_at (400)');

    // Malformed date
    const malformedBooking = await request('POST', '/api/bookings', {
      room_id: roomA.id,
      emp_code: 'EMP101',
      title: 'วันที่เพี้ยน',
      start_at: 'invalid-date',
      end_at: '2026-11-10T14:00:00'
    });
    assert(malformedBooking.status === 400, 'Rejects malformed ISO date string (400)');

    // -----------------------------------------------------------------
    // 4. PIN Security, Hashing & Authorization
    // -----------------------------------------------------------------
    console.log('\n--- 4. PIN Security, Hashing & Authorization ---');
    // Booking without custom PIN gets secure auto-generated 4-digit PIN
    const autoPinBooking = await request('POST', '/api/bookings', {
      room_id: roomA.id,
      emp_code: 'EMP101',
      title: 'ประชุม PIN สุ่มอัตโนมัติ',
      start_at: '2026-11-10T10:30:00',
      end_at: '2026-11-10T11:30:00'
    });
    assert(autoPinBooking.status === 201, 'Booking created with auto PIN (201)');
    const returnedPin = autoPinBooking.body.pin;
    assert(/^\d{4}$/.test(returnedPin), 'Generated PIN is a 4-digit numeric string', returnedPin);

    // Verify DB does not store plaintext PIN
    const autoPinDbRow = db.prepare("SELECT pin FROM bookings WHERE id = ?").get(autoPinBooking.body.id);
    assert(autoPinDbRow.pin.startsWith('$scrypt$'), 'PIN is stored as scrypt hash in database, not plaintext');
    assert(!autoPinDbRow.pin.includes(returnedPin), 'Plaintext PIN is not present in stored hash string');

    // Reject PIN in query string for cancel
    const cancelQueryRes = await request('DELETE', `/api/bookings/${autoPinBooking.body.id}?pin=${returnedPin}`);
    assert(cancelQueryRes.status === 400, 'Rejects PIN in query string for cancellation (400)');

    // Reject wrong PIN for cancel
    const cancelWrongPin = await request('DELETE', `/api/bookings/${autoPinBooking.body.id}`, { pin: '0000' });
    assert(cancelWrongPin.status === 401, 'Rejects invalid booking PIN for cancellation (401)');

    // Edit booking with valid PIN
    const editRes = await request('PUT', `/api/bookings/${autoPinBooking.body.id}`, {
      pin: returnedPin,
      title: 'ประชุม PIN สุ่มอัตโนมัติ (แก้ไขหัวข้อแล้ว)'
    });
    assert(editRes.status === 200, 'Successfully edits booking using valid booking PIN');

    // Reject PIN in query string for edit
    const editQueryRes = await request('PUT', `/api/bookings/${autoPinBooking.body.id}?pin=${returnedPin}`, {
      title: 'พยายามส่ง PIN ผ่าน query'
    });
    assert(editQueryRes.status === 400, 'Rejects PIN in query string for edit (400)');

    // Cancel booking with valid PIN
    const cancelOkRes = await request('DELETE', `/api/bookings/${autoPinBooking.body.id}`, { pin: returnedPin });
    assert(cancelOkRes.status === 200, 'Successfully cancels booking using valid booking PIN');

    const cancelledRow = db.prepare("SELECT status FROM bookings WHERE id = ?").get(autoPinBooking.body.id);
    assert(cancelledRow.status === 'cancelled', 'Booking status transitioned to cancelled in DB');

    // -----------------------------------------------------------------
    // 5. Booking Conflict Detection & Concurrency (Transactions)
    // -----------------------------------------------------------------
    console.log('\n--- 5. Booking Conflict Detection & Concurrency ---');
    // Base booking on Room B: 13:00 - 15:00
    const baseBooking = await request('POST', '/api/bookings', {
      room_id: 2, // Room B
      emp_code: 'EMP102',
      title: 'ประชุมประจำสัปดาห์ Room B',
      start_at: '2026-11-15T13:00:00',
      end_at: '2026-11-15T15:00:00'
    });
    assert(baseBooking.status === 201, 'Base booking on Room B created (13:00-15:00)');

    // Overlapping booking: 13:30 - 14:30
    const conflictBooking = await request('POST', '/api/bookings', {
      room_id: 2,
      emp_code: 'EMP101',
      title: 'ประชุมชนเวลา',
      start_at: '2026-11-15T13:30:00',
      end_at: '2026-11-15T14:30:00'
    });
    assert(conflictBooking.status === 409, 'Overlapping booking is rejected with 409 Conflict');

    // Adjacent booking before: 11:30 - 13:00 (Allowed)
    const adjacentBefore = await request('POST', '/api/bookings', {
      room_id: 2,
      emp_code: 'EMP101',
      title: 'ประชุมติดกันช่วงหน้า',
      start_at: '2026-11-15T11:30:00',
      end_at: '2026-11-15T13:00:00'
    });
    assert(adjacentBefore.status === 201, 'Adjacent booking ending exactly at start time is permitted (201)');

    // Adjacent booking after: 15:00 - 16:30 (Allowed)
    const adjacentAfter = await request('POST', '/api/bookings', {
      room_id: 2,
      emp_code: 'EMP101',
      title: 'ประชุมติดกันช่วงหลัง',
      start_at: '2026-11-15T15:00:00',
      end_at: '2026-11-15T16:30:00'
    });
    assert(adjacentAfter.status === 201, 'Adjacent booking starting exactly at end time is permitted (201)');

    // 5 Concurrent overlapping requests for the same room & time slot
    console.log('  Testing 5 concurrent overlapping bookings (BEGIN IMMEDIATE transaction safety)...');
    const concurrentTimeStart = '2026-11-16T10:00:00';
    const concurrentTimeEnd = '2026-11-16T11:00:00';

    const concurrentRequests = Array.from({ length: 5 }, (_, i) => 
      request('POST', '/api/bookings', {
        room_id: 2,
        emp_code: 'EMP101',
        title: `การจองชนกันพร้อมกัน #${i + 1}`,
        start_at: concurrentTimeStart,
        end_at: concurrentTimeEnd
      })
    );

    const concurrentResults = await Promise.all(concurrentRequests);
    const successCount = concurrentResults.filter(r => r.status === 201).length;
    const conflictCount = concurrentResults.filter(r => r.status === 409).length;

    assert(successCount === 1, `Exactly 1 concurrent booking succeeded (actual: ${successCount})`);
    assert(conflictCount === 4, `Remaining 4 concurrent bookings received 409 Conflict (actual: ${conflictCount})`);

    // -----------------------------------------------------------------
    // 6. Admin Authorization & Rate Limiting
    // -----------------------------------------------------------------
    console.log('\n--- 6. Admin Authorization & Rate Limiting ---');
    // Reject access without admin credentials
    const noAuthAdmin = await request('GET', '/api/admin/employees');
    assert(noAuthAdmin.status === 401, 'Denies GET /api/admin/employees without credentials (401)');

    const noAuthRoom = await request('POST', '/api/rooms', { name: 'ห้องลับ' });
    assert(noAuthRoom.status === 401, 'Denies POST /api/rooms without credentials (401)');

    // Reject admin credentials in query string
    const queryAdmin = await request('GET', `/api/admin/employees?admin_pin=${adminPin}`);
    assert(queryAdmin.status === 400, 'Rejects admin PIN sent via query string (400)');

    // Allow admin credentials via x-admin-pin header
    const validHeaderAdmin = await request('GET', '/api/admin/employees', null, { 'x-admin-pin': adminPin });
    assert(validHeaderAdmin.status === 200, 'Allows admin access with valid X-Admin-Pin header (200)');

    // Allow admin credentials via Authorization Bearer
    const validBearerAdmin = await request('GET', '/api/admin/employees', null, { 'Authorization': `Bearer ${adminPin}` });
    assert(validBearerAdmin.status === 200, 'Allows admin access with Authorization: Bearer <pin> header (200)');

    // Admin Room CRUD
    const addRoomRes = await request('POST', '/api/rooms', {
      name: 'ห้องทดสอบแอดมินใหม่',
      code: 'ROOM-ADMIN-1',
      capacity: 8,
      location: 'ชั้น 4'
    }, { 'x-admin-pin': adminPin });
    assert(addRoomRes.status === 201, 'Admin can create room via header auth (201)');
    const newRoomId = addRoomRes.body.id;

    const editRoomRes = await request('PUT', `/api/rooms/${newRoomId}`, {
      name: 'ห้องทดสอบแอดมินใหม่ (แก้ไขแล้ว)',
      capacity: 12
    }, { 'x-admin-pin': adminPin });
    assert(editRoomRes.status === 200, 'Admin can edit room via header auth (200)');

    const deleteRoomRes = await request('DELETE', `/api/rooms/${newRoomId}`, null, { 'x-admin-pin': adminPin });
    assert(deleteRoomRes.status === 200, 'Admin can delete room via header auth (200)');

    // Admin Rate Limiting on failed PIN attempts
    console.log('  Testing admin rate limiting on consecutive failed auth...');
    let rateLimited = false;
    let retryAfterHeader = null;
    for (let i = 0; i < 7; i++) {
      const failAttempt = await request('POST', '/api/admin/verify', { pin: 'WRONG_PIN_' + i });
      if (failAttempt.status === 429) {
        rateLimited = true;
        retryAfterHeader = failAttempt.headers['retry-after'];
        break;
      }
    }
    assert(rateLimited, 'Triggers HTTP 429 Too Many Requests after repeated failed PIN attempts');
    assert(!!retryAfterHeader && Number(retryAfterHeader) > 0, 'Includes valid Retry-After header on 429', retryAfterHeader);

    // Reset rate limiter for test runner IP so subsequent admin tests proceed
    resetAdminAuthRateLimit('127.0.0.1');
    resetAdminAuthRateLimit('::ffff:127.0.0.1');
    resetAdminAuthRateLimit('::1');

    // -----------------------------------------------------------------
    // 7. LINE Notification Secret Protection
    // -----------------------------------------------------------------
    console.log('\n--- 7. LINE Notification Secret Protection ---');
    const lineGetRes = await request('GET', '/api/admin/settings/line', null, { 'x-admin-pin': adminPin });
    assert(lineGetRes.status === 200, 'Admin can read LINE settings (200)');
    assert(lineGetRes.body.hasToken === true, 'Settings response reports hasToken: true');
    assert(lineGetRes.body.token.includes('***'), 'LINE token is masked with asterisks (***), not plaintext', lineGetRes.body.token);
    assert(!lineGetRes.body.token.includes('SECURE_LINE_SECRET_TOKEN_12345'), 'Raw LINE token is not leaked in response');

    // Updating settings without changing token retains existing token
    const lineUpdateRes = await request('POST', '/api/admin/settings/line', {
      enabled: true,
      type: 'messaging_api',
      destinationId: 'DEST_LINE_GROUP_UPDATED',
      token: lineGetRes.body.token // Send back the masked token
    }, { 'x-admin-pin': adminPin });
    assert(lineUpdateRes.status === 200, 'Settings updated successfully');

    const lineDbRow = db.prepare("SELECT value FROM settings WHERE key = 'line_token'").get();
    assert(lineDbRow.value === 'SECURE_LINE_SECRET_TOKEN_12345', 'Existing token in DB is safely preserved');

    // -----------------------------------------------------------------
    // 8. Kiosk Endpoint & Quick-Book Security
    // -----------------------------------------------------------------
    console.log('\n--- 8. Kiosk Endpoint & Quick-Book Security ---');
    // Missing secret
    const kioskNoAuth = await request('POST', '/api/kiosk/quick-book', {
      room_id: roomA.id,
      minutes: 15
    });
    assert(kioskNoAuth.status === 401, 'Denies Kiosk quick-book without secret header (401)');

    // Invalid secret
    const kioskWrongAuth = await request('POST', '/api/kiosk/quick-book', {
      room_id: roomA.id,
      minutes: 15
    }, { 'x-kiosk-secret': 'wrong_secret' });
    assert(kioskWrongAuth.status === 401, 'Denies Kiosk quick-book with incorrect secret (401)');

    // Secret via query string rejected
    const kioskQueryAuth = await request('POST', `/api/kiosk/quick-book?kiosk_secret=${kioskSecret}`, {
      room_id: roomA.id,
      minutes: 15
    });
    assert(kioskQueryAuth.status === 400, 'Rejects Kiosk secret sent via query string (400)');

    // Disallowed duration (e.g. 20 minutes)
    const kioskInvalidDuration = await request('POST', '/api/kiosk/quick-book', {
      room_id: roomA.id,
      minutes: 20
    }, { 'x-kiosk-secret': kioskSecret });
    assert(kioskInvalidDuration.status === 400, 'Rejects non-whitelisted duration (e.g., 20 mins) (400)');

    // Quick-book on inactive room
    const kioskInactiveRoom = await request('POST', '/api/kiosk/quick-book', {
      room_id: roomOff.id,
      minutes: 15
    }, { 'x-kiosk-secret': kioskSecret });
    assert(kioskInactiveRoom.status === 400, 'Rejects quick-book on inactive room (400)');

    // Valid quick-book with secret
    const kioskOkRes = await request('POST', '/api/kiosk/quick-book', {
      room_id: roomA.id,
      minutes: 30
    }, { 'x-kiosk-secret': kioskSecret });
    assert(kioskOkRes.status === 201, 'Kiosk quick-book succeeded with valid secret (201)');
    assert(kioskOkRes.body.pin !== '9999', 'Kiosk generates random secure PIN, not hardcoded 9999', kioskOkRes.body.pin);

    const kioskDbRow = db.prepare("SELECT pin FROM bookings WHERE id = ?").get(kioskOkRes.body.id);
    assert(kioskDbRow.pin.startsWith('$scrypt$'), 'Kiosk booking PIN is stored as scrypt hash in database');

    // -----------------------------------------------------------------
    // 9. Static Assets & System Info
    // -----------------------------------------------------------------
    console.log('\n--- 9. Static Assets & System Info ---');
    const staticIndex = await request('GET', '/');
    assert(staticIndex.status === 200, 'GET / returns 200 OK');

    const staticAdmin = await request('GET', '/admin.html');
    assert(staticAdmin.status === 200, 'GET /admin.html returns 200 OK');

    const staticKiosk = await request('GET', '/kiosk.html');
    assert(staticKiosk.status === 200, 'GET /kiosk.html returns 200 OK');

    const sysInfo = await request('GET', '/api/system/info');
    assert(sysInfo.status === 200, 'GET /api/system/info returns 200 OK');
    assert(!JSON.stringify(sysInfo.body).includes('admin_super_secret_pin'), 'System info does not leak admin secrets');
    assert(!JSON.stringify(sysInfo.body).includes('kiosk_super_secret_token'), 'System info does not leak kiosk secrets');

    // -----------------------------------------------------------------
    // 10. Verification of Production Database Pristineness
    // -----------------------------------------------------------------
    console.log('\n--- 10. Verification of Production Database Pristineness ---');
    const prodDbBuffer = fs.readFileSync(PROD_DB_PATH);
    const prodDbHash = crypto.createHash('sha256').update(prodDbBuffer).digest('hex').toUpperCase();

    assert(prodDbHash === BASELINE_PROD_DB_HASH, 'Production database data/meeting_rooms.db remained 100% UNTOUCHED', prodDbHash);

    console.log('\n================================================================');
    console.log(`🏁 Total Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
    console.log('================================================================\n');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Fatal test error:', err);
    process.exit(1);
  } finally {
    if (server) {
      server.close();
    }
    // Cleanup temporary test database files
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (_) {}
  }
}

runTests();
