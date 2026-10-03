import { useContext, useState } from 'react';
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
});

export function ProductMagentoAttention({ product, problems = [], onRepairCharacteristics, onSaved }) {
  const { permissions = [] } = useContext(AuthContext) || {};
  const [open, setOpen] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const readiness = problems.find((problem) => problem.code === 'PRODUCT_EVALUATION_NOT_READY');
  const issueFields = [...new Set(readiness?.issueFields || [])];
  const needsNameCompletion = product?.categoryCode === 'SV' && issueFields.includes('name') && !product?.nameConflict;
  const needsSize = product?.categoryCode === 'SV' && issueFields.includes('rozmir_suveniriv');
  const needsCharacteristics = issueFields.some((field) => !['name', 'rozmir_suveniriv'].includes(field));
  const inheritedNameReview = product?.magentoNameReviewRequired === true && !product?.nameConflict;
  if ((!readiness && !inheritedNameReview) || product?.status !== 'active') return null;
  const canEditName = product.categoryCode === 'SV' && permissions.includes('exports.create');
  const canRepairInformation = permissions.includes('products.recount');
  const canRepairCharacteristics = permissions.includes('products.recount') && onRepairCharacteristics;
  const labels = issueFields.map((field) => FIELD_LABELS[field]).filter(Boolean);
  return <>
    <Notice tone="warning"><p className="font-semibold">{readiness ? 'Товар не готовий до синхронізації' : 'Потрібно перевірити назву для Magento'}</p>
      <p>{readiness
        ? 'Потрібно доповнити або виправити дані товару.'
        : 'Успадковані назви потребують підтвердження. Після перевірки сервер повторно оцінить готовність товару до синхронізації.'}</p>
      {labels.length > 0 && <ul className="mt-2 list-disc pl-5">{labels.map((label) => <li key={label}>{label}</li>)}</ul>}
      <div className="mt-2 flex flex-wrap gap-2">
        {(needsNameCompletion || inheritedNameReview) && canEditName && <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
          {needsNameCompletion ? 'Заповнити назви' : 'Перевірити назви'}
        </button>}
        {needsSize && canRepairInformation && <button type="button" className="btn btn-primary" onClick={() => setSizeOpen(true)}>Заповнити розмір</button>}
        {needsCharacteristics && canRepairCharacteristics && <button type="button" className="btn btn-primary" onClick={onRepairCharacteristics}>
          Виправити характеристики
        </button>}
      </div>
      {((needsNameCompletion || inheritedNameReview) && !canEditName) || (needsSize && !canRepairInformation) || (needsCharacteristics && !canRepairCharacteristics)
        ? <p className="mt-2">Передайте виправлення оператору з дозволом на відповідну зміну даних товару.</p>
        : null}
      {readiness && <TechnicalDisclosure><dl className="technical-key-values"><div><dt>Код</dt><dd>{readiness.code}</dd></div>
        {readiness.diagnosticCode && <div><dt>Діагностика</dt><dd>{readiness.diagnosticCode}</dd></div>}
        {issueFields.length > 0 && <div><dt>Контекст</dt><dd>{issueFields.join(', ')}</dd></div>}</dl></TechnicalDisclosure>}
    </Notice>
    {open && <WorkspaceDialog title={needsNameCompletion ? 'Заповнення назв для Magento' : 'Перевірка назв для Magento'} onClose={() => setOpen(false)} busy={busy}>
      <ProductMagentoNameReview product={product} onBusyChange={setBusy} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onSaved?.(); }} />
    </WorkspaceDialog>}
    {sizeOpen && <WorkspaceDialog title="Заповнення розміру" onClose={() => setSizeOpen(false)} busy={busy}>
      <ProductInformationRepair product={product} onBusyChange={setBusy} onClose={() => setSizeOpen(false)}
        onSaved={() => { setSizeOpen(false); onSaved?.(); }} />
    </WorkspaceDialog>}
  </>;
}
