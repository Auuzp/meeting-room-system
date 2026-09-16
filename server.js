const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'meeting_rooms.db');

app.use(cors());
app.use(express.json());

// Prevent stale caching on all API requests
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite Database
const db = new DatabaseSync(DB_PATH);

// Setup Tables & Migrations
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emp_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    position TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    name TEXT NOT NULL,
    capacity INTEGER DEFAULT 10,
    location TEXT,
    color TEXT DEFAULT '#ff6a00',
    amenities TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    emp_code TEXT,
    title TEXT NOT NULL,
    booked_by TEXT NOT NULL,
    department TEXT,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    note TEXT,
    pin TEXT DEFAULT '0000',
    status TEXT DEFAULT 'confirmed',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(room_id) REFERENCES rooms(id)
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_time ON bookings(room_id, start_at, end_at, status);
  CREATE INDEX IF NOT EXISTS idx_emp_code ON employees(emp_code);
`);

// Migration: Ensure is_active column exists in employees table
try {
  db.exec(`ALTER TABLE employees ADD COLUMN is_active INTEGER DEFAULT 1;`);
} catch (e) {
  // Column already exists, ignore
}

// Initialize Default Settings
const adminPinRow = db.prepare("SELECT value FROM settings WHERE key = 'admin_pin'").get();
if (!adminPinRow) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('admin_pin', '8888')").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('org_name', 'ระบบจองห้องประชุมภายในองค์กร')").run();
}

// Helper: Check Admin PIN
function checkAdminPin(pin) {
  const systemAdminPin = db.prepare("SELECT value FROM settings WHERE key = 'admin_pin'").get()?.value || '8888';
  return pin === systemAdminPin;
}

// Utility: Get Local IPv4 Address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

// Helper: Check Overlap Conflict
function findConflict(roomId, startAt, endAt, excludeBookingId = null) {
  let query = `
    SELECT b.*, r.name as room_name 
    FROM bookings b
    JOIN rooms r ON b.room_id = r.id
    WHERE b.room_id = ?
      AND b.status = 'confirmed'
      AND (? < b.end_at AND ? > b.start_at)
  `;
  const params = [roomId, startAt, endAt];

  if (excludeBookingId) {
    query += " AND b.id != ?";
    params.push(excludeBookingId);
  }

  query += " LIMIT 1";
  return db.prepare(query).get(...params);
}

function getNowIso() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}:${s}`;
}

// ----------------------------------------------------
// LINE Notification Helper
// ----------------------------------------------------
function getLineSettings() {
  const enabled = db.prepare("SELECT value FROM settings WHERE key = 'line_enabled'").get()?.value === '1';
  const type = db.prepare("SELECT value FROM settings WHERE key = 'line_type'").get()?.value || 'messaging_api';
  const token = db.prepare("SELECT value FROM settings WHERE key = 'line_token'").get()?.value || '';
  const destinationId = db.prepare("SELECT value FROM settings WHERE key = 'line_dest_id'").get()?.value || '';
  return { enabled, type, token, destinationId };
}

function formatBookingThaiDate(iso) {
  if (!iso) return '-';
  const parts = iso.slice(0, 10).split('-');
  if (parts.length < 3) return iso;
  const y = parseInt(parts[0], 10) + 543;
  const mList = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const m = mList[parseInt(parts[1], 10)] || parts[1];
  const d = parseInt(parts[2], 10);
  return `${d} ${m} ${y}`;
}

async function sendLineNotification(messageText) {
  try {
    const { enabled, type, token, destinationId } = getLineSettings();
    if (!enabled || !token) {
      return { success: false, reason: 'ไม่ได้เปิดใช้งาน LINE หรือยังไม่ได้ระบุ Token' };
    }

    if (type === 'messaging_api') {
      if (!destinationId) {
        return { success: false, reason: 'LINE Messaging API จำเป็นต้องระบุ Destination ID (User ID / Group ID)' };
      }
      const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          to: destinationId,
          messages: [{ type: 'text', text: messageText }]
        })
      });
      const data = await res.json().catch(() => ({}));
      return { success: res.ok, status: res.status, data };
    } else if (type === 'line_notify') {
      const res = await fetch('https://notify-api.line.me/api/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Bearer ${token}`
        },
        body: new URLSearchParams({ message: '\n' + messageText }).toString()
      });
      const data = await res.json().catch(() => ({}));
      return { success: res.ok, status: res.status, data };
    }
    return { success: false, reason: 'ไม่รองรับประเภท LINE นี้' };
  } catch (err) {
    console.error('[LINE Error]:', err.message);
    return { success: false, error: err.message };
  }
}

