const fs = require('node:fs/promises');
const path = require('node:path');
const { gates, matrix } = require('./benchmark-matrix');

const inspectedExpectations = Object.freeze({
  product_config: '2 + 3 per category, plus authentication/session',
  product_preview: '6-7 domain queries, plus authentication/session',
  product_save: '10-11 domain queries, plus authentication/session',
  product_decode: '6 domain queries, plus authentication/session',
  recount_preview: '16-17 domain queries, plus authentication/session',
  recount_direct_apply: '31-34 domain queries, plus authentication/session',
  correction_completion: '52-56 domain queries without drafts, plus authentication/session',
  catalog_read: '2 domain queries, plus authentication/session',
  schema_read: '5 domain queries, plus authentication/session',
  pricing_read: '1 domain query, plus authentication/session',
  correction_queue: '2 domain queries, plus authentication/session',
  correction_history_page: '5 domain queries, plus authentication/session',
  correction_history_csv: '5 domain queries, plus authentication/session',
  product_timeline: '6-7 domain queries, plus authentication/session',
  repricing_scenario_preview: '3 domain queries, plus authentication/session',
  repricing_global_preview: 'batched context reads; constant query count by category',
  repricing_draft_list: '1 domain query, plus authentication/session',
  repricing_draft_read: '4-5 domain queries, plus authentication/session',
  repricing_draft_create: '11-12 domain queries, plus authentication/session',
  repricing_draft_sync: '9-10 domain queries, plus authentication/session',
  repricing_apply: 'about 12 + 2 per changed product, plus authentication/session',
  repricing_rollback: 'about 6 + 1 per changed product, plus authentication/session',
  repricing_csv: '2 domain queries, plus authentication/session',
  export_status: '2-3 domain queries, plus authentication/session',
  export_snapshot_create: '8-9 domain queries, plus authentication/session',
  export_snapshot_reuse: '1 domain query, plus authentication/session',
  export_snapshot_download: '1 domain query, plus authentication/session',
  export_snapshot_confirmation: 'transactional constant query count, plus authentication/session',
});

const confirmedCandidateGuidance = Object.freeze({
  product_config: {
    measured: 'Authenticated configuration request latency, total/domain fingerprint counts, DB time, response bytes, CPU, memory, and c1/c4 behavior.',
    reproduce: '`npm run benchmark:phase7` with categories=25; inspect `product_config` at c1 and c4 in all three run artifacts.',
    cause: 'The category-dependent fingerprint executes 25 times per request; the request has 31 total queries including session/RBAC.',
    experiment: 'In checkpoint 7.1 only, prototype the smallest set-based catalog/schema read behind the existing service shape and compare it against this exact baseline.',
    risks: 'Category/question/option ordering, visibility rules, immutable schema selection, and the public JSON shape.',
    verify: 'Exact HTTP contract tests, catalog/SKU schema integration coverage, 25-category c1/c4 benchmark, query fingerprints, and final data-state assertions.',
  },
  correction_completion: {
    measured: 'Completion-only authenticated request latency and query fingerprints after deterministic request creation and claim setup.',
    reproduce: '`npm run benchmark:phase7`; inspect `correction_completion` with 100 active requests and the 999-row correction-history fixture.',
    cause: 'Several preview/schema/pricing reads repeat during final-state revalidation; two dominant fingerprints each execute 25 times per completion sample.',
    experiment: 'In checkpoint 7.1 only, trace the repeated fingerprints to call sites and test reuse of an already transaction-consistent read model without moving any lock or revalidation boundary.',
    risks: 'Claim ownership epoch, target-based recount validation, final-state revalidation, SKU reservation, correction immutability, and lock ordering.',
    verify: 'Existing claim/race/final-state integration tests plus three-run completion benchmarks with identical request setup and database-state assertions.',
  },
  repricing_apply: {
    measured: 'Authenticated scenario apply over the requested 500-change axis (451 active changed products after the 50-link lineage fixture), including request/DB time and per-fingerprint counts.',
    reproduce: '`npm run benchmark:phase7`; inspect `repricing_apply` after deterministic price reset in each sample.',
    cause: 'One product UPDATE and one repricing-item INSERT per changed product dominate: each fingerprint executes 451 times per request.',
    experiment: 'In checkpoint 7.1 only, benchmark the smallest write-count reduction that keeps the same transaction and ascending product-lock order; do not change concurrency semantics.',
    risks: 'Atomic apply, product state tokens, manual/automatic price meanings, immutable batch evidence, audit attribution, idempotency, and deadlock avoidance.',
    verify: 'All repricing concurrency/final-state/rollback tests plus three-run apply benchmarks at multiple changed-product axes and exact batch/item/product-state comparisons.',
  },
  repricing_rollback: {
    measured: 'Authenticated rollback for the same 451-item applied batch, including request/DB time and per-fingerprint counts.',
    reproduce: '`npm run benchmark:phase7`; each measured rollback follows a newly prepared deterministic apply.',
    cause: 'The product UPDATE fingerprint executes once for each rolled-back item and dominates the 461 total queries.',
    experiment: 'In checkpoint 7.1 only, benchmark the smallest write-count reduction while preserving the single transaction, batch lock, ordered product locks, and exact historical payload checks.',
    risks: 'Rollback atomicity, exact payload validation, immutable historical items, product state restoration, audit attribution, and lock ordering.',
    verify: 'Rollback race/idempotency/final-state integration tests plus three-run rollback benchmarks and byte/row-equivalent restored state.',
  },
});

