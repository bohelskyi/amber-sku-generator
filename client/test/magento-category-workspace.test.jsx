import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoCategoryWorkspace from '../src/components/workspace/MagentoCategoryWorkspace.jsx';
import MagentoWorkspaceReview from '../src/components/workspace/MagentoWorkspaceReview.jsx';
import MagentoIntegrationPage from '../src/pages/MagentoIntegrationPage.jsx';
import { assertCategoryScope, changedFields, decisionKey, routeLabel, uniqueOptionSuggestions } from '../src/lib/magento-category-workspace.js';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
const permissions = ['export_templates.view', 'export_templates.manage', 'export_templates.publish', 'exports.view', 'exports.create'];
const categories = [{ code: 'BR', name: 'Браслети', unboundCount: 1, operational: { count: 0 } }, { code: 'OT', name: 'Інші', unboundCount: 0, operational: { count: 0 } }];
const active = { id: 'current', revision: '4', state: 'published', templateId: 'original', templateVersionId: 'original-version' };
const definition = { evaluatorVersion: 'magento-declarative-4', outputContract: 'magento-products-columns-v2',
  sources: { color: { kind: 'semantic', category: 'BR', key: 'color', type: 'scalar' } }, tables: {},
  bindings: [{ id: 'sharedName', value: { op: 'literal', value: 'Стара назва' } }],
  groups: ['BR', 'OT'].map((route) => ({ route, columns: ['name', 'description', 'kolir'], rows: [
    { id: 'base', cells: { name: { op: 'ref', id: 'sharedName' }, description: { op: 'literal', value: 'Старий опис' }, kolir: { op: 'source', id: 'color' } } },
    { id: 'english', cells: { name: { op: 'literal', value: 'Old name' }, description: { op: 'literal', value: 'Old description' }, kolir: { op: 'literal', value: '' } } },
  ] })) };
const entry = { id: 'option:color-binding:zero', group: 'BR', routeKey: 'BR:all', row: 'base', target: 'kolir', kind: 'option', source: 'BR.color=value_id:0', evaluated: 'Нуль', identity: '10', reviewState: 'review_required', exact: false };
const options = [{ value: '10', label: 'Нуль' }, { value: '20', label: 'Інше значення' }];
const questions = [{ id: 'color', label: 'Колір', options: [{ id: 0, label: 'Нуль' }], uses: [{ target: 'kolir', rowId: 'base' }] }, { id: 'guard', label: 'Лише в умові', options: [], uses: [] }];
function projection(revision = active, rules = definition, rowId = 'base') {
  return { category: categories[0], revision, template: { definition: rules, versionId: revision.templateVersionId }, groupIndex: 0, rowIndex: rowId === 'english' ? 1 : 0,
    observedAt: '2026-10-01T00:00:00Z', routeKey: 'BR:all', routes: [{ routeKey: 'BR:all', setName: 'Прикраси' }], questions, unboundCount: 1,
    attributes: [
      ...[['name', 'Назва'], ['description', 'Опис'], ['kolir', 'Колір Magento']].map(([code, label]) => ({ code, target: code, label, inputType: code === 'kolir' ? 'select' : 'text', text: code !== 'kolir', configured: true, editable: true, sources: code === 'kolir' ? [{ label: 'Колір' }] : [], state: 'connected', unresolved: 0, policy: 'authoritative_create_update', policyApproved: true })),
      { code: 'material', target: 'material', label: 'Матеріал', text: false, configured: false, editable: true, inputType: 'select', sources: [], state: 'unmapped' },
      { code: 'photo', target: 'photo', label: 'Зображення', text: false, configured: false, editable: false, sources: [], state: 'unmapped', restriction: 'Цей тип атрибута доступний лише для перегляду.' },
    ] };
}
let saved;
let draft;
function mocks() {
  saved = null; draft = { ...active, id: 'isolated', revision: '1', state: 'draft', templateVersionId: 'version-next' };
  api.get.mockImplementation(async (url, config) => {
    if (url.endsWith('/sources')) return { data: { productFields: ['public_sku'], references: { questions: [], schemas: [] } } };
    if (url.endsWith('/sample-products')) return { data: { products: [{ id: 21, category: 'BR', public_sku: 'AG-21' }, { id: 22, category: 'OT', public_sku: 'AG-22' }], nextOffset: null } };
    if (url.includes('/fields/')) return { data: { attribute: {}, options, entries: url.endsWith('/kolir') ? [entry] : [] } };
    if (url.includes('/categories/')) return { data: projection(config?.params?.bindingRevisionId === 'isolated' ? draft : active, config?.params?.bindingRevisionId === 'isolated' ? saved?.draft.definition || definition : definition, config?.params?.rowId) };
    if (url.endsWith('/bindings/isolated')) return { data: { revision: { ...draft, schema: { attributes: [{ attribute_code: 'kolir', options }], attributeSets: [] }, bindings: { attributes: [{ bindingKey: 'color-binding', attributeCode: 'kolir' }] } }, entries: [entry], validation: { diagnostics: [] } } };
    if (url === '/admin/export-templates/family') return { data: saved };
    if (url.endsWith('/handoffs')) return { data: [] };
    throw new Error(`Unexpected GET ${url}`);
  });
  api.post.mockImplementation(async (url, body) => {
    if (url === '/admin/export-templates') { saved = { id: 'family', draft: { revision: '1', definitionHash: 'hash', definition: body.definition } }; return { data: saved }; }
    if (url.endsWith('/validate')) return { data: { valid: true } };
    if (url.endsWith('/publish')) return { data: { id: 'version-next' } };
    if (url.endsWith('/successor/prepare')) return { data: { previewToken: 'successor-proof' } };
    if (url.endsWith('/successor/apply')) return { data: draft };
    if (url.endsWith('/select')) { draft = { ...draft, revision: String(Number(draft.revision) + 1) }; return { data: draft }; }
    throw new Error(`Unexpected POST ${url}`);
  });
  api.put.mockImplementation(async (_url, body) => { saved = { ...saved, draft: { ...saved.draft, revision: '2', definition: body.definition } }; return { data: saved.draft }; });
}
function mount(path = '/admin/magento?category=BR', grants = permissions, roles = []) {
  const router = createMemoryRouter([{ path: '/admin/magento', element: <MagentoCategoryWorkspace categories={categories} activePublication={active} onPublished={vi.fn()} /> }], { initialEntries: [path] });
  const view = render(<AuthContext.Provider value={{ permissions: grants, roles }}><RouterProvider router={router} /></AuthContext.Provider>);
  return { ...view, router };
}
async function textFields() {
  fireEvent.click(await screen.findByRole('button', { name: 'Назва й описи' }));
}
function saveDraft() {
  fireEvent.click(screen.getByText('Зберегти й продовжити пізніше'));
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти чернетку' }));
}
beforeEach(() => { vi.resetAllMocks(); mocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('reuses the exact initial base category read while preserving a different language baseline', async () => {
  mount(); await screen.findByRole('button', { name: 'Матеріал' });
  expect(api.get.mock.calls.filter(([url]) => url === '/admin/magento-integration/categories/BR')).toHaveLength(1);
  cleanup(); api.get.mockClear();
  mount('/admin/magento?category=BR&language=english'); await screen.findByRole('button', { name: 'Матеріал' });
  expect(api.get.mock.calls.filter(([url]) => url === '/admin/magento-integration/categories/BR')).toHaveLength(2);
});

it('shows intended local edits and unrelated publication blockers before preparation without extra requests', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.includes('/categories/') && !url.includes('/fields/')) result.data.reviewScope = { categoryCount: 2, unresolved: [{ group: 'OT', target: 'name', row: 'base', kind: 'policy', reviewState: 'review_required' }] };
    return result;
  });
  mount('/admin/magento?category=BR&language=english');
  const scope = await screen.findByRole('region', { name: 'Обсяг редагування та перевірки' });
  expect(scope.textContent).toContain('Браслети · EN');
  expect(scope.textContent).toContain('увесь пакет правил (2 категорій)');
  expect(scope.textContent).toContain('В інших категоріях: 1 (Інші)');
  expect(api.post).not.toHaveBeenCalled();
});

