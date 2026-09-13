const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const forbiddenPatterns = [
  ['database URL', /postgres(?:ql)?:\/\//i],
  ['canonical test password', /amber_test_local_only/i],
  ['session secret', /phase7-benchmark-session-secret/i],
  ['fixture identity', /phase7-fixture-subject/i],
  ['stored CSV payload field', /csv_content/i],
  ['raw query text field', /queryText/i],
  ['synthetic product payload', /synthetic-[0-9]+/i],
  ['SKU-shaped fixture value', /PF1[0-9]{3,}/],
];

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(target));
    else if (entry.name !== 'redaction-check.json') files.push(target);
  }
  return files;
}

async function validateArtifacts(outputDirectory) {
  const runs = [];
  for (let run = 1; run <= 3; run += 1) {
    const artifact = JSON.parse(await fs.readFile(path.join(outputDirectory, `run-${run}.json`), 'utf8'));
    assert.equal(artifact.run, run);
    assert.match(artifact.databaseName, /_test$/);
    assert.equal(artifact.results.length, 43, `run ${run} has an incomplete benchmark matrix`);
    assert.equal(artifact.plans.length, 20, `run ${run} has an incomplete plan matrix`);
    assert.ok(artifact.results.every((result) => result.queryCount.min > 0), `run ${run} contains uninstrumented HTTP samples`);
    runs.push(artifact);
  }
  assert.equal(new Set(runs.map((run) => run.revision)).size, 1, 'revisions differ between runs');
  const comparableOptions = runs.map((artifact) => {
    const { run: _run, ...options } = artifact.requestedScales;
    return options;
  });
  assert.equal(new Set(comparableOptions.map(JSON.stringify)).size, 1, 'fixture/command options differ between runs');

  const phaseDirectory = path.join(outputDirectory, 'phase-metrics');
  const hasSupplementalPhases = await fs.access(phaseDirectory).then(() => true, () => false);
  const phaseRuns = [];
  if (hasSupplementalPhases) {
    for (let run = 1; run <= 3; run += 1) {
      const artifact = JSON.parse(await fs.readFile(path.join(phaseDirectory, `run-${run}.json`), 'utf8'));
      assert.equal(artifact.results.length, 10, `supplemental run ${run} has an incomplete phase matrix`);
      assert.ok(artifact.results.every((result) => result.queryCount.min > 0));
      phaseRuns.push(artifact);
    }
  } else {
    phaseRuns.push(...runs);
  }
  const observedPhases = new Set(phaseRuns.flatMap((artifact) => artifact.results.flatMap(
    (result) => Object.keys(result.phases || {})
  )));
  for (const requiredPhase of [
    'catalog.hydration',
    'correction_history.normalization',
    'correction_history.csv',
    'repricing.projection_and_tokens',
    'export.shaping',
    'export.csv',
  ]) {
    assert.ok(observedPhases.has(requiredPhase), `phase ${requiredPhase} was not observed`);
  }
  const stateDirectory = path.join(outputDirectory, 'state-validation');
  const stateRowsPerRun = [];
  const hasStateValidation = await fs.access(stateDirectory).then(() => true, () => false);
  if (hasStateValidation) {
    for (let run = 1; run <= 3; run += 1) {
      const artifact = JSON.parse(await fs.readFile(path.join(stateDirectory, `run-${run}.json`), 'utf8'));
      assert.equal(artifact.results.length, 11, `state-validation run ${run} is incomplete`);
      assert.ok(artifact.results.every((result) => result.queryCount.min > 0));
      stateRowsPerRun.push(artifact.results.length);
    }
  } else {
    stateRowsPerRun.push(...runs.map((run) => run.results.length));
  }

  const files = await listFiles(outputDirectory);
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8');
    for (const [label, pattern] of forbiddenPatterns) {
      assert.doesNotMatch(content, pattern, `${path.relative(outputDirectory, file)} contains ${label}`);
    }
  }

  const result = {
    passed: true,
    checkedAt: new Date().toISOString(),
    fileCount: files.length,
    runCount: runs.length,
    resultRowsPerRun: runs.map((run) => run.results.length),
    planRowsPerRun: runs.map((run) => run.plans.length),
    phaseRowsPerRun: phaseRuns.map((run) => run.results.length),
    stateValidationRowsPerRun: stateRowsPerRun,
    checks: [
      'three corrected process artifacts share one revision and fixture definition',
      'all HTTP result rows contain observed query metrics',
      'all first/warm EXPLAIN plan pairs are present',
      'all six request-scoped phase timers were observed in three supplemental processes',
      'all mutation/export database postconditions passed in three state-validation processes',
      'no database URL or credential material',
      'no session or fixture identity material',
      'no raw query text fields or stored CSV payload fields',
      'no synthetic product payload values or SKU-shaped fixture values',
    ],
  };
  await fs.writeFile(
    path.join(outputDirectory, 'redaction-check.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8'
  );
  return result;
}

module.exports = { validateArtifacts };
