import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import RestoreReviewHandoff from '../src/components/app/RestoreReviewHandoff.jsx';
import { restoreReviewLinks, restoreReviewReport } from '../src/lib/restore-review-report.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const blocked = { inputSku: 'OLD/1', article: 'OLD/1', productId: 9, status: 'archived', category: 'KL', disposition: 'conflict', reasonCode: 'PRODUCT_ARCHIVE_PROOF_MISSING', priorRoute: null, priorExclusion: null, confirmedMagentoId: null, reviewNonce: 'secret-nonce', fingerprint: 'secret-fingerprint' };

it('reports exact blocked facts, explicit unknowns and no approval evidence or sensitive fields', () => {
  const report = restoreReviewReport([blocked, { ...blocked, disposition: 'found', article: 'ELIGIBLE' }]);
  expect(report).toContain('Попередній маршрут: Не зафіксовано');
  expect(report).toContain('Підтверджений Magento ID: Не підтверджено');
  expect(report).toContain('Товар №: 9');
  expect(report).not.toMatch(/secret-|ELIGIBLE/);
  expect(restoreReviewReport([{ ...blocked, priorExclusion: 0 }])).toContain('Попереднє виключення з експорту: 0');
});

it('offers exact encoded product/history links and only clipboard handoff', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<RestoreReviewHandoff items={[blocked]} />);
  expect(screen.getByText('Відкрити товар у новій вкладці').getAttribute('href')).toBe('/products/open?article=OLD%2F1');
  expect(screen.getByText('Історія цього артикулу у новій вкладці').getAttribute('href')).toBe('/products/history?sku=OLD%2F1');
  expect(screen.getAllByRole('button')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button'));
  await screen.findByText('Звіт скопійовано.');
  expect(writeText).toHaveBeenCalledWith(restoreReviewReport([blocked]));
});

it('opens evidence in a new tab while keeping the dirty review and making no API calls', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<><textarea aria-label="Перевірений список" defaultValue={'OLD/1\nOLD/2'} /><RestoreReviewHandoff items={[blocked]} /></>);
  for (const link of screen.getAllByRole('link')) {
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    fireEvent.click(link);
  }
  expect(screen.getByRole('textbox').value).toBe('OLD/1\nOLD/2');
  expect(screen.getByRole('region', { name: 'Передавання відновлення на перевірку' })).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it('does not invent links for unresolved ownership and gives a manual fallback on copy failure', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  expect(restoreReviewLinks({ ...blocked, productId: null })).toBeNull();
  render(<RestoreReviewHandoff items={[{ ...blocked, productId: null, article: null }]} />);
  expect(screen.queryByRole('link')).toBeNull();
  fireEvent.click(screen.getByRole('button'));
  await screen.findByText(/Не вдалося скопіювати/);
  expect(screen.getByText('Факти та текст звіту')).toBeTruthy();
});

it('renders no handoff when no item is blocked', () => {
  const { container } = render(<RestoreReviewHandoff items={[{ ...blocked, disposition: 'found' }]} />);
  expect(container.textContent).toBe('');
});

it('keeps a seventy-item handoff closed by default without omitting report facts or links', () => {
  const items = Array.from({ length: 70 }, (_, index) => ({ ...blocked, inputSku: `OLD/${index + 1}`, article: `OLD/${index + 1}`, productId: index + 1 }));
  render(<RestoreReviewHandoff items={items} />);
  const summary = screen.getByText('Переглянути товари для Адміністратора (70)');
  expect(summary.closest('details').open).toBe(false);
  expect(screen.getByRole('button', { name: 'Скопіювати звіт для Адміністратора' })).toBeTruthy();
  const report = restoreReviewReport(items);
  expect(report.match(/Введений артикул:/g)).toHaveLength(70);
  for (const item of items) expect(report).toContain(`Артикул товару: ${item.article}\n`);
  const links = summary.closest('details').querySelectorAll('a');
  expect(links).toHaveLength(140);
  expect(links[139].getAttribute('href')).toBe('/products/history?sku=OLD%2F70');
  for (const link of links) {
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  }
});