it('focuses the exact semantic zero value from a product repair without selecting or approving it', async () => {
  mount('/admin/magento?category=BR&question=color&value=0&productId=7&returnTo=%2Fattention%3Fproblem%3D7');
  const mapping = await screen.findByLabelText('Magento для Нуль');
  const row = mapping.closest('tr');
  expect(row.classList.contains('is-repair-target')).toBe(true);
  expect(row.textContent).toContain('Значення з проблеми цього товару');
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(screen.getByRole('link', { name: 'Повернутися до проблеми товару' }).getAttribute('href')).toBe('/attention?problem=7');
  expect(api.post).not.toHaveBeenCalled();
});

it('identifies a missing historical local value instead of rendering a naked numeric ID', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.endsWith('/kolir')) result.data.entries = [{ ...entry, source: 'BR.color=value_id:87', evaluated: '' }];
    return result;
  });
  mount('/admin/magento?category=BR&field=kolir&question=color&value=87');
  await screen.findByLabelText('Magento для Невідоме локальне значення (ID 87)');
  expect(api.post).not.toHaveBeenCalled();
});

it('restores the applied result and reads persistent delivery evidence without implying remote confirmation', async () => {
  mount('/admin/magento?category=BR&binding=current&source=current');
  await screen.findByText('Застосовано в Amber. Доставку Magento перевіряємо окремо.');
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/magento-integration/bindings/current/handoffs', expect.any(Object)));
  expect(api.post).not.toHaveBeenCalled();
});

it('prepares native product source support only through the server-advertised explicit isolated draft upgrade', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.endsWith('/sources')) result.data.nativeCharacteristicsUpgrade = { targetContract: 'public-product-characteristics-v1', evaluatorVersion: 'magento-declarative-5', supportedEvaluatorVersions: ['magento-declarative-3', 'magento-declarative-4'] };
    return result;
  });
  const post = api.post.getMockImplementation();
  api.post.mockImplementation(async (url, body) => {
    if (url.endsWith('/draft/upgrade-columns')) {
      saved.draft = { ...saved.draft, revision: '2', definitionHash: 'native-hash', definition: { ...saved.draft.definition, evaluatorVersion: 'magento-declarative-5', sourceContractVersion: 'public-product-characteristics-v1' } };
      return { data: saved.draft };
    }
    return post(url, body);
  });
  mount();
  fireEvent.click(await screen.findByText('Підтримка характеристик нових товарів'));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Підготувати підтримку характеристик нових товарів' }));
  await screen.findByText('Підтримку нових товарів збережено у чернетці. Перевірте й застосуйте зміни пакета.');
  expect(api.post).toHaveBeenCalledWith('/admin/export-templates/family/draft/upgrade-columns', { expectedRevision: '1', expectedDefinitionHash: 'hash', targetContract: 'public-product-characteristics-v1' });
  expect(api.post.mock.calls.some(([url]) => /successor|publication|\/publish$/.test(url))).toBe(false);
});

