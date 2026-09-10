const assert = require('node:assert/strict');
const test = require('node:test');

const { createOidcAdapter, OIDC_SCOPE } = require('../src/auth/oidc-adapter');

test('OIDC adapter dynamically imports once, discovers once, and uses validated code flow helpers', async () => {
  const calls = {
    imports: 0,
    discoveries: 0,
    authorizationParameters: [],
    grants: [],
    logoutParameters: [],
  };
  const configuration = {
    serverMetadata: () => ({
      issuer: 'https://auth.example.invalid/realms/amber',
      end_session_endpoint: 'https://auth.example.invalid/logout',
    }),
  };
  const claims = { iss: 'https://auth.example.invalid/realms/amber', sub: 'subject-1' };
  const fakeModule = {
    ClientSecretPost(secret) {
      return { method: 'client_secret_post', secret };
    },
    async discovery(...args) {
      calls.discoveries += 1;
      calls.discoveryArgs = args;
      return configuration;
    },
    async calculatePKCECodeChallenge(verifier) {
      calls.verifier = verifier;
      return 'calculated-challenge';
    },
    buildAuthorizationUrl(_configuration, parameters) {
      calls.authorizationParameters.push(parameters);
      return new URL(`https://auth.example.invalid/authorize?state=${parameters.state}`);
    },
    async authorizationCodeGrant(...args) {
      calls.grants.push(args);
      return { claims: () => claims, access_token: 'must-not-escape-adapter' };
    },
    buildEndSessionUrl(_configuration, parameters) {
      calls.logoutParameters.push(parameters);
      return new URL('https://auth.example.invalid/logout?fixed=1');
    },
  };
  const adapter = createOidcAdapter({
    issuer: 'https://auth.example.invalid/realms/amber',
    clientId: 'amber-sku-manager',
    clientSecret: 'server-only-secret',
    redirectUri: 'https://app.example.invalid/api/auth/callback',
    postLogoutRedirectUri: 'https://app.example.invalid/',
    importOpenIdClient: async () => {
      calls.imports += 1;
      return fakeModule;
    },
  });

  await Promise.all([
    adapter.buildAuthorizationRedirect({ state: 'state-1', nonce: 'nonce-1', codeVerifier: 'verifier-1' }),
    adapter.buildAuthorizationRedirect({ state: 'state-2', nonce: 'nonce-2', codeVerifier: 'verifier-2' }),
  ]);
  const returnedClaims = await adapter.exchangeAuthorizationCode({
    callbackUrl: new URL('https://app.example.invalid/api/auth/callback?code=code&state=state-1'),
    state: 'state-1',
    nonce: 'nonce-1',
    codeVerifier: 'verifier-1',
  });
  await adapter.buildLogoutRedirect();

  assert.equal(calls.imports, 1);
  assert.equal(calls.discoveries, 1);
  assert.equal(calls.discoveryArgs[0].href, 'https://auth.example.invalid/realms/amber');
  assert.equal(calls.discoveryArgs[1], 'amber-sku-manager');
  assert.deepEqual(calls.discoveryArgs[2], {
    client_secret: 'server-only-secret',
    redirect_uris: ['https://app.example.invalid/api/auth/callback'],
    response_types: ['code'],
  });
  assert.deepEqual(calls.discoveryArgs[3], {
    method: 'client_secret_post',
    secret: 'server-only-secret',
  });
  assert.equal(calls.discoveryArgs[4].timeout, 10);
  assert.equal(calls.authorizationParameters[0].response_type, 'code');
  assert.equal(calls.authorizationParameters[0].scope, OIDC_SCOPE);
  assert.equal(calls.authorizationParameters[0].code_challenge, 'calculated-challenge');
  assert.equal(calls.authorizationParameters[0].code_challenge_method, 'S256');
  assert.equal(calls.authorizationParameters[0].nonce, 'nonce-1');
  assert.equal(calls.grants[0][2].expectedState, 'state-1');
  assert.equal(calls.grants[0][2].expectedNonce, 'nonce-1');
  assert.equal(calls.grants[0][2].pkceCodeVerifier, 'verifier-1');
  assert.equal(calls.grants[0][2].idTokenExpected, true);
  assert.equal(returnedClaims, claims);
  assert.deepEqual(calls.logoutParameters[0], {
    client_id: 'amber-sku-manager',
    post_logout_redirect_uri: 'https://app.example.invalid/',
  });
});

test('OIDC adapter does not invent provider logout when discovery omits the endpoint', async () => {
  let buildCalls = 0;
  const fakeModule = {
    ClientSecretPost: () => () => {},
    discovery: async () => ({ serverMetadata: () => ({}) }),
    buildEndSessionUrl: () => {
      buildCalls += 1;
    },
  };
  const adapter = createOidcAdapter({
    issuer: 'https://auth.example.invalid/realms/amber',
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'https://app.example.invalid/api/auth/callback',
    postLogoutRedirectUri: 'https://app.example.invalid/',
    importOpenIdClient: async () => fakeModule,
  });

  assert.equal(await adapter.buildLogoutRedirect(), null);
  assert.equal(buildCalls, 0);
});
