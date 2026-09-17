const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

function createSqliteDb(dbPath) {
  const finalPath = dbPath || process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'meeting_rooms.db');
  const dbDir = path.dirname(finalPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new DatabaseSync(finalPath);

  // Setup Tables & Migrations
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emp_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      department TEXT NOT NULL,
      position TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      name TEXT NOT NULL,
      capacity INTEGER DEFAULT 10,
      location TEXT,
      color TEXT DEFAULT '#ff6a00',
      amenities TEXT DEFAULT '[]',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      emp_code TEXT,
      title TEXT NOT NULL,
      booked_by TEXT NOT NULL,
      department TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      note TEXT,
      pin TEXT,
      status TEXT DEFAULT 'confirmed',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(room_id) REFERENCES rooms(id)
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_time ON bookings(room_id, start_at, end_at, status);
  `);

  return db;
}

module.exports = {
  createSqliteDb
};
