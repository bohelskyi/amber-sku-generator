import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, RefreshCw } from 'lucide-react';
import { exportsApi } from '../../api/exports-api';
import { getApiError } from '../../lib/http-error';
import { getNewProductCopy } from '../../lib/product-export-copy';
import { ControlledExportOptions } from './ControlledExportOptions';
import { Link } from 'react-router-dom';

const INITIAL_PROBLEM_ROWS = 6;

const GROUP_NAMES = {
  BR: 'Браслети',
  NM: 'Намиста',
  KL: 'Кулони',
  CH: 'Чотки',
  AR: 'Картини',
  SV: 'Сувеніри',
};

const FIELD_LABELS = {
  name: 'назву',
  decor_weight: 'вагу',
  vaha_vyrobu: 'вагу виробу',
  price: 'ціну',
  categories: 'категорію Magento',
  dovzhyna_brasletu_diuimiv: 'довжину браслета',
  dovzhyna_namysta_tochna: 'точну довжину намиста',
  dovzhyna_namysta: 'довжину намиста',
  rozmir_iuvelirnoho_vyrobu: 'розмір виробу',
  dovzhyna_namystyny: 'довжину намистини',
  diametr_namystyny: 'діаметр намистини',
  dovzhyna_vyrobu: 'довжину виробу',
  rozmir_kameniu: 'розмір каменю',
  rozmir_kartyny: 'розмір картини',
  rozmir_suveniriv: 'розмір сувеніра',
  typy_obrobky_burshtynu: 'тип обробки бурштину',
  vyd_obrobky_kameniu: 'вид обробки каменю',
  faktura_namystyn: 'фактуру намистин',
  faktura_kulonu: 'фактуру кулона',
  kolir: 'колір',
  forma_namystyn: 'форму намистин',
  typ_vykonannia: 'тип виконання',
  vyd_kulonu: 'вид кулона',
  relihiina_prynalezhnist: 'релігійну приналежність',
  kilkist_namystyn: 'кількість намистин',
  kartynyy: 'тип картини',
  sklo: 'наявність скла',
  dodatkovo_kartyny: 'додаткові характеристики картини',
  kartyny_pidsvitka: 'підсвітку картини',
  suveniry: 'тип сувеніра',
  vyd_statuetky: 'вид статуетки',
  tematyka_vyrobu: 'тематику виробу',
  vyd_ptakha: 'вид птаха',
  vyd_roslyny: 'вид рослини',
  vyd_symvoliky: 'вид символіки',
  nastlni_ihry: 'настільну гру',
  kamin_obrobka: 'обробку каменю',
  kamin_suvenirnyi: 'вид сувенірного каменю',
};

function getIssueLabel(field) {
  if (field.code === 'manual_name_required' || field.field === 'name') {
    return 'Потрібно вказати назву';
  }
  if (field.field === 'decor_weight' || field.field === 'vaha_vyrobu') {
    return 'Відсутня вага';
  }
  if (field.field === 'price') return 'Відсутня ціна';
  if (field.field === 'categories') return 'Не визначено категорію Magento';
  const label = FIELD_LABELS[field.field];
  return label ? `Потрібно перевірити ${label}` : 'Потрібно перевірити дані товару';
}

function getProblemGroups(errors) {
  const groups = new Map();
  for (const product of errors) {
    const productReasons = new Set((product.fields || []).map(getIssueLabel));
    for (const reason of productReasons) groups.set(reason, (groups.get(reason) || 0) + 1);
  }
  return [...groups.entries()].map(([reason, count]) => ({ reason, count }));
}

function getProductProblems(product) {
  return [...new Set((product.fields || []).map(getIssueLabel))];
}

function productCountLabel(rawCount) {
  const count = Number(rawCount);
  if (!Number.isFinite(count)) return '';
  const plural = new Intl.PluralRules('uk').select(count);
  const noun = plural === 'one' ? 'товар' : plural === 'few' ? 'товари' : 'товарів';
  return `${count} ${noun}`;
}

function readinessHeading(rawCount) {
  const count = Number(rawCount) || 0;
  const plural = new Intl.PluralRules('uk').select(count);
  const noun = plural === 'one' ? 'товар готовий'
    : plural === 'few' ? 'товари готові' : 'товарів готові';
  return `${count} ${noun} до експорту`;
}

