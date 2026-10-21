import { Link } from 'react-router-dom';
import { Notice, StatusBadge, TechnicalDisclosure } from '../ui';
import './export-workspaces.css';

export function ExportLanding({ workflow, productTools, historyContent }) {
  const legacyEnabled = workflow.exportStatus?.delivery?.legacyProductCsvEnabled;
  const pendingPrices = workflow.priceExportStatus?.pendingCount;
  const priceCountKnown = Number.isInteger(pendingPrices) && pendingPrices >= 0;
  const showProductWorkflow = workflow.pendingCreate
    || workflow.exportSnapshot || workflow.exportPreview;
  return <div className="export-landing">
    <nav className="export-continuation-links" aria-label="Незавершена робота">
      <Link to="/exports/sessions">Мої експорти</Link>
      <Link to="/exports/shared">Спільні зі мною</Link>
      <Link to="/exports/invitations">Запрошення</Link>
    </nav>
    {showProductWorkflow && <section aria-label="Початкова операція експорту">{productTools}</section>}
    {historyContent}
    <TechnicalDisclosure summary="Стан сумісного потоку цін">
      <StatusBadge tone="neutral">{workflow.statusLoading ? 'Оновлюємо стан…' : priceCountKnown
        ? `${pendingPrices} змін у сумісній черзі експорту цін` : 'Дані про чергу недоступні'}</StatusBadge>
      {workflow.priceStatusError && <Notice tone="warning" title="Не вдалося оновити стан експорту цін">{workflow.priceStatusError}</Notice>}
    </TechnicalDisclosure>
    {workflow.exportStatusError && <Notice tone="warning" title="Стан експорту товарів недоступний">{workflow.exportStatusError}</Notice>}
    {legacyEnabled === true && !showProductWorkflow && <details><summary>Створити сумісний експорт</summary>
      <Link className="underline" to="/exports/new/template">Експорт за опублікованим шаблоном</Link>{productTools}
    </details>}
  </div>;
}
