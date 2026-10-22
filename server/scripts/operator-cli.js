'use strict';
// Offline command boundary only. Domain decisions and mutations stay in the UI services.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const CONTRACT = 'amber-operator-review-v1';
const MAX_BYTES = 4 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(Error(code), { code }); };
const safeCode = cause => cause?.code === 'EEXIST' ? 'OPERATOR_OUTPUT_EXISTS'
  : typeof cause?.code === 'string' && /^[A-Z][A-Z0-9_]{0,159}$/.test(cause.code) ? cause.code : 'OPERATOR_FAILED';

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  fail('OPERATOR_PLAN_INVALID');
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

async function readBytes(file, maxBytes) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) fail('OPERATOR_INPUT_LIMIT');
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) fail('OPERATOR_INPUT_LIMIT');
    return bytes.toString('utf8');
  } finally { await handle.close(); }
}
async function readJson(file, maxBytes = MAX_BYTES) {
  const text = await readBytes(file, maxBytes);
  try { return JSON.parse(text); } catch { fail('OPERATOR_INPUT_INVALID'); }
}
async function readJsonLines(file, maxBytes = MAX_BYTES) {
  const text = await readBytes(file, maxBytes);
  try { return text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { fail('OPERATOR_INPUT_INVALID'); }
}

function getOnly(fetchImpl, signal) {
  return (url, init = {}) => {
    const request = url && typeof url === 'object' ? url : null;
    const method = init.method ?? request?.method ?? 'GET';
    if (typeof method !== 'string' || method.toUpperCase() !== 'GET' || init.body != null
      || request?.body != null || request?.method !== undefined && String(request.method).toUpperCase() !== 'GET') {
      fail('OPERATOR_REMOTE_WRITE_DENIED');
    }
    if (signal?.aborted) fail('OPERATOR_INTERRUPTED');
    return fetchImpl(url, { ...init, method: 'GET', ...(signal ? {
      signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
    } : {}) });
  };
}

function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const flags = { '--mode': 'mode', '--input': 'input', '--output': 'output', '--expected-database': 'expectedDatabase',
    '--actor-id': 'actorId', '--plan-hash': 'planHash' }, values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = flags[args[i]], value = args[i + 1];
    if (!key || Object.hasOwn(values, key) || typeof value !== 'string' || !value.trim()
      || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) fail('OPERATOR_ARGUMENTS');
    values[key] = value;
  }
  if (!['preview', 'apply'].includes(values.mode) || !values.input || !values.output || !values.expectedDatabase
    || !/^[1-9][0-9]*$/.test(values.actorId || '') || !Number.isSafeInteger(Number(values.actorId))
    || (values.mode === 'apply') !== Object.hasOwn(values, 'planHash')
    || values.planHash !== undefined && !HEX.test(values.planHash)) fail('OPERATOR_ARGUMENTS');
  return { ...values, actorId: Number(values.actorId) };
}

async function implementationHash() {
  // Works in the shipped container without .git. Includes the actual service and
  // script sources, plus dependency manifests; never hashes configuration/secrets.
  const root = path.resolve(__dirname, '..'), entries = [];
  async function collect(directory) {
    for (const entry of (await fs.readdir(path.join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = directory + '/' + entry.name;
      if (entry.isDirectory()) await collect(relative);
      else if (entry.isFile() && entry.name.endsWith('.js')) entries.push(relative);
    }
  }
  await collect('src'); await collect('scripts');
  entries.push('package.json', 'package-lock.json');
  const digest = createHash('sha256');
  for (const file of entries.sort()) {
    const bytes = await fs.readFile(path.join(root, file));
    digest.update(file + '\0' + bytes.length + '\0'); digest.update(bytes);
  }
  return digest.digest('hex');
}

function poolFor(env, readOnly) {
  const configuration = require('../src/config/env').loadConfig(env);
  const pool = new (require('pg').Pool)({ ...configuration.databaseOptions,
    ssl: configuration.useSsl ? { rejectUnauthorized: false } : false, max: 4,
    connectionTimeoutMillis: configuration.pgConnectTimeoutMs, statement_timeout: configuration.pgStatementTimeoutMs,
    query_timeout: configuration.pgQueryTimeoutMs, ...(readOnly ? { options: '-c default_transaction_read_only=on' } : {}) });
  return pool;
}

function targetHash(env, actual) {
  const configuration = require('../src/config/env').loadConfig(env);
  const options = configuration.databaseOptions;
  const url = options.connectionString ? new URL(options.connectionString) : null;
  return hash({ host: options.host ?? url?.hostname ?? 'localhost', port: String(options.port ?? (url?.port || '5432')),
    database: actual.name, user: actual.username, address: actual.address, serverPort: actual.port,
    configuredDatabase: options.database ?? decodeURIComponent(url?.pathname.slice(1) || ''),
    configuredUser: options.user ?? decodeURIComponent(url?.username || ''), ssl: configuration.useSsl });
}

async function writeAll(handle, bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) fail('OPERATOR_JOURNAL_WRITE_FAILED');
    offset += bytesWritten;
  }
  await handle.sync();
}

