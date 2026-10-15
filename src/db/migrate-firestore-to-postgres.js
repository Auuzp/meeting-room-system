function timestampValue(value) {
  if (value && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  if (value === undefined || value === null) return null;
  return String(value);
}

function activeValue(value) {
  if (value === undefined || value === null) return 1;
  if (value === true) return 1;
  if (value === false) return 0;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error('is_active contains an invalid value');
  return number;
}

function idValue(documentId) {
  const id = Number(documentId);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('A collection contains a non-numeric document ID');
  }
  return id;
}

function jsonValue(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('A Firestore value cannot be represented as JSON');
  return text;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const result = {};
    Object.keys(value).sort().forEach((key) => {
      result[key] = canonical(value[key]);
    });
    return result;
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

async function readCollection(firestore, name) {
  const snapshot = await firestore.collection(name).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
}

async function readFirestoreSnapshot(firestore) {
  const settings = await readCollection(firestore, 'settings');
  const rooms = await readCollection(firestore, 'rooms');
  const employees = await readCollection(firestore, 'employees');
  const bookings = await readCollection(firestore, 'bookings');
  const counters = await readCollection(firestore, '_counters');
  return { settings, rooms, employees, bookings, counters };
}

function normalizeRows(snapshot) {
  const settings = snapshot.settings.map((doc) => {
    if (!Object.prototype.hasOwnProperty.call(doc.data, 'value')) {
      throw new Error('A settings record is missing its value');
    }
    return {
      key: doc.id,
      value: doc.data.value,
      updated_at: timestampValue(doc.data.updated_at),
      source_data: doc.data
    };
  });

  const rooms = snapshot.rooms.map((doc) => {
    const data = doc.data;
    const amenities = data.amenities === undefined || data.amenities === null
      ? '[]'
      : (typeof data.amenities === 'string' ? data.amenities : jsonValue(data.amenities));
    return {
      id: idValue(doc.id),
      code: data.code || '',
      name: data.name,
      capacity: data.capacity === undefined || data.capacity === null ? 10 : Number(data.capacity),
      location: data.location || '',
      color: data.color || '#ff6a00',
      amenities,
      is_active: activeValue(data.is_active),
      created_at: timestampValue(data.created_at),
      updated_at: timestampValue(data.updated_at),
      source_data: data
    };
  });

  const employees = snapshot.employees.map((doc) => {
    const data = doc.data;
    return {
      id: idValue(doc.id),
      emp_code: data.emp_code,
      name: data.name,
      department: data.department,
      position: data.position || '',
      is_active: activeValue(data.is_active),
      created_at: timestampValue(data.created_at),
      updated_at: timestampValue(data.updated_at),
      source_data: data
    };
  });

  const bookings = snapshot.bookings.map((doc) => {
    const data = doc.data;
    return {
      id: idValue(doc.id),
      room_id: Number(data.room_id),
      emp_code: data.emp_code || '',
      title: data.title,
      booked_by: data.booked_by,
      department: data.department || '',
      start_at: timestampValue(data.start_at),
      end_at: timestampValue(data.end_at),
      note: data.note || '',
      pin: data.pin || null,
      status: data.status || 'confirmed',
      created_at: timestampValue(data.created_at),
      updated_at: timestampValue(data.updated_at),
      source_data: data
    };
  });

  for (const row of rooms) {
    if (!row.name || !Number.isFinite(row.capacity)) throw new Error('A room record is missing required data');
  }
  for (const row of employees) {
    if (!row.emp_code || !row.name || !row.department) throw new Error('An employee record is missing required data');
  }
  for (const row of bookings) {
    if (!Number.isSafeInteger(row.room_id) || row.room_id < 1 || !row.title || !row.booked_by || !row.start_at || !row.end_at) {
      throw new Error('A booking record is missing required data');
    }
  }

  settings.sort((a, b) => a.key.localeCompare(b.key));
  rooms.sort((a, b) => a.id - b.id);
  employees.sort((a, b) => a.id - b.id);
  bookings.sort((a, b) => a.id - b.id);
  return { settings, rooms, employees, bookings };
}

function publicSettings(row) {
  return { key: row.key, value: row.value, updated_at: row.updated_at };
}

function publicRoom(row) {
  return {
    id: Number(row.id), code: row.code, name: row.name, capacity: Number(row.capacity),
    location: row.location, color: row.color, amenities: row.amenities,
    is_active: Number(row.is_active), created_at: row.created_at, updated_at: row.updated_at
  };
}

function publicEmployee(row) {
  return {
    id: Number(row.id), emp_code: row.emp_code, name: row.name, department: row.department,
    position: row.position, is_active: Number(row.is_active), created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function publicBooking(row) {
  return {
    id: Number(row.id), room_id: Number(row.room_id), emp_code: row.emp_code,
    title: row.title, booked_by: row.booked_by, department: row.department,
    start_at: row.start_at, end_at: row.end_at, note: row.note, pin: row.pin,
    status: row.status, created_at: row.created_at, updated_at: row.updated_at
  };
}

async function fetchDestination(client) {
  const [settings, rooms, employees, bookings] = await Promise.all([
    client.query('SELECT key, value, updated_at FROM settings ORDER BY key'),
    client.query('SELECT id, code, name, capacity, location, color, amenities, is_active, created_at, updated_at FROM rooms ORDER BY id'),
    client.query('SELECT id, emp_code, name, department, position, is_active, created_at, updated_at FROM employees ORDER BY id'),
    client.query('SELECT id, room_id, emp_code, title, booked_by, department, start_at, end_at, note, pin, status, created_at, updated_at FROM bookings ORDER BY id')
  ]);
  return {
    settings: settings.rows.map(publicSettings),
    rooms: rooms.rows.map(publicRoom),
    employees: employees.rows.map(publicEmployee),
    bookings: bookings.rows.map(publicBooking)
  };
}

function sameRows(source, destination) {
  for (const table of ['settings', 'rooms', 'employees', 'bookings']) {
    if (source[table].length !== destination[table].length) return false;
    for (let i = 0; i < source[table].length; i += 1) {
      const expected = table === 'settings' ? publicSettings(source[table][i])
        : table === 'rooms' ? publicRoom(source[table][i])
        : table === 'employees' ? publicEmployee(source[table][i])
        : publicBooking(source[table][i]);
      const actual = destination[table][i];
      if (!sameJson(expected, actual)) return false;
    }
  }
  return true;
}

async function setSequence(client, table, currentValue) {
  const value = Math.max(0, Number(currentValue) || 0);
  await client.query(
    "SELECT setval(pg_get_serial_sequence($1, 'id'), $2, $3)",
    [table, value > 0 ? value : 1, value > 0]
  );
}

async function copyRows(client, rows) {
  for (const row of rows.settings) {
    await client.query(
      'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)',
      [row.key, jsonValue(row.value), row.updated_at]
    );
  }
  for (const row of rows.rooms) {
    await client.query(
      'INSERT INTO rooms (id, code, name, capacity, location, color, amenities, is_active, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [row.id, row.code, row.name, row.capacity, row.location, row.color, row.amenities, row.is_active, row.created_at, row.updated_at]
    );
  }
  for (const row of rows.employees) {
    await client.query(
      'INSERT INTO employees (id, emp_code, name, department, position, is_active, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [row.id, row.emp_code, row.name, row.department, row.position, row.is_active, row.created_at, row.updated_at]
    );
  }
  for (const row of rows.bookings) {
    await client.query(
      'INSERT INTO bookings (id, room_id, emp_code, title, booked_by, department, start_at, end_at, note, pin, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [row.id, row.room_id, row.emp_code, row.title, row.booked_by, row.department, row.start_at, row.end_at, row.note, row.pin, row.status, row.created_at, row.updated_at]
    );
  }

  const counterByName = Object.fromEntries(rows.counters.map((row) => [row.id, Number(row.data.current) || 0]));
  const maxRoom = rows.rooms.reduce((max, row) => Math.max(max, row.id), 0);
  const maxEmployee = rows.employees.reduce((max, row) => Math.max(max, row.id), 0);
  const maxBooking = rows.bookings.reduce((max, row) => Math.max(max, row.id), 0);
  await setSequence(client, 'rooms', Math.max(maxRoom, counterByName.rooms || 0));
  await setSequence(client, 'employees', Math.max(maxEmployee, counterByName.employees || 0));
  await setSequence(client, 'bookings', Math.max(maxBooking, counterByName.bookings || 0));
}

async function migrateFirestoreToPostgres(firestore, pool) {
  await pool.ready;
  const firestoreSnapshot = await readFirestoreSnapshot(firestore);
  const rows = normalizeRows(firestoreSnapshot);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE settings, rooms, employees, bookings IN EXCLUSIVE MODE');
    const destination = await fetchDestination(client);
    const hasDestinationData = Object.values(destination).some((table) => table.length > 0);

    if (hasDestinationData) {
      if (sameRows(rows, destination)) {
        await client.query('COMMIT');
        return {
          alreadyMigrated: true,
          counts: Object.fromEntries(Object.entries(rows).map(([key, table]) => [key, table.length]))
        };
      }
      throw new Error('The Neon database is not empty or its records differ; migration stopped to protect existing data');
    }

    await copyRows(client, rows);
    const verification = await fetchDestination(client);
    if (!sameRows(rows, verification)) {
      throw new Error('Destination verification failed; the transaction was rolled back');
    }

    await client.query('COMMIT');
    return {
      alreadyMigrated: false,
      counts: Object.fromEntries(Object.entries(rows).map(([key, table]) => [key, table.length]))
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function getFirestoreCollectionCounts(firestore) {
  const snapshot = await readFirestoreSnapshot(firestore);
  return {
    settings: snapshot.settings.length,
    rooms: snapshot.rooms.length,
    employees: snapshot.employees.length,
    bookings: snapshot.bookings.length
  };
}

module.exports = { migrateFirestoreToPostgres, getFirestoreCollectionCounts };
