const limits = { category: 40, field: 120, question: 120, value: 500, path: 500 };
const hasControl = (value) => [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const routeKeys = ['intent', 'tab', 'version', 'templateVersion', 'step', 'draft'];

export function safeRepairReturn(value) {
  if (typeof value !== 'string' || value.length > 3000 || /[\\#]/.test(value) || hasControl(value)) return null;
  if (!/^\/(?:attention|sync-problems)(?:\?|$)/.test(value)) return null;
  return value;
}

// These values select a view only. Every preview and write still resolves its
// product, current publication and exact resource on the server.
export function repairContext(params) {
  const get = (key) => params instanceof URLSearchParams ? params.get(key) : params?.[key];
  const context = {};
  const productId = String(get('productId') ?? '');
  if (/^[1-9]\d*$/.test(productId) && Number.isSafeInteger(Number(productId))) context.productId = productId;
  for (const [key, limit] of Object.entries(limits)) {
    const value = get(key);
    if (typeof value === 'string' && value.length > 0 && value.length <= limit && !hasControl(value)) context[key] = value;
  }
  const returnTo = safeRepairReturn(get('returnTo'));
  if (returnTo) context.returnTo = returnTo;
  return context;
}

export function withRepairContext(path, context, overrides = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\#]/.test(path) || hasControl(path)) return '/admin/magento';
  const separator = path.indexOf('?');
  const pathname = separator === -1 ? path : path.slice(0, separator);
  const search = separator === -1 ? '' : path.slice(separator + 1);
  const params = new URLSearchParams(search);
  const selected = repairContext({ ...repairContext(params), ...repairContext(context), ...overrides });
  for (const key of ['productId', ...Object.keys(limits), 'returnTo']) {
    params.delete(key);
    if (selected[key]) params.set(key, selected[key]);
  }
  for (const key of routeKeys) {
    if (!Object.hasOwn(overrides, key)) continue;
    params.delete(key);
    const value = overrides[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 120 && !hasControl(value)) params.set(key, value);
  }
  return `${pathname}${params.size ? `?${params}` : ''}`;
}
