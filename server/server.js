const app = require('./src/app');
const { PORT } = require('./src/config/env');
const { initDb } = require('./src/db/init-db');

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Server startup failed:', err.message || err);
  process.exit(1);
});
