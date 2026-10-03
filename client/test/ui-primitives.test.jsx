import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ActionMenu,
  ConfirmDialog,
  CopyAction,
  Dialog,
  LocalNavigation,
  OperationReceipt,
  Pagination,
  TechnicalDisclosure,
} from '../src/components/ui/index.js';

beforeEach(() => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 10, height: 10 }]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('mounts technical evidence only after the operator opens it', () => {
  const build = vi.fn(() => <p>revision: 42</p>);
  render(<TechnicalDisclosure>{build}</TechnicalDisclosure>);
  expect(build).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Технічні деталі'));
  expect(build).toHaveBeenCalledOnce();
  expect(screen.getByText('revision: 42')).toBeTruthy();
});

it('copies the supplied authoritative value and announces completion', async () => {
  render(<CopyAction value="AG-000042" label="Копіювати артикул" buttonLabel="Копіювати артикул" />);
  fireEvent.click(screen.getByRole('button', { name: 'Копіювати артикул' }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('AG-000042'));
  expect(screen.getByRole('status').textContent).toBe('Скопійовано');
});

it('shows clipboard failure beside an icon-only copy action', async () => {
  navigator.clipboard.writeText.mockRejectedValue(new Error('denied'));
  vi.stubGlobal('document', document);
  document.execCommand = vi.fn(() => { throw new Error('unavailable'); });
  render(<CopyAction value="AG-000042" label="Копіювати артикул" compact />);
  fireEvent.click(screen.getByRole('button', { name: 'Копіювати артикул' }));
  expect(await screen.findByText('Не вдалося скопіювати', { selector: '.ui-copy-feedback' })).toBeTruthy();
});

it('supports keyset continuation without requiring a fabricated total', () => {
  const next = vi.fn();
  render(<Pagination hasNext onNext={next} nextLabel="Показати ще" />);
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Показати ще' }));
  expect(next).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Назад' }).disabled).toBe(true);
});

it('restores focus after a confirmation closes', async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Відкрити</button>
      <ConfirmDialog open={open} title="Підтвердження" onClose={() => setOpen(false)} onConfirm={() => setOpen(false)} />
    </>;
  }
  render(<Harness />);
  const trigger = screen.getByRole('button', { name: 'Відкрити' });
  trigger.focus(); fireEvent.click(trigger);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Скасувати' })));
  fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
  await act(async () => {});
  expect(document.activeElement).toBe(trigger);
});

it('keeps a confirmation closed when its caller omits open', () => {
  render(<ConfirmDialog title="Підтвердження" onClose={vi.fn()} onConfirm={vi.fn()} />);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps the application inert until the final nested overlay closes', async () => {
  const view = render(<><button>Фон</button><Dialog key="parent" title="Батьківське">Вміст</Dialog><Dialog key="child" title="Дочірнє">Деталі</Dialog></>);
  await waitFor(() => expect(view.container.inert).toBe(true));
  expect(document.body.style.overflow).toBe('hidden');
  const dialogs = screen.getAllByRole('dialog');
  expect(dialogs[0].inert).toBe(true);
  expect(dialogs[1].inert).toBe(false);
  view.rerender(<><button>Фон</button><Dialog key="child" title="Дочірнє">Деталі</Dialog></>);
  expect(view.container.inert).toBe(true);
  expect(screen.getByRole('dialog').inert).toBe(false);
  expect(document.body.style.overflow).toBe('hidden');
  view.rerender(<button>Фон</button>);
  await waitFor(() => expect(Boolean(view.container.inert)).toBe(false));
  expect(document.body.style.overflow).toBe('');
});

it('restores focus to a visible fallback if the original control disappeared', async () => {
  const hiddenRef = (element) => { if (element) element.getClientRects = () => []; };
  const view = render(<><button key="primary">Початковий</button><button key="hidden" ref={hiddenRef} style={{ display: 'none' }}>Прихований</button><button key="fallback">Резервний</button></>);
  screen.getByRole('button', { name: 'Початковий' }).focus();
  view.rerender(<><button key="primary">Початковий</button><button key="hidden" ref={hiddenRef} style={{ display: 'none' }}>Прихований</button><button key="fallback">Резервний</button><Dialog key="dialog" title="Перевірка">Вміст</Dialog></>);
  await screen.findByRole('dialog');
  view.rerender(<><button key="hidden" ref={hiddenRef} style={{ display: 'none' }}>Прихований</button><button key="fallback">Резервний</button><Dialog key="dialog" title="Перевірка">Вміст</Dialog></>);
  view.rerender(<><button key="hidden" ref={hiddenRef} style={{ display: 'none' }}>Прихований</button><button key="fallback">Резервний</button></>);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Резервний' })));
});

it('focuses portalled action choices and provides a clear keyboard exit', async () => {
  render(<><ActionMenu label="Дії з товаром"><button type="button">Архівувати</button></ActionMenu><button type="button">Наступна дія</button></>);
  const trigger = screen.getByRole('button', { name: 'Дії з товаром' });
  fireEvent.click(trigger);
  const action = await screen.findByRole('button', { name: 'Архівувати' });
  await waitFor(() => expect(document.activeElement).toBe(action));
  expect(screen.queryByRole('menu')).toBeNull();
  expect(action.parentElement.parentElement).toBe(document.body);
  fireEvent.keyDown(action, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Наступна дія' }));
  expect(screen.queryByRole('button', { name: 'Архівувати' })).toBeNull();
  fireEvent.click(trigger);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Архівувати' })));
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  expect(document.activeElement).toBe(trigger);
});

it('keeps local navigation addressable and marks its exact destination', () => {
  render(<MemoryRouter initialEntries={['/settings']}><LocalNavigation label="Розділи" items={[
    { to: '/settings', label: 'Налаштування' }, { to: '/settings/catalog', label: 'Каталог' },
  ]} /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Налаштування' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('link', { name: 'Каталог' }).getAttribute('aria-current')).toBeNull();
});

it('presents saved identity as a receipt with separate actions', () => {
  render(<OperationReceipt title="Товар збережено" identity="AG-000042"
    actions={<button type="button">Відкрити товар</button>} />);
  expect(screen.getByText('AG-000042')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Відкрити товар' })).toBeTruthy();
});
