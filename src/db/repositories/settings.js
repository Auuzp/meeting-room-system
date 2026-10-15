function createSettingsRepository(db, provider = 'sqlite') {
  if (provider === 'sqlite') {
    return {
      get(key) {
        return db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
      },
      set(key, value) {
        db.prepare(`
          INSERT INTO settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(key, value);
      },
      getAll() {
        const rows = db.prepare("SELECT key, value FROM settings").all();
        const res = {};
        rows.forEach(r => { res[r.key] = r.value; });
        return res;
      }
    };
  }

  if (provider === 'postgres') {
    return {
      async get(key) {
        const result = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
        return result.rows[0] || null;
      },
      async set(key, value) {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new Error('Setting value cannot be undefined');
        await db.query(
          'INSERT INTO settings (key, value, updated_at) VALUES ($1,$2::jsonb,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at',
          [key, serialized, new Date().toISOString()]
        );
      },
      async getAll() {
        const result = await db.query('SELECT key, value FROM settings');
        const values = {};
        result.rows.forEach((row) => { values[row.key] = row.value; });
        return values;
      }
    };
  }

  // Firestore provider
  return {
    async get(key) {
      const doc = await db.collection('settings').doc(key).get();
      if (!doc.exists) return null;
      return { value: doc.data().value };
    },
    async set(key, value) {
      await db.collection('settings').doc(key).set({
        value,
        updated_at: new Date().toISOString()
      }, { merge: true });
    },
    async getAll() {
      const snap = await db.collection('settings').get();
      const res = {};
      snap.forEach(doc => {
        res[doc.id] = doc.data().value;
      });
      return res;
    }
  };
}

module.exports = { createSettingsRepository };
