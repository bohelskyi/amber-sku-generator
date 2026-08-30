const fs = require('fs/promises');
const path = require('path');
const crypto = require('node:crypto');
const pool = require('./pool');

const MIGRATIONS_LOCK_KEY = 'amber_schema_migrations';
const migrationsDirectory = path.resolve(__dirname, '../../migrations');

async function runMigrations() {
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATIONS_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');

    const migrationFiles = (await fs.readdir(migrationsDirectory))
      .filter((fileName) => fileName.endsWith('.sql'))
      .sort();
    const appliedResult = await client.query('SELECT name, checksum FROM schema_migrations');
    const appliedMigrations = new Map(
      appliedResult.rows.map((row) => [row.name, row.checksum])
    );

    for (const fileName of migrationFiles) {
      const sql = await fs.readFile(path.join(migrationsDirectory, fileName), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      if (appliedMigrations.has(fileName)) {
        const appliedChecksum = appliedMigrations.get(fileName);
        if (!appliedChecksum) {
          await client.query(
            'UPDATE schema_migrations SET checksum = $1 WHERE name = $2 AND checksum IS NULL',
            [checksum, fileName]
          );
        } else if (appliedChecksum !== checksum) {
          throw new Error(`Migration checksum mismatch: ${fileName}`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [fileName, checksum]
        );
        await client.query('COMMIT');
        console.log(`Applied migration ${fileName}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATIONS_LOCK_KEY]);
    client.release();
  }
}

module.exports = { runMigrations };
