const fs = require('fs/promises');
const path = require('path');
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
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const migrationFiles = (await fs.readdir(migrationsDirectory))
      .filter((fileName) => fileName.endsWith('.sql'))
      .sort();
    const appliedResult = await client.query('SELECT name FROM schema_migrations');
    const appliedMigrations = new Set(appliedResult.rows.map((row) => row.name));

    for (const fileName of migrationFiles) {
      if (appliedMigrations.has(fileName)) continue;

      const sql = await fs.readFile(path.join(migrationsDirectory, fileName), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [fileName]);
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
