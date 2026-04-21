const PORT = Number(process.env.PORT || 5000);
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/amber';

module.exports = {
  PORT,
  DATABASE_URL,
  useSsl: process.env.PGSSL === 'true',
};
