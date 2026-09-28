const fs = require('node:fs/promises');
const path = require('node:path');

// A fresh directory per attempt prevents concurrent runs overwriting receipts.
// Resume the same plan into a NEW directory; PostgreSQL receipts decide what ran.
async function createReceiptWriter(directory) {
  await fs.mkdir(directory);
  if (process.platform !== 'win32') {
    const parent = await fs.open(path.dirname(directory), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
  let sequence = 0;
  return async receipt => {
    const temporary = path.join(directory, `.summary-${++sequence}.tmp`);
    const file = await fs.open(temporary, 'wx');
    try { await file.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await fs.rename(temporary, path.join(directory, 'summary.json'));
    if (process.platform !== 'win32') {
      const parent = await fs.open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
  };
}
module.exports = { createReceiptWriter };
