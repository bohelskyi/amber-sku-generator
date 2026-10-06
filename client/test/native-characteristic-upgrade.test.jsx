import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import AttentionProblemDetail from '../src/components/attention/AttentionProblemDetail.jsx';
import { nextAction } from '../src/components/attention/sync-problem-presentation.js';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('an upgrade code without the precise server configuration classification keeps product repair', () => {
  expect(nextAction({ diagnosticCode: 'NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED', resolution: 'product' })).toBe('Доповнити дані товару');
});

for (const [category, question] of [['NM', 'extra'], ['AR', 'size']]) {
  it(`${category} old-contract handoff opens reviewed configuration with exact product context without a mutation`, () => {
    const problem = { code: 'PRODUCT_EVALUATION_NOT_READY', diagnosticCode: 'NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED',
      resolution: 'integration_configuration', question, message: 'Потрібно підготувати підтримку нових товарів.',
      evaluationIssues: [{ code: 'SOURCE_SUPPORT_INVALID', field: 'sourceSupport',
        message: `${category}.${question}: native characteristics require a reviewed evaluator 5 template and binding successor` }] };
    render(<AuthContext.Provider value={{ permissions: ['export_templates.view'] }}><MemoryRouter>
      <AttentionProblemDetail product={{ productId: 42, article: 'AG-000123', category, problems: [problem] }}
        returnTo="/attention?problem=42" />
    </MemoryRouter></AuthContext.Provider>);
    const link = new URL(screen.getByRole('link', { name: 'Підготувати підтримку нових товарів' }).href);
    expect(link.pathname).toBe(`/admin/magento/categories/${category}`);
    expect(link.searchParams.get('productId')).toBe('42');
    expect(link.searchParams.get('question')).toBe(question);
    expect(link.searchParams.get('returnTo')).toBe('/attention?problem=42');
    expect(screen.getByText(problem.message)).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });
}