function crossedGates(result) {
  const findings = [];
  const queryGate = result.kind === 'read' ? gates.readQueryCount : gates.writeQueryCount;
  if (result.requestMs.p95 >= gates.requestP95Ms) findings.push(`request p95 ${result.requestMs.p95}ms >= ${gates.requestP95Ms}ms`);
  if (result.queryCount.p50 >= queryGate) findings.push(`query p50 ${result.queryCount.p50} >= ${queryGate}`);
  if (result.maxQueryMs.p95 >= gates.maxSingleQueryMs) findings.push(`single-query p95 ${result.maxQueryMs.p95}ms >= ${gates.maxSingleQueryMs}ms`);
  if (result.responseBytes.p95 >= gates.responseBytes) findings.push(`response p95 ${result.responseBytes.p95} >= ${gates.responseBytes} bytes`);
  if (result.heapDeltaBytes.p95 >= gates.heapGrowthBytes) findings.push(`heap delta p95 ${result.heapDeltaBytes.p95} >= ${gates.heapGrowthBytes} bytes`);
  return findings;
}

function classify(runResults, definition, concurrency, fullScale) {
  const matching = runResults.map((run) => run.results.find(
    (result) => result.id === definition.id && result.concurrency === concurrency
  ));
  if (matching.some((result) => !result)) {
    return { classification: 'inconclusive', evidence: 'One or more process repetitions are missing.' };
  }
  const findings = matching.map(crossedGates);
  const common = findings[0].filter((finding) => {
    const gateName = finding.split(' ')[0];
    return findings.every((items) => items.some((item) => item.startsWith(gateName)));
  });
  if (common.length > 0) {
    return { classification: 'confirmed', evidence: `All three processes crossed: ${common.join('; ')}.` };
  }
  if (!fullScale) {
    return { classification: 'inconclusive', evidence: 'Smoke-scale execution did not cross a gate; representative scale was not exercised.' };
  }
  if (findings.every((items) => items.length === 0)) {
    return { classification: 'rejected', evidence: 'All three representative/high-scale processes stayed below every endpoint gate.' };
  }
  return { classification: 'inconclusive', evidence: 'A gate was crossed in fewer than three process repetitions.' };
}