it('opens the category and complete attribute set without product evaluation or remote writes; exposes unreadable types', async () => {
  mount(); await screen.findByRole('button', { name: 'Матеріал' });
  expect(screen.getByText('Лише в умові')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  expect(api.get.mock.calls.every(([url]) => /categories|sources/.test(url))).toBe(true);
  expect(screen.queryByRole('button', { name: 'Перевірити зміни' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Оновити структуру Magento' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Показати'), { target: { value: 'unmapped' } });
  expect(screen.queryByRole('button', { name: 'Опис' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Службові поля (1)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Зображення' }));
  expect(screen.getByText('Цей тип атрибута доступний лише для перегляду.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Підключити поле' })).toBeNull();
});

it('explains a review state and starts isolated binding review without requiring a fake rule edit', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.includes('/categories/') && !url.includes('/fields/')) {
      const color = result.data.attributes.find((a) => a.code === 'kolir');
      color.state = 'review'; color.reviewReasons = [{ kind: 'option', message: 'Є значення без підтвердженої відповідності.' }];
    }
    return result;
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Що виправити' }));
  await screen.findByRole('region', { name: 'Що виправити в полі' });
  expect(screen.getAllByText('Є значення без підтвердженої відповідності.').length).toBeGreaterThan(0);
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити прив’язку цього поля' }));
  await screen.findByRole('region', { name: 'Перевірка підготовлених відповідностей' });
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/successor/prepare', { sourceId: 'current', expectedSourceRevision: '4', templateVersionId: 'original-version' });
  expect(api.post.mock.calls.some(([url]) => url === '/admin/export-templates' || /decision|publication\/apply/.test(url))).toBe(false);
});

it('offers optional empty descriptions and hides editable service text from everyday fields', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.includes('/categories/') && !url.includes('/fields/')) {
      result.data.attributes.find((a) => a.code === 'description').state = 'empty';
      result.data.attributes.push({ code: 'image_label', label: 'Image Label', text: true, service: true, editable: true, sources: [], state: 'unmapped' });
    }
    return result;
  });
  mount(); await textFields();
  expect(screen.getByText('Порожній текст не передається в Magento.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Image Label' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Додати текст' }));
  await screen.findByLabelText('Текст для магазину');
  expect(screen.getByText(/Це необов’язкове поле порожнє/)).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

it('opens category repair in the new workspace, with paths and a scoped confirmation action', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.includes('/categories/') && !url.includes('/fields/')) result.data.placements = [{ id: 'category:one', target: 'categories', label: 'Default/Кулони', identity: 42, reviewState: 'proposed' }];
    return result;
  });
  const { router } = mount('/admin/magento?category=BR&view=placement&returnTo=%2Fattention%3Fproblem%3D7');
  await screen.findByRole('region', { name: 'Категорії магазину для товарів' });
  expect(screen.getByText('Default › Кулони')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Повернутися до проблеми товару' }).getAttribute('href')).toBe('/attention?problem=7');
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити відповідність розділів' }));
  await screen.findByRole('heading', { name: 'Підтвердьте розділи магазину' });
  expect(new URLSearchParams(router.state.location.search).get('reviewField')).toBe('categories');
});

it('checks the originating product, confirms its new path and requires a separate apply before returning to attention', async () => {
  const categoryEntry = { ...entry, id: 'category:placement:unique', kind: 'category', target: 'categories',
    source: undefined, evaluated: undefined, label: 'Default/Браслети/Світлі', identity: '42',
    candidates: [{ categoryId: '42', path: 'Default/Браслети/Світлі' }], exact: true, reviewState: 'proposed' };
  let confirmed = false;
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.includes('/categories/') && !url.includes('/fields/')) result.data.placements = [
      { ...categoryEntry, id: 'category:placement:saved', label: 'Default/Браслети', reviewState: 'approved' },
    ];
    if (url.endsWith('/bindings/isolated')) result.data.entries = [{ ...categoryEntry, ...(confirmed ? { reviewState: 'approved' } : {}) }];
    return result;
  });
  const post = api.post.getMockImplementation();
  api.post.mockImplementation(async (url, body) => {
    if (url.endsWith('/decision')) { confirmed = true; draft = { ...draft, revision: '2' }; return { data: draft }; }
    if (url.endsWith('/publication/preview')) return { data: { previewToken: 'impact-proof', blockers: [], affected: [], preservedNames: [], lostProducts: [], lostRoutes: [], totalProducts: 12 } };
    if (url.endsWith('/publication/apply')) { draft = { ...draft, state: 'published' }; return { data: { revision: draft } }; }
    return post(url, body);
  });
  mount('/admin/magento?category=BR&view=placement&productId=5080&returnTo=%2Fattention%3Fproblem%3D5080');
  await screen.findByText('Підтверджено в збережених налаштуваннях');
  const check = screen.getByRole('button', { name: 'Перевірити відповідність розділів' });
  expect(check.compareDocumentPosition(screen.getByText('Default › Браслети')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText(/Перевірка врахує товар, з якого ви перейшли/)).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(check);
  await screen.findByRole('heading', { name: 'Підтвердьте розділи магазину' });
  const request = { sourceId: 'current', expectedSourceRevision: '4', templateVersionId: 'original-version', productIds: [5080] };
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/successor/prepare', request);
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/successor/apply', { ...request, previewToken: 'successor-proof' });
  expect((await screen.findByLabelText('Відповідність: Default/Браслети/Світлі')).value).toBe('42');
  expect(screen.getByText(/Перевірте шлях у колонці Magento/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Застосувати зміни' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити', exact: true }));
  const apply = await screen.findByRole('button', { name: 'Застосувати зміни' });
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/bindings/isolated/decision', { expectedRevision: '1', binding: categoryEntry.id, action: 'approve', acceptReview: true });
  expect(api.post.mock.calls.some(([url]) => url.endsWith('/publication/apply'))).toBe(false);
  fireEvent.click(apply);
  await screen.findByText(/Поверніться до проблеми товару й натисніть «Перевірити товар у Magento»/);
  expect(screen.getByText(/Розділи збережено. Наступний крок — «Повернутися до проблеми товару»/)).toBeTruthy();
  expect(screen.queryByText(/^Наступний крок — «Перевірити відповідність розділів»/)).toBeNull();
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/publication/apply', expect.objectContaining({ bindingRevisionId: 'isolated', expectedRevision: '2', expectedCurrentId: 'current', previewToken: 'impact-proof' }));
  expect(screen.getByRole('link', { name: 'Повернутися до проблеми товару' }).getAttribute('href')).toBe('/attention?problem=5080');
});

