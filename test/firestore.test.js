const assert = require('assert');
const crypto = require('crypto');
const { createRoomsRepository } = require('../src/db/repositories/rooms');
const { createEmployeesRepository } = require('../src/db/repositories/employees');
const { createBookingsRepository } = require('../src/db/repositories/bookings');
const { createSettingsRepository } = require('../src/db/repositories/settings');

// In-memory Firestore Mock for Isolated Automated Tests
function createMockFirestore() {
  const data = new Map(); // col/doc -> docData
  let locked = false;

  function getDocKey(col, docId) {
    return `${col}/${docId}`;
  }

  const firestore = {
    collection(colName) {
      return {
        doc(docId) {
          const key = getDocKey(colName, docId);
          return {
            id: docId,
            async get() {
              const val = data.get(key);
              return {
                id: docId,
                exists: val !== undefined,
                data: () => (val ? JSON.parse(JSON.stringify(val)) : undefined)
              };
            },
            async set(docData, options = {}) {
              if (options.merge && data.has(key)) {
                data.set(key, { ...data.get(key), ...docData });
              } else {
                data.set(key, JSON.parse(JSON.stringify(docData)));
              }
            },
            async update(docData) {
              if (!data.has(key)) throw new Error('Document does not exist');
              data.set(key, { ...data.get(key), ...docData });
            },
            async delete() {
              data.delete(key);
            }
          };
        },
        where(field, op, val) {
          return {
            where(f2, op2, val2) {
              return {
                async get() {
                  const docs = [];
                  for (const [k, v] of data.entries()) {
                    if (k.startsWith(colName + '/')) {
                      const id = k.split('/')[1];
                      if (v[field] === val && v[f2] === val2) {
                        docs.push({
                          id,
                          data: () => JSON.parse(JSON.stringify(v))
                        });
                      }
                    }
                  }
                  return { docs, size: docs.length, forEach: (cb) => docs.forEach(cb) };
                }
              };
            },
            async get() {
              const docs = [];
              for (const [k, v] of data.entries()) {
                if (k.startsWith(colName + '/')) {
                  const id = k.split('/')[1];
                  if (v[field] === val) {
                    docs.push({
                      id,
                      data: () => JSON.parse(JSON.stringify(v))
                    });
                  }
                }
              }
              return { docs, size: docs.length, forEach: (cb) => docs.forEach(cb) };
            }
          };
        },
        async get() {
          const docs = [];
          for (const [k, v] of data.entries()) {
            if (k.startsWith(colName + '/')) {
              const id = k.split('/')[1];
              docs.push({
                id,
                data: () => JSON.parse(JSON.stringify(v))
              });
            }
          }
          return { docs, size: docs.length, forEach: (cb) => docs.forEach(cb) };
        }
      };
    },
    async runTransaction(updateFunction) {
      // Simple transaction serialization for atomicity
      while (locked) {
        await new Promise(r => setTimeout(r, 10));
      }
      locked = true;
      try {
        const transaction = {
          async get(refOrQuery) {
            return refOrQuery.get();
          },
          set(docRef, docData, options = {}) {
            return docRef.set(docData, options);
          },
          update(docRef, docData) {
            return docRef.update(docData);
          },
          delete(docRef) {
            return docRef.delete();
          }
        };
        return await updateFunction(transaction);
      } finally {
        locked = false;
      }
    }
  };

  return firestore;
}

function hashPin(pin, salt = null) {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `$scrypt$${salt}$${hash}`;
}

