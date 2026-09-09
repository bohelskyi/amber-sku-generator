if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    'postgresql://unit_test:unit_test_password@127.0.0.1:5432/amber_unit_test';
}

process.env.APP_BASE_URL ||= 'http://localhost:5173';
process.env.OIDC_ISSUER_URL ||= 'https://auth.example.invalid/realms/amber';
process.env.OIDC_CLIENT_ID ||= 'amber-sku-manager-test';
process.env.OIDC_CLIENT_SECRET ||= 'unit-test-client-secret';
process.env.OIDC_REDIRECT_URI ||= 'http://localhost:5000/api/auth/callback';
process.env.SESSION_SECRET ||= 'unit-test-session-secret-0123456789abcdef';
process.env.SESSION_COOKIE_SECURE ||= 'false';
process.env.TRUST_PROXY ||= 'false';
