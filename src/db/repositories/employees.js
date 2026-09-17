function createEmployeesRepository(db, provider = 'sqlite') {
  if (provider === 'sqlite') {
    return {
      getAll() {
        return db.prepare("SELECT * FROM employees ORDER BY id DESC").all();
      },
      getById(id) {
        return db.prepare("SELECT * FROM employees WHERE id = ?").get(id);
      },
      getByCode(code, excludeId = null) {
        if (!code) return null;
        let sql = "SELECT * FROM employees WHERE UPPER(emp_code) = UPPER(?)";
        const params = [code];
        if (excludeId) {
          sql += " AND id != ?";
          params.push(excludeId);
        }
        return db.prepare(sql).get(...params);
      },
      findByKeyword(keyword) {
        if (!keyword) return null;
        const clean = keyword.trim();
        return db.prepare(`
          SELECT * FROM employees
          WHERE UPPER(emp_code) = UPPER(?)
             OR name LIKE ?
          LIMIT 1
        `).get(clean, `%${clean}%`);
      },
      create(data) {
        const stmt = db.prepare(`
          INSERT INTO employees (emp_code, name, department, position, is_active)
          VALUES (?, ?, ?, ?, 1)
        `);
        const result = stmt.run(data.emp_code, data.name, data.department, data.position || '');
        return { id: Number(result.lastInsertRowid), ...data, is_active: 1 };
      },
      update(id, data) {
        db.prepare(`
          UPDATE employees
          SET emp_code = ?, name = ?, department = ?, position = ?, is_active = ?
          WHERE id = ?
        `).run(data.emp_code, data.name, data.department, data.position || '', data.is_active, id);
        return this.getById(id);
      },
      delete(id) {
        db.prepare("DELETE FROM employees WHERE id = ?").run(id);
      }
    };
  }

  // Firestore provider
  async function getNextId(colName = 'employees') {
    const counterRef = db.collection('_counters').doc(colName);
    const doc = await counterRef.get();
    let current = 0;
    if (doc.exists) {
      current = doc.data().current || 0;
    }
    const next = current + 1;
    await counterRef.set({ current: next }, { merge: true });
    return next;
  }

  return {
    async getAll() {
      const snap = await db.collection('employees').get();
      const emps = [];
      snap.forEach(doc => {
        emps.push({ id: Number(doc.id), ...doc.data() });
      });
      return emps.sort((a, b) => b.id - a.id);
    },
    async getById(id) {
      const doc = await db.collection('employees').doc(String(id)).get();
      if (!doc.exists) return null;
      return { id: Number(doc.id), ...doc.data() };
    },
    async getByCode(code, excludeId = null) {
      if (!code) return null;
      const snap = await db.collection('employees').get();
      for (const doc of snap.docs) {
        const data = doc.data();
        if (data.emp_code && data.emp_code.toUpperCase() === code.toUpperCase()) {
          if (excludeId && Number(doc.id) === Number(excludeId)) continue;
          return { id: Number(doc.id), ...data };
        }
      }
      return null;
    },
    async findByKeyword(keyword) {
      if (!keyword) return null;
      const clean = keyword.trim().toLowerCase();
      const snap = await db.collection('employees').get();
      for (const doc of snap.docs) {
        const data = doc.data();
        const codeMatch = data.emp_code && data.emp_code.toLowerCase() === clean;
        const nameMatch = data.name && data.name.toLowerCase().includes(clean);
        if (codeMatch || nameMatch) {
          return { id: Number(doc.id), ...data };
        }
      }
      return null;
    },
    async create(data) {
      const id = await getNextId('employees');
      const docData = {
        id,
        emp_code: data.emp_code,
        name: data.name,
        department: data.department,
        position: data.position || '',
        is_active: data.is_active !== undefined ? data.is_active : 1,
        created_at: new Date().toISOString()
      };
      await db.collection('employees').doc(String(id)).set(docData);
      return docData;
    },
    async update(id, data) {
      const docRef = db.collection('employees').doc(String(id));
      await docRef.set({
        emp_code: data.emp_code,
        name: data.name,
        department: data.department,
        position: data.position || '',
        is_active: data.is_active !== undefined ? data.is_active : 1,
        updated_at: new Date().toISOString()
      }, { merge: true });
      return this.getById(id);
    },
    async delete(id) {
      await db.collection('employees').doc(String(id)).delete();
    }
  };
}

module.exports = { createEmployeesRepository };