function problemsHeading(rawCount) {
  const count = Number(rawCount) || 0;
  const plural = new Intl.PluralRules('uk').select(count);
  const phrase = plural === 'one' ? 'товар потребує'
    : plural === 'few' ? 'товари потребують' : 'товарів потребують';
  return `${count} ${phrase} виправлення`;
}

function priceChangesHeading(rawCount) {
  const count = Number(rawCount) || 0;
  const plural = new Intl.PluralRules('uk').select(count);
  const phrase = plural === 'one' ? 'зміна ціни очікує'
    : plural === 'few' ? 'зміни цін очікують' : 'змін цін очікують';
  return `${count} ${phrase} експорту.`;
}

function ManualMagentoNameEditor({ product, onClose, onSaved,
  translationSuggestionAvailable }) {
  const [subjectUa, setSubjectUa] = useState('');
  const [subjectEn, setSubjectEn] = useState('');
  const [enEdited, setEnEdited] = useState(false);
  const [suggestionError, setSuggestionError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestionAttempt, setSuggestionAttempt] = useState(0);

  useEffect(() => {
    const ua = subjectUa.trim();
    if (!translationSuggestionAvailable || !ua || enEdited) return undefined;
    let current = true;
    const timeout = setTimeout(async () => {
      setIsSuggesting(true);
      setSuggestionError('');
      try {
        const response = await exportsApi.suggestMagentoName({
          productId: product.productId, subjectUa: ua,
        });
        if (current) setSubjectEn(response.data.subjectEn);
      } catch (error) {
        if (current) setSuggestionError(getApiError(error));
      } finally {
        if (current) setIsSuggesting(false);
      }
    }, 500);
    return () => { current = false; clearTimeout(timeout); };
  }, [subjectUa, enEdited, product.productId, suggestionAttempt,
    translationSuggestionAvailable]);

  const save = async () => {
    setSaveError('');
    setIsSaving(true);
    try {
      const payload = { productId: product.productId,
        subjectUa: subjectUa.trim(), subjectEn: subjectEn.trim() };
      const preview = await exportsApi.previewMagentoName(payload);
      await exportsApi.applyMagentoName({ ...payload,
        previewToken: preview.data.previewToken });
      onSaved();
    } catch (error) {
      setSaveError(getApiError(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="font-semibold">Назва для {product.sku}</p>
      <p className="text-xs text-slate-600">Збереження назви не змінить SKU, ціну чи характеристики товару.</p>
      <label className="mt-3 block text-sm font-medium" htmlFor="magento-subject-ua">Українська назва</label>
      <input id="magento-subject-ua" className="input mt-1" value={subjectUa}
        onChange={(event) => {
          setSubjectUa(event.target.value);
          setSuggestionError('');
          setIsSuggesting(false);
        }}
        maxLength={200} />
      <label className="mt-3 block text-sm font-medium" htmlFor="magento-subject-en">English name</label>
      <input id="magento-subject-en" className="input mt-1" value={subjectEn}
        onChange={(event) => {
          setSubjectEn(event.target.value);
          setEnEdited(true);
          setIsSuggesting(false);
        }}
        maxLength={200} />
      {translationSuggestionAvailable && subjectUa.trim() && (
        <button className="mt-2 text-sm underline" onClick={() => {
          setEnEdited(false);
          setSuggestionAttempt((current) => current + 1);
        }}>Запропонувати переклад</button>
      )}
      {translationSuggestionAvailable && isSuggesting
        && <p className="text-xs text-slate-600">Пропонуємо переклад…</p>}
      {translationSuggestionAvailable && suggestionError && (
        <div className="text-sm text-amber-900" role="alert">
        {suggestionError} Англійську назву можна ввести вручну.
        <button className="ml-2 underline" onClick={() => {
          setEnEdited(false);
          setSuggestionAttempt((current) => current + 1);
        }}>Спробувати переклад ще раз</button>
        </div>
      )}
      <p className="mt-3 text-sm">UA: {subjectUa.trim()
        ? `${subjectUa.trim()} з бурштину. Арт: ${product.sku}` : '—'}</p>
      <p className="text-sm">EN: {subjectEn.trim()
        ? `Amber ${subjectEn.trim()}. Art: ${product.sku}` : '—'}</p>
      {saveError && <p className="mt-2 text-sm text-red-700" role="alert">{saveError}</p>}
      <div className="mt-3 flex gap-2">
        <button className="btn btn-primary px-4" onClick={save}
          disabled={isSaving || !subjectUa.trim() || !subjectEn.trim()}>
          {isSaving ? 'Зберігаємо…' : 'Зберегти назви'}
        </button>
        <button className="btn px-4" onClick={onClose}>Скасувати</button>
      </div>
    </div>
  );
}

export function PreviewSummary({ preview, loading, onRefresh }) {
  const representedCount = Number(preview.representedCount || 0);
  const readyCount = Number(preview.readyCount || 0);
  const attentionCount = Math.max(0, representedCount - readyCount);
  return (
    <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid grid-cols-3 gap-x-6 gap-y-2 text-sm">
          <p><strong className="block text-lg leading-5 text-slate-900">{representedCount}</strong><span className="text-slate-600">всього</span></p>
          <p><strong className="block text-lg leading-5 text-emerald-700">{readyCount}</strong><span className="text-slate-600">готові</span></p>
          <p><strong className={`block text-lg leading-5 ${attentionCount ? 'text-amber-700' : 'text-slate-500'}`}>{attentionCount}</strong><span className="text-slate-600">потребують уваги</span></p>
        </div>
        <button type="button" className="btn btn-outline gap-2 px-3 py-2 text-xs"
          onClick={onRefresh} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Оновлюємо…' : 'Оновити перевірку'}
        </button>
      </div>
    </div>
  );
}

export function ReadinessProblems({ errors, expanded, showAll, onToggle, onShowAll,
  manualNameProduct, onEditName, onCloseName, onSavedName,
  translationSuggestionAvailable }) {
  const groups = getProblemGroups(errors);
  const visibleErrors = showAll ? errors : errors.slice(0, INITIAL_PROBLEM_ROWS);
  return (
    <div className="px-4 py-5 sm:px-5">
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 shrink-0 text-amber-700" size={20} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h5 className="font-semibold text-slate-900">{problemsHeading(errors.length)}</h5>
          <ul className="mt-2 space-y-1 text-sm text-slate-700">
            {groups.map((group) => <li key={group.reason}><strong>{group.count}</strong> — {group.reason.toLocaleLowerCase('uk')}</li>)}
          </ul>
          <button type="button" className="mt-4 text-sm font-semibold text-slate-800 underline decoration-slate-300 underline-offset-4"
            aria-expanded={expanded} onClick={onToggle}>
            {expanded ? 'Сховати проблемні товари' : 'Показати проблемні товари'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
          <div className="hidden grid-cols-[minmax(120px,0.7fr)_minmax(260px,2fr)_minmax(130px,0.8fr)] gap-3 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 sm:grid">
            <span>SKU</span><span>Проблема</span><span>Дія</span>
          </div>
          <div className="divide-y divide-slate-200">
            {visibleErrors.map((product) => {
              const problems = getProductProblems(product);
              const canEditName = Boolean(onEditName) && product.fields?.some((field) => field.code === 'manual_name_required');
              return (
                <div key={`${product.productId}-${product.sku}`}
                  className="grid gap-1 px-3 py-3 text-sm sm:grid-cols-[minmax(120px,0.7fr)_minmax(260px,2fr)_minmax(130px,0.8fr)] sm:items-center sm:gap-3">
                  <strong className="font-mono text-slate-900">{product.sku}</strong>
                  <span className="text-slate-700">{problems.join(' · ')}</span>
                  {canEditName ? (
                    <button type="button" className="justify-self-start font-semibold text-slate-800 underline decoration-amber-400 underline-offset-4"
                      onClick={() => onEditName({ productId: product.productId, sku: product.sku })}>
                      Заповнити назву
                    </button>
                  ) : <span className="text-xs text-slate-500">Виправити дані товару</span>}
                </div>
              );
            })}
          </div>
          {!showAll && errors.length > INITIAL_PROBLEM_ROWS && (
            <div className="border-t border-slate-200 bg-slate-50 px-3 py-2 text-center">
              <button type="button" className="text-sm font-semibold text-slate-700 underline underline-offset-4"
                onClick={onShowAll}>Показати всі {errors.length}</button>
            </div>
          )}
        </div>
      )}

      {manualNameProduct && (
        <ManualMagentoNameEditor key={manualNameProduct.productId}
          product={manualNameProduct}
          translationSuggestionAvailable={translationSuggestionAvailable}
          onClose={onCloseName}
          onSaved={onSavedName} />
      )}
    </div>
  );
}

function ReadyToCreate({ count, loading, disabled = loading, onCreate }) {
  return (
    <div className="px-4 py-5 sm:px-5">
      <div className="flex gap-3">
        <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-700" size={21} aria-hidden="true" />
        <div>
          <h5 className="font-semibold text-slate-900">{readinessHeading(count)}</h5>
          <p className="mt-1 text-sm text-slate-600">Усі необхідні дані заповнені та пройшли перевірку.</p>
          <button type="button" className="btn btn-primary mt-4 px-5" onClick={onCreate} disabled={disabled}>
            {loading ? 'Створюємо файли…' : 'Створити файли Magento'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SnapshotFiles({ snapshot, loading, onDownload, onConfirm, canConfirm = true }) {
  const confirmed = snapshot.status === 'confirmed';
  return (
    <div className="px-4 py-5 sm:px-5">
      <div className="flex gap-3">
        <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-700" size={22} aria-hidden="true" />
        <div>
          <h5 className="text-lg font-semibold text-slate-900">Файли Magento готові</h5>
          <p className="mt-1 text-sm text-slate-600">Завантажте CSV для кожної представленої групи.</p>
          {snapshot.capturedRange && <p className="mt-1 text-sm break-words">Діапазон цього знімка: {snapshot.capturedRange.fromSku} — {snapshot.capturedRange.toSku || snapshot.capturedRange.resolvedToSku}.</p>}
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {(snapshot.artifacts || []).map((item) => (
          <div key={item.groupCode} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-3">
            <div className="min-w-0">
              <p className="font-semibold text-slate-900">{item.groupName || GROUP_NAMES[item.groupCode] || 'Товари'}</p>
              {Number.isFinite(Number(item.productCount)) && (
                <p className="text-xs text-slate-500">{productCountLabel(item.productCount)}</p>
              )}
            </div>
            <button type="button" className="btn btn-outline shrink-0 gap-2 px-3 py-2 text-xs"
              disabled={loading} onClick={() => onDownload(item.groupCode)}>
              <Download size={14} aria-hidden="true" />Завантажити CSV
            </button>
          </div>
        ))}
      </div>

      <div className="mt-5 border-t border-slate-200 pt-5">
        {confirmed ? (
          <div className="flex items-start gap-2 text-sm text-emerald-800" role="status">
            <CheckCircle2 className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
            <div><p className="font-semibold">Експорт завершено</p><p>Товари прибрано з черги нових.</p></div>
          </div>
        ) : (
          <>
            <h6 className="font-semibold text-slate-900">Завантажили всі потрібні файли?</h6>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">Після завершення ці товари будуть прибрані з черги нових. Це не означає, що Magento вже імпортувала файли.</p>
            <button type="button" className="btn btn-primary mt-3 px-5" disabled={loading || !canConfirm} onClick={onConfirm}>
              {loading ? 'Завершуємо…' : 'Завершити експорт'}
            </button>
          </>
        )}
      </div>

      <details className="mt-5 border-t border-slate-200 pt-3 text-xs text-slate-500">
        <summary className="cursor-pointer font-semibold text-slate-600">Технічні дані</summary>
        <dl className="mt-2 grid gap-1 sm:grid-cols-[130px_1fr]">
          <dt>Ідентифікатор</dt><dd className="break-all font-mono">{snapshot.id}</dd>
          <dt>Профіль</dt><dd>{snapshot.artifacts?.[0]?.profileVersion || 'magento-products-v1'}</dd>
          <dt>Статус</dt><dd>{confirmed ? 'підтверджено' : 'очікує завершення'}</dd>
          <dt>Файли</dt>
          <dd>
            <ul className="space-y-0.5 font-mono">
              {(snapshot.artifacts || []).map((item) => (
                <li key={item.groupCode}>{item.fileName}</li>
              ))}
            </ul>
          </dd>
        </dl>
      </details>
    </div>
  );
}

export function ExportTools({
  exportFromSku,
  setExportFromSku,
  exportToSku,
  setExportToSku,
  exportError,
  exportStatus,
  exportPreview,
  exportSnapshot,
  setExportError,
  isExportLoading,
  isPriceExportLoading,
  priceExportError,
  priceExportStatus,
  skuToDelete,
  setSkuToDelete,
  onPreviewExport,
  onCreateSnapshot,
  onDownloadMagentoArtifact,
  onConfirmSnapshot,
  onPriceExportCsv,
  onDelete,
  canArchive = true,
  canCreateExport = true,
  canViewExport = canCreateExport,
  templateMode = false,
  setTemplateMode,
  templateSelection,
  setTemplateSelection,
  pendingCreate,
  canActivateTemplate = false,
  durableSessions = false,
}) {
  const [manualNameProduct, setManualNameProduct] = useState(null);
  const [problemsExpanded, setProblemsExpanded] = useState(false);
  const [showAllProblems, setShowAllProblems] = useState(false);
  const [customExportExpanded, setCustomExportExpanded] = useState(false);
  const newProductCount = Number(exportStatus?.countSinceLastExport || 0);
  const newProductCopy = getNewProductCopy(newProductCount);
  const previewErrors = exportPreview?.errors || [];

  const startPreview = (mode) => {
    setProblemsExpanded(false);
    setShowAllProblems(false);
    setManualNameProduct(null);
    onPreviewExport(mode);
  };

  const refreshPreview = (mode) => {
    setManualNameProduct(null);
    onPreviewExport(mode);
  };

  return (
    <section className="fade-up stagger-2 space-y-4">
      {canViewExport && (
        <div className="card overflow-hidden">
          <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
            <p className="eyebrow">Magento Products v1</p>
            <h3 className="section-title-text mt-1">Експорт товарів у Magento</h3>
            <p className="section-subtitle mt-1">Перевірте нові товари, створіть файли та завершіть експорт після завантаження.</p>
          </div>

          {durableSessions ? <div className="p-4 border-b"><Link className="underline" to="/exports/sessions">Мої експорти · Запрошення · Створити свій експорт за шаблоном</Link><p className="text-xs mt-2">Нижче — звичайний Magento v1. Контрольований експорт відкривається окремо й зберігається на сервері.</p></div> : setTemplateMode && <ControlledExportOptions templateMode={templateMode} setTemplateMode={setTemplateMode}
            templateSelection={templateSelection} setTemplateSelection={setTemplateSelection}
            pendingCreate={pendingCreate} isExportLoading={isExportLoading || !canCreateExport}
            onRetry={onCreateSnapshot} evidence={exportSnapshot || exportPreview} canActivate={canActivateTemplate} />}

          {!exportStatus && !exportPreview && !exportSnapshot && (
            <div className="px-4 py-5 text-sm text-slate-600 sm:px-5" role="status">Завантаження статусу експорту…</div>
          )}

          {exportStatus && !exportPreview && !exportSnapshot && (
            <div className="px-4 py-5 sm:px-5">
              {newProductCount > 0 ? (
                <>
                  <p className="font-semibold text-slate-900">{newProductCopy.pendingLabel}</p>
                  <p className="mt-1 text-sm text-slate-600">Перевірте готовність товарів перед створенням файлів.</p>
                  <button type="button" onClick={() => startPreview('new')}
                    className="btn btn-primary mt-4 px-5" disabled={isExportLoading || Boolean(pendingCreate)}>
                    {isExportLoading ? 'Перевіряємо…' : newProductCopy.previewLabel}
                  </button>
                </>
              ) : (
                <div className="flex items-start gap-3 text-sm text-slate-600">
                  <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-700" aria-hidden="true" />
                  <div><p className="font-semibold text-slate-900">Нових товарів для експорту немає</p><p className="mt-1">Черга Magento зараз порожня.</p></div>
                </div>
              )}
            </div>
          )}

          {exportPreview && !exportSnapshot && (
            <>
              <PreviewSummary preview={exportPreview} loading={isExportLoading || Boolean(pendingCreate)}
                onRefresh={() => refreshPreview(exportPreview.mode)} />
              {previewErrors.length > 0 ? (
                <ReadinessProblems errors={previewErrors} expanded={problemsExpanded}
                  showAll={showAllProblems}
                  onToggle={() => setProblemsExpanded((current) => !current)}
                  onShowAll={() => setShowAllProblems(true)}
                  manualNameProduct={manualNameProduct}
                  onEditName={canCreateExport ? setManualNameProduct : null}
                  onCloseName={() => setManualNameProduct(null)}
                  translationSuggestionAvailable={exportStatus?.translationSuggestionAvailable === true}
                  onSavedName={() => refreshPreview(exportPreview.mode)} />
              ) : Number(exportPreview.representedCount) > 0 ? (
                <ReadyToCreate count={exportPreview.representedCount}
                  loading={isExportLoading} disabled={isExportLoading || !canCreateExport || Boolean(pendingCreate)} onCreate={onCreateSnapshot} />
              ) : (
                <div className="px-4 py-5 text-sm text-slate-600 sm:px-5">У вибраному діапазоні немає товарів для експорту.</div>
              )}
            </>
          )}

          {exportSnapshot && (
            <SnapshotFiles snapshot={exportSnapshot} loading={isExportLoading} canConfirm={canCreateExport}
              onDownload={onDownloadMagentoArtifact} onConfirm={onConfirmSnapshot} />
          )}

          {exportError && <div className="danger-panel mx-4 mb-4 p-3 text-sm sm:mx-5" role="alert">{exportError}</div>}

          <details className="border-t border-slate-200 px-4 py-3 sm:px-5"
            open={customExportExpanded}
            onToggle={(event) => setCustomExportExpanded(event.currentTarget.open)}>
            <summary className="cursor-pointer text-sm font-semibold text-slate-700">Повторний або вибірковий експорт</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <input type="text" value={exportFromSku}
                onChange={(event) => {
                  setExportFromSku(event.target.value.toUpperCase());
                  setExportError('');
                }}
                placeholder="Один SKU або початок діапазону"
                aria-label="Початковий SKU для повторного експорту" className="input" />
              <input type="text" value={exportToSku}
                onChange={(event) => {
                  setExportToSku(event.target.value.toUpperCase());
                  setExportError('');
                }}
                placeholder="Кінцевий SKU, необов’язково"
                aria-label="Кінцевий SKU для повторного експорту, необов’язково" className="input" />
              <button type="button" onClick={() => startPreview('manual')}
                className="btn btn-outline px-5" disabled={isExportLoading || Boolean(pendingCreate)}>Перевірити діапазон</button>
            </div>
            <p className="mt-2 text-xs text-slate-500">Порожній кінцевий SKU означає повторний експорт одного товару.</p>
          </details>
        </div>
      )}

      {canCreateExport && (
        <div className="field-group">
          <h3 className="text-lg font-semibold text-slate-900">Оновлення цін Magento</h3>
          {!priceExportStatus ? (
            <p className="mt-2 text-sm text-slate-600" role="status">Завантаження стану цін…</p>
          ) : Number(priceExportStatus.pendingCount || 0) === 0 ? (
            <p className="mt-2 text-sm text-slate-600">Немає змін цін для експорту.</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-slate-700">{priceChangesHeading(priceExportStatus.pendingCount)}</p>
              {Number(priceExportStatus.excludedPendingCount) > 0 && (
                <p className="mt-1 text-xs text-slate-500">Виключено з експорту: {priceExportStatus.excludedPendingCount}.</p>
              )}
              <button type="button" onClick={onPriceExportCsv}
                className="btn btn-primary mt-4 px-5" disabled={isPriceExportLoading}>
                {isPriceExportLoading ? 'Експортуємо ціни…' : 'Експортувати зміни цін'}
              </button>
            </>
          )}
          {priceExportError && <div className="danger-panel mt-3 p-3 text-sm" role="alert">{priceExportError}</div>}
        </div>
      )}

      {canArchive && (
        <div className="field-group">
          <h3 className="text-lg font-semibold text-slate-900">Архівування</h3>
          <p className="section-subtitle mt-1">Архівний артикул зберігається в базі, але не потрапляє в історію та експорт.</p>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <input type="text" value={skuToDelete}
              onChange={(event) => setSkuToDelete(event.target.value)}
              placeholder="Введіть повний артикул..." aria-label="SKU товару для архівування" className="input" />
            <button type="button" onClick={() => onDelete(skuToDelete)} className="btn btn-danger px-6">Архівувати</button>
          </div>
        </div>
      )}
    </section>
  );
}
