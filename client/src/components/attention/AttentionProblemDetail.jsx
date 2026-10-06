import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/auth-context.js';
import { ProductNameConflict } from '../app/ProductNameConflict.jsx';
import { ProductMagentoAttention } from '../app/ProductMagentoAttention.jsx';
import { TechnicalDisclosure } from '../ui/index.js';
import { MagentoRecovery } from './MagentoRecovery.jsx';
import MagentoProductDiagnosis from './MagentoProductDiagnosis.jsx';
import { attentionProblemGroups, needsDeliveryRecovery, nextAction, problemImpact, problemRepairUrl, problemSubject, problemTitle, PRODUCT_FIELD_LABELS } from './sync-problem-presentation.js';

function ProblemFacts({ problem }) {
  const subject = problemSubject(problem);
  return <>
    {(subject.path || subject.field || subject.value !== null) && <dl className="sync-problem-subject">
      {subject.path && <div><dt>Категорія Magento</dt><dd>{subject.path}</dd></div>}
      {subject.field && <div><dt>Характеристика</dt><dd>{subject.field}</dd></div>}
      {subject.value !== null && <div><dt>Значення за правилом Amber</dt><dd>{String(subject.value)}</dd></div>}
    </dl>}
    {problem.evaluationIssues?.length > 0 ? <ul className="sync-issue-fields">{problem.evaluationIssues.map((issue, index) => <li key={index}>
      {PRODUCT_FIELD_LABELS[issue.field] && <strong>{PRODUCT_FIELD_LABELS[issue.field]}: </strong>}{issue.message || 'Потрібна перевірка значення.'}</li>)}</ul>
      : problem.issueFields?.length > 0 && <ul className="sync-issue-fields">{problem.issueFields.map((field) => <li key={field}>{PRODUCT_FIELD_LABELS[field] || 'Додаткове поле товару'}</li>)}</ul>}
  </>;
}

