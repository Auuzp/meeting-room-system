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
