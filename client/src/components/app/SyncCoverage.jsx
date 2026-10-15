import { useMagentoSummary } from '../../hooks/useMagentoSummary.js';
import { coveragePercent } from '../../lib/sync-coverage.js';

function CoverageBar({ label, synced, total, compact = false }) {
  const percent = coveragePercent(synced, total);
  return (
    <div className={compact ? 'sync-coverage-row is-compact' : 'sync-coverage-row'}>
      <div className="sync-coverage-row-text">
        <span className="sync-coverage-label">{label}</span>
        <span className="sync-coverage-count">{synced} / {total} · {percent}%</span>
      </div>
      <div className="sync-coverage-track" role="progressbar" aria-label={`${label}: синхронізовано ${percent}%`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="sync-coverage-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

// Presentation only; the server decides which current products count as synchronized.
export function SyncCoverage() {
  const { summary } = useMagentoSummary();
  const coverage = summary?.coverage;
  if (!coverage || !coverage.total) return null;
  return (
    <section className="sync-coverage card fade-up" data-testid="sync-coverage">
      <CoverageBar label="Синхронізовано з Magento" synced={coverage.synced} total={coverage.total} />
      <div className="sync-coverage-categories">
        {coverage.categories.map((category) => (
          <CoverageBar key={category.code} label={category.name} synced={category.synced} total={category.total} compact />
        ))}
      </div>
    </section>
  );
}
