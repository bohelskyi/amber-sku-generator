const fs = require('fs/promises');
const path = require('path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { DATABASE_URL, useSsl } = require('../config/env');

const MIGRATIONS_LOCK_KEY = 'amber_schema_migrations';
const migrationsDirectory = path.resolve(__dirname, '../../migrations');

function migrationQuery(client, text, values = []) {
  return client.query({ text, values, query_timeout: 0 });
}

function getMigrationChecksum(sql) {
  const canonicalSql = String(sql).replace(/\r\n?/g, '\n');
  return crypto.createHash('sha256').update(canonicalSql).digest('hex');
}

async function runMigrations({ directory = migrationsDirectory } = {}) {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 5000),
    query_timeout: 0,
    statement_timeout: 0,
  });
  await client.connect();

  try {
    await migrationQuery(client, 'SET statement_timeout = 0');
    await migrationQuery(client, 'SELECT pg_advisory_lock(hashtext($1))', [MIGRATIONS_LOCK_KEY]);
    await migrationQuery(client, `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await migrationQuery(
      client,
      'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT'
    );

    const migrationFiles = (await fs.readdir(directory))
      .filter((fileName) => fileName.endsWith('.sql'))
      .sort();
    const appliedResult = await migrationQuery(
      client,
      'SELECT name, checksum FROM schema_migrations'
    );
    const appliedMigrations = new Map(
      appliedResult.rows.map((row) => [row.name, row.checksum])
    );

    for (const fileName of migrationFiles) {
      const sql = await fs.readFile(path.join(directory, fileName), 'utf8');
      const checksum = getMigrationChecksum(sql);
      if (appliedMigrations.has(fileName)) {
        const appliedChecksum = appliedMigrations.get(fileName);
        if (!appliedChecksum) {
          await migrationQuery(
            client,
            'UPDATE schema_migrations SET checksum = $1 WHERE name = $2 AND checksum IS NULL',
            [checksum, fileName]
          );
        } else if (appliedChecksum !== checksum) {
          throw new Error(`Migration checksum mismatch: ${fileName}`);
        }
        continue;
      }

      await migrationQuery(client, 'BEGIN');
      try {
        await migrationQuery(client, sql);
        await migrationQuery(
          client,
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [fileName, checksum]
        );
        await migrationQuery(client, 'COMMIT');
        console.log(`Applied migration ${fileName}`);
      } catch (err) {
        await migrationQuery(client, 'ROLLBACK');
        throw err;
      }
    }
  } finally {
    await migrationQuery(
      client,
      'SELECT pg_advisory_unlock(hashtext($1))',
      [MIGRATIONS_LOCK_KEY]
    );
    await client.end();
  }
}

module.exports = { getMigrationChecksum, runMigrations };
