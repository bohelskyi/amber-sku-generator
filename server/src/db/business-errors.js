const { PublicHttpError } = require('../http/errors');

const INSTRUMENTED_QUERY = Symbol('media-business-errors');
const INSTRUMENTED_POOL = Symbol('media-business-error-pool');

function normalizeBusinessDatabaseError(error) {
  if (error?.code !== 'P0651' || error.constraint !== 'product_media_native_input_fence') return error;
  return new PublicHttpError(409,
    'Спочатку завершіть або перевірте передавання фото у товарі. Зміна товару недоступна, доки результат передавання не підтверджено.',
    { code: 'PHOTO_MEDIA_RECONCILIATION_REQUIRED' });
}

function mappedCallback(callback) {
  return function businessErrorCallback(error, ...results) {
    return callback.call(this, normalizeBusinessDatabaseError(error), ...results);
  };
}

function instrumentBusinessErrorQueries(target) {
  if (!target || typeof target.query !== 'function' || target[INSTRUMENTED_QUERY]) return target;
  Object.defineProperty(target, INSTRUMENTED_QUERY, { value: true });
  const original = target.query;
  target.query = function businessErrorQuery(...args) {
    if (typeof args[2] === 'function') args[2] = mappedCallback(args[2]);
    else if (typeof args[1] === 'function') args[1] = mappedCallback(args[1]);
    else if (args[0] && typeof args[0] === 'object' && typeof args[0].callback === 'function'
      && typeof args[0].submit !== 'function') {
      args[0] = { ...args[0], callback: mappedCallback(args[0].callback) };
    }
    let result;
    try { result = original.apply(this, args); }
    catch (error) { throw normalizeBusinessDatabaseError(error); }
    if (result && typeof result.then === 'function') {
      return result.then(undefined, (error) => { throw normalizeBusinessDatabaseError(error); });
    }
    return result;
  };
  return target;
}

function instrumentBusinessDatabaseErrors(pool) {
  instrumentBusinessErrorQueries(pool);
  if (pool && typeof pool.on === 'function' && !pool[INSTRUMENTED_POOL]) {
    Object.defineProperty(pool, INSTRUMENTED_POOL, { value: true });
    pool.on('connect', instrumentBusinessErrorQueries);
  }
  return pool;
}

module.exports = {
  normalizeBusinessDatabaseError,
  instrumentBusinessDatabaseErrors,
};
