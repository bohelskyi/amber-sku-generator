const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('file timing measures each test child once without changing pass/failure or helper behavior', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-file-timing-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const preload = path.join(directory, 'file-timing.js');
  await fs.copyFile(path.join(__dirname, 'file-timing.js'), preload);
  await fs.writeFile(path.join(directory, 'pass.test.js'),
    "require('node:test')('pass', async () => { await new Promise(resolve => setTimeout(resolve, 30)); });\n");
  await fs.writeFile(path.join(directory, 'fail.test.js'),
    "require('node:test')('fail', () => { throw new Error('expected fixture failure'); });\n");
  await fs.writeFile(path.join(directory, 'helper.js'), "process.stdout.write('helper-only\\n');\n");
  const run = async (args, enabled = '1') => {
    // Start a new runner rather than inheriting the outer test child's protocol.
    const env = { ...process.env, AMBER_INTEGRATION_FILE_TIMING: enabled };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    try {
      const result = await promisify(execFile)(process.execPath, ['--require', preload, ...args], {
        cwd: directory, windowsHide: true,
        // Remove the outer CI preload: this subprocess has its own copied probe.
        env,
      });
      return { ...result, code: 0 };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
  };
  const records = output => output.split('\n').flatMap(line => {
    const match = line.match(/AMBER_INTEGRATION_FILE_TIMING (\{.*\})$/);
    return match ? [JSON.parse(match[1])] : [];
  });

  const passing = await run(['--test', 'pass.test.js']);
  assert.equal(passing.code, 0, passing.stderr);
  assert.match(passing.stdout, /# pass 1\b/);
  const measured = records(passing.stdout);
  assert.equal(measured.length, 1, 'Do not also measure the --test parent');
  assert.equal(measured[0].file, 'pass.test.js');
  assert.equal(measured[0].exitCode, 0);
  assert.ok(Number.isFinite(measured[0].durationMs) && measured[0].durationMs >= 25);

  const failing = await run(['--test', 'fail.test.js']);
  assert.equal(failing.code, 1);
  assert.match(failing.stdout, /expected fixture failure/);
  assert.match(failing.stdout, /# fail 1\b/);
  const failed = records(failing.stdout);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].file, 'fail.test.js');
  assert.equal(failed[0].exitCode, 1);

  const disabled = await run(['--test', 'pass.test.js'], '');
  assert.equal(disabled.code, 0);
  assert.deepEqual(records(disabled.stdout), []);
  const helper = await run(['helper.js']);
  assert.equal(helper.code, 0);
  assert.equal(helper.stdout.trim(), 'helper-only');
});
