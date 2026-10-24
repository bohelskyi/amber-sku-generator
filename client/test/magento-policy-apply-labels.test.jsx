import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoPublicationActions from '../src/components/workspace/MagentoPublicationActions.jsx';
import MagentoWorkspaceReview from '../src/components/workspace/MagentoWorkspaceReview.jsx';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../src/lib/magento-policy-labels.js', async (importOriginal) => ({
  ...await importOriginal(),
  ruleApplyLabels: Object.freeze({ apply: 'Спільна дія застосування', applying: 'Спільна дія виконується…' }),
}));

afterEach(() => { cleanup(); vi.resetAllMocks(); });
const revision = { id: 'draft', revision: '3', state: 'draft', bindings: { attributes: [] }, schema: { attributes: [], attributeSets: [] } };

it('uses the shared apply and busy labels with the same explicit preview proof and one publication request', async () => {
  const permissions = ['export_templates.manage', 'export_templates.publish', 'exports.view'];
  const proof = { previewToken: 'exact-reviewed-proof', totalProducts: 1, affected: [], lostRoutes: [], lostProducts: [], preservedNames: [], checked: [], blockers: [] };
  let finishApply;
  api.post.mockResolvedValueOnce({ data: proof }).mockImplementationOnce(() => new Promise((resolve) => { finishApply = resolve; }));
  const published = vi.fn();
  render(<AuthContext.Provider value={{ permissions }}><MemoryRouter>
    <MagentoPublicationActions revision={revision} currentPublishedId="current" onPublished={published} />
  </MemoryRouter></AuthContext.Provider>);
  expect(screen.queryByRole('button', { name: 'Спільна дія застосування' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити вплив публікації' }));
  const apply = await screen.findByRole('button', { name: 'Спільна дія застосування' });
  expect(apply.disabled).toBe(false);
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/publication/preview', {
    bindingRevisionId: 'draft', expectedRevision: '3', expectedCurrentId: 'current', representatives: [],
  });
  fireEvent.click(apply);
  const busy = screen.getByRole('button', { name: 'Спільна дія виконується…' });
  expect(busy.disabled).toBe(true); fireEvent.click(busy);
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(api.post.mock.calls[1]).toEqual(['/admin/magento-integration/publication/apply', {
    bindingRevisionId: 'draft', expectedRevision: '3', expectedCurrentId: 'current', representatives: [], previewToken: 'exact-reviewed-proof',
  }]);
  expect(published).not.toHaveBeenCalled();
  await act(async () => finishApply({ data: { revision: { id: 'published' } } }));
  expect(published).toHaveBeenCalledExactlyOnceWith({ id: 'published' });
});

it.each([false, true])('names the shared publication action in category review guidance (ready=%s)', async (ready) => {
  const entry = { id: 'category:BR:all', group: 'BR', target: 'categories', kind: 'category', row: 'base',
    label: 'Розділ магазину', identity: '1', reviewState: ready ? 'approved' : 'review_required', exact: false, candidates: [] };
  api.get.mockResolvedValue({ data: { revision, entries: [entry], validation: { diagnostics: [] } } });
  render(<MagentoWorkspaceReview revision={revision} categoryCode="BR" questions={[]} selections={{}} focusTarget="categories" onChanged={vi.fn()} />);
  const help = await screen.findByText(ready
    ? 'Розділи підтверджено. Наступний крок — перевірка впливу на товари у блоці нижче, а потім «Спільна дія застосування».'
    : 'Перевірте шлях у колонці Magento й натисніть «Підтвердити». Після підтвердження всіх відповідностей з’явиться кнопка «Спільна дія застосування».');
  expect(help).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});
