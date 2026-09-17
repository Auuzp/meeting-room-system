const { createSqliteDb } = require('./sqlite');
const { initFirestore, getFirestore } = require('./firestore');
const { createRoomsRepository } = require('./repositories/rooms');
const { createEmployeesRepository } = require('./repositories/employees');
const { createBookingsRepository } = require('./repositories/bookings');
const { createSettingsRepository } = require('./repositories/settings');

let currentProvider = process.env.DB_PROVIDER === 'firestore' ? 'firestore' : 'sqlite';
let dbInstance = null;
let repos = null;

function initDatabase(provider = null, options = {}) {
  const chosenProvider = provider || process.env.DB_PROVIDER || 'sqlite';
  currentProvider = chosenProvider === 'firestore' ? 'firestore' : 'sqlite';

  if (currentProvider === 'firestore') {
    dbInstance = options.firestore || initFirestore(options);
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
