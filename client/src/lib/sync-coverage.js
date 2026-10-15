export function coveragePercent(synced, total) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((synced / total) * 100)));
}
