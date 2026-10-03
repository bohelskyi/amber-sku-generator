import { useCallback, useState } from 'react';
import { exportsApi } from '../../api/exports-api';
import { ExportDataGrid } from './ExportDataGrid';
import { dateText } from '../../lib/export-review-presentation';
import { ConfirmDialog, OperationReceipt, TechnicalDisclosure } from '../ui';

export function StoredSnapshot({ snapshot, loading, onDownload, onConfirm, canConfirm = false, onDenied, loadArtifact }) {
  const [confirming, setConfirming] = useState(false);
  const price = snapshot.stream === 'price';
  const loadFile = useCallback(async (group) => (await (price ? exportsApi.readPriceArtifact(snapshot.id)
    : exportsApi.readMagentoArtifact(snapshot.id, group))).data, [snapshot.id, price]);
  const range = snapshot.capturedRange;
  return <section className="p-3 space-y-3" aria-label="Збережений результат">
    {snapshot.fullProductSelection?.mode === 'replacement' && <p className="notice">Погоджена заміна SKU. Перед обробкою звірте попередній товар і файли.</p>}
    {snapshot.fullProductWarnings?.length > 0 && <p className="notice notice-warning" role="alert">
      Файл містить товари, які пізніше виправили або архівували: {snapshot.fullProductWarnings.map((p)=>p.sku_at_capture).join(', ')}. Звірте їх перед імпортом.
    </p>}
    <OperationReceipt title="Збережені файли" description={snapshot.artifacts?.length
      ? 'Незмінний збережений результат. Таблиця читається зі створеного файлу.'
      : 'Збережено відомості про експорт. Файли CSV для цього запису недоступні.'} />
    <p>Створено: {dateText(snapshot.generatedAt)} · Товарів: {snapshot.productCount ?? snapshot.rowCount ?? 'Немає даних'} · Рядків CSV: {snapshot.csvRowCount ?? (snapshot.artifacts?.length ? snapshot.artifacts.reduce((n, a) => n + Number(a.rowCount || 0), 0) : 'Немає даних')}</p>
    <p>{price ? 'Оновлення цін · sku,price' : snapshot.template ? `${snapshot.templateLabel?.displayName || 'Опублікований шаблон'} · v${snapshot.templateLabel?.versionNumber || 'Немає даних'}` : snapshot.recipe?.name || (snapshot.artifacts?.length ? 'Системний профіль' : 'Немає даних про профіль Magento')}</p>
    {!price && <p>Зафіксований діапазон: {range ? `${range.fromSku} — ${range.toSku || range.resolvedToSku}` : 'Немає даних'}</p>}
    <ExportDataGrid key={`${snapshot.id}:${snapshot.accessEpoch || ''}`} identity={snapshot.id} files={snapshot.artifacts} stored loadFile={loadArtifact || loadFile} onDownload={onDownload} onDenied={onDenied} />
    <div className="border-t pt-4">
      {snapshot.status === 'confirmed' ? <div role="status"><p>Експорт завершено</p><p>Підтверджено: {dateText(snapshot.confirmedAt)} · Користувач: {snapshot.confirmedByName || (snapshot.confirmedByUserId == null ? 'Автор невідомий' : 'Ім’я недоступне')}</p></div> : <>
        <p>Очікує підтвердження. Завантаження файлу нічого не підтверджує.</p>
        {canConfirm && <button className="btn btn-primary mt-3 px-4" disabled={loading} onClick={() => setConfirming(true)}>{price ? 'Підтвердити експорт цін' : 'Завершити експорт'}</button>}
      </>}
    </div>
    <TechnicalDisclosure><p className="break-all">Знімок: {snapshot.id}</p><p>Автор: {snapshot.createdByUserId ?? 'Немає даних'}</p>{snapshot.template && <p className="break-all">Публікація: {snapshot.template.versionId} · {snapshot.template.definitionHash}</p>}<p>Статус: {snapshot.status}</p></TechnicalDisclosure>
    <ConfirmDialog open={confirming} title={price ? 'Підтвердження експорту цін' : 'Завершення експорту'} busy={loading} onClose={() => setConfirming(false)}
      confirmLabel="Підтвердити збережений експорт" onConfirm={async () => { await onConfirm(); setConfirming(false); }}>
      <p className="font-semibold">{price ? 'Підтвердити збережений експорт цін?' : 'Завершити збережений експорт?'}</p>
      <p>Ця дія підтверджує саме збережений файл від {dateText(snapshot.generatedAt)}.</p>
      <p>{price ? 'Сервер підтвердить лише зміни цін, зафіксовані в цьому файлі. Пізніші зміни залишаться в черзі. Черга нових товарів не зміниться.' : 'Черга нових товарів просунеться до зафіксованого товару, якщо ще не дійшла до нього. Сервер врахує лише зміни цін, зафіксовані в цих файлах за чинними правилами; пізніші зміни залишаться в черзі.'}</p>
      <p>Це не означає, що імпорт у Magento успішний. Попереднє завантаження не є умовою підтвердження.</p>
    </ConfirmDialog>
  </section>;
}
