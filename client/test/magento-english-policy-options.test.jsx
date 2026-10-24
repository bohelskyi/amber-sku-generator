import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import { deliveryPolicies } from '../src/lib/magento-category-workspace.js';
import MagentoWorkspaceReview from '../src/components/workspace/MagentoWorkspaceReview.jsx';
import MagentoBindingReview from '../src/components/workspace/MagentoBindingReview.jsx';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const revision = { id: 'draft', state: 'draft', revision: '7', templateId: 'family', templateVersionId: 'version',
  schema: { attributes: [], attributeSets: [] }, bindings: { attributes: [] } };
const policyEntry = (overrides = {}) => ({ id: 'policy:exact-binding:en', kind: 'policy', group: 'SV', routeKey: 'SV:all',
  row: 'english', label: 'en', target: 'meta_title', identity: 'magento_managed', reviewState: 'review_required', exact: false, evidence: {}, ...overrides });
const review = (entries, current = revision) => ({ revision: current, entries, validation: { valid: false, diagnostics: [] } });
const confirmName = (mode) => mode === 'primary' ? 'Підтвердити' : 'Підтвердити зв’язок';
const reasonText = 'Перевірено правило англійського поля';
beforeEach(() => { vi.resetAllMocks(); api.post.mockResolvedValue({ data: { ...revision, revision: '8' } }); });
afterEach(cleanup);

async function show(mode, entries, props = {}, permissions = ['export_templates.manage']) {
  api.get.mockResolvedValue({ data: review(entries, props.loadedRevision || revision) });
  const changed = vi.fn();
  render(mode === 'primary'
    ? <MagentoWorkspaceReview revision={revision} categoryCode="SV" questions={[]} selections={{}} onChanged={changed} {...props} />
    : <AuthContext.Provider value={{ permissions }}><MemoryRouter><MagentoBindingReview revision={revision} mode="review" onChanged={changed} {...props} /></MemoryRouter></AuthContext.Provider>);
  if (mode === 'primary') await screen.findByRole('region', { name: 'Перевірка підготовлених відповідностей' });
  await waitFor(() => expect(screen.queryByText(mode === 'primary' ? 'Оновлюємо підтвердження…' : 'Читаємо відповідності…')).toBeNull());
  return changed;
}

async function showApproved(mode) {
  if (mode === 'primary') {
    fireEvent.click(screen.getByText('Поведінка передавання полів').closest('summary'));
    fireEvent.click(await screen.findByRole('button', { name: 'Змінити поведінку підключених полів' }));
  } else fireEvent.click(screen.getByRole('button', { name: 'Показати всі відповідності' }));
}

