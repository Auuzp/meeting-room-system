// Load environment variables from .env if present (supported natively in Node.js 20.6.0+)
if (typeof process.loadEnvFile === 'function') {
  try {
    if (!process.env.DB_PATH || !process.env.DB_PATH.includes('test_meeting_rooms')) {
      process.loadEnvFile();
    }
  } catch (err) {
    // .env is optional
  }
}

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');

const { initDatabase, getDatabase } = require('./src/db');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'meeting_rooms.db');

// Initialize Database (Dual provider: SQLite or Cloud Firestore)
const { provider: dbProvider, db, repositories } = initDatabase(process.env.DB_PROVIDER, { dbPath: DB_PATH });
const {
  rooms: roomsRepo,
  employees: employeesRepo,
  bookings: bookingsRepo,
  settings: settingsRepo
} = repositories;

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

// ----------------------------------------------------
// Security & PIN Hashing Helpers
// ----------------------------------------------------
function hashPin(pin, salt = null) {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `$scrypt$${salt}$${hash}`;
}

function verifyPinHash(pin, storedValue) {
  if (!pin || !storedValue) return false;
  if (!storedValue.startsWith('$scrypt$')) {
    // Legacy plaintext support during migration (constant-time compare)
    const pinBuf = Buffer.from(String(pin));
    const storedBuf = Buffer.from(String(storedValue));
    if (pinBuf.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(pinBuf, storedBuf);
  }
  const parts = storedValue.split('$');
  if (parts.length !== 4) return false;
  const salt = parts[2];
  const originalHash = parts[3];
  const targetHash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  const origBuf = Buffer.from(originalHash, 'hex');
  const targetBuf = Buffer.from(targetHash, 'hex');
  if (origBuf.length !== targetBuf.length) return false;
  return crypto.timingSafeEqual(origBuf, targetBuf);
}

// Generate zero-modulo-bias 4-digit PIN using crypto.randomInt
function generateSecurePin() {
  return crypto.randomInt(1000, 10000).toString();
}

// Rate Limiter for Admin PIN (Failed attempt tracking per IP)
const adminRateLimitMap = new Map();

function checkAdminRateLimit(ip) {
  const now = Date.now();
  const record = adminRateLimitMap.get(ip);
  if (!record) return { allowed: true };

  if (record.lockUntil && record.lockUntil > now) {
    const retryAfter = Math.max(1, Math.ceil((record.lockUntil - now) / 1000));
    return { allowed: false, retryAfter };
  }

  if (record.lockUntil && record.lockUntil <= now) {
    adminRateLimitMap.delete(ip);
    return { allowed: true };
  }

  return { allowed: true };
}

function recordAdminAuthFailure(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxAttempts = 5;
  const lockDurationMs = 60 * 1000;

  let record = adminRateLimitMap.get(ip);
  if (!record || (now - record.firstAttemptAt > windowMs && !record.lockUntil)) {
    record = { count: 1, firstAttemptAt: now, lockUntil: null };
  } else {
    record.count += 1;
  }

  if (record.count >= maxAttempts) {
    record.lockUntil = now + lockDurationMs;
  }
  adminRateLimitMap.set(ip, record);
  return record;
}

function resetAdminAuthRateLimit(ip) {
  adminRateLimitMap.delete(ip);
}

// Initialize Settings & Migration
(async () => {
  try {
    if (process.env.ADMIN_PIN && process.env.ADMIN_PIN.trim()) {
      const hashed = hashPin(process.env.ADMIN_PIN.trim());
      await settingsRepo.set('admin_pin', hashed);
    } else {
      const row = await settingsRepo.get('admin_pin');
      if (row && row.value && !row.value.startsWith('$scrypt$')) {
        await settingsRepo.set('admin_pin', hashPin(row.value));
      }
    }

    const orgNameRow = await settingsRepo.get('org_name');
    if (!orgNameRow) {
      await settingsRepo.set('org_name', 'ระบบจองห้องประชุมภายในองค์กร');
    }
  } catch (err) {
    console.error('Settings initialization warning:', err.message);
  }
})();

// Helper: Extract Admin PIN safely (Reject if in query string)
function extractAdminPin(req) {
  let pin = req.headers['x-admin-pin'];
  if (!pin && req.headers.authorization) {
    const auth = req.headers.authorization.trim();
    if (auth.startsWith('Bearer ')) {
      pin = auth.slice(7).trim();
    } else {
      pin = auth;
    }
  }
  if (!pin && req.body && typeof req.body === 'object') {
    pin = req.body.admin_pin || req.body.pin;
  }
  return pin ? String(pin).trim() : null;
}

// Helper: Check Admin PIN
async function checkAdminPin(pin) {
  if (!pin) return false;
  const row = await settingsRepo.get('admin_pin');
  if (!row || !row.value) return false;
  return verifyPinHash(pin, row.value);
}

// Middleware: Require Admin Authentication
async function requireAdminAuth(req, res, next) {
  if (req.query && (req.query.admin_pin || req.query.pin)) {
    return res.status(400).json({ message: 'ไม่อนุญาตให้ส่ง Admin PIN ผ่าน query string' });
  }

  const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
  const rateLimitStatus = checkAdminRateLimit(clientIp);
  if (!rateLimitStatus.allowed) {
    res.setHeader('Retry-After', String(rateLimitStatus.retryAfter));
    return res.status(429).json({
      message: `ลองรหัสผ่านผิดเกินกำหนด กรุณารอ ${rateLimitStatus.retryAfter} วินาที`,
      retryAfter: rateLimitStatus.retryAfter
    });
  }

  const pin = extractAdminPin(req);
  if (await checkAdminPin(pin)) {
    resetAdminAuthRateLimit(clientIp);
    return next();
  }

  const failureRecord = recordAdminAuthFailure(clientIp);
  if (failureRecord.lockUntil && failureRecord.lockUntil > Date.now()) {
    const retryAfter = Math.max(1, Math.ceil((failureRecord.lockUntil - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      message: `ลองรหัสผ่านผิดเกินกำหนด กรุณารอ ${retryAfter} วินาที`,
      retryAfter: retryAfter
    });
  }

  return res.status(401).json({ message: 'ต้องการสิทธิ์ผู้ดูแลระบบ (Admin PIN ไม่ถูกต้อง)' });
}

// Middleware: Require Kiosk Authentication (Strict: NO default secret, Header ONLY)
function requireKioskAuth(req, res, next) {
  if (req.query && (req.query.kiosk_secret || req.query.secret)) {
    return res.status(400).json({ message: 'ไม่อนุญาตให้ส่ง Kiosk Secret ผ่าน query string' });
  }

  const kioskSecretEnv = process.env.KIOSK_SECRET;
  if (!kioskSecretEnv || !kioskSecretEnv.trim()) {
    return res.status(401).json({ message: 'Kiosk service is not configured (missing KIOSK_SECRET)' });
  }

  const secret = req.headers['x-kiosk-secret'];
  if (!secret) {
    return res.status(401).json({ message: 'ต้องการสิทธิ์ Kiosk (กรุณาระบุ X-Kiosk-Secret header)' });
  }

  const secBuf = Buffer.from(String(secret));
  const envBuf = Buffer.from(String(kioskSecretEnv.trim()));
  if (secBuf.length !== envBuf.length || !crypto.timingSafeEqual(secBuf, envBuf)) {
    return res.status(401).json({ message: 'Kiosk secret ไม่ถูกต้อง' });
  }
  next();
}

// Utility: Get Local IPv4 Address
function getLocalIp() {
  try {
    const interfaces = os.networkInterfaces();
    if (interfaces && typeof interfaces === 'object') {
      for (const name of Object.keys(interfaces)) {
        const ifaceList = interfaces[name];
        if (Array.isArray(ifaceList)) {
          for (const net of ifaceList) {
            if (net && net.family === 'IPv4' && !net.internal) {
              return net.address;
            }
          }
        }
      }
    }
  } catch (err) {}
  return 'localhost';
}

// Strict ISO Date parsing & validation (prevent auto-normalization of invalid calendar dates like Feb 31)
function parseAndValidateIsoDate(isoStr) {
  if (typeof isoStr !== 'string') return null;
  const match = isoStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = match[6] ? parseInt(match[6], 10) : 0;

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (second < 0 || second > 59) return null;

  const isLeapYear = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0));
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]) return null;

  const pad = (n) => String(n).padStart(2, '0');
  const normalized = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  return { normalized, timestamp, year, month, day, hour, minute, second };
}

