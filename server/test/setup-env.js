if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    'postgresql://unit_test:unit_test_password@127.0.0.1:5432/amber_unit_test';
}
