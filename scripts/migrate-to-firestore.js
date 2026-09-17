#!/usr/bin/env node
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch (err) {
    // .env is optional
  }
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { initFirestore } = require('../src/db/firestore');

async function migrate() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'meeting_rooms.db');

  console.log('=============================================================');
  console.log('📦 SQLite -> Cloud Firestore Data Migration Tool');
  console.log('=============================================================');
  console.log('Source SQLite DB:', dbPath);
  console.log('Dry Run Mode:', isDryRun ? 'ENABLED (No data will be written)' : 'DISABLED (Live write)');

  if (!fs.existsSync(dbPath)) {
    console.error('❌ Error: SQLite database file not found at:', dbPath);
    process.exit(1);
  }

  // 1. Calculate SHA-256 of SQLite database before migration
  const fileBuffer = fs.readFileSync(dbPath);
  const initialSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex').toUpperCase();
  console.log('Source DB SHA-256:', initialSha256);

  // 2. Create timestamped backup file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(path.dirname(dbPath), `meeting_rooms.db.backup.${timestamp}`);
  fs.copyFileSync(dbPath, backupPath);
  console.log('✅ Created backup copy at:', backupPath);

  // 3. Connect to SQLite (read-only mode)
  const sqlite = new DatabaseSync(dbPath, { readOnly: true });

  // Read tables
  const settingsRows = sqlite.prepare("SELECT key, value FROM settings").all();
  const roomsRows = sqlite.prepare("SELECT * FROM rooms").all();
  const employeesRows = sqlite.prepare("SELECT * FROM employees").all();
  const bookingsRows = sqlite.prepare("SELECT * FROM bookings").all();

  console.log('\n--- SQLite Source Record Counts ---');
  console.log(`settings: ${settingsRows.length}`);
  console.log(`rooms: ${roomsRows.length}`);
  console.log(`employees: ${employeesRows.length}`);
  console.log(`bookings: ${bookingsRows.length}`);

  if (isDryRun) {
    console.log('\n🔍 [DRY-RUN] Verifying sample records:');
    if (roomsRows.length > 0) console.log('Sample Room:', JSON.stringify(roomsRows[0]));
    if (employeesRows.length > 0) console.log('Sample Employee:', JSON.stringify(employeesRows[0]));
    if (bookingsRows.length > 0) {
      const sampleB = { ...bookingsRows[0] };
      if (sampleB.pin) sampleB.pin = '$scrypt$***[MASKED]***';
      console.log('Sample Booking:', JSON.stringify(sampleB));
    }
    console.log('\n✅ [DRY-RUN] Simulation completed successfully. No records were modified.');
    process.exit(0);
  }

  // 4. Connect to Firestore
  console.log('\nConnecting to Cloud Firestore...');
  const firestore = initFirestore();

  // 5. Migrate Settings
  console.log('Migrating settings...');
  for (const row of settingsRows) {
    await firestore.collection('settings').doc(row.key).set({
      value: row.value,
      migrated_at: new Date().toISOString()
    }, { merge: true });
  }

  // 6. Migrate Rooms
  console.log('Migrating rooms...');
  let maxRoomId = 0;
  for (const row of roomsRows) {
    const id = Number(row.id);
    if (id > maxRoomId) maxRoomId = id;
    await firestore.collection('rooms').doc(String(id)).set({
      id,
      code: row.code || '',
      name: row.name,
      capacity: row.capacity,
      location: row.location || '',
      color: row.color || '#ff6a00',
      amenities: row.amenities || '[]',
      is_active: row.is_active !== undefined ? row.is_active : 1,
      created_at: row.created_at || new Date().toISOString()
    }, { merge: true });
  }
  await firestore.collection('_counters').doc('rooms').set({ current: maxRoomId }, { merge: true });

  // 7. Migrate Employees
  console.log('Migrating employees...');
  let maxEmpId = 0;
  for (const row of employeesRows) {
    const id = Number(row.id);
    if (id > maxEmpId) maxEmpId = id;
    await firestore.collection('employees').doc(String(id)).set({
      id,
      emp_code: row.emp_code,
      name: row.name,
      department: row.department,
      position: row.position || '',
      is_active: row.is_active !== undefined ? row.is_active : 1,
      created_at: row.created_at || new Date().toISOString()
    }, { merge: true });
  }
  await firestore.collection('_counters').doc('employees').set({ current: maxEmpId }, { merge: true });

  // 8. Migrate Bookings
  console.log('Migrating bookings...');
  let maxBookingId = 0;
  for (const row of bookingsRows) {
    const id = Number(row.id);
    if (id > maxBookingId) maxBookingId = id;
    await firestore.collection('bookings').doc(String(id)).set({
      id,
      room_id: Number(row.room_id),
      emp_code: row.emp_code || '',
      title: row.title,
      booked_by: row.booked_by,
      department: row.department || '',
      start_at: row.start_at,
      end_at: row.end_at,
      note: row.note || '',
      pin: row.pin, // Preserves existing hashed PIN without plaintext conversion
      status: row.status || 'confirmed',
      created_at: row.created_at || new Date().toISOString()
    }, { merge: true });
  }
  await firestore.collection('_counters').doc('bookings').set({ current: maxBookingId }, { merge: true });

  // 9. Verify Firestore Counts
  console.log('\n--- Verifying Destination Record Counts ---');
  const fsSettings = await firestore.collection('settings').get();
  const fsRooms = await firestore.collection('rooms').get();
  const fsEmployees = await firestore.collection('employees').get();
  const fsBookings = await firestore.collection('bookings').get();

  console.log('\nSQLite:');
  console.log(`settings: ${settingsRows.length}`);
  console.log(`rooms: ${roomsRows.length}`);
  console.log(`employees: ${employeesRows.length}`);
  console.log(`bookings: ${bookingsRows.length}`);

  console.log('\nFirestore:');
  console.log(`settings: ${fsSettings.size}`);
  console.log(`rooms: ${fsRooms.size}`);
  console.log(`employees: ${fsEmployees.size}`);
  console.log(`bookings: ${fsBookings.size}`);

  const match = (
    settingsRows.length === fsSettings.size &&
    roomsRows.length === fsRooms.size &&
    employeesRows.length === fsEmployees.size &&
    bookingsRows.length === fsBookings.size
  );

  if (!match) {
    console.error('\n❌ Mismatch = FAIL. Record counts do not match between SQLite and Firestore.');
    process.exit(1);
  }

  // 10. Verify SQLite source file remained 100% pristine
  const finalFileBuffer = fs.readFileSync(dbPath);
  const finalSha256 = crypto.createHash('sha256').update(finalFileBuffer).digest('hex').toUpperCase();
  if (initialSha256 !== finalSha256) {
    console.error('\n❌ Error: Source SQLite file was altered during migration!');
    process.exit(1);
  }

  console.log('\n🎉 MIGRATION SUCCESSFUL! All record counts match and source database is intact.');
}

migrate().catch(err => {
  console.error('\n❌ Migration Failed:', err);
  process.exit(1);
});