it('continues restored category review explicitly and checks impact without creating another draft', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.endsWith('/bindings/isolated')) result.data.entries = [{ ...entry, reviewState: 'approved' }];
    return result;
  });
  api.post.mockResolvedValue({ data: { previewToken: 'impact-proof', blockers: [], affected: [], preservedNames: [], lostProducts: [], lostRoutes: [], totalProducts: 12 } });
  mount('/admin/magento?category=BR&view=placement&binding=isolated&source=current&reviewField=categories');
  await screen.findByText('Відповідності перевірено');
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Продовжити перевірку розділів' }));
  await screen.findByRole('button', { name: 'Застосувати зміни' });
  expect(api.post.mock.calls).toEqual([['/admin/magento-integration/publication/preview', {
    bindingRevisionId: 'isolated', expectedRevision: '1', expectedCurrentId: 'current', representatives: [],
  }]]);
});
it('keeps a source failure after category approvals in the same exact preparation and points to the affected field', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.endsWith('/bindings/isolated')) result.data.entries = [{ ...entry, reviewState: 'approved' }];
    return result;
  });
  api.post.mockResolvedValue({ data: { previewToken: 'blocked-proof', blockers: [{ code: 'SOURCE_REFERENCE_UNRESOLVED', sourceId: 'color',
    category: 'BR', key: 'color', requirement: 'historical_sku_or_current_non_sku_value_ids', unresolvedValueIds: ['9'] }],
    affected: [], preservedNames: [], lostProducts: [], lostRoutes: [], totalProducts: 3339, checked: [] } });
  mount('/admin/magento?category=BR&view=placement&binding=isolated&source=current&productId=5080&returnTo=%2Fattention%3Fproblem%3D5080');
  fireEvent.click(await screen.findByRole('button', { name: 'Продовжити перевірку розділів' }));
  const issues = await screen.findByRole('region', { name: 'Що блокує застосування' });
  expect(within(issues).getByText(/яких немає серед підтверджених значень/)).toBeTruthy();
  expect(within(issues).getByText('Непідтверджені значення: 9.')).toBeTruthy();
  const target = new URL(within(issues).getByRole('link', { name: 'Перевірити поле: Браслети → Колір · UA' }).href);
  expect(Object.fromEntries(target.searchParams)).toMatchObject({ binding: 'isolated', source: 'current', field: 'kolir', language: 'base', productId: '5080', returnTo: '/attention?problem=5080' });
  expect(within(issues).queryByRole('link', { name: 'Проблеми синхронізації' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Застосувати зміни' }).disabled).toBe(true);
  expect(api.post.mock.calls).toEqual([['/admin/magento-integration/publication/preview', {
    bindingRevisionId: 'isolated', expectedRevision: '1', expectedCurrentId: 'current', representatives: [],
  }]]);
});

it('shows the exact remaining category after placement confirmation and applies only after its separate approval', async () => {
  const placement = { ...entry, id: 'category:placement:local', kind: 'category', target: 'categories',
    source: undefined, evaluated: undefined, label: 'Default/Браслети/Форма: коло', identity: '42',
    candidates: [{ categoryId: '42', path: 'Default/Браслети/Форма: коло' }], exact: true, reviewState: 'proposed' };
  // The other blocker is outside the selected field as well as its category.
  const other = { ...entry, id: 'attribute:other', group: 'OT', kind: 'attribute', target: 'other_field',
    source: undefined, evaluated: undefined, label: 'Матеріал оправи', identity: '77', exact: true };
  const confirmed = new Set(); let finishRead;
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.includes('/categories/') && !url.includes('/fields/')) result.data.placements = [
      { ...placement, ...(confirmed.has(placement.id) ? { reviewState: 'approved' } : {}) },
    ];
    if (url.endsWith('/bindings/isolated')) {
      result.data.entries = [placement, other].map((item) => ({ ...item, ...(confirmed.has(item.id) ? { reviewState: 'approved' } : {}) }));
      if (draft.revision === '2') await new Promise((resolve) => { finishRead = resolve; });
    }
    return result;
  });
  const post = api.post.getMockImplementation();
  api.post.mockImplementation(async (url, body) => {
    if (url.endsWith('/decision')) { confirmed.add(body.binding); draft = { ...draft, revision: String(Number(draft.revision) + 1) }; return { data: draft }; }
    if (url.endsWith('/publication/preview')) return { data: { previewToken: 'impact-proof', blockers: [], affected: [], preservedNames: [], lostProducts: [], lostRoutes: [], totalProducts: 12 } };
    if (url.endsWith('/publication/apply')) return { data: { revision: { ...draft, state: 'published' } } };
    return post(url, body);
  });
  mount('/admin/magento?category=BR&view=placement');
  fireEvent.click(await screen.findByRole('button', { name: 'Перевірити відповідність розділів' }));
  await screen.findByLabelText('Відповідність: Default/Браслети/Форма: коло');
  expect(screen.queryByText('Матеріал оправи')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити', exact: true }));
  await screen.findByText('Оновлюємо підтвердження…');
  expect(screen.queryByText(/Чернетка змінилася/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Застосувати зміни' })).toBeNull();
  await act(async () => finishRead());
  await screen.findByRole('heading', { name: 'Підтвердьте відповідності інших категорій' });
  await screen.findByText('Розділи «Браслети» підтверджено. Застосування чекає на підтвердження: Інші.');
  const row = screen.getByRole('row', { name: /Матеріал оправи/ });
  expect(within(row).getByText('Інші')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Показати також інші категорії' })).toBeNull();
  expect(screen.getByText('Default › Браслети › Форма: коло').closest('.mc-placement-row').textContent).toContain('Підтверджено. Очікує застосування змін.');
  expect(api.post.mock.calls.filter(([url]) => url.endsWith('/decision'))).toHaveLength(1);
  expect(api.post.mock.calls.some(([url]) => url.includes('/publication/'))).toBe(false);
  fireEvent.click(within(row).getByRole('button', { name: 'Підтвердити', exact: true }));
  const apply = await screen.findByRole('button', { name: 'Застосувати зміни' });
  expect(api.post.mock.calls.filter(([url]) => url.endsWith('/decision')).map(([, body]) => [body.binding, body.expectedRevision])).toEqual([[placement.id, '1'], [other.id, '2']]);
  expect(screen.queryByText(/Застосування чекає на підтвердження/)).toBeNull();
  expect(api.post.mock.calls.some(([url]) => url.endsWith('/publication/apply'))).toBe(false);
  fireEvent.click(apply);
  await screen.findByText('Зміни застосовано в Amber. Результат доставки відстежується окремо.');
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/publication/apply', expect.objectContaining({ bindingRevisionId: 'isolated', expectedRevision: '3', previewToken: 'impact-proof' }));
});

it('restores the remaining fields of another category visibly without automatic approval or impact checking', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.endsWith('/bindings/isolated')) result.data.entries = [{ ...entry, group: 'OT', source: 'OT.color=value_id:0', evaluated: 'Золотиста оправа' }];
    return result;
  });
  mount('/admin/magento?category=BR&view=placement&binding=isolated&source=current&reviewField=categories');
  await screen.findByRole('heading', { name: 'Підтвердьте відповідності інших категорій' });
  const row = screen.getByRole('row', { name: /Золотиста оправа/ });
  expect(row.textContent).toContain('Інші');
  expect(within(row).queryByText('Колір: Нуль')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Застосувати зміни' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('shows remaining local fields after the focused placement is confirmed and keeps real draft conflicts blocked', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.endsWith('/bindings/isolated')) result.data.revision.revision = '2';
    return result;
  });
  mount('/admin/magento?category=BR&view=placement&binding=isolated&source=current&reviewField=categories');
  await screen.findByRole('heading', { name: 'Підтвердьте решту полів категорії' });
  expect(screen.getByLabelText('Відповідність: Колір: Нуль')).toBeTruthy();
  expect(screen.getByText(/Чернетка змінилася/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: 'Перевірено' } });
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити', exact: true }));
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Застосувати зміни' })).toBeNull();
});

