import { ExportReview } from '../exports/ExportReview';
import { StoredSnapshot } from '../exports/StoredSnapshot';
import { WorkspaceDialog } from '../workspace/WorkspaceDialog';
import { useContext, useEffect, useRef, useState } from 'react';
import { AuthContext } from '../../auth/auth-context';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { exportsApi } from '../../api/exports-api';
import { getApiError } from '../../lib/http-error';
import { getNewProductCopy } from '../../lib/product-export-copy';
import { ControlledExportOptions } from './ControlledExportOptions';
import { Link } from 'react-router-dom';

const INITIAL_PROBLEM_ROWS = 6;

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
  if (field.code === 'manual_name_review_required') return 'Потрібна перевірка успадкованих назв';
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

export function ManualMagentoNameEditor({ product, onClose, onSaved,
  translationSuggestionAvailable }) {
  const { principalLifetime } = useContext(AuthContext) || {}; const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => alive.current && principalLifetime?.valid !== false;
  const [subjectUa, setSubjectUa] = useState('');
  const [subjectEn, setSubjectEn] = useState('');
  const [enEdited, setEnEdited] = useState(false);
  const [suggestionError, setSuggestionError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestionAttempt, setSuggestionAttempt] = useState(0);
  const [review, setReview] = useState(null);

  useEffect(() => {
    if (!product.reviewRequired) return undefined;
    let live = true;
    exportsApi.previewMagentoName({ productId: product.productId }).then(({ data }) => {
      if (!live || principalLifetime?.valid === false) return;
      setSubjectUa(data.subjectUa || ''); setSubjectEn(data.subjectEn || '');
      setEnEdited(true); setReview(data);
    }).catch((error) => { if (live) setSaveError(getApiError(error)); });
    return () => { live = false; };
  }, [product.productId, product.reviewRequired, principalLifetime]);

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

  const save = async (confirmUnchanged = false) => {
    if (!current() || isSaving) return;
    setSaveError('');
    setIsSaving(true);
    try {
      const payload = { productId: product.productId,
        subjectUa: confirmUnchanged ? subjectUa : subjectUa.trim(),
        subjectEn: confirmUnchanged ? subjectEn : subjectEn.trim(),
        ...(confirmUnchanged ? { confirmUnchanged: true } : {}) };
      // Confirmation consumes the evidence displayed when the pair was loaded.
      // Re-previewing here would silently accept lifecycle drift while reviewing.
      const preview = confirmUnchanged ? { data: review } : await exportsApi.previewMagentoName(payload);
      if (!current()) return;
      await exportsApi.applyMagentoName({ ...payload,
        previewToken: preview.data.previewToken });
      if (!current()) return;
      onSaved();
    } catch (error) {
      if (current()) setSaveError(getApiError(error));
    } finally {
      if (current()) setIsSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="font-semibold">Назва для {product.sku}</p>
      {review?.reviewRequired && <p className="font-semibold text-amber-900">Потрібна перевірка успадкованих назв</p>}
      <p className="text-xs text-slate-600">Збереження назви не змінить SKU, ціну чи характеристики товару.</p>
      <label className="mt-3 block text-sm font-medium" htmlFor="magento-subject-ua">Українська назва</label>
      <input id="magento-subject-ua" className="input mt-1" value={subjectUa} disabled={product.reviewRequired && !review}
        onChange={(event) => {
          setSubjectUa(event.target.value);
          setSuggestionError('');
          setIsSuggesting(false);
        }}
        maxLength={200} />
      <label className="mt-3 block text-sm font-medium" htmlFor="magento-subject-en">English name</label>
      <input id="magento-subject-en" className="input mt-1" value={subjectEn} disabled={product.reviewRequired && !review}
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
        <button className="btn btn-primary px-4" onClick={() => save()}
          disabled={isSaving || !subjectUa.trim() || !subjectEn.trim()}>
          {isSaving ? 'Зберігаємо…' : 'Зберегти назви'}
        </button>
        {review?.canConfirmUnchanged && review.previewToken && subjectUa === review.subjectUa && subjectEn === review.subjectEn && (
          <button className="btn btn-outline px-4" onClick={() => save(true)} disabled={isSaving}>
            Підтвердити без змін
          </button>
        )}
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
              const reviewRequired = product.fields?.some((field) => field.code === 'manual_name_review_required');
              const canEditName = Boolean(onEditName) && (reviewRequired || product.fields?.some((field) => field.code === 'manual_name_required'));
              return (
                <div key={`${product.productId}-${product.sku}`}
                  className="grid gap-1 px-3 py-3 text-sm sm:grid-cols-[minmax(120px,0.7fr)_minmax(260px,2fr)_minmax(130px,0.8fr)] sm:items-center sm:gap-3">
                  <strong className="font-mono text-slate-900">{product.sku}</strong>
                  <span className="text-slate-700">{problems.join(' · ')}</span>
                  {canEditName ? (
                    <button type="button" className="justify-self-start font-semibold text-slate-800 underline decoration-amber-400 underline-offset-4"
                      onClick={() => onEditName({ productId: product.productId, sku: product.sku, ...(reviewRequired ? { reviewRequired: true } : {}) })}>
                      {reviewRequired ? 'Перевірити назви' : 'Заповнити назву'}
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

function ReadyToCreate({ count, loading, disabled = loading, onCreate, canCreate = true }) {
  return (
    <div className="px-4 py-5 sm:px-5">
      <div className="flex gap-3">
        <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-700" size={21} aria-hidden="true" />
        <div>
          <h5 className="font-semibold text-slate-900">{readinessHeading(count)}</h5>
          <p className="mt-1 text-sm text-slate-600">Усі необхідні дані заповнені та пройшли перевірку.</p>
          {canCreate && <button type="button" className="btn btn-primary mt-4 px-5" onClick={onCreate} disabled={disabled}>
            {loading ? 'Створюємо файли…' : 'Створити файли Magento'}
          </button>}
        </div>
      </div>
    </div>
  );
}

export function SnapshotFiles(props) {
  return <StoredSnapshot {...props} />;
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
  skuToDelete,
  setSkuToDelete,
  onPreviewExport,
  onCreateSnapshot,
  onDownloadMagentoArtifact,
  onConfirmSnapshot,
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
  surface = 'all',
  exportReviewStale = false,
  exportProductChanged = false,
  exportReviewView,
  markExportReviewStale,
  refreshAfterProductChange,
  exportRefreshing,
  beginExportHandoff,
  startNewExport,
  canDecode = false,
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
      {canViewExport && surface !== 'prices' && (
        <div className="card overflow-hidden">
          {!exportPreview && !exportSnapshot && <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
            <p className="eyebrow">Magento Products v1</p>
            <h3 className="section-title-text mt-1">Експорт товарів у Magento</h3>
            <p className="section-subtitle mt-1">Перевірте товари, створіть незмінні файли та окремо підтвердьте експорт.</p>
          </div>}

          {durableSessions ? <>
            {surface === 'all' && <div className="p-4 border-b"><Link className="underline" to="/exports/sessions">Мої експорти · Запрошення · Створити свій експорт за шаблоном</Link><p className="text-xs mt-2">Нижче — звичайний Magento v1. Експорт за опублікованим шаблоном — окрема збережена операція; учасників можна запросити явно.</p></div>}
            {pendingCreate && <div className="notice notice-warning m-4" role="status"><div>
              <p>Результат створення ще не підтверджено. Повтор збереже початкову операцію.</p>
              <button className="btn btn-primary mt-2 px-3" disabled={isExportLoading || !canCreateExport} onClick={onCreateSnapshot}>Повторити початкове створення</button>
            </div></div>}
          </> : !exportSnapshot && setTemplateMode && <ControlledExportOptions templateMode={templateMode} setTemplateMode={setTemplateMode}
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
              <ExportReview preview={exportPreview} stale={exportReviewStale} productChanged={exportProductChanged} refreshing={exportRefreshing} viewMemory={exportReviewView} recoveryFocusBlocked={Boolean(manualNameProduct)} busy={isExportLoading || Boolean(pendingCreate)}
                onRefresh={() => refreshPreview(exportPreview.mode)} canDecode={canDecode} onHandoff={(context) => beginExportHandoff?.({ ...context, returnTo: '/exports' })}
                onEditName={canCreateExport ? setManualNameProduct : undefined} />
              {previewErrors.length > 0 && !exportPreview.review ? (
                <ReadinessProblems errors={previewErrors} expanded={problemsExpanded}
                  showAll={showAllProblems}
                  onToggle={() => setProblemsExpanded((current) => !current)}
                  onShowAll={() => setShowAllProblems(true)}
                  manualNameProduct={manualNameProduct}
                  onEditName={canCreateExport ? setManualNameProduct : null}
                  onCloseName={() => setManualNameProduct(null)}
                  translationSuggestionAvailable={exportStatus?.translationSuggestionAvailable === true}
                  onSavedName={() => { setManualNameProduct(null); if (refreshAfterProductChange) void refreshAfterProductChange(); else markExportReviewStale?.({ kind: 'product' }); }} />
              ) : !previewErrors.length && Number(exportPreview.representedCount) > 0 ? (
                <ReadyToCreate canCreate={canCreateExport} count={exportPreview.representedCount}
                  loading={isExportLoading} disabled={isExportLoading || !canCreateExport || exportReviewStale || Boolean(pendingCreate)} onCreate={onCreateSnapshot} />
              ) : !previewErrors.length ? (
                <div className="px-4 py-5 text-sm text-slate-600 sm:px-5">У вибраному діапазоні немає товарів для експорту.</div>
              ) : null}
            </>
          )}

          {exportSnapshot && (
            <SnapshotFiles snapshot={exportSnapshot} loading={isExportLoading} canConfirm={canCreateExport}
              onDownload={onDownloadMagentoArtifact} onConfirm={onConfirmSnapshot} />
          )}

          {exportPreview?.review && manualNameProduct && !exportSnapshot && <WorkspaceDialog title="Назва товару Magento" onClose={() => setManualNameProduct(null)}>
            <ManualMagentoNameEditor product={manualNameProduct} onClose={() => setManualNameProduct(null)}
              translationSuggestionAvailable={exportStatus?.translationSuggestionAvailable === true}
              onSaved={() => { setManualNameProduct(null); if (refreshAfterProductChange) void refreshAfterProductChange(); else markExportReviewStale?.({ kind: 'product' }); }} />
          </WorkspaceDialog>}
          {exportSnapshot && startNewExport && <button className="btn btn-outline m-4 px-4" onClick={startNewExport}>Новий експорт</button>}
          {exportError && <div className="danger-panel mx-4 mb-4 p-3 text-sm sm:mx-5" role="alert">{exportError}</div>}

          {!exportSnapshot && <details className="border-t border-slate-200 px-4 py-3 sm:px-5"
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
          </details>}
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
