'use strict';

// Opt-in Node 20 preload for complete test-file wall times, including setup and
// teardown. The --test parent also has the first test file in argv[1], so only
// instrument the isolated test child. Migration/fixture workers are not entries.
if (process.env.AMBER_INTEGRATION_FILE_TIMING === '1'
  && process.env.NODE_TEST_CONTEXT === 'child-v8'
  && process.argv[1]) {
  const path = require('node:path');
  const entry = path.resolve(process.argv[1]);
  if (path.dirname(entry) === __dirname && entry.endsWith('.test.js')) {
    const fs = require('node:fs');
    const started = process.hrtime.bigint();
    process.once('exit', exitCode => {
      const record = {
        file: path.basename(entry),
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        exitCode,
      };
      // Synchronous output survives normal exit and remains a TAP diagnostic.
      // Telemetry must never replace the test's own failure or exit status.
      try { fs.writeSync(1, '# AMBER_INTEGRATION_FILE_TIMING ' + JSON.stringify(record) + '\n'); }
      catch {}
    });
  }
}