it('isolates a shared text rule to the chosen category and language and saves a separate family', async () => {
  mount(); await textFields(); fireEvent.click(await screen.findByRole('button', { name: 'Назва' }));
  fireEvent.change(await screen.findByLabelText('Текст для магазину'), { target: { value: 'Нова назва' } });
  expect(screen.queryByLabelText('Як формується значення')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Змінити назву поля' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
  saveDraft();
  await screen.findByText('Чернетку збережено. Чинна інтеграція ще не змінена.');
  const next = api.post.mock.calls[0][1];
  expect(next.key).toMatch(/^magento-edit-/);
  expect(next.definition.groups[1]).toEqual(definition.groups[1]);
  expect(next.definition.groups[0].rows[1]).toEqual(definition.groups[0].rows[1]);
  expect(changedFields(definition, next.definition, 'BR')).toEqual([{ field: 'name', rowId: 'base' }]);
  expect(definition.bindings[0].value.value).toBe('Стара назва');
  expect(api.put).not.toHaveBeenCalled();
});

it('keeps unsaved field input when closing, changing category, or switching language', async () => {
  mount(); await textFields(); fireEvent.click(await screen.findByRole('button', { name: 'Опис' }));
  fireEvent.change(await screen.findByLabelText('Текст для магазину'), { target: { value: 'Введення' } });
  expect(screen.getByLabelText('Мова полів').disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Закрити налаштування' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Незбережене поле' })).getByRole('button', { name: 'Залишитися' }));
  expect(screen.getByLabelText('Текст для магазину').value).toBe('Введення');
  fireEvent.click(screen.getByRole('link', { name: /Інші/ }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Незбережені зміни' })).getByRole('button', { name: 'Залишитися' }));
  expect(screen.getByLabelText('Текст для магазину').value).toBe('Введення');
  expect(api.post).not.toHaveBeenCalled();
});

