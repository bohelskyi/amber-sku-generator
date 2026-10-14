'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_BYTES = 64 * 1024 * 1024, MAX_RECORD = 4 * 1024 * 1024;
const fail = code => { throw Object.assign(Error(code), { code }); };
async function syncDirectory(io, directory) {
  if (process.platform === 'win32') return;
  const handle = await io.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readLimited(io, file, max = MAX_BYTES) {
  const handle = await io.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) fail('SV_CAMPAIGN_FILE_LIMIT');
    const data = await handle.readFile();
    if (data.length > max) fail('SV_CAMPAIGN_FILE_LIMIT');
    return data;
  } finally { await handle.close(); }
}
async function writeAll(handle, bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) fail('SV_CAMPAIGN_OUTPUT_STALLED');
    offset += bytesWritten;
  }
  await handle.sync();
}
function parseJournal(bytes, runtime) {
  if (!bytes.length || bytes.at(-1) !== 10) fail('SV_CAMPAIGN_JOURNAL_INCOMPLETE');
  let rows;
  try { rows = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line)); }
  catch { fail('SV_CAMPAIGN_JOURNAL_INVALID'); }
  let previousHash = null;
  for (const [seq, row] of rows.entries()) {
    if (!row || Object.keys(row).sort().join(',') !== 'hash,previousHash,record,seq'
      || row.seq !== seq || row.previousHash !== previousHash
      || !row.record || typeof row.record.type !== 'string'
      || runtime.c.hash({ seq, previousHash, record: row.record }) !== row.hash)
      fail('SV_CAMPAIGN_JOURNAL_CHANGED');
    previousHash = row.hash;
  }
  if (rows[0]?.record.type !== 'start') fail('SV_CAMPAIGN_JOURNAL_INVALID');
  return rows;
}
async function openJournal({ directory, mode, header, runtime, io = fs }) {
  if (!['run', 'resume'].includes(mode)) fail('SV_CAMPAIGN_MODE_INVALID');
  let handle, lock, poisoned = false;
  const lockPath = path.join(directory, 'run.lock'), file = path.join(directory, 'journal.jsonl');
  try {
    if (mode === 'run') {
      await io.mkdir(directory, { mode: 0o700 });
      await syncDirectory(io, path.dirname(path.resolve(directory)));
    }
    lock = await io.open(lockPath, 'wx', 0o600);
    await writeAll(lock, Buffer.from(JSON.stringify({ pid: process.pid }) + '\n'));
    await syncDirectory(io, directory);
    const rows = mode === 'resume' ? parseJournal(await readLimited(io, file), runtime) : [];
    const existingHeader = rows[0]?.record;
    if (existingHeader) {
      const { type, runId, ...saved } = existingHeader;
      if (type !== 'start' || typeof runId !== 'string' || runtime.c.hash(saved) !== runtime.c.hash(header))
        fail('SV_CAMPAIGN_RUN_CHANGED');
    }
    const runId = existingHeader?.runId || randomUUID();
    const records = rows.map(row => row.record);
    let previousHash = rows.at(-1)?.hash || null, length = mode === 'resume' ? (await io.stat(file)).size : 0;
    handle = await io.open(file, mode === 'resume' ? 'a' : 'wx', 0o600);
    await syncDirectory(io, directory);
    const append = async record => {
      if (poisoned) fail('SV_CAMPAIGN_JOURNAL_POISONED');
      try {
        if (!record || typeof record.type !== 'string') fail('SV_CAMPAIGN_RECORD_INVALID');
        const sealed = structuredClone(record), seq = records.length;
        const body = { seq, previousHash, record: sealed }, hash = runtime.c.hash(body);
        const bytes = Buffer.from(JSON.stringify({ ...body, hash }) + '\n');
        if (bytes.length > MAX_RECORD || length + bytes.length > MAX_BYTES) fail('SV_CAMPAIGN_JOURNAL_LIMIT');
        await writeAll(handle, bytes);
        records.push(sealed); previousHash = hash; length += bytes.length;
      } catch (error) { poisoned = true; error.journalFailure = true; throw error; }
    };
    if (!existingHeader) await append({ type: 'start', runId, ...header });
    return { records, runId, append, async close() {
      await handle.close(); handle = null;
      await lock.close(); lock = null;
      if (!poisoned) { await io.unlink(lockPath); await syncDirectory(io, directory); }
    } };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (lock) {
      await lock.close().catch(() => {});
      // A failed write is not a safe checkpoint. Preserve its lock for reconciliation.
      if (!poisoned && !error.journalFailure) await io.unlink(lockPath).catch(() => {});
    }
    throw error;
  }
}
module.exports = { openJournal, parseJournal, readLimited, writeAll, syncDirectory, MAX_BYTES };
