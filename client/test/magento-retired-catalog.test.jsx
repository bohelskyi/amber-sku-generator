import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import MagentoPublicationActions from '../src/components/workspace/MagentoPublicationActions.jsx';
import { api } from '../src/lib/api.js';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const revision = { id: 'old-test-draft', revision: '3', state: 'draft' };
const retired = { state: 'retired_targets', publicationBlocked: true, resources: [
  { categoryCode: 'SV', attributeCode: 'test_261005102222', attributeId: '1535', optionId: null },
] };
const permissions = ['export_templates.manage', 'export_templates.publish', 'exports.view'];
const principalLifetime = { id: 'retired-catalog-administrator', valid: true };
const applyLabel = 'Застосувати правила й передати 0 товарів';
const shell = (value, autoPreview = false) => <AuthContext.Provider value={{ permissions, principalLifetime, roles: [{ key: 'administrator' }] }}><MemoryRouter><MagentoPublicationActions revision={value} currentPublishedId="current" autoPreview={autoPreview} onPublished={vi.fn()} /></MemoryRouter></AuthContext.Provider>;
it('shows the exact cleaned resource and a fresh preparation route while preventing automatic or explicit preview', async () => {
  render(shell({ ...revision, catalogAvailability: retired }, true));
  expect(screen.getByText(/test_261005102222/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Підготувати нову зміну від чинної публікації' }).getAttribute('href')).toBe('/admin/magento/prepare');
  await act(async () => {}); expect(api.post).not.toHaveBeenCalled();
});
it('blocks a previously successful zero-blocker preview as soon as recorded cleanup becomes visible', async () => {
  api.post.mockResolvedValue({ data: { previewToken: 'old-proof', totalProducts: 0, affected: [], preservedNames: [], lostProducts: [], lostRoutes: [], checked: [], blockers: [] } });
  const view = render(shell(revision));
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити вплив публікації' }));
  const apply = await screen.findByRole('button', { name: applyLabel });
  expect(apply.disabled).toBe(false);
  view.rerender(shell({ ...revision, catalogAvailability: retired }));
  expect(screen.getByRole('button', { name: applyLabel }).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Перевірити вплив публікації' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: applyLabel }));
  expect(api.post).toHaveBeenCalledOnce();
  expect(api.post.mock.calls[0][0]).toBe('/admin/magento-integration/publication/preview');
});
