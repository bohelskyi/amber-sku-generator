const { createHmac, randomBytes } = require('node:crypto');
const { validateBaseUrl } = require('../../config/magento');
const { percentEncode, signGetRequest } = require('./oauth');
const { readJson } = require('./client');
const c = require('./binding-contract');

function pathFor(target) {
  if (!c.code(target.attributeCode) || !c.positive(target.attributeId)) c.invalid();
  if (target.optionId !== null && (!/^[1-9][0-9]*$/.test(target.optionId) || !c.positive(Number(target.optionId)))) c.invalid();
  return `products/attributes/${target.attributeCode}${target.optionId === null ? '' : `/options/${target.optionId}`}`;
}
// Closed DELETE signer: neither the caller nor a browser can supply a URL/method.
function signCatalogDeleteRequest(url, credentials, { nonce = randomBytes(24).toString('hex'), timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const parsed = new URL(url);
  if (parsed.search || parsed.hash || parsed.username || parsed.password
    || !/^\/rest\/all\/V1\/products\/attributes\/[a-zA-Z][a-zA-Z0-9_]{0,99}(?:\/options\/[1-9][0-9]*)?$/.test(parsed.pathname)
    || parsed.origin !== validateBaseUrl(credentials.baseUrl) || typeof nonce !== 'string' || !nonce || !Number.isSafeInteger(timestamp) || timestamp < 0) c.invalid();
  for (const key of ['consumerKey','consumerSecret','accessToken','accessTokenSecret']) if (typeof credentials[key] !== 'string' || !credentials[key].trim()) c.invalid();
  const oauth = { oauth_consumer_key: credentials.consumerKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(timestamp), oauth_token: credentials.accessToken, oauth_version: '1.0' };
  const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
  const parameters = Object.entries(oauth).map(([key,value]) => [percentEncode(key),percentEncode(value)])
    .sort((a,b) => compare(a[0],b[0]) || compare(a[1],b[1])).map(([key,value]) => `${key}=${value}`).join('&');
  const signature = ['DELETE', `${parsed.origin}${parsed.pathname}`, parameters].map(percentEncode).join('&');
  oauth.oauth_signature = createHmac('sha256',`${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.accessTokenSecret)}`).update(signature).digest('base64');
  return `OAuth ${Object.entries(oauth).sort(([a],[b]) => compare(a,b)).map(([key,value]) => `${percentEncode(key)}="${percentEncode(value)}"`).join(', ')}`;
}
function createCatalogDeleteTransport(config, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (!config.configured) throw c.error(409,'MAGENTO_NOT_CONFIGURED','Magento не налаштовано.');
  const credentials = { ...config }; const origin = validateBaseUrl(config.baseUrl);
  let reads = 0; const deadline = Date.now() + 60000;
  async function request(method,path,query,storeCode='all') {
    if (!c.code(storeCode) || (method === 'DELETE' && storeCode !== 'all')) c.invalid();
    if (Date.now() >= deadline || (method === 'GET' && ++reads > 40)) throw c.error(409,'CATALOG_DELETE_OBSERVATION_LIMIT','Перевірка перевищила межу; повного результату немає.');
    const url = new URL(`${origin}/rest/${storeCode}/V1/${path}`);
    if (query) url.search = new URLSearchParams(query).toString();
    const signal = AbortSignal.timeout(Math.min(timeoutMs, Math.max(1,deadline-Date.now())));
    const authorization = method === 'DELETE' ? signCatalogDeleteRequest(url.toString(),credentials) : signGetRequest(url.toString(),credentials);
    let response;
    try {
      response = await fetchImpl(url.toString(),{method,redirect:'manual',signal,headers:{Accept:'application/json',Authorization:authorization}});
      if (!response.ok) throw c.error(409,'CATALOG_DELETE_REMOTE_UNAVAILABLE','Magento не підтвердив результат. Повторне видалення не надсилається.');
      return await readJson(response);
    } catch (error) {
      if (error.code === 'CATALOG_DELETE_REMOTE_UNAVAILABLE') throw error;
      throw c.error(409,'CATALOG_DELETE_REMOTE_UNAVAILABLE','Magento недоступний або повернув неповну відповідь.');
    } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }
  function listQuery(field,value,condition='eq') {
    return {'searchCriteria[filter_groups][0][filters][0][field]':field,'searchCriteria[filter_groups][0][filters][0][value]':String(value),
      'searchCriteria[filter_groups][0][filters][0][condition_type]':condition,'searchCriteria[pageSize]':'100','searchCriteria[currentPage]':'1'};
  }
  function complete(result,limit=100) {
    if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(result.total_count) || result.total_count < 0
      || result.total_count > limit || result.items.length !== result.total_count) throw c.error(409,'CATALOG_DELETE_INCOMPLETE_SCOPE','Повний перелік залежностей не отримано.');
    return result.items;
  }
  return Object.freeze({
    async attribute(target) {
      pathFor(target);
      const items = complete(await request('GET','products/attributes',listQuery('attribute_code',target.attributeCode)),1);
      if (items.some(item => item.attribute_code !== target.attributeCode)) c.invalid();
      return items[0] || null;
    },
    async stores() {
      const views=await request('GET','store/storeViews');
      if(!Array.isArray(views) || views.length>20 || views.some(view=>!Number.isSafeInteger(view.id) || view.id<0
        || (view.id===0 && view.code!=='admin') || (view.code==='admin' && view.id!==0)
        || !c.code(view.code) || ![true,false,0,1].includes(view.is_active))
        || new Set(views.map(view=>view.id)).size!==views.length || new Set(views.map(view=>view.code)).size!==views.length) c.invalid();
      const active=views.filter(view=>view.id>0 && (view.is_active===true || view.is_active===1)).map(view=>({id:view.id,code:view.code})).sort((a,b)=>a.id-b.id);
      if(active.length>5) throw c.error(409,'CATALOG_DELETE_INCOMPLETE_SCOPE','Забагато активних мовних магазинів для повної перевірки.');
      return [{id:0,code:'all'},...active.filter(view=>view.code!=='all')];
    },
    options: (target,storeCode='all') => { pathFor(target); return request('GET',`products/attributes/${target.attributeCode}/options`,undefined,storeCode); },
    async products(target,inputType,storeCode='all') {
      pathFor(target);
      // An attribute deletion is blocked by any stored value, not just a default.
      const condition = target.optionId === null ? 'notnull' : inputType === 'multiselect' ? 'finset' : 'eq';
      return complete(await request('GET','products',listQuery(target.attributeCode,target.optionId || '1',condition),storeCode))
        .map(item => { if (!c.positive(item.id) || typeof item.sku !== 'string' || !item.sku) c.invalid(); return {id:item.id,sku:item.sku}; });
    },
    async sets(target) {
      pathFor(target);
      const sets = complete(await request('GET','products/attribute-sets/sets/list',{'searchCriteria[pageSize]':'100','searchCriteria[currentPage]':'1'}));
      if (sets.length > 20) throw c.error(409,'CATALOG_DELETE_INCOMPLETE_SCOPE','Забагато наборів для повної перевірки.');
      const affected = [];
      for (const set of sets) {
        if (!c.positive(set.attribute_set_id) || typeof set.attribute_set_name !== 'string') c.invalid();
        const members = await request('GET',`products/attribute-sets/${set.attribute_set_id}/attributes`);
        if (!Array.isArray(members) || members.length > 2000) c.invalid();
        if (members.some(item => item.attribute_code === target.attributeCode && item.attribute_id !== target.attributeId)) c.invalid();
        if (members.some(item => item.attribute_id === target.attributeId)) affected.push({id:set.attribute_set_id,name:set.attribute_set_name});
      }
      return affected;
    },
    async remove(target) { const result = await request('DELETE',pathFor(target)); if (result !== true) throw c.error(409,'CATALOG_DELETE_RESULT_UNVERIFIED','Відповідь DELETE не підтверджена. Потрібна перевірка без повторного видалення.'); },
  });
}
module.exports = { pathFor, signCatalogDeleteRequest, createCatalogDeleteTransport };
