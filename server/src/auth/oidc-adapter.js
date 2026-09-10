const env = require('../config/env');

const OIDC_SCOPE = 'openid profile email';
const OIDC_HTTP_TIMEOUT_SECONDS = 10;

function createOidcAdapter({
  issuer = env.oidcIssuerUrl,
  clientId = env.oidcClientId,
  clientSecret = env.oidcClientSecret,
  redirectUri = env.oidcRedirectUri,
  postLogoutRedirectUri = env.appBaseUrl,
  importOpenIdClient = () => import('openid-client'),
} = {}) {
  let modulePromise;
  let configurationPromise;

  function getModule() {
    modulePromise ||= Promise.resolve().then(importOpenIdClient);
    return modulePromise;
  }

  function getConfiguration() {
    if (!configurationPromise) {
      configurationPromise = getModule()
        .then((client) => client.discovery(
          new URL(issuer),
          clientId,
          {
            client_secret: clientSecret,
            redirect_uris: [redirectUri],
            response_types: ['code'],
          },
          client.ClientSecretPost(clientSecret),
          { timeout: OIDC_HTTP_TIMEOUT_SECONDS }
        ))
        .catch((error) => {
          configurationPromise = undefined;
          throw error;
        });
    }
    return configurationPromise;
  }

  async function buildAuthorizationRedirect({ state, nonce, codeVerifier }) {
    const [client, configuration] = await Promise.all([getModule(), getConfiguration()]);
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    return client.buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: OIDC_SCOPE,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  async function exchangeAuthorizationCode({ callbackUrl, state, nonce, codeVerifier }) {
    const [client, configuration] = await Promise.all([getModule(), getConfiguration()]);
    const tokenResponse = await client.authorizationCodeGrant(
      configuration,
      callbackUrl,
      {
        expectedState: state,
        expectedNonce: nonce,
        pkceCodeVerifier: codeVerifier,
        idTokenExpected: true,
      }
    );
    const claims = tokenResponse.claims();
    if (!claims) throw new Error('OIDC provider did not return validated identity claims');
    return claims;
  }

  async function buildLogoutRedirect() {
    const [client, configuration] = await Promise.all([getModule(), getConfiguration()]);
    if (!configuration.serverMetadata().end_session_endpoint) return null;
    return client.buildEndSessionUrl(configuration, {
      client_id: clientId,
      post_logout_redirect_uri: postLogoutRedirectUri,
    });
  }

  return {
    issuer,
    redirectUri,
    postLogoutRedirectUri,
    getConfiguration,
    buildAuthorizationRedirect,
    exchangeAuthorizationCode,
    buildLogoutRedirect,
  };
}

module.exports = {
  OIDC_SCOPE,
  OIDC_HTTP_TIMEOUT_SECONDS,
  createOidcAdapter,
};