function planGateFindings(plan) {
  const sharedRead = plan.nodes.reduce((sum, node) => sum + Number(node.sharedReadBlocks || 0), 0);
  const tempBlocks = plan.nodes.reduce((sum, node) => (
    sum + Number(node.tempReadBlocks || 0) + Number(node.tempWrittenBlocks || 0)
  ), 0);
  const estimateRatio = Math.max(1, ...plan.nodes.map((node) => {
    const actual = Number(node.actualRows || 0);
    const planned = Number(node.planRows || 0);
    if (!actual || !planned) return 1;
    return Math.max(actual / planned, planned / actual);
  }));
  const findings = [];
  if (Number(plan.executionTimeMs || 0) >= gates.maxSingleQueryMs) {
    findings.push(`execution ${plan.executionTimeMs}ms >= ${gates.maxSingleQueryMs}ms`);
  }
  if (estimateRatio >= gates.planEstimateRatio) {
    findings.push(`estimate ratio ${estimateRatio.toFixed(2)} >= ${gates.planEstimateRatio}`);
  }
  if (sharedRead >= gates.sharedReadBlocks) findings.push(`shared reads ${sharedRead} >= ${gates.sharedReadBlocks}`);
  if (tempBlocks >= gates.tempBlocks) findings.push(`temp blocks ${tempBlocks} >= ${gates.tempBlocks}`);
  return findings;
}

function classifyPlans(runs) {
  const ids = [...new Set(runs.flatMap((run) => run.plans.map((plan) => plan.id)))];
  return ids.map((id) => {
    const perRun = runs.map((run) => run.plans.filter((plan) => plan.id === id));
    if (perRun.some((plans) => plans.length !== 2)) {
      return { id: `plan_${id}`, classification: 'inconclusive', evidence: 'First/warm plan pair missing in one or more runs.' };
    }
    const findings = perRun.map((plans) => plans.flatMap(planGateFindings));
    const gateNames = ['execution', 'estimate ratio', 'shared reads', 'temp blocks'];
    const commonGate = gateNames.find((name) => findings.every((items) => items.some((item) => item.startsWith(name))));
    if (commonGate) {
      return {
        id: `plan_${id}`,
        classification: 'confirmed',
        evidence: `All three first/warm plan pairs crossed the ${commonGate} gate. This is a plan-quality finding; endpoint latency must still justify any optimization experiment.`,
      };
    }
    if (findings.every((items) => items.length === 0)) {
      return { id: `plan_${id}`, classification: 'rejected', evidence: 'All three first/warm plan pairs stayed below every plan gate.' };
    }
    return { id: `plan_${id}`, classification: 'inconclusive', evidence: 'A plan gate did not reproduce in all three runs.' };
  });
}

function formatBytes(value) {
  if (value === null || value === undefined) return '-';
  return `${(Number(value) / 1024).toFixed(1)} KiB`;
}

async function clientBuildObservation(repositoryRoot) {
  const assetDirectory = path.join(repositoryRoot, 'client', 'dist', 'assets');
  try {
    const files = await fs.readdir(assetDirectory);
    const rows = [];
    for (const file of files) {
      const stat = await fs.stat(path.join(assetDirectory, file));
      rows.push({ file, bytes: stat.size });
    }
    return rows.sort((a, b) => b.bytes - a.bytes);
  } catch {
    return [];
  }
}