it('stores explicit option IDs in the prepared draft with CAS but does not approve or apply it automatically', async () => {
  const { router } = mount(); fireEvent.click(await screen.findByRole('button', { name: 'Колір Magento' }));
  fireEvent.change(await screen.findByLabelText('Magento для Нуль'), { target: { value: '20' } });
  fireEvent.click(screen.getByRole('button', { name: 'Закрити налаштування' }));
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити зміни' }));
  await screen.findByText('Підготовку збережено. Перевірте відповідності й вплив перед застосуванням.');
  expect(api.post.mock.calls).toContainEqual(['/admin/magento-integration/successor/prepare', { sourceId: 'current', expectedSourceRevision: '4', templateVersionId: 'original-version' }]);
  expect(api.post.mock.calls).toContainEqual(['/admin/magento-integration/bindings/isolated/select', { expectedRevision: '1', binding: entry.id, identity: '20' }]);
  expect(api.post.mock.calls.some(([url]) => /decision|publication\/apply/.test(url))).toBe(false);
  expect(new URLSearchParams(router.state.location.search).get('binding')).toBe('isolated');
});

it('preserves both saved rule and binding identities during preparation and uses only the inactive new version', async () => {
  const { router } = mount(); await textFields(); fireEvent.click(await screen.findByRole('button', { name: 'Опис' }));
  fireEvent.change(await screen.findByLabelText('Текст для магазину'), { target: { value: 'Підготовлений опис' } });
  fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити зміни' }));
  await waitFor(() => expect(api.post.mock.calls.map(([url]) => url)).toContain('/admin/magento-integration/successor/apply'));
  await waitFor(() => expect(api.post.mock.calls.map(([url]) => url)).toContain('/admin/magento-integration/successor/apply'));
  await screen.findByText('Підготовку збережено. Перевірте відповідності й вплив перед застосуванням.');
  const params = new URLSearchParams(router.state.location.search);
  expect(params.get('binding')).toBe('isolated'); expect(params.get('ruleDraft')).toBe('family'); expect(params.get('source')).toBe('current');
  expect(api.post.mock.calls).toContainEqual(['/admin/export-templates/family/publish', { expectedRevision: '1', expectedDefinitionHash: 'hash' }]);
  expect(api.post.mock.calls.find(([url]) => url.endsWith('/successor/prepare'))[1].templateVersionId).toBe('version-next');
  expect(api.put.mock.calls.some(([url]) => url.endsWith('/activation'))).toBe(false);
  expect(api.get.mock.calls.filter(([url]) => url.endsWith('/categories/BR'))).toHaveLength(2);
});

it('reads an externally navigated language scope without confusing it with a local URL commit', async () => {
  const { router } = mount(); await textFields(); await screen.findByRole('button', { name: 'Опис' });
  await act(() => router.navigate('/admin/magento?category=BR&language=english&view=text'));
  fireEvent.click(await screen.findByRole('button', { name: 'Опис' }));
  expect((await screen.findByLabelText('Текст для магазину')).value).toBe('Old description');
});

it('restores a saved rule draft after reload and keeps it when a CAS save fails', async () => {
  saved = { id: 'family', draft: { revision: '8', definitionHash: 'hash', definition: structuredClone(definition) } };
  saved.draft.definition.groups[0].rows[0].cells.description.value = 'Відновлений опис';
  mount('/admin/magento?category=BR&ruleDraft=family&source=current');
  await textFields();
  fireEvent.click(await screen.findByRole('button', { name: 'Опис' }));
  expect((await screen.findByLabelText('Текст для магазину')).value).toBe('Відновлений опис');
  fireEvent.change(screen.getByLabelText('Текст для магазину'), { target: { value: 'Зберегти введення' } });
  fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
  api.put.mockRejectedValueOnce({ response: { data: { error: 'Чернетка змінилася' } } });
  saveDraft();
  await screen.findByText('Чернетка змінилася');
  expect(api.put.mock.calls[0][1].expectedRevision).toBe('8');
  fireEvent.click(screen.getByRole('button', { name: 'Опис' }));
  expect((await screen.findByLabelText('Текст для магазину')).value).toBe('Зберегти введення');
});

