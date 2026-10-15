function createRoomsRepository(db, provider = 'sqlite') {
  if (provider === 'sqlite') {
    return {
      getAll(activeOnly = true) {
        let sql = "SELECT * FROM rooms";
        if (activeOnly) sql += " WHERE is_active = 1";
        sql += " ORDER BY id ASC";
        return db.prepare(sql).all();
      },
      getById(id, activeOnly = false) {
        let sql = "SELECT * FROM rooms WHERE id = ?";
        if (activeOnly) sql += " AND is_active = 1";
        return db.prepare(sql).get(id);
      },
      getByCode(code, excludeId = null) {
        let sql = "SELECT id FROM rooms WHERE UPPER(code) = UPPER(?)";
        const params = [code];
        if (excludeId) {
          sql += " AND id != ?";
          params.push(excludeId);
        }
        return db.prepare(sql).get(...params);
      },
      getByNameOrCode(name, code) {
        return db.prepare("SELECT id FROM rooms WHERE (name = ? OR code = ?) AND is_active = 1").get(name, code);
      },
      create(roomData) {
        const stmt = db.prepare(`
          INSERT INTO rooms (code, name, capacity, location, color, amenities, is_active)
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `);
        const result = stmt.run(
          roomData.code,
          roomData.name,
          roomData.capacity,
          roomData.location,
          roomData.color,
          roomData.amenities
        );
        return { id: Number(result.lastInsertRowid), ...roomData, is_active: 1 };
      },
      update(id, roomData) {
        db.prepare(`
          UPDATE rooms
          SET code = ?, name = ?, capacity = ?, location = ?, color = ?, amenities = ?
          WHERE id = ?
        `).run(
          roomData.code,
          roomData.name,
          roomData.capacity,
          roomData.location,
          roomData.color,
          roomData.amenities,
          id
        );
        return this.getById(id);
      },
      deactivate(id) {
        db.prepare("UPDATE rooms SET is_active = 0 WHERE id = ?").run(id);
      }
    };
  }

  if (provider === 'postgres') {
    return {
      async getAll(activeOnly = true) {
        const result = await db.query(
          'SELECT id, code, name, capacity, location, color, amenities, is_active, created_at, updated_at FROM rooms' +
          (activeOnly ? ' WHERE is_active = 1' : '') + ' ORDER BY id ASC'
        );
        return result.rows;
      },
      async getById(id, activeOnly = false) {
        const result = await db.query(
          'SELECT id, code, name, capacity, location, color, amenities, is_active, created_at, updated_at FROM rooms WHERE id = $1' +
          (activeOnly ? ' AND is_active = 1' : ''),
          [Number(id)]
        );
        return result.rows[0] || null;
      },
      async getByCode(code, excludeId = null) {
        if (!code) return null;
        const result = await db.query(
          'SELECT id FROM rooms WHERE UPPER(code) = UPPER($1) AND ($2::bigint IS NULL OR id <> $2)',
          [code, excludeId ? Number(excludeId) : null]
        );
        return result.rows[0] || null;
      },
      async getByNameOrCode(name, code) {
        const result = await db.query(
          'SELECT id, code, name, capacity, location, color, amenities, is_active, created_at, updated_at FROM rooms WHERE is_active = 1 AND (($1 <> \'\' AND name = $1) OR ($2 <> \'\' AND code = $2)) LIMIT 1',
          [name || '', code || '']
        );
        return result.rows[0] || null;
      },
      async create(roomData) {
        const result = await db.query(
          "INSERT INTO rooms (code, name, capacity, location, color, amenities, is_active) VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING id, code, name, capacity, location, color, amenities, is_active, created_at, updated_at",
          [roomData.code || '', roomData.name, roomData.capacity || 10, roomData.location || '', roomData.color || '#ff6a00', roomData.amenities || '[]']
        );
        return result.rows[0];
      },
      async update(id, roomData) {
        await db.query(
          'UPDATE rooms SET code=$1, name=$2, capacity=$3, location=$4, color=$5, amenities=$6, updated_at=$7 WHERE id=$8',
          [roomData.code, roomData.name, roomData.capacity, roomData.location, roomData.color, roomData.amenities, new Date().toISOString(), Number(id)]
        );
        return this.getById(id);
      },
      async deactivate(id) {
        await db.query('UPDATE rooms SET is_active=0, updated_at=$1 WHERE id=$2', [new Date().toISOString(), Number(id)]);
      }
    };
  }

  // Firestore provider
  async function getNextId(transaction, colName = 'rooms') {
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
    async getAll(activeOnly = true) {
      let query = db.collection('rooms');
      if (activeOnly) {
        query = query.where('is_active', '==', 1);
      }
      const snapshot = await query.get();
      const rooms = [];
      snapshot.forEach(doc => {
        rooms.push({ id: Number(doc.id), ...doc.data() });
      });
      return rooms.sort((a, b) => a.id - b.id);
    },
    async getById(id, activeOnly = false) {
      const doc = await db.collection('rooms').doc(String(id)).get();
      if (!doc.exists) return null;
      const data = { id: Number(doc.id), ...doc.data() };
      if (activeOnly && data.is_active !== 1) return null;
      return data;
    },
    async getByCode(code, excludeId = null) {
      if (!code) return null;
      const snapshot = await db.collection('rooms').get();
      for (const doc of snapshot.docs) {
        const data = doc.data();
        if (data.code && data.code.toUpperCase() === code.toUpperCase()) {
          if (excludeId && Number(doc.id) === Number(excludeId)) continue;
          return { id: Number(doc.id), ...data };
        }
      }
      return null;
    },
    async getByNameOrCode(name, code) {
      const snapshot = await db.collection('rooms').where('is_active', '==', 1).get();
      for (const doc of snapshot.docs) {
        const data = doc.data();
        if ((name && data.name === name) || (code && data.code === code)) {
          return { id: Number(doc.id), ...data };
        }
      }
      return null;
    },
    async create(roomData) {
      const id = await getNextId(null, 'rooms');
      const docData = {
        id,
        code: roomData.code || '',
        name: roomData.name,
        capacity: roomData.capacity || 10,
        location: roomData.location || '',
        color: roomData.color || '#ff6a00',
        amenities: roomData.amenities || '[]',
        is_active: 1,
        created_at: new Date().toISOString()
      };
      await db.collection('rooms').doc(String(id)).set(docData);
      return docData;
    },
    async update(id, roomData) {
      const docRef = db.collection('rooms').doc(String(id));
      await docRef.set({
        code: roomData.code,
        name: roomData.name,
        capacity: roomData.capacity,
        location: roomData.location,
        color: roomData.color,
        amenities: roomData.amenities,
        updated_at: new Date().toISOString()
      }, { merge: true });
      return this.getById(id);
    },
    async deactivate(id) {
      await db.collection('rooms').doc(String(id)).update({
        is_active: 0,
        updated_at: new Date().toISOString()
      });
    }
  };
}

module.exports = { createRoomsRepository };