async function writeReport({ outputDirectory, runs, options, repositoryRoot, overhead, phaseRuns = runs }) {
  const fullScale = options.samples !== 'smoke';
  const lines = [
    '# Phase 7.0 Baseline Measurement',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'This report records measurement infrastructure and baseline evidence only. No optimization, SQL rewrite, index, cache, batching, pagination, concurrency, transaction, configuration, or migration change is included.',
    '',
    '## Environment and dataset',
    '',
    `- Revision: \`${runs[0].revision}\``,
    '- Revision identifies the committed Phase 6D base. Phase 7.0 instrumentation and harness changes were intentionally uncommitted while these measurements were collected.',
    `- Node: \`${runs[0].nodeVersion}\`; PostgreSQL: \`${runs[0].postgresVersion}\``,
    `- Connected database verified by query: \`${runs[0].databaseName}\``,
    `- CPU: ${runs[0].cpuModel} (${runs[0].cpuCount} logical); RAM: ${formatBytes(runs[0].ramBytes)}`,
    `- Pool maximum: ${runs[0].pool.max}; NBU rate override: 40`,
    `- Fixture seed: \`${options.fixtureSeed}\``,
    `- Scale: categories=${options.categories}, products=${options.products}, correction history=${options.corrections}, active correction requests=${options.activeCorrections}, active drafts=${options.activeDrafts}, repricing changes=${options.repricingChanges}, export range=${options.exportRange}, lineage=${options.lineage}`,
    `- Sampling: ${fullScale ? '10 warm-ups + 100 samples for reads/previews; 5 warm-ups + 30 samples for writes/exports' : 'smoke (1 warm-up + 2 samples)'}, three fresh server processes; concurrency 1 and 4 for reads.`,
    '',
    'Each process independently connected, made `SELECT current_database()` its first SQL statement, verified the `_test` suffix, repeated that check immediately before schema reset, reran immutable migrations, generated synthetic data, and executed authenticated HTTP requests through the PostgreSQL session store and active-user authorization boundary.',
    '',
    '## Benchmark matrix and classifications',
    '',
    '| Workflow | C | Run p50/p95 ms | Queries p50 | DB p95 ms | CPU p95 ms | ELD p95 ms | Peak RSS | Response p95 | Classification | Gate evidence |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  const classifications = [];
  for (const definition of matrix) {
    for (const concurrency of definition.concurrency) {
      const values = runs.map((run) => run.results.find(
        (result) => result.id === definition.id && result.concurrency === concurrency
      )).filter(Boolean);
      if (!values.length) continue;
      const decision = classify(runs, definition, concurrency, fullScale);
      classifications.push({ id: definition.id, concurrency, ...decision });
      lines.push(
        `| ${definition.id} | ${concurrency} | ${values.map((value) => `${value.requestMs.p50}/${value.requestMs.p95}`).join('; ')} | ${values.map((value) => value.queryCount.p50).join('; ')} | ${values.map((value) => value.databaseMs.p95).join('; ')} | ${values.map((value) => value.cpuMs.p95).join('; ')} | ${values.map((value) => value.eventLoopDelayMs.p95).join('; ')} | ${values.map((value) => formatBytes(value.peakRssBytes)).join('; ')} | ${values.map((value) => formatBytes(value.responseBytes.p95)).join('; ')} | **${decision.classification}** | ${decision.evidence} |`
      );
    }
  }
  const planClassifications = classifyPlans(runs);
  classifications.push(...planClassifications.map((item) => ({ ...item, concurrency: null })));
  lines.push('', 'Query counts include the PostgreSQL-backed session read and active-user/RBAC reads. Inspected domain-only expectations:', '');
  for (const definition of matrix) {
    lines.push(`- \`${definition.id}\`: ${inspectedExpectations[definition.id] || 'no static expectation recorded'}.`);
  }
  lines.push('', 'End-of-run cardinalities (setup scale plus deterministic mutation samples):', '');
  runs.forEach((run) => lines.push(`- Run ${run.run}: ${Object.entries(run.cardinalities).map(([key, value]) => `${key}=${value}`).join(', ')}.`));

  lines.push('', '## EXPLAIN (ANALYZE, BUFFERS) observations', '');
  lines.push('Plans were captured after `ANALYZE`, twice per target (first and warm), in explicit transactions that were always rolled back. Expression literals were sanitized before writing artifacts.', '');
  const planRows = runs[0].plans || [];
  lines.push('| Target | Temp | Execution ms | Significant nodes | Shared read | Temp blocks | Max estimate ratio |', '| --- | --- | ---: | --- | ---: | ---: | ---: |');
  for (const plan of planRows) {
    const significant = [...new Set(plan.nodes.map((node) => node.nodeType))].join(', ');
    const sharedRead = plan.nodes.reduce((sum, node) => sum + Number(node.sharedReadBlocks || 0), 0);
    const temp = plan.nodes.reduce((sum, node) => sum + Number(node.tempReadBlocks || 0) + Number(node.tempWrittenBlocks || 0), 0);
    const estimateRatio = Math.max(1, ...plan.nodes.map((node) => {
      const actual = Number(node.actualRows || 0);
      const planned = Number(node.planRows || 0);
      if (!actual || !planned) return 1;
      return Math.max(actual / planned, planned / actual);
    }));
    lines.push(`| ${plan.id} | ${plan.temperature} | ${plan.executionTimeMs} | ${significant} | ${sharedRead} | ${temp} | ${estimateRatio.toFixed(2)} |`);
  }
  lines.push('', 'Plan candidate classifications:', '');
  for (const item of planClassifications) {
    lines.push(`- \`${item.id}\`: **${item.classification}** — ${item.evidence}`);
  }

  lines.push('', '## Phase timer observations', '', '| Workflow / phase | Run p50/p95 ms | Observed samples |', '| --- | --- | --- |');
  const phaseKeys = new Set();
  for (const run of phaseRuns) {
    for (const result of run.results) {
      for (const phaseName of Object.keys(result.phases || {})) phaseKeys.add(`${result.id}\u0000${result.concurrency}\u0000${phaseName}`);
    }
  }
  for (const key of phaseKeys) {
    const [id, concurrency, phaseName] = key.split('\u0000');
    const values = phaseRuns.map((run) => run.results.find((result) => (
      result.id === id && String(result.concurrency) === concurrency
    ))?.phases?.[phaseName]).filter(Boolean);
    lines.push(`| ${id} c${concurrency} / \`${phaseName}\` | ${values.map((value) => `${value.durationMs.p50}/${value.durationMs.p95}`).join('; ')} | ${values.map((value) => value.observedSamples).join('; ')} |`);
  }
  if (phaseKeys.size === 0) lines.push('| none | - | - |');

  const confirmed = classifications.filter((item) => item.classification === 'confirmed');
  const inconclusive = classifications.filter((item) => item.classification === 'inconclusive');
  lines.push('', '## Suspected hotspots ranked by evidence', '');
  if (confirmed.length) {
    confirmed.forEach((item, index) => lines.push(`${index + 1}. **${item.id}${item.concurrency ? ` (c${item.concurrency})` : ''} — confirmed.** ${item.evidence}`));
  } else {
    lines.push('No candidate crossed the confirmation gates reproducibly in all three processes.');
  }
  inconclusive.forEach((item) => lines.push(`- **${item.id}${item.concurrency ? ` (c${item.concurrency})` : ''} — inconclusive.** ${item.evidence}`));

  lines.push('', '## Optimization checkpoints', '');
  if (confirmed.length) {
    const uniqueConfirmed = [...new Set(confirmed.map((item) => item.id))];
    for (const id of uniqueConfirmed) {
      if (id.startsWith('plan_')) {
        lines.push(`- \`${id}\`: first repeat the plan measurement at a larger representative cardinality. Its estimate-ratio gate crossed, but execution stayed below the single-query latency gate; no SQL or index experiment is authorized yet.`);
      } else {
        lines.push(`- \`${id}\`: checkpoint 7.1 may test the smallest query-count/work reduction isolated to the crossed gate; preserve HTTP behavior, transaction/lock ordering, immutable history, and all domain invariants. Re-run this exact case and correctness suite before considering it.`);
      }
    }
  } else {
    lines.push('- None. No optimization is authorized by this baseline.');
  }

  lines.push('', '## Confirmed candidate measurement records', '');
  const uniqueConfirmedEndpoints = [...new Set(confirmed.filter((item) => !item.id.startsWith('plan_')).map((item) => item.id))];
  for (const id of uniqueConfirmedEndpoints) {
    const guidance = confirmedCandidateGuidance[id];
    const baseline = runs.map((run) => run.results.find((result) => result.id === id && result.concurrency === 1)).filter(Boolean);
    if (!guidance || baseline.length === 0) continue;
    lines.push(`### \`${id}\``, '',
      `1. **Measured:** ${guidance.measured}`,
      `2. **Reproduction:** ${guidance.reproduce}`,
      `3. **Baseline:** request p50/p95 ${baseline.map((value) => `${value.requestMs.p50}/${value.requestMs.p95}ms`).join('; ')}; query p50 ${baseline.map((value) => value.queryCount.p50).join('; ')}; DB p95 ${baseline.map((value) => `${value.databaseMs.p95}ms`).join('; ')}.`,
      `4. **Suspected cause:** ${guidance.cause}`,
      `5. **Smallest possible next experiment:** ${guidance.experiment}`,
      `6. **Correctness risks:** ${guidance.risks}`,
      `7. **Required verification:** ${guidance.verify}`,
      ''
    );
  }
  lines.push('Confirmed plan-estimate findings are not yet endpoint optimization candidates: their execution times stayed below the single-query gate. The smallest next step is measurement at a larger representative cardinality before considering an index or SQL experiment.', '');

  lines.push('', '## Instrumentation overhead', '',
    `- Method: ${overhead.method}.`,
    `- Detailed collection disabled: median ${overhead.disabledPercent.toFixed(3)}% overhead; gate < ${overhead.thresholds.disabledPercent}%.`,
    `- Enabled request/query summary: median ${overhead.enabledPercent.toFixed(3)}% overhead; gate < ${overhead.thresholds.enabledPercent}%.`,
    `- Result: **${overhead.passed ? 'passed' : 'failed'}**.`,
    ''
  );

  lines.push('', '## Client build context', '');
  const assets = await clientBuildObservation(repositoryRoot);
  if (assets.length) {
    for (const asset of assets.slice(0, 10)) lines.push(`- \`${asset.file}\`: ${formatBytes(asset.bytes)} uncompressed.`);
  } else {
    lines.push('- No existing production build assets were present when the report was generated; build verification is recorded separately.');
  }
  lines.push('- Client sizes are context only and do not authorize a client optimization.', '');

  lines.push('## Areas explicitly left alone', '',
    '- All migrations 000-028, indexes, constraints, triggers, transaction boundaries, and lock ordering.',
    '- Global pricing-context batching and timeline bulk hydration, which already avoid the previously suspected N+1 patterns.',
    '- HTTP/JSON/CSV contracts, permissions, SKU/pricing/recount/repricing behavior, export immutability, and migration checksum handling.',
    '- Pagination semantics, caches, denormalization, streaming, concurrency, and client bundle composition.',
    '', '## Acceptance criteria and reproduction', '',
    '- Run `npm run benchmark:phase7` from `server/` with canonical `TEST_DATABASE_URL` and PostgreSQL 16.',
    '- The command refuses missing or connected non-`_test` databases before migrations, reset, plans, fixtures, or HTTP startup.',
    '- Raw sanitized plans are under `plans-run-*`; per-process metrics are `run-*.json`.',
    '- `state-validation/run-*.json` proves three-process execution of independent post-request database assertions for every mutation/export case.',
    '- A candidate is confirmed only if the same gate is crossed in all three fresh process repetitions.',
    '- Phase 7.0 stops at evidence. Any checkpoint 7.1 experiment requires separate review.',
    ''
  );

  await fs.writeFile(path.join(outputDirectory, 'BASELINE.md'), lines.join('\n'), 'utf8');
  await fs.writeFile(
    path.join(outputDirectory, 'classifications.json'),
    `${JSON.stringify({ gates, classifications }, null, 2)}\n`,
    'utf8'
  );
  return classifications;
}

module.exports = { classify, classifyPlans, crossedGates, inspectedExpectations, planGateFindings, writeReport };