async function runFirestoreTests() {
  console.log('=============================================================');
  console.log('🧪 Running Firebase Firestore Adapter & Security Test Suite');
  console.log('=============================================================\n');

  let passed = 0;
  let failed = 0;

  function testAssert(cond, msg) {
    if (cond) {
      console.log(`  ✅ [PASS] ${msg}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${msg}`);
      failed++;
    }
  }

  const mockDb = createMockFirestore();
  const roomsRepo = createRoomsRepository(mockDb, 'firestore');
  const employeesRepo = createEmployeesRepository(mockDb, 'firestore');
  const bookingsRepo = createBookingsRepository(mockDb, 'firestore');
  const settingsRepo = createSettingsRepository(mockDb, 'firestore');

  // 1. Settings CRUD
  console.log('--- 1. Settings Persistence ---');
  await settingsRepo.set('org_name', 'ระบบจองห้องประชุมองค์กร (Firestore)');
  await settingsRepo.set('admin_pin', hashPin('secure_admin_pin'));
  const orgSetting = await settingsRepo.get('org_name');
  testAssert(orgSetting && orgSetting.value === 'ระบบจองห้องประชุมองค์กร (Firestore)', 'Settings set and get correctly');

  // 2. Rooms: create, read, update, deactivate
  console.log('\n--- 2. Rooms Management ---');
  const room1 = await roomsRepo.create({
    code: 'ROOM-FS-1',
    name: 'ห้องประชุม บอร์ดรูม (Firestore)',
    capacity: 20,
    location: 'ชั้น 5',
    color: '#2563eb',
    amenities: '["projector","tv"]'
  });
  testAssert(room1 && room1.id === 1 && room1.name.includes('บอร์ดรูม'), 'Room created with sequential ID 1');

  const room2 = await roomsRepo.create({
    code: 'ROOM-FS-2',
    name: 'ห้องประชุม ปิดใช้งาน',
    capacity: 8,
    location: 'ชั้น 1',
    color: '#64748b'
  });
  await roomsRepo.deactivate(room2.id);
  const inactiveRoom = await roomsRepo.getById(room2.id);
  testAssert(inactiveRoom && inactiveRoom.is_active === 0, 'Room deactivated successfully (is_active=0)');

  const activeRooms = await roomsRepo.getAll(true);
  testAssert(activeRooms.length === 1 && activeRooms[0].id === room1.id, 'Active-only room filter works');

  // 3. Employees Management & Inactive Employee Rejection
  console.log('\n--- 3. Employees Management ---');
  const emp1 = await employeesRepo.create({
    emp_code: 'EMP201',
    name: 'สมชาย รักงาน',
    department: 'ฝ่ายวิศวกรรม',
    position: 'Staff'
  });
  testAssert(emp1 && emp1.id === 1 && emp1.emp_code === 'EMP201', 'Employee created with sequential ID 1');

  const emp2 = await employeesRepo.create({
    emp_code: 'EMP202',
    name: 'พนักงาน ถูกระงับ',
    department: 'ฝ่ายบัญชี',
    is_active: 0
  });
  const suspendedEmp = await employeesRepo.getById(emp2.id);
  testAssert(suspendedEmp && suspendedEmp.is_active === 0, 'Suspended employee record persisted (is_active=0)');

  const findEmp = await employeesRepo.findByKeyword('สมชาย');
  testAssert(findEmp && findEmp.emp_code === 'EMP201', 'Employee keyword search finds employee');

  // 4. Booking Creation & Atomic Transaction
  console.log('\n--- 4. Booking Creation & Atomic Conflict Protection ---');
  const securePin = hashPin('5555');
  const booking1 = await bookingsRepo.createAtomic({
    room_id: room1.id,
    emp_code: emp1.emp_code,
    title: 'ประชุมประจำสัปดาห์',
    booked_by: emp1.name,
    department: emp1.department,
    start_at: '2026-12-10T10:00:00',
    end_at: '2026-12-10T12:00:00',
    pin: securePin
  });
  testAssert(booking1 && booking1.id === 1 && booking1.status === 'confirmed', 'Booking created atomically in Firestore');
  testAssert(booking1.pin.startsWith('$scrypt$'), 'Booking PIN is securely hashed via scrypt');

  // 5. Inactive Room Rejection
  try {
    await bookingsRepo.createAtomic({
      room_id: room2.id,
      emp_code: emp1.emp_code,
      title: 'พยายามจองห้องปิดปรับปรุง',
      booked_by: emp1.name,
      start_at: '2026-12-10T13:00:00',
      end_at: '2026-12-10T14:00:00',
      pin: securePin
    });
    testAssert(false, 'Booking in inactive room was rejected');
  } catch (err) {
    testAssert(err.status === 400, 'Booking in inactive room is rejected with 400 Bad Request');
  }

  // 6. Overlapping Booking Rejection
  try {
    await bookingsRepo.createAtomic({
      room_id: room1.id,
      emp_code: emp1.emp_code,
      title: 'ประชุมชนเวลา',
      booked_by: emp1.name,
      start_at: '2026-12-10T11:00:00',
      end_at: '2026-12-10T13:00:00',
      pin: securePin
    });
    testAssert(false, 'Overlapping booking was rejected');
  } catch (err) {
    testAssert(err.status === 409, 'Overlapping booking is rejected with 409 Conflict');
  }

  // 7. Simultaneous / Concurrent Booking Requests
  console.log('\n--- 5. Concurrency & Race-Condition Safety ---');
  const concurrentReqs = Array.from({ length: 5 }, (_, i) => {
    return bookingsRepo.createAtomic({
      room_id: room1.id,
      emp_code: emp1.emp_code,
      title: `จองชนพร้อมกัน #${i + 1}`,
      booked_by: emp1.name,
      start_at: '2026-12-11T14:00:00',
      end_at: '2026-12-11T16:00:00',
      pin: securePin
    }).then(res => ({ success: true, res })).catch(err => ({ success: false, err }));
  });

  const concurrentResults = await Promise.all(concurrentReqs);
  const successCount = concurrentResults.filter(r => r.success).length;
  const conflictCount = concurrentResults.filter(r => !r.success && r.err.status === 409).length;
  testAssert(successCount === 1, `Exactly 1 concurrent booking succeeded (actual: ${successCount})`);
  testAssert(conflictCount === 4, `Remaining 4 concurrent bookings received 409 Conflict (actual: ${conflictCount})`);

  // 8. Booking Cancellation
  console.log('\n--- 6. Booking Cancellation ---');
  const cancelled = await bookingsRepo.cancel(booking1.id);
  testAssert(cancelled && cancelled.status === 'cancelled', 'Booking cancelled successfully in Firestore');

  // 9. After cancellation, slot is free for new booking
  const reuseSlot = await bookingsRepo.createAtomic({
    room_id: room1.id,
    emp_code: emp1.emp_code,
    title: 'จองสล็อตเดิมหลังจากยกเลิก',
    booked_by: emp1.name,
    start_at: '2026-12-10T10:00:00',
    end_at: '2026-12-10T12:00:00',
    pin: securePin
  });
  testAssert(reuseSlot && reuseSlot.status === 'confirmed', 'Cancelled time slot can be booked again');

  console.log('\n=============================================================');
  console.log(`🏁 Firestore Tests Summary: Passed: ${passed} | Failed: ${failed}`);
  console.log('=============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runFirestoreTests().catch(err => {
  console.error('Firestore test suite failed:', err);
  process.exit(1);
});
