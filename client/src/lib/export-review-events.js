// Notification of a successful authoritative mutation, never a local freshness hash.
const listeners = new Set();
export const notifyExportReviewChanged = (event = { kind: 'product' }) => { for (const listener of listeners) listener(event); };
export const subscribeExportReviewChanged = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
