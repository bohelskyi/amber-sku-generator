import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoCategoryActions from '../src/components/workspace/MagentoCategoryActions.jsx';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
afterEach(cleanup);
const path = 'Default/Сувеніри/Нова підкатегорія';
const revision = { id: 'draft', revision: '1', state: 'draft', bindings: { attributes: [
  { bindingKey: 'categories', target: 'categories', evidence: { categories: [{ requestedPath: path, normalizedPath: path }] } },
] } };
const observation = { categories: [{ categoryId: '10', normalizedPath: 'Default/Сувеніри', comparable: true }] };
const shell = (permissions = ['export_templates.manage', 'export_templates.publish']) => render(<AuthContext.Provider value={{ permissions }}><MagentoCategoryActions revision={revision} observation={observation} /></AuthContext.Provider>);
beforeEach(() => { vi.resetAllMocks(); api.get.mockResolvedValue({ data: [] }); });
it('category creation needs explicit preview/apply and remains separate from binding approval', async () => {
  shell(); api.post.mockResolvedValueOnce({ data: { path, parentId: 10, bindingRevisionId: 'draft', expectedRevision: '1', previewToken: 'proof' } });
  fireEvent.click(screen.getByRole('button', { name: /Перевірити створення під/ }));
  const apply = await screen.findByRole('button', { name: 'Створити підкатегорію' });
  expect(api.post).toHaveBeenCalledTimes(1);
  api.post.mockResolvedValueOnce({ data: { id: 'action', kind: 'category', state: 'verified', path, remoteId: '6001', message: 'Створено, зв’язок ще не підтверджено' } });
  fireEvent.click(apply); await screen.findByText(/Створено, зв’язок ще не підтверджено/);
  expect(api.post.mock.calls[1][1].previewToken).toBe('proof');
  expect(api.post.mock.calls.every(([url]) => !url.includes('binding'))).toBe(true);
});
it('uncertain dispatch remains visible after reload and offers no blind Retry or Create', async () => {
  api.get.mockResolvedValue({ data: [{ id: 'action', kind: 'category', state: 'dispatched', path, remoteId: null,
    canReconcile: false, message: 'Надсилання не підтверджено.' }] });
  shell(); await screen.findByText(/Надсилання не підтверджено/);
  expect(screen.queryByRole('button', { name: /створення/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Повтор|Retry|Перевірити результат/ })).toBeNull();
});
it('remote creation is unavailable without both existing permissions', () => {
  shell(['export_templates.manage']);
  expect(screen.queryByRole('button', { name: /створення/ })).toBeNull();
});
