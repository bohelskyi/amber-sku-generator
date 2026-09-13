const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const path = require('node:path');
const signature = require('cookie-signature');
const { Client } = require('pg');
const { matrix } = require('./benchmark-matrix');
const { resetDisposableSchema, verifyConnectedTestDatabase } = require('./database-safety');

function parseOptions() {
  const encoded = process.argv.find((value) => value.startsWith('--options='))?.slice(10);
  if (!encoded) throw new Error('Worker options are required.');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

function configureEnvironment(databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.APP_BASE_URL = 'http://localhost:5173';
  process.env.OIDC_ISSUER_URL = 'https://benchmark.invalid/issuer';
  process.env.OIDC_CLIENT_ID = 'phase7-benchmark';
  process.env.OIDC_CLIENT_SECRET = 'phase7-benchmark-client-secret';
  process.env.OIDC_REDIRECT_URI = 'http://localhost:5000/api/auth/callback';
  process.env.SESSION_SECRET = 'phase7-benchmark-session-secret-0123456789abcdef';
  process.env.SESSION_COOKIE_SECURE = 'false';
  process.env.TRUST_PROXY = 'false';
  process.env.NBU_RATE_OVERRIDE = '40';
  process.env.PERF_METRICS_ENABLED = 'true';
  process.env.PERF_SLOW_QUERY_MS = '0';
  process.env.PERF_FINGERPRINT_DETAILS = 'true';
}

async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function createRequester({ baseUrl, cookie, csrfToken, takeMetric }) {
  return async function request(method, route, body, extraHeaders = {}) {
    const requestId = `phase7-${crypto.randomUUID()}`;
    const beforeMemory = process.memoryUsage();
    const beforeCpu = process.cpuUsage();
    const startedAt = process.hrtime.bigint();
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        Cookie: cookie,
        'X-CSRF-Token': csrfToken,
        'X-Request-ID': requestId,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseBody = await response.text();
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const cpu = process.cpuUsage(beforeCpu);
    await new Promise((resolve) => setImmediate(resolve));
    const requestMetric = takeMetric(requestId);
    if (!requestMetric) throw new Error(`Missing request metric for ${requestId}`);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${method} ${route} returned ${response.status}: ${responseBody.slice(0, 300)}`);
    }
    const afterMemory = process.memoryUsage();
    let json = null;
    if ((response.headers.get('content-type') || '').includes('json')) json = JSON.parse(responseBody);
    return {
      body: json,
      text: responseBody,
      metric: {
        ...requestMetric,
        durationMs: Number(elapsedMs.toFixed(3)),
        cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(3)),
        heapDeltaBytes: afterMemory.heapUsed - beforeMemory.heapUsed,
        heapUsedBytes: afterMemory.heapUsed,
        rssBytes: afterMemory.rss,
      },
    };
  };
}

async function guardedCleanup(client, statements) {
  await resetDisposableSchema(client, async (checkedClient) => {
    for (const statement of statements) await checkedClient.query(statement);
  });
}

async function seedCorrectionQueue(pool, fixture, count) {
  if (count <= 0) return;
  await pool.query(
    `INSERT INTO correction_requests
     (source_product_id, category_code, source_sku, proposed_sku, old_payload,
      proposed_payload, changes, comment, preview_signature, created_by_user_id)
     SELECT id, category, full_sku, full_sku || '-001', details, details,
            '[]'::jsonb, 'synthetic queue item', 'fixture-' || id, $1
     FROM products
     WHERE category = $2 AND sequence_number > $3
     ORDER BY sequence_number DESC LIMIT $4`,
    [fixture.userId, fixture.categoryCode, Number(fixture.lineageLength || 1), count]
  );
}

function makeCaseFactory({ request, pool, safetyClient, fixture, options }) {
  const basePayload = {
    categoryCode: fixture.categoryCode,
    answers: { kind: 1, note: 'synthetic request' },
    isCalibrated: null,
    weight: 0,
  };
  let sourceSequence = Math.max(Number(options.lineage) + 5, 20);

  async function assertRow(text, values, message) {
    const result = await pool.query(text, values);
    assert.ok(result.rows[0], message);
    return result.rows[0];
  }

  async function productSku(sequence) {
    const result = await pool.query(
      'SELECT full_sku FROM products WHERE category = $1 AND sequence_number = $2',
      [fixture.categoryCode, sequence]
    );
    return result.rows[0]?.full_sku;
  }

  async function preview() {
    return request('POST', '/api/preview', basePayload);
  }

  async function createDraft() {
    return request('POST', '/api/admin/repricing/drafts', {
      scope: 'scenario', scenarioId: fixture.scenarioId, manualOverrides: [],
      reviewedProductIds: [], uiState: {},
    });
  }

  async function clearRepricing() {
    await guardedCleanup(safetyClient, [
      'DELETE FROM repricing_drafts',
      'DELETE FROM repricing_batches',
      { text: `UPDATE products
       SET total_price = CASE WHEN sequence_number <= $1 THEN 25 ELSE 30 END,
           total_price_uah = CASE WHEN sequence_number <= $1 THEN 1000 ELSE 1200 END,
           price_per_gram = 0, uah_rate = 40, details = details - 'repricing'
       WHERE category = 'PF'`, values: [Number(options.repricingChanges)] },
    ]);
  }

  let activeCorrectionsCleared = false;
  async function clearActiveCorrections() {
    if (activeCorrectionsCleared) return;
    await guardedCleanup(safetyClient, [
      "UPDATE correction_requests SET status = 'rejected', rejected_at = CURRENT_TIMESTAMP WHERE status IN ('pending', 'in_progress')",
    ]);
    activeCorrectionsCleared = true;
  }

  async function prepareAppliedBatch() {
    await clearRepricing();
    const current = await request('POST', '/api/admin/repricing/preview', { scenarioId: fixture.scenarioId });
    const applied = await request('POST', '/api/admin/repricing/apply', {
      scenarioId: fixture.scenarioId,
      previewToken: current.body.previewToken,
      manualOverrides: [],
      draftId: null,
    });
    return applied.body.batch.id;
  }

  return {
    product_config: () => request('GET', '/api/config'),
    product_preview: () => preview(),
    product_save: async () => {
      const current = await preview();
      const saved = await request('POST', '/api/save', {
        skuSchemaVersionId: current.body.skuSchemaVersionId,
        previewToken: current.body.previewToken,
        category: fixture.categoryCode,
        answers: basePayload.answers,
        isCalibrated: null,
        weight: 0,
      });
      const row = await assertRow(
        'SELECT id, full_sku FROM products WHERE id = $1 AND full_sku = $2',
        [saved.body.id, saved.body.fullSku],
        'saved product final state is missing'
      );
      assert.equal(row.full_sku, saved.body.fullSku);
      return saved;
    },
    product_decode: async () => request('POST', '/api/decode', { sku: await productSku(options.lineage + 2) }),
    recount_preview: async () => request('POST', '/api/recount/preview', {
      sourceSku: await productSku(options.lineage + 3), answers: { kind: 2 }, reason: 'synthetic',
    }),
    recount_direct_apply: async () => {
      const sku = await productSku(sourceSequence++);
      const applied = await request('POST', '/api/recount/apply', { sourceSku: sku, answers: { kind: 2 }, reason: 'synthetic' });
      await assertRow(
        `SELECT id FROM products
         WHERE full_sku = $1 AND corrected_to_product_id IS NOT NULL AND status = 'corrected'`,
        [sku],
        'recount source final state was not corrected'
      );
      return applied;
    },
    correction_completion: async () => {
      const sku = await productSku(sourceSequence++);
      const created = await request('POST', '/api/admin/correction-requests', {
        sourceSku: sku, answers: { kind: 2 }, reason: 'synthetic',
      });
      const claimed = await request('POST', `/api/admin/correction-requests/${created.body.request.id}/claim`);
      const completed = await request(
        'POST',
        `/api/admin/correction-requests/${created.body.request.id}/complete`,
        { claimVersion: claimed.body.request.claimVersion }
      );
      await assertRow(
        `SELECT id FROM correction_requests
         WHERE id = $1 AND status = 'completed' AND corrected_product_id IS NOT NULL`,
        [created.body.request.id],
        'correction completion final state is missing'
      );
      return completed;
    },
    catalog_read: () => request('GET', '/api/admin/config'),
    schema_read: () => request('GET', `/api/admin/sku-schema/${fixture.categoryCode}`),
    pricing_read: () => request('GET', `/api/admin/prices/${fixture.categoryCode}`),
    correction_queue: () => request('GET', '/api/admin/correction-requests?status=all&limit=300'),
    correction_history_page: () => request('GET', '/api/admin/product-corrections?limit=200&offset=0'),
    correction_history_csv: () => request('GET', '/api/admin/product-corrections/csv'),
    product_timeline: () => request('GET', `/api/product-timeline?sku=${encodeURIComponent(fixture.from_sku)}`),
    repricing_scenario_preview: async () => {
      await clearActiveCorrections();
      return request('POST', '/api/admin/repricing/preview', { scenarioId: fixture.scenarioId });
    },
    repricing_global_preview: async () => {
      await clearActiveCorrections();
      return request('POST', '/api/admin/repricing/global/preview', {});
    },
    repricing_draft_list: () => request('GET', '/api/admin/repricing/drafts'),
    repricing_draft_read: async () => {
      await clearActiveCorrections();
      const draft = await createDraft();
      return request('GET', `/api/admin/repricing/drafts/${draft.body.draft.id}`);
    },
    repricing_draft_create: async () => {
      await clearActiveCorrections();
      await guardedCleanup(safetyClient, ["UPDATE repricing_drafts SET status = 'discarded' WHERE status = 'draft'"]);
      const created = await createDraft();
      await assertRow(
        "SELECT id FROM repricing_drafts WHERE id = $1 AND status = 'draft'",
        [created.body.draft.id],
        'repricing draft final state is missing'
      );
      return created;
    },
    repricing_draft_sync: async () => {
      await clearActiveCorrections();
      await guardedCleanup(safetyClient, ["UPDATE repricing_drafts SET status = 'discarded' WHERE status = 'draft'"]);
      const draft = await createDraft();
      const synced = await request('POST', `/api/admin/repricing/drafts/${draft.body.draft.id}/sync`, {});
      await assertRow(
        "SELECT id FROM repricing_drafts WHERE id = $1 AND status = 'draft'",
        [draft.body.draft.id],
        'synchronized draft final state is missing'
      );
      return synced;
    },
    repricing_apply: async () => {
      await clearActiveCorrections();
      await clearRepricing();
      const current = await request('POST', '/api/admin/repricing/preview', { scenarioId: fixture.scenarioId });
      const applied = await request('POST', '/api/admin/repricing/apply', {
        scenarioId: fixture.scenarioId, previewToken: current.body.previewToken,
        manualOverrides: [], draftId: null,
      });
      const state = await assertRow(
        `SELECT b.changed_count, COUNT(i.id) AS item_count
         FROM repricing_batches b
         LEFT JOIN repricing_items i ON i.batch_id = b.id
         WHERE b.id = $1 AND b.status = 'completed'
         GROUP BY b.id`,
        [applied.body.batch.id],
        'repricing apply batch final state is missing'
      );
      assert.equal(Number(state.item_count), Number(state.changed_count));
      return applied;
    },
    repricing_rollback: async () => {
      const batchId = await prepareAppliedBatch();
      const rolledBack = await request('POST', `/api/admin/repricing/${batchId}/rollback`, {});
      await assertRow(
        "SELECT id FROM repricing_batches WHERE id = $1 AND status = 'rolled_back'",
        [batchId],
        'repricing rollback final state is missing'
      );
      return rolledBack;
    },
    repricing_csv: async () => request('GET', `/api/admin/repricing/${await prepareAppliedBatch()}/csv`),
    export_status: () => request('GET', '/api/export/status'),
    export_snapshot_create: async () => {
      const created = await request('POST', '/api/export/snapshots', {
        fromSku: fixture.from_sku, toSku: fixture.exportToSku,
      }, { 'Idempotency-Key': `phase7-create-${crypto.randomUUID()}` });
      await assertRow(
        "SELECT id FROM export_snapshots WHERE id = $1 AND status = 'generated'",
        [created.body.id],
        'export snapshot final state is missing'
      );
      return created;
    },
    export_snapshot_reuse: async () => {
      const key = `phase7-reuse-${crypto.randomUUID()}`;
      await request('POST', '/api/export/snapshots', {
        fromSku: fixture.from_sku, toSku: fixture.exportToSku,
      }, { 'Idempotency-Key': key });
      const reused = await request('POST', '/api/export/snapshots', {
        fromSku: fixture.from_sku, toSku: fixture.exportToSku,
      }, { 'Idempotency-Key': key });
      assert.equal(reused.body.id, (await assertRow(
        'SELECT id FROM export_snapshots WHERE idempotency_key = $1',
        [key],
        'idempotent export snapshot is missing'
      )).id);
      return reused;
    },
    export_snapshot_download: async () => {
      const created = await request('POST', '/api/export/snapshots', {
        fromSku: fixture.from_sku, toSku: fixture.exportToSku,
      }, { 'Idempotency-Key': `phase7-download-${crypto.randomUUID()}` });
      const downloaded = await request('GET', `/api/export/snapshots/${created.body.id}/csv`);
      assert.match(downloaded.text, /^\ufeff?sku,/, 'snapshot download is not the stored CSV contract');
      return downloaded;
    },
    export_snapshot_confirmation: async () => {
      const created = await request('POST', '/api/export/snapshots', {
        fromSku: fixture.from_sku, toSku: fixture.exportToSku,
      }, { 'Idempotency-Key': `phase7-confirm-${crypto.randomUUID()}` });
      const confirmed = await request('POST', `/api/export/snapshots/${created.body.id}/confirm`, {});
      await assertRow(
        "SELECT id FROM export_snapshots WHERE id = $1 AND status = 'confirmed' AND confirmed_at IS NOT NULL",
        [created.body.id],
        'export confirmation final state is missing'
      );
      return confirmed;
    },
  };
}

async function main() {
  const options = parseOptions();
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required; no fallback is permitted.');

  // Deliberately load only pg and the safety module before this check. This is the
  // first SQL statement made by every fresh benchmark worker.
  const safetyClient = new Client({ connectionString: databaseUrl });
  await safetyClient.connect();
  const databaseName = await verifyConnectedTestDatabase(safetyClient);
  await resetDisposableSchema(safetyClient, async (client) => {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
  });

  configureEnvironment(databaseUrl);
  const { runMigrations } = require('../src/db/run-migrations');
  await runMigrations();
  const pool = require('../src/db/pool');
  const { createApp } = require('../src/app');
  const logger = require('../src/utils/logger');
  const { createDatabaseSession, createSyntheticFixtures } = require('./fixtures');
  const { captureExplainPlans } = require('./explain-capture');
  const { summarizeSamples } = require('./statistics');

  const fixture = await createSyntheticFixtures(pool, options);
  fixture.lineageLength = options.lineage;
  await seedCorrectionQueue(pool, fixture, Math.min(options.activeCorrections, options.products - options.lineage - 5));

  const sessionId = crypto.randomBytes(24).toString('hex');
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  await createDatabaseSession(pool, fixture, { sessionId, csrfToken });
  const cookieValue = `s:${signature.sign(sessionId, process.env.SESSION_SECRET)}`;
  const cookie = `amber.sid=${encodeURIComponent(cookieValue)}`;

  const metrics = new Map();
  const originalInfo = logger.info;
  logger.info = (event, context) => {
    if (event === 'http.request.completed' && String(context?.requestId || '').startsWith('phase7-')) {
      metrics.set(context.requestId, context);
      return;
    }
    originalInfo.call(logger, event, context);
  };
  const takeMetric = (requestId) => {
    const value = metrics.get(requestId);
    metrics.delete(requestId);
    return value;
  };

  const server = await listen(createApp());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = createRequester({ baseUrl, cookie, csrfToken, takeMetric });
  const cases = makeCaseFactory({ request, pool, safetyClient, fixture, options });
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const results = [];
  try {
    for (const definition of matrix) {
      if (options.caseIds?.length && !options.caseIds.includes(definition.id)) continue;
      const execute = cases[definition.id];
      assert.equal(typeof execute, 'function', `Missing benchmark case ${definition.id}`);
      for (const concurrency of definition.concurrency) {
        const warmups = options.samples === 'smoke' ? 1 : definition.warmups;
        const sampleCount = options.samples === 'smoke' ? 2 : definition.samples;
        for (let index = 0; index < warmups; index += 1) {
          await Promise.all(Array.from({ length: concurrency }, execute));
        }
        const samples = [];
        for (let index = 0; index < sampleCount; index += 1) {
          eventLoop.reset();
          const wave = await Promise.all(Array.from({ length: concurrency }, execute));
          const delay = Number.isFinite(eventLoop.mean) ? eventLoop.mean / 1e6 : 0;
          for (const response of wave) samples.push({ ...response.metric, eventLoopDelayMs: delay });
        }
        results.push({ id: definition.id, kind: definition.kind, concurrency, ...summarizeSamples(samples) });
      }
    }
  } finally {
    eventLoop.disable();
    logger.info = originalInfo;
    await closeServer(server);
  }

  const planDirectory = path.join(options.outputDirectory, `plans-run-${options.run}`);
  const plans = await captureExplainPlans(safetyClient, planDirectory);
  const versions = await safetyClient.query(
    `SELECT current_setting('server_version') AS postgres_version`
  );
  const counts = await safetyClient.query(
    `SELECT
       (SELECT COUNT(*) FROM categories) AS categories,
       (SELECT COUNT(*) FROM products) AS products,
       (SELECT COUNT(*) FROM product_corrections) AS corrections,
       (SELECT COUNT(*) FROM correction_requests) AS correction_requests,
       (SELECT COUNT(*) FROM repricing_drafts) AS drafts,
       (SELECT COUNT(*) FROM repricing_items) AS repricing_items,
       (SELECT COUNT(*) FROM export_snapshots) AS export_snapshots`
  );
  const artifact = {
    run: options.run,
    databaseName,
    nodeVersion: process.version,
    postgresVersion: versions.rows[0].postgres_version,
    revision: options.revision,
    platform: process.platform,
    architecture: process.arch,
    cpuModel: options.cpuModel,
    cpuCount: options.cpuCount,
    ramBytes: options.ramBytes,
    pool: { max: Number(process.env.PG_POOL_MAX || 10) },
    fixtureSeed: options.fixtureSeed,
    requestedScales: options,
    cardinalities: Object.fromEntries(Object.entries(counts.rows[0]).map(([key, value]) => [key, Number(value)])),
    results,
    plans,
  };
  await fs.mkdir(options.outputDirectory, { recursive: true });
  const outputFile = path.join(options.outputDirectory, `run-${options.run}.json`);
  await fs.writeFile(outputFile, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  await pool.end();
  await safetyClient.end();
  process.stdout.write(`${JSON.stringify({ outputFile })}\n`);
}

main().catch((error) => {
  process.stderr.write(`Phase 7 worker failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