export default function AttentionProblemDetail({ product, productUrl, returnTo, onSaved, onRepairCharacteristics }) {
  const { permissions } = useAuth();
  const [recoveryEvidence, setRecoveryEvidence] = useState(null);
  const [comparisonEvidence, setComparisonEvidence] = useState(null);
  const groups = attentionProblemGroups(product.problems);
  const main = groups[0]?.problem;
  const recovery = groups.some(({ problem }) => needsDeliveryRecovery(problem));
  const identityProblem = (main?.diagnosticCode || main?.code) === 'NAME_REMOTE_IDENTITY_CHANGED';
  const canCompare = permissions.includes('export_templates.manage') && permissions.includes('exports.view');
  const canDecode = permissions.includes('products.decode');
  const canReconcile = permissions.includes('exports.reconcile');
  const canOpenRecovery = canReconcile || permissions.includes('export_templates.publish');
  const selectedProduct = { productId: product.productId, publicSku: product.article, categoryCode: product.category,
    status: product.productStatus || 'active', nameConflict: Boolean(product.nameConflict) };

  function repair(problem) {
    if (needsDeliveryRecovery(problem)) return null;
    if (problem.code === 'TEST_DELETION_PENDING') return canDecode && productUrl
      ? <Link className="btn btn-outline btn-compact-md" to={productUrl}>Перевірити тестове видалення у товарі</Link>
      : <p className="sync-problem-guidance">Передайте артикул оператору з доступом до товару для перевірки початкової операції видалення.</p>;
    if (problem.resolution === 'product') return problem.code === 'PRODUCT_EVALUATION_NOT_READY'
      ? <ProductMagentoAttention compact product={selectedProduct} problems={[problem]} onSaved={onSaved} onRepairCharacteristics={onRepairCharacteristics} />
      : canDecode && productUrl ? <Link className="btn btn-outline btn-compact-md" to={productUrl}>Відкрити дані товару</Link>
        : <p className="sync-problem-guidance">Передайте виправлення оператору з доступом до даних товару.</p>;
    if (['integration_configuration', 'integration_preparation'].includes(problem.resolution)) return permissions.includes('export_templates.view')
      ? <Link className="btn btn-outline btn-compact-md" to={problemRepairUrl(problem, product, returnTo)}>{nextAction(problem)}</Link>
      : <p className="sync-problem-guidance">Передайте опис оператору з доступом до налаштувань інтеграції.</p>;
    if (problem.resolution === 'name' && !product.nameConflict) return <p className="sync-problem-guidance">Потрібна перевірка доступності або ідентичності товару Magento. Передайте артикул відповідальному за інтеграцію.</p>;
    if (problem.resolution !== 'name') return <p className="sync-problem-guidance">Скопіюйте опис проблеми та передайте відповідальному за інтеграцію.</p>;
    return null;
  }

  return <div className="sync-problem-detail-body">
    {main && <section className="sync-start-task" aria-label="З чого почати">
      <h3>{problemTitle(main)}</h3>
      <p className="sync-problem-guidance">{problemImpact(main)}</p>
      <ProblemFacts problem={main} />
      {needsDeliveryRecovery(main) && !canOpenRecovery && <p className="sync-problem-guidance">Потрібне узгодження Адміністратора або відповідального оператора з дозволом на відновлення доставки. Скопіюйте опис проблеми та передайте йому.</p>}
      {needsDeliveryRecovery(main) && canOpenRecovery && <MagentoRecovery guided productId={product.productId} categoryCode={product.category} onTechnicalEvidence={setRecoveryEvidence} onSaved={() => onSaved('recovery')} />}
      {identityProblem && canCompare ? <MagentoProductDiagnosis product={product} returnTo={returnTo} identityOnly onTechnicalEvidence={setComparisonEvidence} /> : repair(main)}
      {main.resolution === 'name' && <ProductNameConflict productId={product.productId} available={Boolean(product.nameConflict)} onSaved={onSaved} />}
    </section>}
    {groups.length > 1 && <section className="sync-other-problems" aria-label="Інші перешкоди">
      <h3>Інші перешкоди</h3>
      <p className="sync-problem-guidance">Ці причини також зафіксовано для товару. Після виправлення перевірте оновлений стан доставки.</p>
      <ul>{groups.slice(1).map(({ key, problem }) => <li key={key}>
        <h4>{problem.message || 'Причину ще не визначено'}</h4>
        <ProblemFacts problem={problem} />
        {needsDeliveryRecovery(problem) ? <p className="sync-problem-guidance">Перевіряється у процедурі відновлення доставки на цій сторінці.</p> : repair(problem)}
      </li>)}</ul>
    </section>}
    {main?.resolution !== 'name' && <ProductNameConflict productId={product.productId} available={Boolean(product.nameConflict)} onSaved={onSaved} />}
    {recovery && !needsDeliveryRecovery(main) && <MagentoRecovery productId={product.productId} categoryCode={product.category} onTechnicalEvidence={setRecoveryEvidence} onSaved={() => onSaved('recovery')} />}
    {canCompare && !identityProblem && <TechnicalDisclosure summary="Додаткова перевірка даних у Magento">
      {() => <MagentoProductDiagnosis key={`${product.productId}:${product.observedAt || product.state || ''}`} product={product} returnTo={returnTo} onTechnicalEvidence={setComparisonEvidence} />}
    </TechnicalDisclosure>}
    {(product.problems.length > 0 || recoveryEvidence || comparisonEvidence) && <TechnicalDisclosure summary="Дані для підтримки">
      {() => <div className="sync-support-evidence"><section><h4>Збережена діагностика товару</h4>
        {product.observedAt && <p className="sync-problem-guidance">Зафіксовано: {new Date(product.observedAt).toLocaleString('uk-UA')}</p>}
        <pre className="sync-raw-evidence">{JSON.stringify(product.problems, null, 2)}</pre></section>
        {recoveryEvidence && <section><h4>Свідчення перевірки доставки</h4><pre className="sync-raw-evidence">{JSON.stringify(recoveryEvidence, null, 2)}</pre></section>}
        {comparisonEvidence && <section><h4>Спостереження Magento</h4><pre className="sync-raw-evidence">{JSON.stringify(comparisonEvidence, null, 2)}</pre></section>}
      </div>}
    </TechnicalDisclosure>}
  </div>;
}