// ----------------------------------------------------
// REST API Endpoints
// ----------------------------------------------------

// 1. System Info & QR Code
app.get('/api/system/info', async (req, res) => {
  try {
    const localIp = getLocalIp();
    const networkUrl = `http://${localIp}:${PORT}`;
    const qrDataUrl = await QRCode.toDataURL(networkUrl, {
      margin: 2,
      width: 260,
      color: { dark: '#111827', light: '#ffffff' }
    });

    const orgName = db.prepare("SELECT value FROM settings WHERE key = 'org_name'").get()?.value || 'ระบบจองห้องประชุมภายในองค์กร';

    res.json({
      localIp,
      port: PORT,
      networkUrl,
      qrDataUrl,
      orgName
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Admin PIN Verification
app.post('/api/admin/verify', (req, res) => {
  const { pin } = req.body;
  if (checkAdminPin(pin)) {
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, message: 'รหัส Admin PIN ไม่ถูกต้อง' });
});

// ----------------------------------------------------
// ADMIN: กำหนดรายชื่อพนักงานที่มีสิทธิ์ใช้ (Allowed Employees)
// ----------------------------------------------------

// ดึงรายชื่อพนักงานทั้งหมด (สำหรับ Admin)
app.get('/api/admin/employees', (req, res) => {
  try {
    const adminPin = req.headers['x-admin-pin'] || req.query.admin_pin;
    if (!checkAdminPin(adminPin)) {
      return res.status(401).json({ message: 'ต้องการสิทธิ์ผู้ดูแลระบบ (Admin PIN ไม่ถูกต้อง)' });
    }

    const employees = db.prepare("SELECT * FROM employees ORDER BY id DESC").all();
    res.json(employees);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin เพิ่มพนักงานใหม่ที่มีสิทธิ์ใช้
app.post('/api/admin/employees', (req, res) => {
  try {
    const { admin_pin, emp_code, name, department, position } = req.body;
    if (!checkAdminPin(admin_pin)) {
      return res.status(401).json({ message: 'รหัส Admin PIN ไม่ถูกต้อง' });
    }

    if (!emp_code || !emp_code.trim()) {
      return res.status(400).json({ message: 'กรุณาระบุรหัสพนักงาน' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'กรุณาระบุชื่อ-นามสกุลพนักงาน' });
    }

    const code = emp_code.trim().toUpperCase();

    // Check duplicate emp_code
    const existing = db.prepare("SELECT id FROM employees WHERE UPPER(emp_code) = ?").get(code);
    if (existing) {
      return res.status(409).json({ message: `รหัสพนักงาน "${code}" มีอยู่ในระบบแล้ว` });
    }

    const stmt = db.prepare(`
      INSERT INTO employees (emp_code, name, department, position, is_active)
      VALUES (?, ?, ?, ?, 1)
    `);
    const result = stmt.run(code, name.trim(), (department || '').trim(), (position || '').trim());

    res.status(201).json({ success: true, id: result.lastInsertRowid, message: 'เพิ่มพนักงานที่มีสิทธิ์ใช้งานเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin แก้ไขข้อมูลพนักงาน หรือเปิด/ปิดสิทธิ์การใช้งาน (is_active: 0 หรือ 1)
// Admin แก้ไขข้อมูลพนักงาน หรือเปิด/ปิดสิทธิ์การใช้งาน (is_active: 0 หรือ 1)
app.put('/api/admin/employees/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { admin_pin, emp_code, name, department, position, is_active } = req.body;
    if (!checkAdminPin(admin_pin)) {
      return res.status(401).json({ message: 'รหัส Admin PIN ไม่ถูกต้อง' });
    }

    const targetEmp = db.prepare("SELECT * FROM employees WHERE id = ?").get(id);
    if (!targetEmp) {
      return res.status(404).json({ message: 'ไม่พบข้อมูลพนักงานนี้' });
    }

    const newCode = (emp_code ? emp_code.trim().toUpperCase() : targetEmp.emp_code);
    
    // ตรวจสอบรหัสพนักงานซ้ำกับคนอื่น
    const dup = db.prepare("SELECT id FROM employees WHERE UPPER(emp_code) = ? AND id != ?").get(newCode, id);
    if (dup) {
      return res.status(409).json({ message: `รหัสพนักงาน "${newCode}" ซ้ำกับพนักงานท่านอื่นในระบบ` });
    }

    const newName = (name && name.trim() ? name.trim() : targetEmp.name);
    const newDept = (department !== undefined ? department.trim() : targetEmp.department);
    const newPos = (position !== undefined ? position.trim() : targetEmp.position);
    const newActive = (is_active !== undefined ? Number(is_active) : targetEmp.is_active);

    db.prepare(`
      UPDATE employees 
      SET emp_code = ?, name = ?, department = ?, position = ?, is_active = ?
      WHERE id = ?
    `).run(newCode, newName, newDept, newPos, newActive, id);

    res.json({ success: true, message: 'อัปเดตข้อมูลและสิทธิ์พนักงานเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message, message: 'บันทึกข้อมูลไม่สำเร็จ: ' + err.message });
  }
});

// Admin ลบพนักงานออกจากระบบสิทธิ์
app.delete('/api/admin/employees/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { admin_pin } = req.body || req.query || {};
    if (!checkAdminPin(admin_pin)) {
      return res.status(401).json({ message: 'รหัส Admin PIN ไม่ถูกต้อง' });
    }

    db.prepare("DELETE FROM employees WHERE id = ?").run(id);
    res.json({ success: true, message: 'ลบพนักงานออกจากระบบเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// ADMIN: ตั้งค่าการแจ้งเตือนผ่าน LINE
// ----------------------------------------------------
app.get('/api/admin/settings/line', (req, res) => {
  try {
    const adminPin = req.headers['x-admin-pin'] || req.query.admin_pin;
    if (!checkAdminPin(adminPin)) {
      return res.status(401).json({ message: 'รหัส Admin PIN ไม่ถูกต้อง' });
    }
    const settings = getLineSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/settings/line', (req, res) => {
  try {
    const { admin_pin, enabled, type, token, destinationId } = req.body;
    if (!checkAdminPin(admin_pin)) {
      return res.status(401).json({ message: 'รหัส Admin PIN ไม่ถูกต้อง' });
    }

    const setVal = (k, v) => {
      db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(k, String(v ?? ''));
    };

    setVal('line_enabled', enabled ? '1' : '0');
    setVal('line_type', type || 'messaging_api');
    setVal('line_token', token || '');
    setVal('line_dest_id', destinationId || '');

    res.json({ success: true, message: 'บันทึกการตั้งค่า LINE Notification เรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message, message: 'บันทึกไม่สำเร็จ: ' + err.message });
  }
});

app.post('/api/admin/line/test', async (req, res) => {
  try {
    const { admin_pin } = req.body;
    if (!checkAdminPin(admin_pin)) {
      return res.status(401).json({ message: 'รหัส Admin PIN ไม่ถูกต้อง' });
    }

    const testMessage = `🧪 ทดสอบระบบแจ้งเตือน LINE จากระบบจองห้องประชุม
✅ การเชื่อมต่อระบบสำเร็จเรียบร้อย!
🕒 เวลาทดสอบ: ${new Date().toLocaleTimeString('th-TH')}
พร้อมรับการแจ้งเตือนเมื่อมีการจอง, แก้ไข หรือยกเลิกห้องประชุมแล้วครับ`;

    const result = await sendLineNotification(testMessage);
    if (result && result.success) {
      res.json({ success: true, message: 'ส่งข้อความทดสอบเข้า LINE สำเร็จแล้ว กรุณาเปิดดูในแอป LINE' });
    } else {
      res.status(400).json({ 
        success: false, 
        message: 'ส่งข้อความไม่สำเร็จ: ' + (result?.reason || result?.error || JSON.stringify(result?.data) || 'ตรวจสอบ Token หรือ Destination ID') 
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message, message: 'เกิดข้อผิดพลาดในการทดสอบ: ' + err.message });
  }
});

// ----------------------------------------------------
// พนักงานเข้าสู่ระบบ (ตรวจสอบสิทธิ์การใช้งาน is_active)
// ----------------------------------------------------
app.post('/api/auth/employee-login', (req, res) => {
  try {
    const { keyword } = req.body;
    if (!keyword || !keyword.trim()) {
      return res.status(400).json({ message: 'กรุณาระบุรหัสพนักงาน หรือชื่อพนักงาน' });
    }

    const clean = keyword.trim();
    const employee = db.prepare(`
      SELECT * FROM employees 
      WHERE UPPER(emp_code) = UPPER(?) 
         OR name LIKE ?
      LIMIT 1
    `).get(clean, `%${clean}%`);

    if (!employee) {
      return res.status(404).json({
        message: 'ไม่พบข้อมูลพนักงานในระบบ (Admin ยังไม่ได้เพิ่มชื่อของคุณในรายชื่อผู้มีสิทธิ์ใช้)'
      });
    }

    // ตรวจสอบว่า Admin เปิดสิทธิ์ให้ใช้หรือไม่
    if (employee.is_active === 0) {
      return res.status(403).json({
        message: '⛔ บัญชีพนักงานของคุณถูกระงับสิทธิ์การจองห้องประชุมชั่วคราว กรุณาติดต่อ Admin'
      });
    }

    res.json({
      success: true,
      employee: {
        id: employee.id,
        emp_code: employee.emp_code,
        name: employee.name,
        department: employee.department,
        position: employee.position
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// ADMIN: กำหนดชื่อห้องและข้อมูลห้องประชุม (Manage Rooms)
// ----------------------------------------------------

// Get Rooms (รวมสถานะว่าง/กำลังประชุม)
app.get('/api/rooms', (req, res) => {
  try {
    const rooms = db.prepare("SELECT * FROM rooms WHERE is_active = 1 ORDER BY id ASC").all();
    const nowIso = getNowIso();
    const today = nowIso.slice(0, 10);

    const enriched = rooms.map(room => {
      let parsedAmenities = [];
      try { parsedAmenities = JSON.parse(room.amenities || '[]'); } catch (e) {}

      const current = db.prepare(`
        SELECT * FROM bookings
        WHERE room_id = ? AND status = 'confirmed'
          AND start_at <= ? AND end_at > ?
        ORDER BY start_at ASC LIMIT 1
      `).get(room.id, nowIso, nowIso);

      const next = db.prepare(`
        SELECT * FROM bookings
        WHERE room_id = ? AND status = 'confirmed'
          AND start_at > ? AND start_at LIKE ?
        ORDER BY start_at ASC LIMIT 1
      `).get(room.id, nowIso, `${today}%`);

      return {
        ...room,
        amenities: parsedAmenities,
        is_busy: !!current,
        current_booking: current || null,
        next_booking: next || null
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin กำหนดเพิ่มห้องประชุมใหม่
app.post('/api/rooms', (req, res) => {
  try {
    const { admin_pin, name, code, capacity, location, color, amenities } = req.body;
    if (!checkAdminPin(admin_pin)) {
      return res.status(401).json({ message: 'รหัส Admin PIN ไม่ถูกต้อง' });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'กรุณาระบุชื่อห้องประชุม' });
    }

    const roomCode = code ? code.trim().toUpperCase() : `ROOM-${Date.now().toString().slice(-3)}`;
    const amenJson = JSON.stringify(Array.isArray(amenities) ? amenities : []);

    const stmt = db.prepare(`
      INSERT INTO rooms (code, name, capacity, location, color, amenities)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(roomCode, name.trim(), Number(capacity) || 8, (location || '').trim(), color || '#ff6a00', amenJson);

    res.status(201).json({ success: true, id: result.lastInsertRowid, message: 'เพิ่มห้องประชุมเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin แก้ไขชื่อห้องและรายละเอียดห้องประชุม
app.put('/api/rooms/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { admin_pin, code, name, capacity, location, color, amenities } = req.body;
    if (!checkAdminPin(admin_pin)) {
      return res.status(401).json({ message: 'รหัส Admin PIN ไม่ถูกต้อง' });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'กรุณาระบุชื่อห้องประชุม' });
    }

    const targetRoom = db.prepare("SELECT * FROM rooms WHERE id = ?").get(id);
    if (!targetRoom) {
      return res.status(404).json({ message: 'ไม่พบข้อมูลห้องประชุมนี้' });
    }

    const cleanCode = (code ? code.trim().toUpperCase() : targetRoom.code);

    // ตรวจสอบรหัสห้องซ้ำกับห้องอื่น
    const dup = db.prepare("SELECT id FROM rooms WHERE UPPER(code) = ? AND id != ?").get(cleanCode, id);
    if (dup) {
      return res.status(409).json({ message: `รหัสห้อง "${cleanCode}" มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น` });
    }

    const amenJson = JSON.stringify(Array.isArray(amenities) ? amenities : []);
    db.prepare(`
      UPDATE rooms 
      SET code = ?, name = ?, capacity = ?, location = ?, color = ?, amenities = ?
      WHERE id = ?
    `).run(cleanCode, name.trim(), Number(capacity) || targetRoom.capacity || 8, (location || '').trim(), color || targetRoom.color || '#ff6a00', amenJson, id);

    res.json({ success: true, message: 'บันทึกการแก้ไขห้องประชุมเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message, message: 'บันทึกข้อมูลไม่สำเร็จ: ' + err.message });
  }
});

// Admin ลบห้องประชุม
app.delete('/api/rooms/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { admin_pin } = req.body || req.query || {};
    if (!checkAdminPin(admin_pin)) {
      return res.status(401).json({ message: 'รหัส Admin PIN ไม่ถูกต้อง' });
    }

    db.prepare("UPDATE rooms SET is_active = 0 WHERE id = ?").run(id);
    res.json({ success: true, message: 'ลบห้องประชุมเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// BOOKINGS API
// ----------------------------------------------------

// Get Bookings
app.get('/api/bookings', (req, res) => {
  try {
    const { room_id, date, start_date, end_date } = req.query;
    let query = `
      SELECT b.*, r.name as room_name, r.code as room_code, r.color as room_color, r.location as room_location
      FROM bookings b
      JOIN rooms r ON b.room_id = r.id
      WHERE b.status = 'confirmed'
    `;
    const params = [];

    if (room_id) {
      query += " AND b.room_id = ?";
      params.push(room_id);
    }

    if (date) {
      query += " AND (b.start_at LIKE ? OR b.end_at LIKE ?)";
      params.push(`${date}%`, `${date}%`);
    } else if (start_date && end_date) {
      query += " AND (b.start_at >= ? AND b.start_at <= ?)";
      params.push(`${start_date}T00:00:00`, `${end_date}T23:59:59`);
    }

    query += " ORDER BY b.start_at ASC";
    const bookings = db.prepare(query).all(...params);
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create Booking
app.post('/api/bookings', (req, res) => {
  try {
    const { room, room_id, title, booked_by, department, emp_code, start_at, end_at, note, pin } = req.body;

    // ตรวจสอบสิทธิ์พนักงาน: ต้องเป็นพนักงานที่มีสิทธิ์ (is_active = 1)
    if (emp_code) {
      const emp = db.prepare("SELECT * FROM employees WHERE UPPER(emp_code) = UPPER(?)").get(emp_code);
      if (!emp || emp.is_active === 0) {
        return res.status(403).json({ message: '⛔ พนักงานรหัสนี้ไม่มีสิทธิ์ใช้งาน หรือถูกระงับสิทธิ์โดยผู้ดูแลระบบ' });
      }
    }

    let targetRoomId = room_id;
    if (!targetRoomId && room) {
      const r = db.prepare("SELECT id FROM rooms WHERE name = ? OR code = ?").get(room, room);
      if (r) targetRoomId = r.id;
    }

    if (!targetRoomId) {
      return res.status(400).json({ message: 'กรุณาเลือกห้องประชุม' });
    }

    if (!booked_by || !booked_by.trim()) {
      return res.status(400).json({ message: 'กรุณาระบุชื่อผู้จอง' });
    }

    if (!start_at || !end_at) {
      return res.status(400).json({ message: 'กรุณาระบุวันที่และเวลาที่จอง' });
    }

    if (new Date(start_at) >= new Date(end_at)) {
      return res.status(400).json({ message: 'เวลาเริ่มต้องมาก่อนเวลาสิ้นสุดเสมอ' });
    }

    const meetingTitle = title && title.trim() ? title.trim() : 'การประชุมทั่วไป';

    // Conflict Check
    const conflict = findConflict(targetRoomId, start_at, end_at);
    if (conflict) {
      const sTime = conflict.start_at.slice(11, 16);
      const eTime = conflict.end_at.slice(11, 16);
      return res.status(409).json({
        message: `⛔ ไม่สามารถจองซ้ำได้! ห้อง ${conflict.room_name} ถูกจองแล้วในช่วงเวลาดังกล่าว`,
        conflict: {
          id: conflict.id,
          title: conflict.title,
          booked_by: conflict.booked_by,
          department: conflict.department,
          start_at: conflict.start_at,
          end_at: conflict.end_at,
          time_range: `${sTime} - ${eTime} น.`
        }
      });
    }

    const bookingPin = pin && pin.trim() ? pin.trim() : '1234';

    const stmt = db.prepare(`
      INSERT INTO bookings (room_id, emp_code, title, booked_by, department, start_at, end_at, note, pin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      targetRoomId, 
      (emp_code || '').trim(), 
      meetingTitle, 
      booked_by.trim(), 
      (department || '').trim(), 
      start_at, 
      end_at, 
      (note || '').trim(), 
      bookingPin
    );

    // ส่งแจ้งเตือน LINE อัตโนมัติ (Async ไม่บล็อกการจอง)
    try {
      const roomObj = db.prepare("SELECT name FROM rooms WHERE id = ?").get(targetRoomId);
      const roomName = roomObj?.name || `ห้อง #${targetRoomId}`;
      const dateThai = formatBookingThaiDate(start_at);
      const timeRange = `${start_at.slice(11, 16)} - ${end_at.slice(11, 16)} น.`;

      const lineMsg = `🔔 มีการจองห้องประชุมใหม่!
🏢 ห้อง: ${roomName}
📌 หัวข้อ: ${meetingTitle}
👤 ผู้จอง: ${booked_by.trim()}${department ? ' (' + department.trim() + ')' : ''}
🗓️ วันที่: ${dateThai}
⏰ เวลา: ${timeRange}
${(note && note.trim()) ? '💬 หมายเหตุ: ' + note.trim() + '\n' : ''}✅ สถานะ: ยืนยันการจองเรียบร้อย`;

      sendLineNotification(lineMsg).catch(() => {});
    } catch (e) {}

    res.status(201).json({
      success: true,
      id: result.lastInsertRowid,
      pin: bookingPin,
      message: 'จองห้องประชุมเรียบร้อยแล้ว'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel Booking
app.delete('/api/bookings/:id', (req, res) => {
  try {
    const { id } = req.params;
    const pin = req.body?.pin || req.query?.pin;

    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    if (!booking) {
      return res.status(404).json({ message: 'ไม่พบรายการจองนี้' });
    }

    if (!checkAdminPin(pin) && pin !== booking.pin) {
      return res.status(401).json({ 
        message: 'รหัส PIN ไม่ถูกต้อง (กรุณาระบุรหัส PIN 4 หลักของผู้จอง หรือรหัสแอดมิน)' 
      });
    }

    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(id);

    // ส่งแจ้งเตือนยกเลิกทาง LINE
    try {
      const roomObj = db.prepare("SELECT name FROM rooms WHERE id = ?").get(booking.room_id);
      const roomName = roomObj?.name || `ห้อง #${booking.room_id}`;
      const dateThai = formatBookingThaiDate(booking.start_at);
      const timeRange = `${booking.start_at.slice(11, 16)} - ${booking.end_at.slice(11, 16)} น.`;

      const lineMsg = `❌ มีการยกเลิกการจองห้องประชุม!
🏢 ห้อง: ${roomName}
📌 หัวข้อ: ${booking.title}
👤 ผู้จองเดิม: ${booking.booked_by}
🗓️ วันที่: ${dateThai} (เวลา ${timeRange})
🟢 สถานะ: ว่างพร้อมให้ผู้อื่นเข้าใช้งานหรือจองต่อได้ทันที`;

      sendLineNotification(lineMsg).catch(() => {});
    } catch (e) {}

    res.json({ success: true, message: 'ยกเลิกการจองห้องประชุมเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message, message: 'ยกเลิกไม่สำเร็จ: ' + err.message });
  }
});

// Edit Booking (แก้ไขข้อมูลการจองห้องประชุม)
app.put('/api/bookings/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { pin, room_id, title, booked_by, department, start_at, end_at, note } = req.body;

    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    if (!booking) {
      return res.status(404).json({ message: 'ไม่พบรายการจองนี้' });
    }

    // Verify PIN (allow booking pin or admin pin)
    if (!checkAdminPin(pin) && pin !== booking.pin) {
      return res.status(401).json({ message: 'รหัส PIN ไม่ถูกต้อง (กรุณาระบุรหัส PIN ของผู้จอง หรือรหัสแอดมิน)' });
    }

    const targetRoomId = Number(room_id || booking.room_id);
    const newStart = start_at || booking.start_at;
    const newEnd = end_at || booking.end_at;

    if (new Date(newStart) >= new Date(newEnd)) {
      return res.status(400).json({ message: 'เวลาเริ่มต้องมาก่อนเวลาสิ้นสุดเสมอ' });
    }

    // Conflict Check (exclude current booking ID)
    const conflict = findConflict(targetRoomId, newStart, newEnd, id);
    if (conflict) {
      const sTime = conflict.start_at.slice(11, 16);
      const eTime = conflict.end_at.slice(11, 16);
      return res.status(409).json({
        message: `⛔ ไม่สามารถแก้ไขได้! ห้อง ${conflict.room_name} ถูกจองแล้วในช่วงเวลาดังกล่าว (${sTime} - ${eTime} น.)`,
        conflict
      });
    }

    const newTitle = (title && title.trim()) ? title.trim() : booking.title;
    const newBookedBy = (booked_by && booked_by.trim()) ? booked_by.trim() : booking.booked_by;
    const newDept = department !== undefined ? department.trim() : booking.department;
    const newNote = note !== undefined ? note.trim() : booking.note;

    db.prepare(`
      UPDATE bookings
      SET room_id = ?, title = ?, booked_by = ?, department = ?, start_at = ?, end_at = ?, note = ?
      WHERE id = ?
    `).run(targetRoomId, newTitle, newBookedBy, newDept, newStart, newEnd, newNote, id);

    // ส่งแจ้งเตือนการแก้ไขทาง LINE
    try {
      const roomObj = db.prepare("SELECT name FROM rooms WHERE id = ?").get(targetRoomId);
      const roomName = roomObj?.name || `ห้อง #${targetRoomId}`;
      const dateThai = formatBookingThaiDate(newStart);
      const timeRange = `${newStart.slice(11, 16)} - ${newEnd.slice(11, 16)} น.`;

      const lineMsg = `✏️ มีการแก้ไขข้อมูลการจองห้องประชุม!
🏢 ห้อง: ${roomName}
📌 หัวข้อ: ${newTitle}
👤 ผู้จอง: ${newBookedBy}${newDept ? ' (' + newDept + ')' : ''}
🗓️ วันที่: ${dateThai}
⏰ เวลาใหม่: ${timeRange}
${newNote ? '💬 หมายเหตุ: ' + newNote + '\n' : ''}✅ สถานะ: ปรับปรุงข้อมูลเรียบร้อย`;

      sendLineNotification(lineMsg).catch(() => {});
    } catch (e) {}

    res.json({ success: true, message: 'บันทึกการแก้ไขข้อมูลการจองเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message, message: 'เกิดข้อผิดพลาดในการบันทึก: ' + err.message });
  }
});

// Kiosk Quick Book
app.post('/api/kiosk/quick-book', (req, res) => {
  try {
    const { room_id, minutes, booked_by, title } = req.body;
    const duration = parseInt(minutes, 10) || 30;

    const now = new Date();
    const coeff = 1000 * 60 * 5;
    const roundedStart = new Date(Math.round(now.getTime() / coeff) * coeff);
    const roundedEnd = new Date(roundedStart.getTime() + duration * 60000);

    const formatIso = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const date = String(d.getDate()).padStart(2, '0');
      const h = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      return `${y}-${m}-${date}T${h}:${min}:00`;
    };

    const startAt = formatIso(roundedStart);
    const endAt = formatIso(roundedEnd);

    const conflict = findConflict(room_id, startAt, endAt);
    if (conflict) {
      return res.status(409).json({
        message: `ห้องไม่ว่างในช่วงเวลาดังกล่าว ชนกับ "${conflict.title}"`
      });
    }

    const stmt = db.prepare(`
      INSERT INTO bookings (room_id, emp_code, title, booked_by, department, start_at, end_at, note, pin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      room_id,
      'KIOSK',
      title || `จองด่วนหน้าห้อง (${duration} นาที)`,
      booked_by || 'พนักงานหน้าห้อง',
      'Walk-in',
      startAt,
      endAt,
      'จองผ่านหน้าจอหน้าห้องประชุม',
      '9999'
    );

    res.status(201).json({
      success: true,
      id: result.lastInsertRowid,
      start_at: startAt,
      end_at: endAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export CSV
app.get('/api/bookings/export', (req, res) => {
  try {
    const bookings = db.prepare(`
      SELECT b.id, r.name as room_name, r.code as room_code, b.title, b.booked_by, b.department,
             b.start_at, b.end_at, b.note, b.status, b.created_at
      FROM bookings b
      JOIN rooms r ON b.room_id = r.id
      ORDER BY b.start_at DESC
    `).all();

    let csv = '\uFEFF';
    csv += 'รหัสจอง,รหัสห้อง,ห้องประชุม,หัวข้อการประชุม,ผู้จอง,แผนก,เวลาเริ่ม,เวลาสิ้นสุด,สถานะ,หมายเหตุ,วันที่บันทึก\n';

    for (const b of bookings) {
      const escape = (str) => `"${String(str || '').replace(/"/g, '""')}"`;
      csv += [
        b.id,
        escape(b.room_code),
        escape(b.room_name),
        escape(b.title),
        escape(b.booked_by),
        escape(b.department),
        escape(b.start_at),
        escape(b.end_at),
        escape(b.status === 'confirmed' ? 'ยืนยัน' : 'ยกเลิก'),
        escape(b.note),
        escape(b.created_at)
      ].join(',') + '\n';
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=meeting-bookings-${new Date().toISOString().slice(0,10)}.csv`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download System ZIP & Deployment Files
app.get('/download/meeting-room-system-ready.zip', (req, res) => {
  const localZip = path.join(__dirname, 'public', 'downloads', 'meeting-room-system-ready.zip');
  const parentZip = path.join(__dirname, '..', 'meeting-room-system-ready.zip');
  const target = fs.existsSync(localZip) ? localZip : parentZip;
  if (fs.existsSync(target)) {
    return res.download(target, 'meeting-room-system-ready.zip');
  }
  res.status(404).send('ไม่พบไฟล์ ZIP สำหรับดาวน์โหลด');
});

app.get('/download/:filename', (req, res) => {
  const safeFiles = ['Dockerfile', 'render.yaml', 'START-ONLINE.bat', 'START-SYSTEM.bat', 'MANUAL.md'];
  const { filename } = req.params;
  if (safeFiles.includes(filename)) {
    const filePath = path.join(__dirname, filename);
    if (fs.existsSync(filePath)) {
      return res.download(filePath, filename);
    }
  }
  res.status(404).send('ไม่พบไฟล์ที่ต้องการดาวน์โหลด');
});

// Start Server
const server = app.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log('\n=============================================================');
  console.log('       🚀 ระบบจองห้องประชุมสำหรับพนักงานองค์กร               ');
  console.log('=============================================================');
  console.log(` 💻 เครื่องนี้ (Localhost):   http://localhost:${PORT}`);
  console.log(` 🌐 ทุกอุปกรณ์ในวง Wi-Fi/LAN: http://${localIp}:${PORT}`);
  console.log('-------------------------------------------------------------');
  console.log(` 📲 พนักงานสามารถแสกน QR Code จากมือถือเพื่อเข้าใช้งานได้ทันที`);
  console.log(' 🛡️  รหัส Master Admin PIN: 8888');
  console.log('=============================================================\n');

  QRCode.toString(`http://${localIp}:${PORT}`, { type: 'terminal', small: true }, (err, qrStr) => {
    if (!err) console.log(qrStr);
  });
});

