const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { writeReport } = require('./report');
const { measureInstrumentationOverhead } = require('./overhead');
const { validateArtifacts } = require('./artifact-validation');

const execFileAsync = promisify(execFile);
const serverRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(serverRoot, '..');

function readNumber(name, fallback, minimum = 0) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

async function revision() {
  const result = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot });
  return result.stdout.trim();
}

async function main() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL is required; no DATABASE_URL or local fallback is permitted.');
  }
  const smoke = process.argv.includes('--smoke');
  const supplemental = process.argv.includes('--supplemental');
  const outputArgument = process.argv.find((value) => value.startsWith('--output='))?.slice(9);
  const outputDirectory = path.resolve(repositoryRoot, outputArgument || 'docs/performance/phase7-baseline');
  const caseArgument = process.argv.find((value) => value.startsWith('--cases='))?.slice(8);
  const options = {
    categories: readNumber('categories', smoke ? 2 : 25, 1),
    products: readNumber('products', smoke ? 100 : 1000, 100),
    corrections: readNumber('corrections', smoke ? 20 : 999, 0),
    activeCorrections: readNumber('active-corrections', smoke ? 5 : 100, 0),
    activeDrafts: readNumber('active-drafts', smoke ? 2 : 25, 0),
    repricingChanges: readNumber('repricing-changes', smoke ? 25 : 500, 0),
    exportRange: readNumber('export-range', smoke ? 50 : 1000, 1),
    lineage: readNumber('lineage', smoke ? 5 : 50, 1),
    fixtureSeed: process.argv.find((value) => value.startsWith('--seed='))?.slice(7) || 'phase7-v1',
    samples: smoke ? 'smoke' : 'baseline',
    caseIds: caseArgument ? caseArgument.split(',').map((value) => value.trim()).filter(Boolean) : null,
    outputDirectory,
    revision: await revision(),
    cpuModel: os.cpus()[0]?.model || 'unknown',
    cpuCount: os.cpus().length,
    ramBytes: os.totalmem(),
  };
  if (options.exportRange > options.products) throw new Error('export-range cannot exceed products');
  if (options.lineage > options.products) throw new Error('lineage cannot exceed products');
  await fs.mkdir(outputDirectory, { recursive: true });

  const runs = [];
  for (let run = 1; run <= 3; run += 1) {
    const workerOptions = { ...options, run };
    const encoded = Buffer.from(JSON.stringify(workerOptions)).toString('base64url');
    process.stdout.write(`Phase 7 benchmark process ${run}/3\n`);
    await execFileAsync(process.execPath, [path.join(__dirname, 'worker.js'), `--options=${encoded}`], {
      cwd: serverRoot,
      env: { ...process.env },
      maxBuffer: 50 * 1024 * 1024,
    });
    runs.push(JSON.parse(await fs.readFile(path.join(outputDirectory, `run-${run}.json`), 'utf8')));
  }
  if (supplemental) {
    process.stdout.write(`Supplemental measurements written to ${outputDirectory}\n`);
    return;
  }
  const overhead = await measureInstrumentationOverhead(outputDirectory);
  const classifications = await writeReport({ outputDirectory, runs, options, repositoryRoot, overhead });
  await validateArtifacts(outputDirectory);
  process.stdout.write(`Baseline written to ${path.join(outputDirectory, 'BASELINE.md')}\n`);
  process.stdout.write(`${classifications.filter((item) => item.classification === 'confirmed').length} confirmed, `
    + `${classifications.filter((item) => item.classification === 'rejected').length} rejected, `
    + `${classifications.filter((item) => item.classification === 'inconclusive').length} inconclusive.\n`);
}

main().catch((error) => {
  process.stderr.write(`Phase 7 benchmark failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
