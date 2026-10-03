import { Link } from 'react-router-dom';
import { Button, Notice, SectionHeader, StatusBadge, TechnicalDisclosure } from '../ui';
import './export-workspaces.css';

export function ExportLanding({ workflow, productTools }) {
  const legacyEnabled = workflow.exportStatus?.delivery?.legacyProductCsvEnabled;
  const pendingPrices = workflow.priceExportStatus?.pendingCount;
  const priceCountKnown = Number.isInteger(pendingPrices) && pendingPrices >= 0;
  const showProductWorkflow = legacyEnabled === true || workflow.pendingCreate
    || workflow.exportSnapshot || workflow.exportPreview;
  return <div className="export-landing">
    <SectionHeader title="Збережені файли та сесії" description="Історія попереднього експорту та доступ до його початкових операцій."
      actions={<Button size="compact" busy={workflow.statusLoading} onClick={workflow.fetchExportStatus}>Оновити стан</Button>} />
    <Notice tone="info">Поточні зміни товарів і цін доставляються через інтеграцію Magento. Цей розділ призначений для історії та сумісності попередніх експортів.</Notice>
    <nav className="export-destination-list" aria-label="Збережена робота з експортом">
      <Link to="/exports/history"><strong>Історія створених файлів</strong><span>Товари й ціни: точні збережені файли та підтвердження.</span></Link>
      <Link to="/exports/sessions"><strong>Мої експорти</strong><span>Продовжити перевірку або відкрити збережений результат.</span></Link>
      <Link to="/exports/shared"><strong>Спільні зі мною</strong><span>Експорти, до яких ви приєдналися.</span></Link>
      <Link to="/exports/invitations"><strong>Запрошення</strong><span>Переглянути запрошення до спільної роботи.</span></Link>
      <Link to="/exports/prices"><strong>Експорт цін (сумісність)</strong><span>Попередній потік файлів цін та відновлення початкової операції.</span></Link>
    </nav>
    <TechnicalDisclosure summary="Стан сумісного потоку цін">
      <StatusBadge tone="neutral">{workflow.statusLoading ? 'Оновлюємо стан…' : priceCountKnown
        ? `${pendingPrices} змін у сумісній черзі експорту цін` : 'Дані про чергу недоступні'}</StatusBadge>
      {workflow.priceStatusError && <Notice tone="warning" title="Не вдалося оновити стан експорту цін">{workflow.priceStatusError}</Notice>}
    </TechnicalDisclosure>
    {workflow.exportStatusError && <Notice tone="warning" title="Стан експорту товарів недоступний">{workflow.exportStatusError}</Notice>}
    {legacyEnabled === false && <Notice tone="info" title="CSV товарів вимкнено">
      Створення нових CSV товарів вимкнено. Історичні файли, сесії та сумісні операції залишаються доступними.
    </Notice>}
    {legacyEnabled === true && <Link className="underline" to="/exports/new/template">Експорт за опублікованим шаблоном</Link>}
    {showProductWorkflow && productTools}
  </div>;
}
