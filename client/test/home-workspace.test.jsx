import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HomeDashboard } from '../src/components/app/HomeDashboard.jsx';
import {
  getDecodedAnswerMap,
  normalizeRecountTargetAnswers,
  updateRecountOptionAnswer,
} from '../src/lib/product-recount.js';

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

const recountQuestions = [
  {
    id: 'quality',
    label: 'Якість',
    required: 1,
    options: [
      { id: 1, label: 'Перший сорт' },
      { id: 2, label: 'Другий сорт' },
    ],
  },
  {
    id: 'addit',
    label: 'Інклюз',
    required: 0,
    include_in_sku: 1,
    options: [{ id: 1, label: 'Є інклюз' }],
  },
];

const blankInclusionProduct = {
  existsInDb: true,
  sku: 'KL11221310016',
  category: { code: 'KL', name: 'Кулони', requires_weight: 0 },
  decodedAnswers: [
    { key: 'quality', value_id: 1, value_label: 'Перший сорт' },
    {
      key: 'addit',
      value_id: null,
      value_label: 'Не обрано',
      is_placeholder: true,
    },
  ],
  product: { id: 2384, details: { answers: { quality: 1 } } },
  pricing: { totalPriceUah: 1000 },
  suffix: { type: 'sequence', value: 16 },
};

function RecountStateHarness() {
  const [answers, setAnswers] = useState(getDecodedAnswerMap(blankInclusionProduct));
  const config = {
    categories: { KL: blankInclusionProduct.category },
    questions: { KL: recountQuestions },
  };
  const handleAnswer = (questionId, valueId) => {
    const question = recountQuestions.find((item) => item.id === questionId);
    setAnswers((previous) => normalizeRecountTargetAnswers(
      recountQuestions,
      updateRecountOptionAnswer(previous, question, valueId)
    ));
  };

  return <HomeDashboard
    canCreateProducts={false}
    config={config}
    decodeData={blankInclusionProduct}
    decodeError=""
    decodeErrorDetails={null}
    exportStatus={null}
    hasRecountChanges
    isRecountApplying={false}
    isRecountLoading={false}
    isRecountOpen
    isRecountPreviewCurrent={false}
    isRecountPreviewUnavailable={false}
    recountAnswers={answers}
    recountBlockers={[]}
    recountError=""
    recountPreview={null}
    recountReason=""
    recountSuccess=""
    recountValidationAttempt={0}
    recountWeight=""
    skuToDecode={blankInclusionProduct.sku}
    onApplyRecount={vi.fn()}
    onCancelRecount={vi.fn()}
    onDecode={vi.fn()}
    onDecodeInputChange={vi.fn()}
    onRecountAnswer={handleAnswer}
    onRecountReasonChange={vi.fn()}
    onRecountTextAnswer={vi.fn()}
    onRecountWeightChange={vi.fn()}
    onStart={vi.fn()}
    onStartRecount={vi.fn()}
  />;
}

describe('Home workspace', () => {
  it('shows category records in one creation surface with their code, name, and weight requirement', () => {
    const { container, onStart } = renderHome();
    const selectionSurface = container.querySelector('.home-create-panel');
    const options = selectionSurface.querySelectorAll('.home-category-option');
    const categoryList = selectionSurface.querySelector('.home-category-list');

    expect(categoryList).toBeTruthy();
    expect(categoryList.classList.contains('grid')).toBe(true);
    expect(categoryList.classList.contains('sm:grid-cols-2')).toBe(true);
    expect(categoryList.classList.contains('xl:grid-cols-3')).toBe(true);
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

  it('keeps Інклюз visibly unselected after an unrelated recount edit', () => {
    render(<RecountStateHarness />);

    const inclusionGroup = screen.getByRole('group', { name: 'Інклюз' });
    expect(inclusionGroup.querySelector('[aria-pressed="true"]').textContent).toBe('Не обрано');

    fireEvent.click(screen.getByRole('button', { name: 'Другий сорт' }));

    expect(inclusionGroup.querySelector('[aria-pressed="true"]').textContent).toBe('Не обрано');
    expect(screen.getByRole('button', { name: 'Є інклюз' }).getAttribute('aria-pressed')).toBe('false');
  });
});