function validateBookingTimes(start_at, end_at) {
  const startParsed = parseAndValidateIsoDate(start_at);
  const endParsed = parseAndValidateIsoDate(end_at);
  if (!startParsed || !endParsed) {
    return { valid: false, message: 'รูปแบบวันที่และเวลาไม่ถูกต้อง หรือเป็นวันที่ไม่มีอยู่จริงในปฏิทิน' };
  }
  if (startParsed.timestamp >= endParsed.timestamp) {
    return { valid: false, message: 'เวลาเริ่มต้องมาก่อนเวลาสิ้นสุดเสมอ' };
  }
  return { valid: true, startAt: startParsed.normalized, endAt: endParsed.normalized };
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
let lineNotificationTransport = (...args) => fetch(...args);

function setLineNotificationTransport(transport) {
  if (typeof transport !== 'function') {
    throw new TypeError('LINE notification transport must be a function');
  }
  lineNotificationTransport = transport;
}

async function getLineSettings() {
  const enabled = (await settingsRepo.get('line_enabled'))?.value === '1';
  const type = (await settingsRepo.get('line_type'))?.value || 'messaging_api';
  const token = (await settingsRepo.get('line_token'))?.value || '';
  const destinationId = (await settingsRepo.get('line_dest_id'))?.value || '';
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
    const { enabled, type, token, destinationId } = await getLineSettings();
    if (!enabled || !token) {
      return { success: false, reason: 'ไม่ได้เปิดใช้งาน LINE หรือยังไม่ได้ระบุ Token' };
    }

    if (type === 'messaging_api') {
      if (!destinationId) {
        return { success: false, reason: 'LINE Messaging API จำเป็นต้องระบุ Destination ID (User ID / Group ID)' };
      }
      const res = await lineNotificationTransport('https://api.line.me/v2/bot/message/push', {
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
      const res = await lineNotificationTransport('https://notify-api.line.me/api/notify', {
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

// Helper: Check Overlap Conflict (exported for testing/backwards-compat)
function findConflict(roomId, startAt, endAt, excludeBookingId = null) {
  return bookingsRepo.findConflict(roomId, startAt, endAt, excludeBookingId);
}

// ----------------------------------------------------
// REST API Endpoints
// ----------------------------------------------------

// 1. System Info & QR Code
app.get('/api/system/info', async (req, res) => {
  try {
    let localIp = 'localhost';
    try {
      localIp = getLocalIp();
    } catch (_) {
      localIp = 'localhost';
    }
    const networkUrl = `http://${localIp}:${PORT}`;
    let qrDataUrl = '';
    try {
      qrDataUrl = await QRCode.toDataURL(networkUrl, {
        margin: 2,
        width: 260,
        color: { dark: '#111827', light: '#ffffff' }
      });
    } catch (_) {
      qrDataUrl = '';
    }

    const orgRow = await settingsRepo.get('org_name');
    const orgName = orgRow?.value || 'ระบบจองห้องประชุมภายในองค์กร';

    res.json({
      localIp,
      port: PORT,
      networkUrl,
      qrDataUrl,
      orgName
    });
  } catch (err) {
    res.status(200).json({
      localIp: 'localhost',
      port: PORT,
      networkUrl: `http://localhost:${PORT}`,
      qrDataUrl: '',
      orgName: 'ระบบจองห้องประชุมภายในองค์กร'
    });
  }
});

// 2. Admin PIN Verification
app.post('/api/admin/verify', async (req, res) => {
  if (req.query && (req.query.admin_pin || req.query.pin)) {
    return res.status(400).json({ success: false, message: 'ไม่อนุญาตให้ส่ง Admin PIN ผ่าน query string' });
  }

  const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
  const rateLimitStatus = checkAdminRateLimit(clientIp);
  if (!rateLimitStatus.allowed) {
    res.setHeader('Retry-After', String(rateLimitStatus.retryAfter));
    return res.status(429).json({
      success: false,
      message: `ลองรหัสผ่านผิดเกินกำหนด กรุณารอ ${rateLimitStatus.retryAfter} วินาที`,
      retryAfter: rateLimitStatus.retryAfter
    });
  }

  const pin = extractAdminPin(req);
  if (await checkAdminPin(pin)) {
    resetAdminAuthRateLimit(clientIp);
    return res.json({ success: true });
  }

  const failureRecord = recordAdminAuthFailure(clientIp);
  if (failureRecord.lockUntil && failureRecord.lockUntil > Date.now()) {
    const retryAfter = Math.max(1, Math.ceil((failureRecord.lockUntil - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      success: false,
      message: `ลองรหัสผ่านผิดเกินกำหนด กรุณารอ ${retryAfter} วินาที`,
      retryAfter: retryAfter
    });
  }

  return res.status(401).json({ success: false, message: 'รหัส Admin PIN ไม่ถูกต้อง' });
});

// ----------------------------------------------------
// ADMIN: กำหนดรายชื่อพนักงานที่มีสิทธิ์ใช้ (Allowed Employees)
// ----------------------------------------------------

// ดึงรายชื่อพนักงานทั้งหมด (สำหรับ Admin)
app.get('/api/admin/employees', requireAdminAuth, async (req, res) => {
  try {
    const employees = await employeesRepo.getAll();
    res.json(employees);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin เพิ่มพนักงานใหม่ที่มีสิทธิ์ใช้
app.post('/api/admin/employees', requireAdminAuth, async (req, res) => {
  try {
    const { emp_code, name, department, position } = req.body;

    if (!emp_code || !emp_code.trim()) {
      return res.status(400).json({ message: 'กรุณาระบุรหัสพนักงาน' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'กรุณาระบุชื่อ-นามสกุลพนักงาน' });
    }

    const code = emp_code.trim().toUpperCase();
    const existing = await employeesRepo.getByCode(code);
    if (existing) {
      return res.status(409).json({ message: `รหัสพนักงาน "${code}" มีอยู่ในระบบแล้ว` });
    }

    const result = await employeesRepo.create({
      emp_code: code,
      name: name.trim(),
      department: (department || '').trim(),
      position: (position || '').trim()
    });

    res.status(201).json({ success: true, id: result.id, message: 'เพิ่มพนักงานที่มีสิทธิ์ใช้งานเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin แก้ไขข้อมูลพนักงาน หรือเปิด/ปิดสิทธิ์การใช้งาน (is_active: 0 หรือ 1)
app.put('/api/admin/employees/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { emp_code, name, department, position, is_active } = req.body;

    const targetEmp = await employeesRepo.getById(id);
    if (!targetEmp) {
      return res.status(404).json({ message: 'ไม่พบข้อมูลพนักงานนี้' });
    }

    const newCode = (emp_code ? emp_code.trim().toUpperCase() : targetEmp.emp_code);
    const dup = await employeesRepo.getByCode(newCode, id);
    if (dup) {
      return res.status(409).json({ message: `รหัสพนักงาน "${newCode}" ซ้ำกับพนักงานท่านอื่นในระบบ` });
    }

    const newName = (name && name.trim() ? name.trim() : targetEmp.name);
    const newDept = (department !== undefined ? department.trim() : targetEmp.department);
    const newPos = (position !== undefined ? position.trim() : targetEmp.position);
    const newActive = (is_active !== undefined ? Number(is_active) : targetEmp.is_active);

    await employeesRepo.update(id, {
      emp_code: newCode,
      name: newName,
      department: newDept,
      position: newPos,
      is_active: newActive
    });

    res.json({ success: true, message: 'อัปเดตข้อมูลและสิทธิ์พนักงานเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message, message: 'บันทึกข้อมูลไม่สำเร็จ: ' + err.message });
  }
});

// Admin ลบพนักงานออกจากระบบสิทธิ์
app.delete('/api/admin/employees/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await employeesRepo.delete(id);
    res.json({ success: true, message: 'ลบพนักงานออกจากระบบเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// ADMIN: ตั้งค่าการแจ้งเตือนผ่าน LINE
// ----------------------------------------------------
app.get('/api/admin/settings/line', requireAdminAuth, async (req, res) => {
  try {
    const settings = await getLineSettings();
    const rawToken = settings.token || '';
    const maskedToken = rawToken ? (rawToken.length > 8 ? rawToken.slice(0, 4) + '***' + rawToken.slice(-4) : '***') : '';
    res.json({
      enabled: settings.enabled,
      type: settings.type,
      destinationId: settings.destinationId,
      hasToken: !!rawToken,
      token: maskedToken
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/settings/line', requireAdminAuth, async (req, res) => {
  try {
    const { enabled, type, token, destinationId } = req.body;
    const existing = await getLineSettings();
    let finalToken = existing.token;
    if (token && typeof token === 'string' && !token.includes('***') && token.trim()) {
      finalToken = token.trim();
    }

    await settingsRepo.set('line_enabled', enabled ? '1' : '0');
    await settingsRepo.set('line_type', type || 'messaging_api');
    await settingsRepo.set('line_token', finalToken || '');
    await settingsRepo.set('line_dest_id', destinationId ? destinationId.trim() : '');

    res.json({ success: true, message: 'บันทึกการตั้งค่า LINE Notification เรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message, message: 'บันทึกไม่สำเร็จ: ' + err.message });
  }
});

app.post('/api/admin/line/test', requireAdminAuth, async (req, res) => {
  try {
    const testMessage = `🧪 ทดสอบระบบแจ้งเตือน LINE จากระบบจองห้องประชุม\n✅ การเชื่อมต่อระบบสำเร็จเรียบร้อย!\n🕒 เวลาทดสอบ: ${new Date().toLocaleTimeString('th-TH')}\nพร้อมรับการแจ้งเตือนเมื่อมีการจอง, แก้ไข หรือยกเลิกห้องประชุมแล้วครับ`;

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
app.post('/api/auth/employee-login', async (req, res) => {
  try {
    const { keyword } = req.body;
    if (!keyword || !keyword.trim()) {
      return res.status(400).json({ message: 'กรุณาระบุรหัสพนักงาน หรือชื่อพนักงาน' });
    }

    const clean = keyword.trim();
    const employee = await employeesRepo.findByKeyword(clean);

    if (!employee) {
      return res.status(404).json({
        message: 'ไม่พบข้อมูลพนักงานในระบบ (Admin ยังไม่ได้เพิ่มชื่อของคุณในรายชื่อผู้มีสิทธิ์ใช้)'
      });
    }

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
app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await roomsRepo.getAll(true);
    const nowIso = getNowIso();
    const today = nowIso.slice(0, 10);
    const allActiveBookings = await bookingsRepo.getAll({ status: 'confirmed' });

    const enriched = rooms.map(room => {
      let parsedAmenities = [];
      try {
        parsedAmenities = typeof room.amenities === 'string' ? JSON.parse(room.amenities || '[]') : (room.amenities || []);
      } catch (e) {}

      const roomBookings = allActiveBookings.filter(b => Number(b.room_id) === Number(room.id));
      const current = roomBookings.find(b => b.start_at <= nowIso && b.end_at > nowIso) || null;
      const next = roomBookings
        .filter(b => b.start_at > nowIso && b.start_at.startsWith(today))
        .sort((a, b) => (a.start_at > b.start_at ? 1 : -1))[0] || null;

      return {
        ...room,
        amenities: parsedAmenities,
        is_busy: !!current,
        current_booking: current,
        next_booking: next
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin กำหนดเพิ่มห้องประชุมใหม่
app.post('/api/rooms', requireAdminAuth, async (req, res) => {
  try {
    const { name, code, capacity, location, color, amenities } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'กรุณาระบุชื่อห้องประชุม' });
    }

    const roomCode = code ? code.trim().toUpperCase() : `ROOM-${Date.now().toString().slice(-3)}`;
    const existing = await roomsRepo.getByCode(roomCode);
    if (existing) {
      return res.status(409).json({ message: `รหัสห้อง "${roomCode}" มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น` });
    }

    const amenJson = Array.isArray(amenities) ? JSON.stringify(amenities) : (typeof amenities === 'string' ? amenities : '[]');
    const result = await roomsRepo.create({
      code: roomCode,
      name: name.trim(),
      capacity: Number(capacity) || 8,
      location: (location || '').trim(),
      color: color || '#ff6a00',
      amenities: amenJson
    });

    res.status(201).json({ success: true, id: result.id, message: 'เพิ่มห้องประชุมเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin แก้ไขชื่อห้องและรายละเอียดห้องประชุม
app.put('/api/rooms/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, capacity, location, color, amenities } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'กรุณาระบุชื่อห้องประชุม' });
    }

    const targetRoom = await roomsRepo.getById(id);
    if (!targetRoom) {
      return res.status(404).json({ message: 'ไม่พบข้อมูลห้องประชุมนี้' });
    }

    const cleanCode = (code ? code.trim().toUpperCase() : targetRoom.code);
    const dup = await roomsRepo.getByCode(cleanCode, id);
    if (dup) {
      return res.status(409).json({ message: `รหัสห้อง "${cleanCode}" มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น` });
    }

    const amenJson = Array.isArray(amenities) ? JSON.stringify(amenities) : (typeof amenities === 'string' ? amenities : '[]');
    await roomsRepo.update(id, {
      code: cleanCode,
      name: name.trim(),
      capacity: Number(capacity) || targetRoom.capacity || 8,
      location: (location || '').trim(),
      color: color || targetRoom.color || '#ff6a00',
      amenities: amenJson
    });

    res.json({ success: true, message: 'บันทึกการแก้ไขห้องประชุมเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message, message: 'บันทึกข้อมูลไม่สำเร็จ: ' + err.message });
  }
});

// Admin ลบห้องประชุม
app.delete('/api/rooms/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const targetRoom = await roomsRepo.getById(id);
    if (!targetRoom) {
      return res.status(404).json({ message: 'ไม่พบข้อมูลห้องประชุมนี้' });
    }

    await roomsRepo.deactivate(id);
    res.json({ success: true, message: 'ลบห้องประชุมเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// BOOKINGS API
// ----------------------------------------------------

// Get Bookings
app.get('/api/bookings', async (req, res) => {
  try {
    const { room_id, date, start_date, end_date } = req.query;
    const bookings = await bookingsRepo.getAll({
      room_id: room_id ? Number(room_id) : undefined,
      date,
      start_date,
      end_date,
      status: 'confirmed'
    });
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create Booking
app.post('/api/bookings', async (req, res) => {
  try {
    const { room, room_id, title, emp_code, start_at, end_at, note } = req.body;

    if (!emp_code || typeof emp_code !== 'string' || !emp_code.trim()) {
      return res.status(400).json({ message: 'กรุณาระบุรหัสพนักงาน (emp_code)' });
    }

    const emp = await employeesRepo.getByCode(emp_code.trim());
    if (!emp || emp.is_active === 0) {
      return res.status(403).json({ message: '⛔ พนักงานรหัสนี้ไม่มีสิทธิ์ใช้งาน หรือถูกระงับสิทธิ์โดยผู้ดูแลระบบ' });
    }

    const booked_by = emp.name;
    const department = emp.department || '';

    let targetRoomId = Number(room_id);
    if (!targetRoomId && room) {
      const r = await roomsRepo.getByNameOrCode(room, room);
      if (r) targetRoomId = r.id;
    }

    if (!targetRoomId) {
      return res.status(400).json({ message: 'กรุณาเลือกห้องประชุม' });
    }

    const roomObj = await roomsRepo.getById(targetRoomId, true);
    if (!roomObj) {
      return res.status(400).json({ message: 'ไม่พบห้องประชุมที่เลือก หรือห้องประชุมถูกปิดใช้งาน' });
    }

    const timeCheck = validateBookingTimes(start_at, end_at);
    if (!timeCheck.valid) {
      return res.status(400).json({ message: timeCheck.message });
    }
    const validStart = timeCheck.startAt;
    const validEnd = timeCheck.endAt;

    const meetingTitle = title && typeof title === 'string' && title.trim() ? title.trim() : 'การประชุมทั่วไป';
    const bookingPin = generateSecurePin();
    const hashedPin = hashPin(bookingPin);

    let result;
    try {
      result = await bookingsRepo.createAtomic({
        room_id: targetRoomId,
        emp_code: emp.emp_code,
        title: meetingTitle,
        booked_by,
        department,
        start_at: validStart,
        end_at: validEnd,
        note: (note && typeof note === 'string' ? note.trim() : ''),
        pin: hashedPin
      });
    } catch (err) {
      if (err.status === 409 || (err.message && err.message.includes('จองซ้ำ'))) {
        const conflict = err.conflict;
        const sTime = conflict ? conflict.start_at.slice(11, 16) : '';
        const eTime = conflict ? conflict.end_at.slice(11, 16) : '';
        return res.status(409).json({
          message: err.message,
          conflict: conflict ? {
            id: conflict.id,
            title: conflict.title,
            booked_by: conflict.booked_by,
            department: conflict.department,
            start_at: conflict.start_at,
            end_at: conflict.end_at,
            time_range: `${sTime} - ${eTime} น.`
          } : undefined
        });
      }
      throw err;
    }

    // Async LINE notification
    try {
      const roomName = roomObj.name || `ห้อง #${targetRoomId}`;
      const dateThai = formatBookingThaiDate(validStart);
      const timeRange = `${validStart.slice(11, 16)} - ${validEnd.slice(11, 16)} น.`;
      const lineMsg = `🔔 มีการจองห้องประชุมใหม่!\n🏢 ห้อง: ${roomName}\n📌 หัวข้อ: ${meetingTitle}\n👤 ผู้จอง: ${booked_by}${department ? ' (' + department + ')' : ''}\n🗓️ วันที่: ${dateThai}\n⏰ เวลา: ${timeRange}\n${(note && typeof note === 'string' && note.trim()) ? '💬 หมายเหตุ: ' + note.trim() + '\n' : ''}✅ สถานะ: ยืนยันการจองเรียบร้อย`;
      sendLineNotification(lineMsg).catch(() => {});
    } catch (_) {}

    res.status(201).json({
      success: true,
      id: result.id,
      pin: bookingPin,
      message: 'จองห้องประชุมเรียบร้อยแล้ว'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel Booking
app.delete('/api/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (req.query && (req.query.pin || req.query.admin_pin)) {
      return res.status(400).json({ message: 'ไม่อนุญาตให้ส่ง PIN ผ่าน query string' });
    }

    const pin = req.body?.pin || req.headers['x-admin-pin'] || (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null);

    const booking = await bookingsRepo.getById(id);
    if (!booking) {
      return res.status(404).json({ message: 'ไม่พบรายการจองนี้' });
    }

    const isAdmin = pin ? await checkAdminPin(pin) : false;
    const isBookingPin = pin ? verifyPinHash(pin, booking.pin) : false;

    if (!isAdmin && !isBookingPin) {
      return res.status(401).json({ 
        message: 'รหัส PIN ไม่ถูกต้อง (กรุณาระบุรหัส PIN 4 หลักของผู้จอง หรือรหัสแอดมิน)' 
      });
    }

    await bookingsRepo.cancel(id);

    // ส่งแจ้งเตือนยกเลิกทาง LINE
    try {
      const roomObj = await roomsRepo.getById(booking.room_id);
      const roomName = roomObj?.name || `ห้อง #${booking.room_id}`;
      const dateThai = formatBookingThaiDate(booking.start_at);
      const timeRange = `${booking.start_at.slice(11, 16)} - ${booking.end_at.slice(11, 16)} น.`;
      const lineMsg = `❌ มีการยกเลิกการจองห้องประชุม!\n🏢 ห้อง: ${roomName}\n📌 หัวข้อ: ${booking.title}\n👤 ผู้จองเดิม: ${booking.booked_by}\n🗓️ วันที่: ${dateThai} (เวลา ${timeRange})\n🟢 สถานะ: ว่างพร้อมให้ผู้อื่นเข้าใช้งานหรือจองต่อได้ทันที`;
      sendLineNotification(lineMsg).catch(() => {});
    } catch (_) {}

    res.json({ success: true, message: 'ยกเลิกการจองห้องประชุมเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message, message: 'ยกเลิกไม่สำเร็จ: ' + err.message });
  }
});

// Edit Booking (แก้ไขข้อมูลการจองห้องประชุม)
app.put('/api/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (req.query && (req.query.pin || req.query.admin_pin)) {
      return res.status(400).json({ message: 'ไม่อนุญาตให้ส่ง PIN ผ่าน query string' });
    }

    const { pin: bodyPin, room_id, title, booked_by, department, start_at, end_at, note } = req.body || {};
    const pin = bodyPin || req.headers['x-admin-pin'] || (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null);

    const booking = await bookingsRepo.getById(id);
    if (!booking) {
      return res.status(404).json({ message: 'ไม่พบรายการจองนี้' });
    }

    const isAdmin = pin ? await checkAdminPin(pin) : false;
    const isBookingPin = pin ? verifyPinHash(pin, booking.pin) : false;

    if (!isAdmin && !isBookingPin) {
      return res.status(401).json({ message: 'รหัส PIN ไม่ถูกต้อง (กรุณาระบุรหัส PIN ของผู้จอง หรือรหัสแอดมิน)' });
    }

    const targetRoomId = Number(room_id || booking.room_id);
    const roomObj = await roomsRepo.getById(targetRoomId, true);
    if (!roomObj) {
      return res.status(400).json({ message: 'ไม่พบห้องประชุมที่เลือก หรือห้องประชุมถูกปิดใช้งาน' });
    }

    const newStart = start_at || booking.start_at;
    const newEnd = end_at || booking.end_at;
    const timeCheck = validateBookingTimes(newStart, newEnd);
    if (!timeCheck.valid) {
      return res.status(400).json({ message: timeCheck.message });
    }
    const validStart = timeCheck.startAt;
    const validEnd = timeCheck.endAt;

    const newTitle = (title && typeof title === 'string' && title.trim()) ? title.trim() : booking.title;
    const newBookedBy = (booked_by && typeof booked_by === 'string' && booked_by.trim()) ? booked_by.trim() : booking.booked_by;
    const newDept = department !== undefined ? String(department).trim() : booking.department;
    const newNote = note !== undefined ? String(note).trim() : booking.note;

    try {
      await bookingsRepo.updateAtomic(id, {
        room_id: targetRoomId,
        title: newTitle,
        booked_by: newBookedBy,
        department: newDept,
        start_at: validStart,
        end_at: validEnd,
        note: newNote
      });
    } catch (err) {
      if (err.status === 409 || (err.message && err.message.includes('จองซ้ำ'))) {
        const conflict = err.conflict;
        const sTime = conflict ? conflict.start_at.slice(11, 16) : '';
        const eTime = conflict ? conflict.end_at.slice(11, 16) : '';
        return res.status(409).json({
          message: err.message,
          conflict
        });
      }
      throw err;
    }

    try {
      const roomName = roomObj.name || `ห้อง #${targetRoomId}`;
      const dateThai = formatBookingThaiDate(validStart);
      const timeRange = `${validStart.slice(11, 16)} - ${validEnd.slice(11, 16)} น.`;
      const lineMsg = `✏️ มีการแก้ไขข้อมูลการจองห้องประชุม!\n🏢 ห้อง: ${roomName}\n📌 หัวข้อ: ${newTitle}\n👤 ผู้จอง: ${newBookedBy}${newDept ? ' (' + newDept + ')' : ''}\n🗓️ วันที่: ${dateThai}\n⏰ เวลาใหม่: ${timeRange}\n${newNote ? '💬 หมายเหตุ: ' + newNote + '\n' : ''}✅ สถานะ: ปรับปรุงข้อมูลเรียบร้อย`;
      sendLineNotification(lineMsg).catch(() => {});
    } catch (_) {}

    res.json({ success: true, message: 'บันทึกการแก้ไขข้อมูลการจองเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ error: err.message, message: 'เกิดข้อผิดพลาดในการบันทึก: ' + err.message });
  }
});

// Kiosk Quick Book
app.post('/api/kiosk/quick-book', requireKioskAuth, async (req, res) => {
  try {
    const { room_id, minutes, booked_by, title } = req.body;
    const allowedDurations = [15, 30, 45, 60];
    const duration = parseInt(minutes, 10);

    if (!allowedDurations.includes(duration)) {
      return res.status(400).json({ message: 'ระยะเวลาต้องเป็น 15, 30, 45 หรือ 60 นาที' });
    }

    const room = await roomsRepo.getById(room_id, true);
    if (!room) {
      return res.status(400).json({ message: 'ไม่พบห้องประชุม หรือห้องถูกปิดใช้งาน' });
    }

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

    const kioskPin = generateSecurePin();
    const hashedPin = hashPin(kioskPin);

    let result;
    try {
      result = await bookingsRepo.createAtomic({
        room_id: Number(room_id),
        emp_code: 'KIOSK',
        title: title || `จองด่วนหน้าห้อง (${duration} นาที)`,
        booked_by: booked_by || 'พนักงานหน้าห้อง',
        department: 'Walk-in',
        start_at: startAt,
        end_at: endAt,
        note: 'จองผ่านหน้าจอหน้าห้องประชุม',
        pin: hashedPin
      });
    } catch (err) {
      if (err.status === 409 || (err.message && err.message.includes('จองซ้ำ'))) {
        return res.status(409).json({
          message: err.conflict ? `ห้องไม่ว่างในช่วงเวลาดังกล่าว ชนกับ "${err.conflict.title}"` : err.message
        });
      }
      throw err;
    }

    res.status(201).json({
      success: true,
      id: result.id,
      start_at: startAt,
      end_at: endAt,
      pin: kioskPin
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export CSV
app.get('/api/bookings/export', async (req, res) => {
  try {
    const bookings = await bookingsRepo.getAll();
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
let server = null;
if (require.main === module) {
  server = app.listen(PORT, '0.0.0.0', () => {
    const localIp = getLocalIp();
    console.log('\n=============================================================');
    console.log('       🚀 ระบบจองห้องประชุมสำหรับพนักงานองค์กร               ');
    console.log(`       ฐานข้อมูลที่ใช้งาน: ${dbProvider.toUpperCase()}`);
    console.log('=============================================================');
    console.log(` 💻 เครื่องนี้ (Localhost):   http://localhost:${PORT}`);
    console.log(` 🌐 ทุกอุปกรณ์ในวง Wi-Fi/LAN: http://${localIp}:${PORT}`);
    console.log('-------------------------------------------------------------');
    console.log(` 📲 พนักงานสามารถแสกน QR Code จากมือถือเพื่อเข้าใช้งานได้ทันที`);
    console.log('=============================================================\n');

    QRCode.toString(`http://${localIp}:${PORT}`, { type: 'terminal', small: true }, (err, qrStr) => {
      if (!err) console.log(qrStr);
    });
  });
}

module.exports = {
  app,
  server,
  db,
  dbProvider,
  repositories,
  checkAdminPin,
  verifyPinHash,
  hashPin,
  generateSecurePin,
  parseAndValidateIsoDate,
  validateBookingTimes,
  findConflict,
  resetAdminAuthRateLimit,
  checkAdminRateLimit,
  recordAdminAuthFailure,
  getLocalIp,
  setLineNotificationTransport
};
