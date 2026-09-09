const OIDC_CALLBACK_PATH = '/api/auth/callback';

function getRequestLogPath(req) {
  const originalUrl = req.originalUrl || req.url || '';
  const queryIndex = originalUrl.indexOf('?');
  const pathname = queryIndex === -1 ? originalUrl : originalUrl.slice(0, queryIndex);
  return (
    pathname === OIDC_CALLBACK_PATH
    || pathname.startsWith(`${OIDC_CALLBACK_PATH}/`)
  ) ? pathname : originalUrl;
}

module.exports = {
  OIDC_CALLBACK_PATH,
  getRequestLogPath,
};
