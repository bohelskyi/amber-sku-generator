import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoPublicationProblems from '../src/components/workspace/MagentoPublicationProblems.jsx';
import MagentoPublicationActions from '../src/components/workspace/MagentoPublicationActions.jsx';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const principal = { permissions: ['export_templates.manage', 'export_templates.publish', 'exports.view'], roles: [{ key: 'administrator' }], principalLifetime: { valid: true } };
const domain = (overrides = {}) => ({ code: 'DOMAIN_POLICY_REVIEW_REQUIRED', operation: 'storeViews', target: 'meta_title',
  requiredPolicy: 'authoritative_create_update', resolution: 'integration_configuration', message: 'Потрібно перевірити дані або відповідності.', ...overrides });
function fixture(problem = domain()) {
  const row = problem.operation === 'storeViews' ? 'english' : 'base'; const store = row === 'english' ? 'en' : 'all';
  const revision = { id: 'reviewed-draft', revision: '3', state: 'draft',
    schema: { attributes: [{ attribute_code: 'meta_title', default_frontend_label: 'Meta Title' }] },
    bindings: { attributes: [
      { bindingKey: 'other-language', routeKey: 'BR:all', rowId: row === 'english' ? 'base' : 'english', target: problem.target },
      { bindingKey: 'another-route', routeKey: 'BR.variant=1', rowId: row, target: problem.target },
      { bindingKey: 'exact-returned-key', routeKey: 'BR:all', rowId: row, target: problem.target },
    ], policies: [
      { bindingKey: 'other-language', storeCode: row === 'english' ? 'all' : 'en', policy: 'magento_managed' },
      { bindingKey: 'another-route', storeCode: store, policy: 'magento_managed' },
      { bindingKey: 'exact-returned-key', storeCode: store, policy: 'initialize_create_only', reviewState: 'review_required' },
    ] } };
  const review = { bindingRevisionId: revision.id, expectedRevision: revision.revision, expectedCurrentId: 'current',
    previewToken: 'original-preview-token', totalProducts: 1, affected: [{ productId: 7, article: 'AG-000007', reason: 'changed' }],
    lostRoutes: [], lostProducts: [], preservedNames: [],
    blockers: [{ code: 'AFFECTED_CURRENT_PREVIEW_BLOCKED', productId: 7 }],
    checked: [{ kind: 'current', productId: 7, article: 'AG-000007', group: 'BR', routeKey: 'BR:all', sendable: false, blockers: [problem] }] };
  return { revision, review, currentPublishedId: 'current' };
}
function show(props, child) {
  return render(<AuthContext.Provider value={principal}><MemoryRouter>{child || <MagentoPublicationProblems {...props} />}</MemoryRouter></AuthContext.Provider>);
}
beforeEach(() => {
  vi.resetAllMocks(); api.get.mockImplementation(url => { throw new Error(`Unexpected GET ${url}`); });
  api.post.mockImplementation(url => { throw new Error(`Unexpected POST ${url}`); });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([
  ['storeViews', 'meta_title', 'authoritative_create_update', 'Передавання англійською', 'Meta Title', 'EN', 'Оновлюється з менеджера'],
  ['inventory', 'qty', 'initialize_create_only', 'Початкові залишки', 'Кількість на складі', 'UA / основний магазин', 'Заповнюється лише для нового товару'],
  ['inventory', 'is_in_stock', 'initialize_create_only', 'Початкові залишки', 'Наявність на складі', 'UA / основний магазин', 'Заповнюється лише для нового товару'],
  ['websites', 'product_websites', 'authoritative_create_update', 'Належність до вебсайтів', 'Вебсайти магазину', 'UA / основний магазин', 'Оновлюється з менеджера'],
  ...['sku', 'product_type', 'attribute_set_code', 'store_view_code'].map(target => ['storeViews', target, 'magento_managed', 'Передавання англійською',
    { sku: 'Артикул', product_type: 'Тип товару', attribute_set_code: 'Набір атрибутів', store_view_code: 'Мова вітрини' }[target], 'EN', 'Вручну в Magento']),
])('explains the actual nested %s/%s requirement and links only its exact policy scope', (operation, target, requiredPolicy, operationLabel, fieldLabel, scopeLabel, policyLabel) => {
  const props = fixture(domain({ operation, target, requiredPolicy })); const original = JSON.stringify(props);
  show(props);
  const link = screen.getByRole('link', { name: 'Переглянути правило передавання' });
  const params = Object.fromEntries(new URL(link.href).searchParams);
  expect(params).toEqual({ binding: 'reviewed-draft', source: 'current', review: 'policies', productId: '7', category: 'BR', route: 'BR:all',
    language: operation === 'storeViews' ? 'english' : 'base', reviewField: target, reviewStore: operation === 'storeViews' ? 'en' : 'all' });
  expect(new URL(link.href).pathname).toBe('/admin/magento/categories/BR');
  expect(screen.queryAllByRole('link', { name: /Перевірити поле:/ })).toHaveLength(0);
  expect(screen.queryByRole('link', { name: 'Відкрити проблему цього товару' })).toBeNull();
  expect(screen.getByText(/потребує поведінки/).textContent).toContain(policyLabel);
  fireEvent.click(screen.getByText('Точна причина перевірки'));
  expect(screen.getByText(operationLabel, { exact: true })).toBeTruthy();
  expect(screen.getByText(fieldLabel, { exact: true })).toBeTruthy();
  expect(screen.getByText(scopeLabel, { exact: true })).toBeTruthy();
  expect(screen.getByText(policyLabel, { exact: true })).toBeTruthy();
  const raw = screen.getByText(/"DOMAIN_POLICY_REVIEW_REQUIRED"/);
  expect(JSON.parse(raw.textContent)).toEqual(props.review.checked[0].blockers[0]);
  expect(JSON.stringify(props)).toBe(original); expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

it.each(['missing', 'duplicate'])('uses an honest general rules link when the policy is %s', mode => {
  const props = fixture();
  if (mode === 'missing') props.revision.bindings.policies = props.revision.bindings.policies.filter(policy => policy.bindingKey !== 'exact-returned-key');
  else props.revision.bindings.policies.push({ ...props.revision.bindings.policies[2] });
  show(props);
  expect(screen.queryByRole('link', { name: 'Переглянути правило передавання' })).toBeNull();
  const href = new URL(screen.getByRole('link', { name: 'Переглянути всі правила категорії' }).href);
  expect(Object.fromEntries(href.searchParams)).toEqual({ binding: 'reviewed-draft', source: 'current', review: 'policies', productId: '7', category: 'BR' });
  expect(screen.queryByRole('link', { name: 'Відкрити проблему цього товару' })).toBeNull();
  expect(screen.queryAllByRole('link', { name: /Перевірити поле:/ })).toHaveLength(0);
  expect(api.post).not.toHaveBeenCalled();
});

it('keeps incomplete domain evidence in settings and copies the exact original report', async () => {
  const props = fixture(domain({ operation: 'constructor', requiredPolicy: 'toString' }));
  delete props.review.expectedCurrentId;
  const writeText = vi.fn().mockResolvedValue(); vi.stubGlobal('navigator', { clipboard: { writeText } });
  const original = JSON.stringify(props.review);
  show(props);
  expect(screen.getByRole('link', { name: 'Переглянути налаштування інтеграції' }).getAttribute('href')).toBe('/admin/magento');
  expect(screen.queryByRole('link', { name: 'Переглянути правило передавання' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Відкрити проблему цього товару' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Копіювати причини блокування' }));
  await screen.findByText('Причини блокування скопійовано.');
  expect(JSON.parse(writeText.mock.calls[0][0])).toEqual({ bindingRevisionId: props.revision.id, expectedRevision: props.revision.revision,
    expectedCurrentId: props.currentPublishedId, blockers: props.review.blockers, checked: props.review.checked });
  expect(JSON.stringify(props.review)).toBe(original); expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

it('keeps real product and ordinary mapping handoffs beside a domain-policy link', () => {
  const props = fixture();
  props.review.checked[0].blockers.push(
    { code: 'OPTION_MAPPING_REVIEW_REQUIRED', target: 'kolir', resolution: 'integration_configuration', message: 'Підтвердьте цей колір.' },
    { code: 'PRODUCT_EVALUATION_NOT_READY', resolution: 'product', message: 'Потрібна вага цього товару.' },
  );
  props.revision.bindings.attributes.push({ bindingKey: 'color', routeKey: 'BR:all', rowId: 'base', target: 'kolir' });
  show(props);
  expect(screen.getByRole('link', { name: 'Переглянути правило передавання' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Перевірити поле: Браслети → Колір · UA' }).getAttribute('href')).toContain('field=kolir');
  expect(screen.getByRole('link', { name: 'Відкрити проблему цього товару' }).getAttribute('href')).toBe('/attention?problem=7');
  expect(screen.getByText('Потрібна вага цього товару.')).toBeTruthy();
  expect(screen.getByText('kolir: Підтвердьте цей колір.')).toBeTruthy(); expect(api.post).not.toHaveBeenCalled();
});

it.each([null, undefined])('supports an exact first-publication draft link without source (current=%s)', currentPublishedId => {
  const props = fixture(); props.review.expectedCurrentId = null; props.currentPublishedId = currentPublishedId;
  show(props);
  const params = new URL(screen.getByRole('link', { name: 'Переглянути правило передавання' }).href).searchParams;
  expect(params.has('source')).toBe(false); expect(params.get('binding')).toBe('reviewed-draft');
  expect(params.get('language')).toBe('english'); expect(params.get('reviewStore')).toBe('en');
});

it('keeps the actual publication preview payload and blocks apply after the domain-only result', async () => {
  const props = fixture(); let resolve;
  const pending = new Promise(done => { resolve = done; }); api.post.mockReturnValue(pending);
  show(props, <MagentoPublicationActions revision={props.revision} currentPublishedId="current" compact />);
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити вплив на товари' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/publication/preview', {
    bindingRevisionId: 'reviewed-draft', expectedRevision: '3', expectedCurrentId: 'current', representatives: [],
  });
  expect(screen.queryByRole('link', { name: 'Переглянути правило передавання' })).toBeNull();
  await act(async () => { resolve({ data: props.review }); });
  await screen.findByRole('link', { name: 'Переглянути правило передавання' });
  const apply = screen.getByRole('button', { name: 'Застосувати правила' }); expect(apply.disabled).toBe(true);
  fireEvent.click(apply); expect(api.post).toHaveBeenCalledTimes(1); expect(api.get).not.toHaveBeenCalled();
});