it('retains the stored schema and date when explicit Magento observation fails', async () => {
  mount(); await screen.findByRole('button', { name: 'Матеріал' });
  fireEvent.click(screen.getByText('Дані Magento та додаткові налаштування'));
  const date = screen.getByText(/^Структура Magento:/).textContent;
  api.post.mockRejectedValueOnce({ response: { data: { error: 'Magento недоступний' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Оновити структуру Magento' }));
  await screen.findByText('Magento недоступний');
  expect(screen.getByText(/^Структура Magento:/).textContent).toBe(date);
  expect(screen.getByRole('button', { name: 'Матеріал' })).toBeTruthy();
});

it('uses a modal for the whole field on a narrow screen and preserves literal English separately', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  mount(); await textFields(); await screen.findByRole('button', { name: 'Опис' });
  fireEvent.change(screen.getByLabelText('Мова полів'), { target: { value: 'english' } });
  await waitFor(() => expect(api.get.mock.calls.some(([, config]) => config?.params?.rowId === 'english')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Опис' }));
  const dialog = await screen.findByRole('dialog', { name: 'Поле Magento' });
  expect((await within(dialog).findByLabelText('Текст для магазину')).value).toBe('Old description');
});

it('scopes the separate Administrator rename chooser on the server and hides it for permission-only roles', async () => {
  const view = mount(undefined, permissions, [{ key: 'administrator' }]);
  fireEvent.click(await screen.findByRole('button', { name: 'Застосувати назви до чинних товарів' }));
  api.get.mockResolvedValueOnce({ data: { products: [], nextCursor: null } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товари для контрольованої дії' }));
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/magento-integration/bindings/current/controlled-products', { params: { after: 0, search: '', categoryCode: 'BR' } }));
  view.unmount(); mount(); await screen.findByRole('button', { name: 'Матеріал' });
  expect(screen.queryByRole('button', { name: 'Застосувати назви до чинних товарів' })).toBeNull();
});

it('makes the main integration page a category entrance and performs only its local overview read', async () => {
  api.get.mockResolvedValue({ data: { integration: { configured: true, activePublication: { ...active, versionNumber: 1 }, delivery: { state: 'enabled' }, operational: { state: 'known', count: 0 }, structureObservation: null, draftCount: 0 }, categories } });
  const router = createMemoryRouter([{ path: '/admin/magento/*', element: <MagentoIntegrationPage /> }], { initialEntries: ['/admin/magento'] });
  render(<AuthContext.Provider value={{ permissions }}><RouterProvider router={router} /></AuthContext.Provider>);
  await screen.findByText('Оберіть категорію менеджера');
  expect(screen.getByRole('link', { name: /Браслети/ })).toBeTruthy();
  expect(api.get.mock.calls.map(([url]) => url)).toEqual(['/admin/magento-integration/overview']);
  expect(api.post).not.toHaveBeenCalled();
});

it('does not guess ambiguous labels, preserves semantic zero, and names conditional sets clearly', () => {
  expect(uniqueOptionSuggestions([entry], options)[0].option.value).toBe('10');
  expect(uniqueOptionSuggestions([entry], [...options, { value: '30', label: 'Нуль' }])).toEqual([]);
  expect(decisionKey(entry)).toContain('value_id:0');
  expect(routeLabel({ routeKey: 'BR.color=value_id:0', setName: 'Прикраси' }, questions)).toBe('Прикраси · Колір — Нуль');
});

it('rejects shared rule edits that would transmit changes to another category or language', () => {
  const next = structuredClone(definition); next.bindings[0].value.value = 'Спільна зміна';
  expect(() => assertCategoryScope(definition, next, 'BR', 'base')).toThrow(/лише вибраної категорії та мови/);
  const english = structuredClone(definition); english.groups[0].rows[1].cells.name.value = 'Changed';
  expect(() => assertCategoryScope(definition, english, 'BR', 'base')).toThrow();
});

it('reopens the original language after an external navigation back from a locally selected scope', async () => {
  const initial = '/admin/magento?category=BR&view=text';
  const { router } = mount(initial);
  await screen.findByRole('button', { name: 'Опис' });
  fireEvent.change(screen.getByLabelText('Мова полів'), { target: { value: 'english' } });
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('language')).toBe('english'));
  await act(() => router.navigate(initial));
  fireEvent.click(await screen.findByRole('button', { name: 'Опис' }));
  expect(screen.getByLabelText('Мова полів').value).toBe('base');
  expect((await screen.findByLabelText('Текст для магазину')).value).toBe('Старий опис');
});

it('checks product impact after the single explicit check and waits for a separate apply confirmation', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.endsWith('/bindings/isolated')) result.data.entries = [{ ...entry, reviewState: 'approved' }];
    return result;
  });
  const post = api.post.getMockImplementation();
  api.post.mockImplementation(async (url, body) => url.endsWith('/publication/preview') ? { data: { previewToken: 'impact-proof', blockers: [], affected: [], preservedNames: [], lostProducts: [], lostRoutes: [], totalProducts: 12 } } : post(url, body));
  mount(); await textFields(); fireEvent.click(await screen.findByRole('button', { name: 'Опис' }));
  fireEvent.change(await screen.findByLabelText('Текст для магазину'), { target: { value: 'Новий опис' } });
  fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити зміни' }));
  const apply = await screen.findByRole('button', { name: 'Застосувати зміни' });
  expect(apply.disabled).toBe(false);
  expect(api.post.mock.calls.filter(([url]) => url.endsWith('/publication/preview'))).toHaveLength(1);
  expect(api.post.mock.calls.some(([url]) => url.endsWith('/publication/apply'))).toBe(false);
  expect(screen.queryByRole('button', { name: 'Перевірити вплив на товари' })).toBeNull();
});

it('restores prepared work without starting an automatic product or Magento check', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.endsWith('/bindings/isolated')) result.data.entries = [{ ...entry, reviewState: 'approved' }];
    return result;
  });
  mount('/admin/magento?category=BR&binding=isolated&source=current');
  expect(await screen.findByRole('button', { name: 'Перевірити вплив на товари' })).toBeTruthy();
  expect(screen.getByText('Відповідності перевірено')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

it('requires an explicit new policy and reason before approving it', async () => {
  const policy = { ...entry, id: 'policy:color-binding:all', kind: 'policy', target: 'kolir', source: undefined, evaluated: undefined, label: 'all', identity: 'initialize_create_only' };
  api.get.mockResolvedValue({ data: { revision: { ...draft, schema: { attributeSets: [], attributes: [] }, bindings: { attributes: [] } }, entries: [policy], validation: { diagnostics: [] } } });
  const changed = vi.fn();
  render(<MagentoWorkspaceReview revision={draft} categoryCode="BR" questions={questions} selections={{}} onChanged={changed} />);
  const selector = await screen.findByLabelText('Відповідність: Колір · UA');
  expect(selector.value).toBe('');
  fireEvent.change(selector, { target: { value: 'authoritative_create_update' } });
  expect(screen.getByRole('button', { name: 'Підтвердити', exact: true }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: 'Перевірено оновлення з менеджера' } });
  api.post.mockResolvedValueOnce({ data: { ...draft, revision: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити', exact: true }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(api.post.mock.calls[0][1]).toMatchObject({ expectedRevision: '1', action: 'approve', policy: 'authoritative_create_update', reason: 'Перевірено оновлення з менеджера' });
});

it('inserts a characteristic using fetched labels without another output-mode step and keeps shared consumers unchanged', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    if (url.endsWith('/sources')) return { data: { productFields: [], references: { questions: [{ category_code: 'BR', key: 'color', label: 'Колір', include_in_sku: 1 }], schemas: [{ category_code: 'BR', questions: [{ key: 'color', label: 'Колір', value_ids: ['0'] }] }] } } };
    if (url.endsWith('/source-details')) return { data: { current: [{ label: 'Колір', options: [{ value_id: '0', label: 'Світлий' }] }] } };
    return get(url, config);
  });
  mount(); await textFields(); fireEvent.click(await screen.findByRole('button', { name: 'Назва' }));
  fireEvent.click(await screen.findByRole('button', { name: '+ Додати характеристику' }));
  const picker = screen.getByRole('combobox', { name: 'Характеристика' });
  fireEvent.focus(picker);
  fireEvent.click(screen.getByRole('option', { name: 'Браслети → Колір' }));
  await screen.findByText('У тексті будуть назви: Світлий.');
  expect(screen.queryByLabelText('Як записувати значення')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Вставити характеристику' }));
  expect(screen.getByLabelText('Текст для магазину').value).toBe('Стара назва{Колір}');
  fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
  saveDraft(); await screen.findByText('Чернетку збережено. Чинна інтеграція ще не змінена.');
  expect(saved.draft.definition.tables['text.names']).toEqual({ 0: 'Світлий' });
  expect(saved.draft.definition.groups[1]).toEqual(definition.groups[1]);
  expect(saved.draft.definition.bindings).toEqual(definition.bindings);
  expect(saved.draft.definition.groups[0].rows[1]).toEqual(definition.groups[0].rows[1]);
});


it('keeps whole-package blockers upfront and discloses saved-draft consequences without issuing a command', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.includes('/categories/') && !url.includes('/fields/')) result.data.reviewScope = { categoryCount: 2, unresolved: [{ group: 'OT', target: 'name', row: 'base', kind: 'policy', reviewState: 'review_required' }] };
    return result;
  });
  mount('/admin/magento?category=BR&question=color&value=0&productId=7&returnTo=%2Fattention%3Fproblem%3D7');
  const scope = await screen.findByRole('region', { name: 'Обсяг редагування та перевірки' });
  expect(scope.textContent).toContain('увесь пакет правил (2 категорій)');
  expect(scope.textContent).toContain('В інших категоріях: 1 (Інші)');
  expect(scope.textContent).toContain('Вони також блокують застосування пакета.');
  expect(scope.textContent).not.toContain('неактивну версію правил');
  fireEvent.click(screen.getByText('Обсяг і наслідки перевірки'));
  expect(scope.textContent).toContain('Перевірка збереже чернетку й підготує неактивну версію правил');
  expect(scope.textContent).toContain('Структурні перешкоди й вплив на товари');
  expect(api.post).not.toHaveBeenCalled();
});

