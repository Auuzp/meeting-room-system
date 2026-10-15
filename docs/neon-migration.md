# Firestore to Neon migration

The app can use Neon PostgreSQL while keeping the existing Render URL. The migration copies Firestore settings, rooms, employees, bookings, and numeric ID counters. It preserves document IDs, booking PIN hashes, status values, timestamps, and existing Firestore records. It does not delete or modify the source database.

## Prepare Neon

1. Create a Neon project and database, then copy its PostgreSQL connection string. Keep it private.
2. In the Render service environment, add `DATABASE_URL` with that connection string.
3. Keep `DB_PROVIDER=firestore` for now. Add `ALLOW_FIRESTORE_TO_POSTGRES_MIGRATION=true`.
4. Save the environment changes and wait for the service to restart.

## Copy and verify

1. Open `https://meeting-room-system-dwwx.onrender.com/neon-migration.html`.
2. Enter the Admin PIN and start the copy.
3. Continue only when the page says the copy was verified and shows counts for settings, rooms, employees, and bookings.
4. If Firestore reports a quota error, no destination transaction is written. Wait for Firestore reads to be available, then retry.

The migration page and endpoint are only usable while the environment flag is enabled. Admin PIN checks and rate limits apply. API writes are paused briefly while the copy runs.

## Switch the app

After successful verification, change the Render environment to:

- `DB_PROVIDER=postgres`
- `ALLOW_FIRESTORE_TO_POSTGRES_MIGRATION=false` (or remove the flag)

Save and deploy. The public Render URL does not change. The app initializes the Neon tables and indexes on startup.

Keep Firestore intact as a source snapshot. If switching back before users create or edit bookings in Neon, set `DB_PROVIDER=firestore`. After the new database has accepted changes, switching back requires reconciliation so those new changes are not lost.

The temporary connection should use a Neon plan and region that meet the app's expected availability and latency. Free plans may change their limits and are not a guaranteed lifetime commitment.
