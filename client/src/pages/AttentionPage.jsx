import { CircleAlert, ClipboardList, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { correctionsApi } from '../api/corrections-api.js';
import { useAuth } from '../auth/auth-context.js';
import { Button, Notice, PageHeader, StatusBadge } from '../components/ui/index.js';
import { useMagentoSummary } from '../hooks/useMagentoSummary.js';

function AttentionCard({ icon: Icon, title, count, loading, error, countLabel, emptyLabel, description, to, linkLabel }) {
  const known = Number.isInteger(count) && count >= 0;
  return <section className="attention-card">
    <header><span className="attention-card-icon"><Icon size={19} aria-hidden="true" /></span><div><h2>{title}</h2><p>{description}</p></div></header>
    <div className="attention-card-state" role="status" aria-live="polite">
      {loading && <span>Оновлюємо стан…</span>}
      {!loading && error && <StatusBadge tone="warning">Стан недоступний</StatusBadge>}
      {!loading && !error && !known && <StatusBadge tone="neutral">Стан невідомий</StatusBadge>}
      {!loading && !error && known && <><strong>{count}</strong><span>{count === 0 ? emptyLabel : countLabel}</span></>}
    </div>
    <Link to={to} className="attention-card-link">{linkLabel}</Link>
  </section>;
}

export default function AttentionPage() {
  const { permissions } = useAuth();
  const canViewCorrections = permissions.includes('corrections.view');
  const canViewSync = permissions.includes('products.view');
  const [corrections, setCorrections] = useState({ loading: canViewCorrections, error: false, count: null });
  const [revision, setRevision] = useState(0);
  const magento = useMagentoSummary({ enabled: canViewSync });

  useEffect(() => {
    if (!canViewCorrections) return undefined;
    let live = true;
    setCorrections((current) => ({ ...current, loading: true, error: false }));
    correctionsApi.listRequests('active').then(({ data }) => {
      if (live) setCorrections({ loading: false, error: false,
        count: Number.isInteger(data?.summary?.active) ? data.summary.active : null });
    }).catch(() => { if (live) setCorrections({ loading: false, error: true, count: null }); });
    return () => { live = false; };
  }, [canViewCorrections, revision]);

  function refresh() { setRevision((value) => value + 1); magento.refresh(); }
  return <main className="app-page"><div className="attention-workspace">
    <PageHeader title="Потребує уваги" description="Поточні робочі черги, які вже зафіксовані в Amber."
      actions={<Button size="compactMd" onClick={refresh}><RefreshCw size={15} aria-hidden="true" />Оновити</Button>} />
    <Notice tone="info">Запити та проблеми доставки показано окремо. Якщо дані недоступні, оновіть їх.</Notice>
    <div className="attention-grid">
      {canViewCorrections && <AttentionCard icon={ClipboardList} title="Запити на виправлення"
        description="Активні запити, що очікують опрацювання або вже взяті в роботу."
        loading={corrections.loading} error={corrections.error} count={corrections.count}
        countLabel="активних запитів" emptyLabel="активних запитів немає"
        to="/admin/corrections" linkLabel="Відкрити запити" />}
      {canViewSync && <AttentionCard icon={CircleAlert} title="Доставка до Magento"
        description="Зафіксовані проблеми доставки та стани, що потребують перевірки."
        loading={magento.loading} error={magento.error} count={Number.isInteger(magento.summary?.problemCount) ? magento.summary.problemCount : null}
        countLabel="зафіксованих проблем" emptyLabel="зафіксованих проблем немає"
        to="/sync-problems" linkLabel="Переглянути проблеми" />}
    </div>
  </div></main>;
}
