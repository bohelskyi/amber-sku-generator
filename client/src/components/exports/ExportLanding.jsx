import { Link } from 'react-router-dom';
import { Button, Notice, SectionHeader, StatusBadge } from '../ui';
import './export-workspaces.css';

export function ExportLanding({ workflow, productTools }) {
  const legacyEnabled = workflow.exportStatus?.delivery?.legacyProductCsvEnabled;
  const pendingPrices = workflow.priceExportStatus?.pendingCount;
  const priceCountKnown = Number.isInteger(pendingPrices) && pendingPrices >= 0;
  const showProductWorkflow = legacyEnabled === true || workflow.pendingCreate
    || workflow.exportSnapshot || workflow.exportPreview;
  return <div className="export-landing">
    <SectionHeader title="Файли та робочі експорти" description="Перевіряйте зміни, створюйте файли й повертайтеся до збережених результатів."
      actions={<Button size="compact" busy={workflow.statusLoading} onClick={workflow.fetchExportStatus}>Оновити стан</Button>} />
    <section className="export-price-entry" aria-labelledby="export-price-entry-title">
      <div><h2 id="export-price-entry-title">Експорт цін</h2>
        <p>Окремий файл артикулів і цін для оновлення Magento.</p>
        <StatusBadge tone={priceCountKnown && pendingPrices > 0 ? 'info' : 'neutral'}>
          {workflow.statusLoading ? 'Оновлюємо стан…' : priceCountKnown
            ? `${pendingPrices} змін очікують експорту` : 'Дані про чергу недоступні'}
        </StatusBadge>
      </div>
      <Link className="btn btn-primary" to="/exports/prices">Переглянути зміни цін</Link>
    </section>
    {workflow.priceStatusError && <Notice tone="warning" title="Не вдалося оновити стан експорту цін">{workflow.priceStatusError}</Notice>}
    <nav className="export-destination-list" aria-label="Збережена робота з експортом">
      <Link to="/exports/sessions"><strong>Мої експорти</strong><span>Продовжити перевірку або відкрити збережений результат.</span></Link>
      <Link to="/exports/shared"><strong>Спільні зі мною</strong><span>Експорти, до яких ви приєдналися.</span></Link>
      <Link to="/exports/invitations"><strong>Запрошення</strong><span>Переглянути запрошення до спільної роботи.</span></Link>
      <Link to="/exports/history"><strong>Історія створених файлів</strong><span>Товари й ціни: точні збережені файли та підтвердження.</span></Link>
    </nav>
    {workflow.exportStatusError && <Notice tone="warning" title="Стан експорту товарів недоступний">{workflow.exportStatusError}</Notice>}
    {legacyEnabled === false && <Notice tone="info" title="CSV товарів вимкнено">
      Створення нових CSV товарів вимкнено. Збережені файли, робочі експорти та окремий експорт цін залишаються доступними.
    </Notice>}
    {legacyEnabled === true && <Link className="underline" to="/exports/new/template">Експорт за опублікованим шаблоном</Link>}
    {showProductWorkflow && productTools}
  </div>;
}
