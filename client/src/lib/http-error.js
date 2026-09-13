export function getApiError(error, fallback = 'Невідома помилка') {
  return error?.response?.data?.error || error?.message || fallback;
}
