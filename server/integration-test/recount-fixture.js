// Old integration scenarios now supply the direct command's required preview
// binding. Stale/missing-binding tests call the raw requester/service explicitly.
async function requestRecount(url, options) {
  const { request } = require('./suite-context');
  if (options.body?.sourceStateSignature) return request(url, options);
  const preview = await request('/api/recount/preview', options);
  return request(url, { ...options, body: { ...options.body,
    sourceStateSignature: preview.data?.source?.stateSignature } });
}
module.exports = { requestRecount };