for (const mode of ['primary', 'advanced']) {
  it.each(['magento_managed', 'initialize_create_only'])(`${mode}: requires an explicit supported EN content choice instead of silently replacing saved %s`, async (identity) => {
    const entry = policyEntry({ identity }); const changed = await show(mode, [entry]);
    const select = screen.getByRole('combobox');
    expect(Array.from(select.options, (option) => option.value)).toEqual(['', 'authoritative_create_update']);
    expect(within(select).getByRole('option', { name: 'Оновлюється з менеджера' })).toBeTruthy();
    expect(select.value).toBe('');
    expect(screen.getByText(`Збережене правило: ${deliveryPolicies[identity]}`)).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: reasonText } });
    const confirm = screen.getByRole('button', { name: confirmName(mode) });
    expect(confirm.disabled).toBe(true); fireEvent.click(confirm); expect(api.post).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: 'authoritative_create_update' } });
    expect(confirm.disabled).toBe(false); fireEvent.click(confirm);
    await waitFor(() => expect(changed).toHaveBeenCalledWith({ ...revision, revision: '8' }));
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/bindings/draft/decision', {
      expectedRevision: '7', binding: entry.id, action: 'approve', acceptReview: true, reason: reasonText, policy: 'authoritative_create_update',
    });
  });

  it.each(['sku', 'product_type', 'attribute_set_code', 'store_view_code'])(`${mode}: explicitly confirms the saved managed bootstrap policy for EN control %s`, async (target) => {
    const entry = policyEntry({ target }); const changed = await show(mode, [entry]);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText(`Збережене правило: ${deliveryPolicies.magento_managed}`)).toBeTruthy();
    expect(screen.getByText(/Системне поле EN/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: confirmName(mode) });
    expect(confirm.disabled).toBe(true); expect(api.post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: 'x' } });
    expect(confirm.disabled).toBe(mode === 'primary');
    fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: reasonText } });
    expect(api.post).not.toHaveBeenCalled(); fireEvent.click(confirm);
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/bindings/draft/decision', {
      expectedRevision: '7', binding: entry.id, action: 'approve', acceptReview: true, reason: reasonText, policy: 'magento_managed',
    });
  });

  it.each(['authoritative_create_update', 'initialize_create_only', 'blocked', 'future_policy', null])(`${mode}: refuses a wrong saved EN system policy %s without pretending it is managed`, async (identity) => {
    await show(mode, [policyEntry({ target: 'sku', identity })]);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText(`Збережене правило: ${Object.hasOwn(deliveryPolicies, identity) ? deliveryPolicies[identity] : identity || 'Не визначено'}`)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: reasonText } });
    const confirm = screen.getByRole('button', { name: confirmName(mode) });
    expect(confirm.disabled).toBe(true); fireEvent.click(confirm); expect(api.post).not.toHaveBeenCalled();
  });

  it.each(['all', 'EN', 'custom', undefined])(`${mode}: refuses EN policy approval with unverified store scope %s`, async (label) => {
    await show(mode, [policyEntry({ label, identity: 'authoritative_create_update' })]);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText(/Мову або область цього правила не підтверджено/)).toBeTruthy();
    if (mode === 'primary') {
      expect(screen.getAllByRole('cell')[0].textContent).toContain(' · EN');
      expect(screen.getAllByRole('cell')[0].textContent).not.toContain(' · UA');
    }
    fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: reasonText } });
    const confirm = screen.getByRole('button', { name: confirmName(mode) });
    expect(confirm.disabled).toBe(true); fireEvent.click(confirm); expect(api.post).not.toHaveBeenCalled();
  });

  it.each(['all', 'custom_store', 'en'])(`${mode}: preserves all UA choices and the base-only create value even for store label %s`, async (label) => {
    const entry = policyEntry({ id: `policy:exact-binding:${label}`, row: 'base', label, target: 'product_online', identity: 'initialize_create_only' });
    const changed = await show(mode, [entry]); const select = screen.getByRole('combobox');
    expect(Array.from(select.options, (option) => option.value)).toEqual(['', 'authoritative_create_update', 'initialize_create_only', 'magento_managed']);
    expect(select.value).toBe(mode === 'primary' ? '' : 'initialize_create_only');
    fireEvent.change(select, { target: { value: 'initialize_create_only' } });
    fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: reasonText } });
    fireEvent.click(screen.getByRole('button', { name: confirmName(mode) }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/bindings/draft/decision', {
      expectedRevision: '7', binding: entry.id, action: 'approve', acceptReview: true, reason: reasonText,
      policy: 'initialize_create_only', createValue: '2',
    });
  });

  it.each(['product_online', 'qty', 'product_websites'])(`${mode}: does not expand the EN identity-control exception to %s`, async (target) => {
    await show(mode, [policyEntry({ target })]);
    const select = screen.getByRole('combobox');
    expect(Array.from(select.options, (option) => option.value)).toEqual(['', 'authoritative_create_update']);
    expect(select.value).toBe(''); expect(api.post).not.toHaveBeenCalled();
  });

  it.each([undefined, 'unrecognized'])(`${mode}: keeps a policy with unknown row %s unavailable`, async (row) => {
    await show(mode, [policyEntry({ row, identity: 'authoritative_create_update' })]);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText(/Мову або область цього правила не підтверджено/)).toBeTruthy();
    if (mode === 'primary') {
      expect(screen.getAllByRole('cell')[0].textContent).toContain('Мову не визначено');
      expect(screen.getAllByRole('cell')[0].textContent).not.toMatch(/ · (UA|EN)/);
    }
    fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: reasonText } });
    expect(screen.getByRole('button', { name: confirmName(mode) }).disabled).toBe(true);
    expect(api.post).not.toHaveBeenCalled();
  });

  it(`${mode}: preserves its initial choice for a saved supported EN policy without an automatic command`, async () => {
    await show(mode, [policyEntry({ identity: 'authoritative_create_update' })]);
    const select = screen.getByRole('combobox');
    expect(select.value).toBe(mode === 'primary' ? '' : 'authoritative_create_update');
    expect(screen.getByText('Збережене правило: Оновлюється з менеджера')).toBeTruthy();
    expect(screen.getByRole('button', { name: confirmName(mode) }).disabled).toBe(true);
    expect(api.post).not.toHaveBeenCalled();
  });

  it(`${mode}: explains why a saved managed control in an unknown review state cannot be confirmed`, async () => {
    await show(mode, [policyEntry({ target: 'sku', reviewState: 'future_state' })]);
    expect(screen.getByText(/Підтвердження для цього стану недоступне/)).toBeTruthy();
    expect(screen.queryByText(/Збережене правило ще потрібно підтвердити/)).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: reasonText } });
    expect(screen.getByRole('button', { name: confirmName(mode) }).disabled).toBe(true);
    expect(api.post).not.toHaveBeenCalled();
  });

  it(`${mode}: shows an approved saved EN control without a no-op approval`, async () => {
    await show(mode, [policyEntry({ target: 'sku', reviewState: 'approved' })]);
    await showApproved(mode);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText(`Збережене правило: ${deliveryPolicies.magento_managed}`)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: reasonText } });
    const confirm = screen.getByRole('button', { name: confirmName(mode) });
    expect(confirm.disabled).toBe(true); fireEvent.click(confirm); expect(api.post).not.toHaveBeenCalled();
  });

  it(`${mode}: shows an approved unsupported EN content policy separately from the empty replacement`, async () => {
    await show(mode, [policyEntry({ reviewState: 'approved', identity: 'initialize_create_only' })]);
    await showApproved(mode);
    expect(screen.getByRole('combobox').value).toBe('');
    expect(screen.getByText(`Збережене правило: ${deliveryPolicies.initialize_create_only}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: confirmName(mode) }).disabled).toBe(true);
    expect(api.post).not.toHaveBeenCalled();
  });
}

it('preserves the primary caller-disabled boundary for EN bootstrap confirmations', async () => {
  await show('primary', [policyEntry({ target: 'sku' })], { disabled: true });
  expect(screen.getByLabelText('Пояснення перевірки').disabled).toBe(true);
  const confirm = screen.getByRole('button', { name: 'Підтвердити' });
  expect(confirm.disabled).toBe(true); fireEvent.click(confirm); expect(api.post).not.toHaveBeenCalled();
});

it('does not offer EN approval to an advanced-review viewer without manage permission', async () => {
  await show('advanced', [policyEntry({ target: 'sku' })], {}, ['export_templates.view']);
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Підтвердити зв’язок' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('does not restrict advanced nonpolicy EN identity approval', async () => {
  const entry = { ...policyEntry({ target: 'sku' }), id: 'attribute:exact-binding', kind: 'attribute', identity: 'sku', label: 'sku', reviewState: 'proposed', exact: true };
  const changed = await show('advanced', [entry]);
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити зв’язок' }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/bindings/draft/decision', {
    expectedRevision: '7', binding: entry.id, action: 'approve', acceptReview: true,
  });
});

it('keeps the existing explicit block-with-reason action for an unsupported EN system policy', async () => {
  const entry = policyEntry({ target: 'sku', identity: 'initialize_create_only' });
  const changed = await show('advanced', [entry]);
  fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: reasonText } });
  fireEvent.click(screen.getByRole('button', { name: 'Відмовити з поясненням' }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/bindings/draft/decision', {
    expectedRevision: '7', binding: entry.id, action: 'block', reason: reasonText,
  });
});

it('does not invite confirmation for a not-applicable managed control in the advanced full list', async () => {
  await show('advanced', [policyEntry({ target: 'sku', reviewState: 'not_applicable' })]);
  await showApproved('advanced');
  expect(screen.getByText('Не застосовується')).toBeTruthy();
  expect(screen.getByText(/Підтвердження для цього стану недоступне/)).toBeTruthy();
  expect(screen.queryByText(/Збережене правило ще потрібно підтвердити/)).toBeNull();
  fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: reasonText } });
  expect(screen.getByRole('button', { name: 'Підтвердити зв’язок' }).disabled).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});

it('keeps the primary exact batch separate from policy confirmation and retains the exact nonpolicy payload', async () => {
  const attribute = { ...policyEntry({ target: 'sku' }), id: 'attribute:exact-binding', kind: 'attribute', identity: 'sku', label: 'sku', reviewState: 'proposed', exact: true };
  const changed = await show('primary', [attribute, policyEntry({ target: 'sku' })]);
  fireEvent.click(screen.getByText('Однозначні підказки').closest('summary'));
  fireEvent.click(await screen.findByRole('button', { name: 'Прийняти однозначні підказки на цій сторінці' }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/bindings/draft/decision', {
    expectedRevision: '7', binding: attribute.id, action: 'approve', acceptReview: true,
  });
});

it.each(['primary', 'advanced'])('%s: keeps one explicit EN decision in flight and does not retry a rejected CAS', async (mode) => {
  let reject; api.post.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  await show(mode, [policyEntry({ target: 'sku' })]);
  fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: reasonText } });
  const confirm = screen.getByRole('button', { name: confirmName(mode) }); fireEvent.click(confirm);
  expect(confirm.disabled).toBe(true); fireEvent.click(confirm); expect(api.post).toHaveBeenCalledTimes(1);
  await act(async () => reject({ response: { status: 409, data: { error: 'Чернетка змінилася на сервері' } } }));
  expect(screen.getByText('Чернетка змінилася на сервері')).toBeTruthy();
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('does not send a primary EN decision against a different loaded revision', async () => {
  await show('primary', [policyEntry({ target: 'sku' })], { loadedRevision: { ...revision, revision: '8' } });
  fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: reasonText } });
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити' }));
  expect(screen.getByText('Чернетка змінилася. Перечитайте збережену підготовку перед підтвердженням.')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});
