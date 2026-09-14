import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HomeDashboard } from '../src/components/app/HomeDashboard.jsx';

afterEach(cleanup);

const categories = {
  BR: { code: 'BR', name: 'Браслети', requires_weight: 1 },
  BN: { code: 'BN', name: 'Намисто', requires_weight: 0 },
};

function renderHome(overrides = {}) {
  const onStart = vi.fn();
  const onDecode = vi.fn();
  const onDecodeInputChange = vi.fn();

  const view = render(
    <HomeDashboard
      config={{ categories }}
      exportStatus={null}
      skuToDecode=""
      decodeData={null}
      decodeError=""
      decodeErrorDetails={null}
      onStart={onStart}
      onDecode={onDecode}
      onDecodeInputChange={onDecodeInputChange}
      {...overrides}
    />,
  );

  return { ...view, onStart, onDecode, onDecodeInputChange };
}

describe('Home workspace', () => {
  it('shows category records in one creation surface with their code, name, and weight requirement', () => {
    const { container, onStart } = renderHome();
    const selectionSurface = container.querySelector('.home-create-panel');
    const options = selectionSurface.querySelectorAll('.home-category-option');

    expect(selectionSurface.querySelector('.home-category-list')).toBeTruthy();
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain('BR');
    expect(options[0].textContent).toContain('Браслети');
    expect(options[0].textContent).toContain('Вага обов’язкова');
    expect(options[1].textContent).toContain('BN');
    expect(options[1].textContent).toContain('Намисто');
    expect(options[1].textContent).toContain('Без ваги');

    fireEvent.click(options[0]);
    fireEvent.click(options[1]);
    expect(onStart).toHaveBeenNthCalledWith(1, 'BR');
    expect(onStart).toHaveBeenNthCalledWith(2, 'BN');
  });

  it('keeps decode and export in one utility surface when category creation is unavailable', () => {
    const { container, onDecode } = renderHome({ canCreateProducts: false });

    expect(container.querySelector('.home-create-panel')).toBeNull();
    expect(container.querySelector('.home-top-workspace.is-decoder-only')).toBeTruthy();
    expect(container.querySelector('.home-side-workspace .home-decode-panel')).toBeTruthy();
    expect(container.querySelector('.home-side-workspace .home-export-panel')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Розшифрувати' }));
    expect(onDecode).toHaveBeenCalledOnce();
  });
});