it('keeps an exact repair edit and its explicit review action before the long field table without approving it', async () => {
  mount('/admin/magento?category=BR&question=color&value=0&productId=7&returnTo=%2Fattention%3Fproblem%3D7');
  const mapping = await screen.findByLabelText('Magento для Нуль');
  fireEvent.change(mapping, { target: { value: '20' } });
  fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
  const action = await screen.findByRole('button', { name: 'Перевірити зміни' });
  const table = screen.getByRole('table', { name: 'Поля Magento та джерела менеджера' });
  expect(action.closest('.mc-change-bar').compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Підготовлені зміни' }).textContent).toContain('вибрані відповідності');
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Повернутися до проблеми товару' }).getAttribute('href')).toBe('/attention?problem=7');
});

it('discloses mobile category choices without changing the selected category or full package scope', async () => {
  mount(); await screen.findByRole('button', { name: 'Матеріал' });
  const chooser = screen.getByRole('button', { name: 'Браслети · змінити категорію' });
  const choices = document.getElementById(chooser.getAttribute('aria-controls'));
  expect(chooser.getAttribute('aria-expanded')).toBe('false');
  expect(choices.classList.contains('is-open')).toBe(false);
  fireEvent.click(chooser);
  expect(chooser.getAttribute('aria-expanded')).toBe('true');
  expect(choices.classList.contains('is-open')).toBe(true);
  expect(within(choices).getByRole('link', { name: /Браслети/ }).getAttribute('aria-current')).toBe('page');
  fireEvent.click(within(choices).getByRole('link', { name: /Браслети/ }));
  expect(choices.classList.contains('is-open')).toBe(false);
  expect(screen.getByRole('region', { name: 'Обсяг редагування та перевірки' }).textContent).toContain('увесь пакет правил (2 категорій)');
  expect(api.post).not.toHaveBeenCalled();
});

it('places optional structural preparation after the ordinary field table without hiding package blockers', async () => {
  mount(); const table = await screen.findByRole('table', { name: 'Поля Magento та джерела менеджера' });
  const structure = screen.getByText('Підготувати зміну структури');
  expect(table.compareDocumentPosition(structure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(structure.closest('details').open).toBe(false);
  fireEvent.click(structure);
  expect(screen.getByRole('link', { name: 'Характеристика', exact: true }).href).toContain('intent=attribute');
  expect(screen.getByRole('region', { name: 'Обсяг редагування та перевірки' }).textContent).toContain('увесь пакет правил (2 категорій)');
  expect(api.post).not.toHaveBeenCalled();
});
