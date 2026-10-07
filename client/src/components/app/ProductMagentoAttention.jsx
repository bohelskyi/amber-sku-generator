import { useContext, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../../auth/auth-context.js';
import { WorkspaceDialog } from '../workspace/WorkspaceDialog.jsx';
import { ProductMagentoNameReview } from './ProductMagentoNameReview.jsx';
import { ProductInformationRepair } from './ProductInformationRepair.jsx';
import { Notice } from './UiPrimitives.jsx';
import { TechnicalDisclosure } from '../ui/index.js';

const FIELD_LABELS = Object.freeze({
  name: 'Назва українською та англійською',
  rozmir_suveniriv: 'Розмір',
  kamin_obrobka: 'Обробка каменю',
  sku: 'Захищені поля інтеграції',
});

export function ProductMagentoAttention({ product, problems = [], onRepairCharacteristics, onSaved, compact = false }) {
  const { permissions = [] } = useContext(AuthContext) || {};
  const [open, setOpen] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const readiness = problems.find((problem) => problem.code === 'PRODUCT_EVALUATION_NOT_READY');
  const issueFields = [...new Set(readiness?.issueFields || [])];
  const effectiveNames = readiness?.evaluationIssues?.some(issue => ['effective_names_required', 'effective_names_invalid'].includes(issue.code));
  const needsNameCompletion = (product?.categoryCode === 'SV' || effectiveNames) && issueFields.includes('name') && !product?.nameConflict;
  const needsSize = product?.categoryCode === 'SV' && issueFields.includes('rozmir_suveniriv');
  const needsProtectedContractReview = issueFields.includes('sku');
  const mappingFields = issueFields.filter((field) => field !== 'sku');
  const needsCharacteristics = mappingFields.some((field) => !['name', 'rozmir_suveniriv'].includes(field));
  const inheritedNameReview = product?.magentoNameReviewRequired === true && !product?.nameConflict;
  if ((!readiness && !inheritedNameReview) || product?.status !== 'active') return null;
  const canEditName = (product.categoryCode === 'SV' || effectiveNames) && permissions.includes('exports.create');
  const canRepairInformation = permissions.includes('products.recount');
  const canRepairCharacteristics = permissions.includes('products.recount') && onRepairCharacteristics;
  const labels = issueFields.map((field) => FIELD_LABELS[field]).filter(Boolean);
  const Surface = compact ? 'div' : Notice;
  return <>
    <Surface {...(compact ? {} : { tone: 'warning' })}>{!compact && <><p className="font-semibold">{readiness ? 'Товар не готовий до синхронізації' : 'Потрібно перевірити назву для Magento'}</p>
      <p>{readiness
        ? readiness.evaluationIssues?.[0]?.message || readiness.message || `Потрібно виправити: ${issueFields.map(field => FIELD_LABELS[field] || field).join(', ') || 'причина не надійшла — оновіть стан'}.`
        : 'Успадковані назви потребують підтвердження. Після перевірки сервер повторно оцінить готовність товару до синхронізації.'}</p>
      {readiness?.evaluationIssues?.length > 1 ? <ul className="mt-2 list-disc pl-5">{readiness.evaluationIssues.slice(1).map((issue, index) => <li key={index}>{issue.message || FIELD_LABELS[issue.field] || 'Перевірте поле товару.'}</li>)}</ul>
        : !readiness?.evaluationIssues?.length && labels.length > 0 && <ul className="mt-2 list-disc pl-5">{labels.map((label) => <li key={label}>{label}</li>)}</ul>}</>}
      <div className="mt-2 flex flex-wrap gap-2">
        {(needsNameCompletion || inheritedNameReview) && canEditName && <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
          {needsNameCompletion ? 'Заповнити назви' : 'Перевірити назви'}
        </button>}
        {needsSize && canRepairInformation && <button type="button" className="btn btn-primary" onClick={() => setSizeOpen(true)}>Заповнити розмір</button>}
        {needsCharacteristics && canRepairCharacteristics && <button type="button" className="btn btn-primary" onClick={onRepairCharacteristics}>
          Виправити характеристики
        </button>}
        {!compact && permissions.includes('export_templates.view') && product.categoryCode && mappingFields.map((field) => <Link key={field} className="btn btn-outline" to={`/admin/magento/categories/${encodeURIComponent(product.categoryCode)}?field=${encodeURIComponent(field)}`}>
          Відповідності: {FIELD_LABELS[field] || field}
        </Link>)}
        {!compact && needsProtectedContractReview && permissions.includes('export_templates.view') && product.categoryCode && <Link className="btn btn-outline" to={`/admin/magento/categories/${encodeURIComponent(product.categoryCode)}`}>Перевірити правила інтеграції</Link>}
      </div>
      {needsProtectedContractReview && <p className="mt-2">Захищені поля потребують перевірки правил інтеграції адміністратором.</p>}
      {((needsNameCompletion || inheritedNameReview) && !canEditName) || (needsSize && !canRepairInformation) || (needsCharacteristics && !canRepairCharacteristics)
        ? <p className="mt-2">Передайте виправлення оператору з дозволом на відповідну зміну даних товару.</p>
        : null}
      {!compact && readiness && <TechnicalDisclosure><dl className="technical-key-values"><div><dt>Код</dt><dd>{readiness.code}</dd></div>
        {readiness.diagnosticCode && <div><dt>Діагностика</dt><dd>{readiness.diagnosticCode}</dd></div>}
        {issueFields.length > 0 && <div><dt>Контекст</dt><dd>{issueFields.join(', ')}</dd></div>}</dl></TechnicalDisclosure>}
    </Surface>
    {open && <WorkspaceDialog title={needsNameCompletion ? 'Заповнення назв для Magento' : 'Перевірка назв для Magento'} onClose={() => setOpen(false)} busy={busy}>
      <ProductMagentoNameReview product={product} onBusyChange={setBusy} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onSaved?.(); }} />
    </WorkspaceDialog>}
    {sizeOpen && <WorkspaceDialog title="Заповнення розміру" onClose={() => setSizeOpen(false)} busy={busy}>
      <ProductInformationRepair product={product} onBusyChange={setBusy} onClose={() => setSizeOpen(false)}
        onSaved={() => { setSizeOpen(false); onSaved?.(); }} />
    </WorkspaceDialog>}
  </>;
}
