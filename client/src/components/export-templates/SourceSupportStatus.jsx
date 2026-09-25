export function SourceSupportEvidence({ policy }) {
  return <>{policy?.placeholder === 'numeric-zero-v1' && <p>Числовий 0 приймається лише з підтвердженим історичним placeholder за власною SKU-схемою товару. Рядок «0» автоматично не означає порожнє значення.</p>}
    {policy && <pre>{JSON.stringify(policy, null, 2)}</pre>}</>;
}

export function SourceSupportStatus({ definition, sourceId, diagnostics = [], showDetails = true, compact = false, onDetails, exceptionalOnly = false, confirmed = false }) {
  const source = definition.sources?.[sourceId];
  if (!source) return null;
  const identity = `${source.category}.${source.key}`;
  const policy = definition.sourceSupport?.sources?.[identity];
  const unresolved = diagnostics.some((d) => d.sourceId === sourceId);
  if (compact) {
    const messages = [
      unresolved && 'Джерело потрібно перевірити перед публікацією.',
      policy?.placeholder === 'numeric-zero-v1' && 'Історичне порожнє значення підтверджується схемою товару.',
      policy?.deferredValues?.length > 0 && 'Значення є в каталозі, але ще не підтримується цією версією.',
    ].filter(Boolean);
    if (exceptionalOnly && !messages.length) return null;
    return <section className="et-source-status et-source-status-compact" aria-label="Підтримка джерела">
      {(messages.length ? messages : [confirmed || policy || source.kind === 'product' ? 'Джерело підтверджено' : 'Підтримка джерела перевіряється перед публікацією.']).map((message) => <p key={message}>{message}</p>)}
      {onDetails && <button type="button" className="et-link" onClick={onDetails}>Докладніше</button>}
    </section>;
  }
  return <section className="et-source-status" aria-label="Підтримка джерела">
    <p>{unresolved ? '⚠ Не вдалося підтвердити джерело для публікації.' : policy ? '✓ Підтримку значень зафіксовано у шаблоні' : 'Підтримка джерела перевіряється перед публікацією.'}</p>
    {policy?.semanticValues?.includes('0') && <p>0 — звичайне підтримуване значення. Це не порожня відповідь.</p>}
    {policy?.placeholder === 'numeric-zero-v1' && <p>Історичне порожнє значення підтверджується схемою товару.</p>}
    {policy?.deferredValues?.length > 0 && <p>Значення є в каталозі, але ще не підтримується цією версією шаблону. Таких значень: {policy.deferredValues.length}. Товари з ними не допускаються до експорту.</p>}
    {showDetails && policy && <details><summary>Подробиці джерела</summary><SourceSupportEvidence policy={policy} /></details>}
  </section>;
}
