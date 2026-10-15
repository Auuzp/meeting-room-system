const { createSqliteDb } = require('./sqlite');
const { createPostgresDb } = require('./postgres');
const { initFirestore, getFirestore } = require('./firestore');
const { createRoomsRepository } = require('./repositories/rooms');
const { createEmployeesRepository } = require('./repositories/employees');
const { createBookingsRepository } = require('./repositories/bookings');
const { createSettingsRepository } = require('./repositories/settings');

let currentProvider = normalizeProvider(process.env.DB_PROVIDER);
let dbInstance = null;
let repos = null;

function normalizeProvider(provider) {
  const name = String(provider || 'sqlite').trim().toLowerCase();
  if (name === 'firestore') return 'firestore';
  if (name === 'postgres' || name === 'postgresql' || name === 'neon') return 'postgres';
  return 'sqlite';
}

function initDatabase(provider = null, options = {}) {
  const chosenProvider = provider || process.env.DB_PROVIDER || 'sqlite';
  currentProvider = normalizeProvider(chosenProvider);

  if (currentProvider === 'firestore') {
    dbInstance = options.firestore || initFirestore(options);
  } else if (currentProvider === 'postgres') {
    dbInstance = options.postgres || createPostgresDb(options);
  } else {
    dbInstance = options.sqlite || createSqliteDb(options.dbPath);
  }

  repos = {
    rooms: createRoomsRepository(dbInstance, currentProvider),
    employees: createEmployeesRepository(dbInstance, currentProvider),
    bookings: createBookingsRepository(dbInstance, currentProvider),
    settings: createSettingsRepository(dbInstance, currentProvider)
  };

  return {
    provider: currentProvider,
    db: dbInstance,
    repositories: repos
  };
}

function getDatabase() {
  if (!repos) {
    return initDatabase();
  }
  return {
    provider: currentProvider,
    db: dbInstance,
    repositories: repos
  };
}

module.exports = {
  initDatabase,
  getDatabase
};
