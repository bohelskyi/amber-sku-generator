import { useEffect, useState } from 'react';
import { exportsApi } from '../../api/exports-api';
import { getApiError } from '../../lib/http-error';

export function ControlledExportOptions({ templateMode, setTemplateMode, templateSelection,
  setTemplateSelection, pendingCreate, isExportLoading, onRetry, evidence, canActivate, fixedMode = false }) {
  const [options, setOptions] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!templateMode) return undefined;
    let current = true;
    exportsApi.getTemplateOptions().then(({ data }) => { if (current) { setOptions(data); setError(''); } })
      .catch((e) => { if (current) setError(getApiError(e)); });
    return () => { current = false; };
  }, [templateMode, canActivate]);
  const effective = options?.versions?.find((v) => v.versionId === evidence?.template?.versionId);
  return <div className="border-b border-slate-200 p-4 space-y-3">
    {!fixedMode && <><label className="flex gap-2 items-start"><input type="checkbox" checked={templateMode} onChange={(e) => setTemplateMode(e.target.checked)} />
      Контрольований експорт за опублікованим шаблоном (явний opt-in)</label>
    <p className="text-xs text-slate-600">За замовчуванням — звичайний Magento v1 (legacy), незалежно від вибору кандидата адміністратором.</p></>}
    {templateMode && <div className="space-y-3 rounded border border-amber-300 p-3">
      <p className="text-sm">Це реальний експорт: створення знімка встановлює експозицію товарів, а «Завершити експорт» може просунути чергу. Тест без цих змін доступний лише для чернетки в редакторі.</p>
      <label className="block">Вибір публікації<select className="input" value={templateSelection.mode} onChange={(e) => setTemplateSelection(e.target.value === 'active' ? { mode: 'active' } : { mode: 'explicit', templateId: '', versionId: '' })}>
        <option value="active">Вибраний адміністратором кандидат</option>
        {canActivate && <option value="explicit">Явно вказана опублікована версія</option>}
      </select></label>
      {error && <p role="alert" className="text-red-700">Не вдалося прочитати назви публікацій: {error}</p>}
      {!options && !error && <p role="status">Завантаження назв публікацій…</p>}
      {options && templateSelection.mode === 'active' && <p className="text-sm">{options.activeVersionId
        ? `Вибрано: ${options.versions.find((v) => v.versionId === options.activeVersionId)?.displayName || options.activeVersionId} · v${options.versions.find((v) => v.versionId === options.activeVersionId)?.versionNumber || '—'}`
        : 'Адміністратор ще не вибрав публікацію. Контрольований експорт недоступний.'} Перевірка повторно визначає фактичну версію.</p>}
      {templateSelection.mode === 'explicit' && <label className="block">Опублікована версія<select className="input" value={templateSelection.versionId} onChange={(e) => {
        const selected = options?.versions.find((v) => v.versionId === e.target.value);
        setTemplateSelection({ mode: 'explicit', templateId: selected?.templateId || '', versionId: selected?.versionId || '' });
      }}><option value="">Оберіть публікацію</option>{options?.versions?.map((v) => <option key={v.versionId} value={v.versionId}>{v.displayName} · v{v.versionNumber}</option>)}</select></label>}
      {templateSelection.mode === 'explicit' && <details><summary className="text-xs">Технічний вибір за UUID</summary><div className="grid gap-3 sm:grid-cols-2">
        <label>ID сімейства шаблону<input className="input" value={templateSelection.templateId} onChange={(e) => setTemplateSelection({ ...templateSelection, templateId: e.target.value })} /></label>
        <label>ID опублікованої версії<input className="input" value={templateSelection.versionId} onChange={(e) => setTemplateSelection({ ...templateSelection, versionId: e.target.value })} /></label>
      </div></details>}
      <p className="text-xs">Недоступний вибір повертає помилку. Автоматичної заміни іншим шаблоном чи legacy немає.</p>
    </div>}
    {evidence?.template && <details open className="text-sm"><summary>Фактична публікація {evidence.id ? 'знімка' : 'перевірки'}</summary>
      {effective && <p className="font-semibold">{effective.displayName} · v{effective.versionNumber}</p>}
      <p className="break-all">Версія: {evidence.template.versionId}</p><p className="break-all text-xs">Сімейство: {evidence.template.templateId} · SHA-256: {evidence.template.definitionHash}</p>
    </details>}
    {pendingCreate && <div role="alert" className="rounded bg-amber-50 p-3 space-y-2">
      <p>Є незавершена операція створення. Зміна полів не змінює її запит. Повтор використовує початковий діапазон, шаблон, токен і ключ.</p>
      <p className="break-words text-sm">Початковий діапазон: {pendingCreate.evidence.range?.fromSku} — {pendingCreate.evidence.range?.toSku || pendingCreate.evidence.range?.resolvedToSku}.</p>
      <p className="text-xs">Операція зберігається під час переходів між розділами в цій сесії. Не перезавантажуйте сторінку: автоматичного відновлення після перезавантаження немає.</p>
      <p className="break-all text-xs">Ключ для звірки: {pendingCreate.idempotencyKey}</p>
      <button className="btn btn-primary px-3" disabled={isExportLoading} onClick={onRetry}>Повторити початкове створення</button>
    </div>}
  </div>;
}
