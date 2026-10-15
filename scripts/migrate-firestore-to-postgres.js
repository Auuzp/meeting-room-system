#!/usr/bin/env node
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch (_) {}
}

const { initFirestore } = require('../src/db/firestore');
const { createPostgresDb } = require('../src/db/postgres');
const { migrateFirestoreToPostgres, getFirestoreCollectionCounts } = require('../src/db/migrate-firestore-to-postgres');

async function main() {
  const apply = process.argv.includes('--apply');
  const firestore = initFirestore();
  if (!apply) {
    const counts = await getFirestoreCollectionCounts(firestore);
    console.log('Dry run only. No records were written.');
    console.log(JSON.stringify(counts, null, 2));
    console.log('Run again with --apply to copy the records.');
    return;
  }

  const pool = createPostgresDb();
  try {
    const result = await migrateFirestoreToPostgres(firestore, pool);
    console.log(result.alreadyMigrated ? 'Destination already matches Firestore.' : 'Migration completed and verified.');
    console.log(JSON.stringify(result.counts, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Firestore to Neon migration failed:', err.code || err.name || 'unknown error');
  console.error(err.message);
  process.exitCode = 1;
});
