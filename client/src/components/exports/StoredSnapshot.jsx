import { useCallback, useState } from 'react';
import { exportsApi } from '../../api/exports-api';
import { ExportDataGrid } from './ExportDataGrid';
import { dateText } from '../../lib/export-review-presentation';
import { WorkspaceDialog } from '../workspace/WorkspaceDialog';

export function StoredSnapshot({ snapshot, loading, onDownload, onConfirm, canConfirm = false, onDenied, loadArtifact }) {
  const [confirming, setConfirming] = useState(false);
  const price = snapshot.stream === 'price';
  const loadFile = useCallback(async (group) => (await (price ? exportsApi.readPriceArtifact(snapshot.id)
    : exportsApi.readMagentoArtifact(snapshot.id, group))).data, [snapshot.id, price]);
  const range = snapshot.capturedRange;
  return <section className="p-3 space-y-3" aria-label="Збережений результат">
    <h3 className="font-semibold text-lg">ЗБЕРЕЖЕНІ ФАЙЛИ</h3>
    <p>Незмінний збережений результат. Таблиця читається зі створеного файлу.</p>
    <p>Створено: {dateText(snapshot.generatedAt)} · Товарів: {snapshot.productCount ?? snapshot.rowCount ?? 'Немає даних'} · Рядків CSV: {snapshot.csvRowCount ?? (snapshot.artifacts?.length ? snapshot.artifacts.reduce((n, a) => n + Number(a.rowCount || 0), 0) : 'Немає даних')}</p>
    <p>{price ? 'Оновлення цін · sku,price' : snapshot.template ? `${snapshot.templateLabel?.displayName || 'Опублікований шаблон'} · v${snapshot.templateLabel?.versionNumber || 'Немає даних'}` : snapshot.recipe?.name || (snapshot.artifacts?.length ? 'Системний профіль' : 'Немає даних про профіль Magento')}</p>
    {!price && <p>Зафіксований діапазон: {range ? `${range.fromSku} — ${range.toSku || range.resolvedToSku}` : 'Немає даних'}</p>}
    <ExportDataGrid key={`${snapshot.id}:${snapshot.accessEpoch || ''}`} identity={snapshot.id} files={snapshot.artifacts} stored loadFile={loadArtifact || loadFile} onDownload={onDownload} onDenied={onDenied} />
    <div className="border-t pt-4">
      {snapshot.status === 'confirmed' ? <div role="status"><p>Експорт завершено</p><p>Підтверджено: {dateText(snapshot.confirmedAt)} · Користувач: {snapshot.confirmedByUserId ?? 'Немає даних'}</p></div> : <>
        <p>Очікує підтвердження. Завантаження файлу нічого не підтверджує.</p>
        {canConfirm && <button className="btn btn-primary mt-3 px-4" disabled={loading} onClick={() => setConfirming(true)}>{price ? 'Підтвердити експорт цін' : 'Завершити експорт'}</button>}
      </>}
    </div>
    <details><summary>Технічні подробиці</summary><p className="break-all">Знімок: {snapshot.id}</p><p>Автор: {snapshot.createdByUserId ?? 'Немає даних'}</p>{snapshot.template && <p className="break-all">Публікація: {snapshot.template.versionId} · {snapshot.template.definitionHash}</p>}<p>Статус: {snapshot.status}</p></details>
    {confirming && <WorkspaceDialog title={price ? 'Підтвердження експорту цін' : 'Завершення експорту'} busy={loading} onClose={() => setConfirming(false)}>
      <h3>{price ? 'Підтвердити збережений експорт цін?' : 'Завершити збережений експорт?'}</h3>
      <p>Ця дія підтверджує саме збережений файл від {dateText(snapshot.generatedAt)}.</p>
      <p>{price ? 'Сервер підтвердить лише зміни цін, зафіксовані в цьому файлі. Пізніші зміни залишаться в черзі. Звичайний курсор товарів не зміниться.' : 'Черга нових товарів просунеться до зафіксованого товару, якщо ще не дійшла до нього. Сервер підтвердить лише ревізії цін із цього знімка за чинними правилами; пізніші зміни залишаться в черзі.'}</p>
      <p>Це не означає, що імпорт у Magento успішний. Попереднє завантаження не є умовою підтвердження.</p>
      <button className="btn btn-primary px-4" disabled={loading} onClick={async () => { await onConfirm(); setConfirming(false); }}>Підтвердити збережений експорт</button>
      <button className="btn btn-outline px-4" disabled={loading} onClick={() => setConfirming(false)}>Скасувати</button>
    </WorkspaceDialog>}
  </section>;
}