function validateEnvelope(review, cli, name) {
  const keys = ['contract', 'command', 'actorId', 'database', 'targetFingerprint', 'origin', 'implementationHash', 'payload', 'planHash'];
  if (!review || typeof review !== 'object' || Array.isArray(review)
    || Object.keys(review).length !== keys.length || keys.some(key => !Object.hasOwn(review, key))
    || review.contract !== CONTRACT || review.command !== name || review.actorId !== cli.actorId
    || review.database !== cli.expectedDatabase || !HEX.test(review.planHash || '')
    || !HEX.test(review.targetFingerprint || '') || !HEX.test(review.implementationHash || '')
    || !(review.origin === null || typeof review.origin === 'string')) fail('OPERATOR_PLAN_INVALID');
  const { planHash, ...body } = review;
  if (planHash !== cli.planHash || hash(body) !== planHash) fail('OPERATOR_PLAN_HASH_MISMATCH');
}

function createCommand(definition) {
  if (!definition || !/^[a-z][a-z0-9-]*$/.test(definition.name || '') || !Array.isArray(definition.permissions)
    || !definition.permissions.length || typeof definition.preview !== 'function' || typeof definition.apply !== 'function'
    || definition.artifactApply && !definition.readOnlyApply) throw new TypeError('Invalid operator command definition');

  async function main(args = process.argv.slice(2), dependencies = {}) {
    const { env = process.env, print = console.log, printError = console.error } = dependencies;
    const io = dependencies.io || fs, signals = dependencies.signals || process;
    const abort = new AbortController();
    let owned, output, cli, journal, enteredApply = false, outputWritten = false, poolFailed = false;
    const stop = () => abort.abort();
    const poolError = () => { poolFailed = true; abort.abort(); };
    const checkStopped = () => {
      if (poolFailed) fail('OPERATOR_DATABASE_FAILED');
      if (abort.signal.aborted) fail('OPERATOR_INTERRUPTED');
    };
    signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
    try {
      cli = parseArguments(args);
      if (cli.help) { print(definition.help || definition.name); return 0; }
      const inputFile = path.resolve(cli.input);
      const input = cli.mode === 'preview'
        ? await (definition.readPreviewInput || readJson)(inputFile) : await readJson(inputFile);
      if (cli.mode === 'apply') validateEnvelope(input, cli, definition.name);
      // Reserve before even connecting: an existing output cannot accompany a mutation.
      output = await io.open(path.resolve(cli.output), 'wx', 0o600);
      // Windows does not expose a directory handle usable by fsync. The file
      // itself is always fsynced; Linux/container runs also persist its directory entry.
      if (process.platform !== 'win32') {
        const directory = await io.open(path.dirname(path.resolve(cli.output)), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      journal = { async append(record) {
        const bytes = Buffer.from(JSON.stringify({ command: definition.name, at: new Date().toISOString(), ...record }) + '\n');
        outputWritten = true; await writeAll(output, bytes);
      } };
      const config = definition.requiresMagento === false ? { configured: false }
        : dependencies.config || require('../src/config/magento').parseMagentoConfig(env);
      if (definition.requiresMagento !== false && !config.configured) fail('MAGENTO_NOT_CONFIGURED');
      const readOnly = cli.mode === 'preview' || definition.readOnlyApply === true;
      const rawPool = dependencies.pool || (owned = (dependencies.createPool || poolFor)(env, readOnly));
      if (owned) owned.on?.('error', poolError);
      const actual = (await rawPool.query('SELECT current_database() AS name, current_user AS username, inet_server_addr()::text AS address, inet_server_port() AS port')).rows[0];
      if (actual?.name !== cli.expectedDatabase) fail('OPERATOR_DATABASE_MISMATCH');
      if (readOnly && (await rawPool.query('SHOW default_transaction_read_only')).rows[0]?.default_transaction_read_only !== 'on') {
        fail('OPERATOR_READ_ONLY_REQUIRED');
      }
      const authority = dependencies.authority || require('./operator-authority');
      const databasePool = readOnly ? rawPool : authority.guardPool(rawPool, cli.actorId, definition.permissions);
      const fetchImpl = getOnly(dependencies.fetchImpl || globalThis.fetch, abort.signal);
      const mutationContext = { actorUserId: cli.actorId };
      const ctx = { databasePool, config, mutationContext, fetchImpl, checkStopped, inputFile,
        actorId: cli.actorId, expectedDatabase: cli.expectedDatabase,
        async authority() { checkStopped(); await authority.authorize(rawPool, cli.actorId, definition.permissions); checkStopped(); } };
      ctx.options = { databasePool, config, mutationContext, fetchImpl };
      await ctx.authority();
      const fingerprint = async (injected, fallback) => typeof injected === 'function' ? injected(ctx)
        : injected === undefined ? fallback() : injected;
      const implementation = await fingerprint(dependencies.buildFingerprint, implementationHash);
      const target = await fingerprint(dependencies.targetFingerprint, () => targetHash(env, actual));
      if (!HEX.test(implementation || '') || !HEX.test(target || '')) fail('OPERATOR_CONTEXT_INVALID');
      const origin = definition.requiresMagento === false ? null : new URL(config.baseUrl).origin;
      if (cli.mode === 'preview') {
        const payload = await definition.preview(input, ctx);
        if (definition.validatePlan) await definition.validatePlan(payload, ctx);
        await ctx.authority();
        const body = { contract: CONTRACT, command: definition.name, actorId: cli.actorId, database: actual.name,
          targetFingerprint: target, origin, implementationHash: implementation, payload };
        const review = { ...body, planHash: hash(body) };
        const bytes = Buffer.from(JSON.stringify(review, null, 2) + '\n');
        if (bytes.length > MAX_BYTES) fail('OPERATOR_PLAN_LIMIT');
        outputWritten = true; await writeAll(output, bytes);
        print(JSON.stringify({ ok: true, mode: 'preview', planHash: review.planHash, output: cli.output }));
        return 0;
      }
      if (input.implementationHash !== implementation || input.targetFingerprint !== target || input.origin !== origin) {
        fail('OPERATOR_CONTEXT_CHANGED');
      }
      if (definition.validatePlan) await definition.validatePlan(input.payload, ctx);
      await ctx.authority();
      const header = { command: definition.name, mode: 'apply', actorId: cli.actorId, database: actual.name, planHash: input.planHash };
      if (!definition.artifactApply) await journal.append({ ...header, type: 'prepared' });
      checkStopped(); enteredApply = true;
      const result = await definition.apply(input.payload, ctx, definition.artifactApply
        ? { append: async () => fail('OPERATOR_ARTIFACT_JOURNAL_INVALID') } : journal);
      if (definition.artifactApply) {
        checkStopped();
        if (!result || !Array.isArray(result.items)) fail('OPERATOR_ARTIFACT_INVALID');
        outputWritten = true;
        await writeAll(output, Buffer.from(JSON.stringify({ items: result.items, journal: { ...header, status: 'complete' } }, null, 2) + '\n'));
      } else await journal.append({ ...header, type: 'complete', result });
      print(JSON.stringify({ ok: true, mode: 'apply', planHash: input.planHash, output: cli.output }));
      return 0;
    } catch (cause) {
      const code = safeCode(cause);
      if (output) {
        const error = { command: definition.name, mode: cli.mode, status: enteredApply && !definition.readOnlyApply ? 'unconfirmed' : 'failed', code };
        try {
          if (cli.mode === 'apply' && !definition.artifactApply && journal) await journal.append({ type: 'error', ...error });
          else if (!outputWritten) await writeAll(output, Buffer.from(JSON.stringify(error) + '\n'));
        } catch { /* A damaged journal must never cause a repeated domain mutation. */ }
      }
      printError(JSON.stringify({ ok: false, code })); return 1;
    } finally {
      signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
      if (output) await output.close().catch(() => {});
      if (owned) {
        await owned.end().catch(() => {});
        owned.removeListener?.('error', poolError);
      }
    }
  }
  return { main, parseArguments };
}

module.exports = { createCommand, fail, getOnly, readJson, readJsonLines };
