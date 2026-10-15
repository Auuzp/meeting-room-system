const { Pool, types } = require('pg');

// PostgreSQL BIGINT values are safe as JavaScript numbers for this app's numeric IDs.
types.setTypeParser(20, (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
});

function createPostgresDb(options = {}) {
  const connectionString = options.connectionString || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required when DB_PROVIDER=postgres');
  }

  const pool = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX) || 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS) || 30000
  });

  pool.on('error', (err) => {
    console.error('[postgres] Idle connection error:', err.code || err.name || 'unknown');
  });

  const schema = [
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TEXT)",
    "CREATE TABLE IF NOT EXISTS employees (id BIGSERIAL PRIMARY KEY, emp_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, department TEXT NOT NULL, position TEXT, is_active SMALLINT NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP::text, updated_at TEXT)",
    "CREATE TABLE IF NOT EXISTS rooms (id BIGSERIAL PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, capacity INTEGER DEFAULT 10, location TEXT, color TEXT DEFAULT '#ff6a00', amenities TEXT DEFAULT '[]', is_active SMALLINT NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP::text, updated_at TEXT)",
    "CREATE TABLE IF NOT EXISTS bookings (id BIGSERIAL PRIMARY KEY, room_id BIGINT NOT NULL REFERENCES rooms(id), emp_code TEXT, title TEXT NOT NULL, booked_by TEXT NOT NULL, department TEXT, start_at TEXT NOT NULL, end_at TEXT NOT NULL, note TEXT, pin TEXT, status TEXT DEFAULT 'confirmed', created_at TEXT DEFAULT CURRENT_TIMESTAMP::text, updated_at TEXT)",
    "CREATE INDEX IF NOT EXISTS idx_bookings_time ON bookings(room_id, start_at, end_at, status)"
  ].join(';\n');

  const nativeQuery = pool.query.bind(pool);
  const nativeConnect = pool.connect.bind(pool);
  let schemaReady = null;

  // Neon can pause its free compute after inactivity. Initialize lazily and allow
  // a later request to retry if the first connection attempt times out.
  function ensureSchema() {
    if (!schemaReady) {
      schemaReady = nativeQuery(schema).catch((err) => {
        schemaReady = null;
        console.error('[postgres] Schema initialization failed:', err.code || err.name || 'unknown');
        throw err;
      });
      // The request awaiting this promise handles the failure. This handler also
      // prevents an unobserved initialization rejection from terminating Node.
      schemaReady.catch(() => {});
    }
    return schemaReady;
  }

  pool.query = async (...args) => {
    await ensureSchema();
    return nativeQuery(...args);
  };
  pool.connect = async () => {
    await ensureSchema();
    return nativeConnect();
  };

  return pool;
}

module.exports = { createPostgresDb };
