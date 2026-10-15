function createBookingsRepository(db, provider = 'sqlite') {
  if (provider === 'sqlite') {
    return {
      findConflict(roomId, startAt, endAt, excludeBookingId = null) {
        let query = `
          SELECT b.*, r.name as room_name
          FROM bookings b
          JOIN rooms r ON b.room_id = r.id
          WHERE b.room_id = ?
            AND b.status = 'confirmed'
            AND (
              (b.start_at < ? AND b.end_at > ?)
            )
        `;
        const params = [roomId, endAt, startAt];
        if (excludeBookingId) {
          query += ' AND b.id != ?';
          params.push(excludeBookingId);
        }
        return db.prepare(query).get(...params);
      },
      getById(id) {
        return db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
      },
      getAll(filter = {}) {
        let query = `
          SELECT b.*, r.name as room_name, r.color as room_color, r.location as room_location
          FROM bookings b
          JOIN rooms r ON b.room_id = r.id
          WHERE 1=1
        `;
        const params = [];
        if (filter.date) {
          query += ' AND (b.start_at LIKE ? OR b.end_at LIKE ?)';
          params.push(`${filter.date}%`, `${filter.date}%`);
        }
        if (filter.room_id) {
          query += ' AND b.room_id = ?';
          params.push(filter.room_id);
        }
        if (filter.status) {
          query += ' AND b.status = ?';
          params.push(filter.status);
        }
        query += ' ORDER BY b.start_at ASC';
        return db.prepare(query).all(...params);
      },
      createAtomic(bookingData) {
        db.exec('BEGIN IMMEDIATE');
        try {
          const conflict = this.findConflict(bookingData.room_id, bookingData.start_at, bookingData.end_at);
          if (conflict) {
            db.exec('ROLLBACK');
            const err = new Error(`⛔ ไม่สามารถจองซ้ำได้! ห้อง ${conflict.room_name} ถูกจองแล้วในช่วงเวลาดังกล่าว`);
            err.status = 409;
            err.conflict = conflict;
            throw err;
          }

          const stmt = db.prepare(`
            INSERT INTO bookings (room_id, emp_code, title, booked_by, department, start_at, end_at, note, pin)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          const result = stmt.run(
            bookingData.room_id,
            bookingData.emp_code || '',
            bookingData.title,
            bookingData.booked_by,
            bookingData.department || '',
            bookingData.start_at,
            bookingData.end_at,
            bookingData.note || '',
            bookingData.pin
          );
          db.exec('COMMIT');
          return { id: Number(result.lastInsertRowid), ...bookingData, status: 'confirmed' };
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch (_) {}
          throw err;
        }
      },
      updateAtomic(id, bookingData) {
        db.exec('BEGIN IMMEDIATE');
        try {
          const conflict = this.findConflict(bookingData.room_id, bookingData.start_at, bookingData.end_at, id);
          if (conflict) {
            db.exec('ROLLBACK');
            const err = new Error(`⛔ ไม่สามารถจองซ้ำได้! ห้อง ${conflict.room_name} ถูกจองแล้วในช่วงเวลาดังกล่าว`);
            err.status = 409;
            err.conflict = conflict;
            throw err;
          }

          db.prepare(`
            UPDATE bookings
            SET room_id = ?, title = ?, start_at = ?, end_at = ?, note = ?
            WHERE id = ?
          `).run(
            bookingData.room_id,
            bookingData.title,
            bookingData.start_at,
            bookingData.end_at,
            bookingData.note || '',
            id
          );
          db.exec('COMMIT');
          return this.getById(id);
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch (_) {}
          throw err;
        }
      },
      cancel(id) {
        db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(id);
        return this.getById(id);
      }
    };
  }

  if (provider === 'postgres') {
    const bookingColumns = 'b.id, b.room_id, b.emp_code, b.title, b.booked_by, b.department, b.start_at, b.end_at, b.note, b.pin, b.status, b.created_at, b.updated_at';
    return {
      async findConflict(roomId, startAt, endAt, excludeBookingId = null) {
        const params = [Number(roomId), endAt, startAt];
        let query = 'SELECT ' + bookingColumns + ', r.name AS room_name FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE b.room_id=$1 AND b.status=\'confirmed\' AND b.start_at < $2 AND b.end_at > $3';
        if (excludeBookingId) {
          params.push(Number(excludeBookingId));
          query += ' AND b.id <> $4';
        }
        query += ' LIMIT 1';
        const result = await db.query(query, params);
        return result.rows[0] || null;
      },
      async getById(id) {
        const result = await db.query(
          'SELECT id, room_id, emp_code, title, booked_by, department, start_at, end_at, note, pin, status, created_at, updated_at FROM bookings WHERE id=$1',
          [Number(id)]
        );
        return result.rows[0] || null;
      },
      async getAll(filter = {}) {
        const params = [];
        const where = [];
        if (filter.date) {
          params.push(String(filter.date) + '%');
          const startParam = '$' + params.length;
          params.push(String(filter.date) + '%');
          where.push('(b.start_at LIKE ' + startParam + ' OR b.end_at LIKE $' + params.length + ')');
        }
        if (filter.room_id) {
          params.push(Number(filter.room_id));
          where.push('b.room_id=$' + params.length);
        }
        if (filter.status) {
          params.push(filter.status);
          where.push('b.status=$' + params.length);
        }
        if (filter.start_date) {
          params.push(filter.start_date);
          where.push('b.start_at >= ($' + params.length + '::date)::text');
        }
        if (filter.end_date) {
          params.push(filter.end_date);
          where.push('b.start_at < ($' + params.length + '::date + 1)::text');
        }
        const result = await db.query(
          'SELECT ' + bookingColumns + ', r.name AS room_name, r.code AS room_code, r.color AS room_color, r.location AS room_location FROM bookings b JOIN rooms r ON r.id=b.room_id' +
          (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY b.start_at ASC',
          params
        );
        return result.rows;
      },
      async createAtomic(bookingData) {
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          const roomResult = await client.query('SELECT id, name, is_active FROM rooms WHERE id=$1 FOR UPDATE', [Number(bookingData.room_id)]);
          const room = roomResult.rows[0];
          if (!room || Number(room.is_active) === 0) {
            const err = new Error('ไม่พบห้องประชุม หรือห้องประชุมถูกปิดใช้งาน');
            err.status = 400;
            throw err;
          }
          const conflictResult = await client.query(
            'SELECT id, title, booked_by, department, start_at, end_at FROM bookings WHERE room_id=$1 AND status=\'confirmed\' AND start_at < $2 AND end_at > $3 LIMIT 1',
            [Number(bookingData.room_id), bookingData.end_at, bookingData.start_at]
          );
          if (conflictResult.rows[0]) {
            const conflict = { ...conflictResult.rows[0], room_name: room.name };
            const err = new Error('⛔ ไม่สามารถจองซ้ำได้! ห้อง ' + room.name + ' ถูกจองแล้วในช่วงเวลาดังกล่าว');
            err.status = 409;
            err.conflict = conflict;
            throw err;
          }
          const result = await client.query(
            'INSERT INTO bookings (room_id, emp_code, title, booked_by, department, start_at, end_at, note, pin, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,\'confirmed\') RETURNING id, room_id, emp_code, title, booked_by, department, start_at, end_at, note, pin, status, created_at, updated_at',
            [Number(bookingData.room_id), bookingData.emp_code || '', bookingData.title, bookingData.booked_by, bookingData.department || '', bookingData.start_at, bookingData.end_at, bookingData.note || '', bookingData.pin]
          );
          await client.query('COMMIT');
          return result.rows[0];
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch (_) {}
          throw err;
        } finally {
          client.release();
        }
      },
      async updateAtomic(id, bookingData) {
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          const existingResult = await client.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE', [Number(id)]);
          if (!existingResult.rows[0]) {
            await client.query('COMMIT');
            return null;
          }
          const roomResult = await client.query('SELECT id, name, is_active FROM rooms WHERE id=$1 FOR UPDATE', [Number(bookingData.room_id)]);
          const room = roomResult.rows[0];
          if (!room || Number(room.is_active) === 0) {
            const err = new Error('ไม่พบห้องประชุม หรือห้องประชุมถูกปิดใช้งาน');
            err.status = 400;
            throw err;
          }
          const conflictResult = await client.query(
            'SELECT id, title, booked_by, department, start_at, end_at FROM bookings WHERE room_id=$1 AND status=\'confirmed\' AND start_at < $2 AND end_at > $3 AND id<>$4 LIMIT 1',
            [Number(bookingData.room_id), bookingData.end_at, bookingData.start_at, Number(id)]
          );
          if (conflictResult.rows[0]) {
            const err = new Error('⛔ ไม่สามารถจองซ้ำได้! ห้อง ' + room.name + ' ถูกจองแล้วในช่วงเวลาดังกล่าว');
            err.status = 409;
            err.conflict = { ...conflictResult.rows[0], room_name: room.name };
            throw err;
          }
          await client.query(
            'UPDATE bookings SET room_id=$1, title=$2, start_at=$3, end_at=$4, note=$5, updated_at=$6 WHERE id=$7',
            [Number(bookingData.room_id), bookingData.title, bookingData.start_at, bookingData.end_at, bookingData.note || '', new Date().toISOString(), Number(id)]
          );
          const updated = await client.query('SELECT id, room_id, emp_code, title, booked_by, department, start_at, end_at, note, pin, status, created_at, updated_at FROM bookings WHERE id=$1', [Number(id)]);
          await client.query('COMMIT');
          return updated.rows[0];
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch (_) {}
          throw err;
        } finally {
          client.release();
        }
      },
      async cancel(id) {
        const result = await db.query(
          "UPDATE bookings SET status='cancelled', updated_at=$1 WHERE id=$2 RETURNING id, room_id, emp_code, title, booked_by, department, start_at, end_at, note, pin, status, created_at, updated_at",
          [new Date().toISOString(), Number(id)]
        );
        return result.rows[0] || null;
      }
    };
  }

  // Firestore provider
  async function getNextId(transaction, colName = 'bookings') {
    const counterRef = db.collection('_counters').doc(colName);
    const doc = await (transaction ? transaction.get(counterRef) : counterRef.get());
    let current = 0;
    if (doc.exists) {
      current = doc.data().current || 0;
    }
    const next = current + 1;
    if (transaction) {
      transaction.set(counterRef, { current: next }, { merge: true });
    } else {
      await counterRef.set({ current: next }, { merge: true });
    }
    return next;
  }

  return {
    async getById(id) {
      const doc = await db.collection('bookings').doc(String(id)).get();
      if (!doc.exists) return null;
      return { id: Number(doc.id), ...doc.data() };
    },
    async getAll(filter = {}) {
      let query = db.collection('bookings');
      if (filter.room_id) {
        query = query.where('room_id', '==', Number(filter.room_id));
      }
      if (filter.status) {
        query = query.where('status', '==', filter.status);
      }

      const snap = await query.get();
      let bookings = [];

      // Fetch rooms map for room_name, room_color, room_location
      const roomsSnap = await db.collection('rooms').get();
      const roomsMap = {};
      roomsSnap.forEach(d => { roomsMap[Number(d.id)] = d.data(); });

      snap.forEach(doc => {
        const b = { id: Number(doc.id), ...doc.data() };
        const r = roomsMap[b.room_id] || {};
        b.room_name = r.name || 'ห้องประชุม';
        b.room_color = r.color || '#ff6a00';
        b.room_location = r.location || '';

        if (filter.date) {
          const sMatch = b.start_at && b.start_at.startsWith(filter.date);
          const eMatch = b.end_at && b.end_at.startsWith(filter.date);
          if (!sMatch && !eMatch) return;
        }

        bookings.push(b);
      });

      return bookings.sort((a, b) => (a.start_at > b.start_at ? 1 : -1));
    },
    async findConflict(roomId, startAt, endAt, excludeBookingId = null) {
      const snap = await db.collection('bookings')
        .where('room_id', '==', Number(roomId))
        .where('status', '==', 'confirmed')
        .get();

      for (const doc of snap.docs) {
        if (excludeBookingId && Number(doc.id) === Number(excludeBookingId)) continue;
        const b = doc.data();
        if (b.start_at < endAt && b.end_at > startAt) {
          const roomDoc = await db.collection('rooms').doc(String(roomId)).get();
          const roomName = roomDoc.exists ? roomDoc.data().name : '';
          return { id: Number(doc.id), ...b, room_name: roomName };
        }
      }
      return null;
    },
    async createAtomic(bookingData) {
      return db.runTransaction(async (transaction) => {
        const roomIdStr = String(bookingData.room_id);
        const roomRef = db.collection('rooms').doc(roomIdStr);
        const roomDoc = await transaction.get(roomRef);
        if (!roomDoc.exists || roomDoc.data().is_active === 0) {
          const err = new Error('ไม่พบห้องประชุม หรือห้องถูกปิดใช้งาน');
          err.status = 400;
          throw err;
        }
        const roomData = roomDoc.data();

        // Query confirmed bookings for this room within the transaction
        const bookingsQuery = db.collection('bookings')
          .where('room_id', '==', Number(bookingData.room_id))
          .where('status', '==', 'confirmed');
        const snapshot = await transaction.get(bookingsQuery);

        for (const doc of snapshot.docs) {
          const b = doc.data();
          if (b.start_at < bookingData.end_at && b.end_at > bookingData.start_at) {
            const err = new Error(`⛔ ไม่สามารถจองซ้ำได้! ห้อง ${roomData.name} ถูกจองแล้วในช่วงเวลาดังกล่าว`);
            err.status = 409;
            err.conflict = {
              title: b.title,
              booked_by: b.booked_by,
              start_at: b.start_at,
              end_at: b.end_at,
              room_name: roomData.name
            };
            throw err;
          }
        }

        const nextId = await getNextId(transaction, 'bookings');
        const newBooking = {
          id: nextId,
          room_id: Number(bookingData.room_id),
          emp_code: bookingData.emp_code || '',
          title: bookingData.title,
          booked_by: bookingData.booked_by,
          department: bookingData.department || '',
          start_at: bookingData.start_at,
          end_at: bookingData.end_at,
          note: bookingData.note || '',
          pin: bookingData.pin,
          status: 'confirmed',
          created_at: new Date().toISOString()
        };

        const docRef = db.collection('bookings').doc(String(nextId));
        transaction.set(docRef, newBooking);
        return newBooking;
      });
    },
    async updateAtomic(id, bookingData) {
      return db.runTransaction(async (transaction) => {
        const roomIdStr = String(bookingData.room_id);
        const roomRef = db.collection('rooms').doc(roomIdStr);
        const roomDoc = await transaction.get(roomRef);
        if (!roomDoc.exists || roomDoc.data().is_active === 0) {
          const err = new Error('ไม่พบห้องประชุม หรือห้องถูกปิดใช้งาน');
          err.status = 400;
          throw err;
        }
        const roomData = roomDoc.data();

        const bookingsQuery = db.collection('bookings')
          .where('room_id', '==', Number(bookingData.room_id))
          .where('status', '==', 'confirmed');
        const snapshot = await transaction.get(bookingsQuery);

        for (const doc of snapshot.docs) {
          if (Number(doc.id) === Number(id)) continue;
          const b = doc.data();
          if (b.start_at < bookingData.end_at && b.end_at > bookingData.start_at) {
            const err = new Error(`⛔ ไม่สามารถจองซ้ำได้! ห้อง ${roomData.name} ถูกจองแล้วในช่วงเวลาดังกล่าว`);
            err.status = 409;
            err.conflict = {
              title: b.title,
              booked_by: b.booked_by,
              start_at: b.start_at,
              end_at: b.end_at,
              room_name: roomData.name
            };
            throw err;
          }
        }

        const docRef = db.collection('bookings').doc(String(id));
        transaction.set(docRef, {
          room_id: Number(bookingData.room_id),
          title: bookingData.title,
          start_at: bookingData.start_at,
          end_at: bookingData.end_at,
          note: bookingData.note || '',
          updated_at: new Date().toISOString()
        }, { merge: true });

        const updatedDoc = await transaction.get(docRef);
        return { id: Number(id), ...updatedDoc.data() };
      });
    },
    async cancel(id) {
      const docRef = db.collection('bookings').doc(String(id));
      await docRef.update({
        status: 'cancelled',
        updated_at: new Date().toISOString()
      });
      return this.getById(id);
    }
  };
}

module.exports = { createBookingsRepository };
