import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
    <MemoryRouter>
      <HomeDashboard
        canViewExports
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
      />
    </MemoryRouter>,
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

function RecountStateHarness({ product = blankInclusionProduct, questions = recountQuestions } = {}) {
  const [answers, setAnswers] = useState(getDecodedAnswerMap(product));
  const category = product.category.code;
  const config = {
    categories: { [category]: product.category },
    questions: { [category]: questions },
  };
  const handleAnswer = (questionId, valueId) => {
    const question = questions.find((item) => item.id === questionId);
    setAnswers((previous) => normalizeRecountTargetAnswers(
      questions,
      updateRecountOptionAnswer(previous, question, valueId)
    ));
  };

  return <HomeDashboard
    canCreateProducts={false}
    config={config}
    decodeData={product}
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
    skuToDecode={product.sku}
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
  it('requires explicit processing selection for a missing stored SV answer', () => {
    const product = { ...blankInclusionProduct, decodeSource: 'stored_history', category: { code: 'SV', name: 'Сувеніри', requires_weight: 0 },
      decodedAnswers: [{ key: 'stone_processing', value_id: null, is_placeholder: true, label: 'Який камінь?' }],
      product: { id: 1368, details: { answers: { souvenir: 5 } } } };
    render(<RecountStateHarness product={product} questions={[{ id: 'stone_processing', label: 'Який камінь?', required: 1, include_in_sku: 1,
      options: [{ id: 0, label: 'Не оброблений камінь' }, { id: 1, label: 'Оброблений камінь' }] }]} />);
    const option = screen.getByRole('button', { name: 'Не оброблений камінь' });
    expect(option.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(option);
    expect(option.getAttribute('aria-pressed')).toBe('true');
  });
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
    expect(options[1].textContent).toContain('Вага необов’язкова');

    fireEvent.click(options[0]);
    fireEvent.click(options[1]);
    expect(onStart).toHaveBeenNthCalledWith(1, 'BR');
    expect(onStart).toHaveBeenNthCalledWith(2, 'BN');
  });

  it('keeps exact product lookup as the focused workspace when category creation is unavailable', () => {
    const { container, onDecode } = renderHome({ canCreateProducts: false });

    expect(container.querySelector('.home-create-panel')).toBeNull();
    expect(container.querySelector('.product-landing-grid.is-lookup-only')).toBeTruthy();
    expect(container.querySelector('.product-lookup-panel .home-decode-panel')).toBeTruthy();
    expect(screen.getByText(/старих записів також можна ввести внутрішній SKU/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Відкрити товар' }));
    expect(onDecode).toHaveBeenCalledOnce();
  });

  it('keeps delivery implementation details out of the daily product landing', () => {
    renderHome({ canViewAttention: true, exportStatus: { delivery: { legacyProductCsvEnabled: true, automaticSyncEnabled: false }, hasExport: true, countSinceLastExport: 25,
      totalProducts: 400, exportableProducts: 390,
      lastExport: { createdAt: '2026-09-22T10:00:00.000Z', exportedToProductId: 375 } } });
    expect(screen.getByText('Потребує уваги')).toBeTruthy();
    expect(screen.queryByText('Magento')).toBeNull();
    expect(screen.queryByText(/У базі:/)).toBeNull();
    expect(screen.queryByText(/До експорту:/)).toBeNull();
    expect(screen.queryByText(/375/)).toBeNull();
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


it('recount shows archived assignments as history and keeps a single comma-capable weight field', () => {
  const product = { ...blankInclusionProduct, category: { code: 'SV', name: 'Сувеніри', requires_weight: 1 }, decodedAnswers: [],
    product: { id: 2384, weight: 12.3, details: { answers: { retired: '0012', kind: 0, weight: 12.3 } } } };
  const questions = [{ id: 'retired', label: 'Архівне поле', input_type: 'text', archived: 1 },
    { id: 'kind', label: 'Вид', options: [{ id: 0, label: 'Старий нуль', archived: 1 }, { id: 2, label: 'Активний варіант' }] },
    { id: 'weight', label: 'Вага', input_type: 'text', required: 1, numeric_validation: { kind: 'decimal', min: 0, minInclusive: false, maxFractionDigits: 3 } }];
  const changeWeight = vi.fn();
  const { container } = renderHome({ decodeData: product, config: { categories: { SV: product.category }, questions: { SV: questions } },
    isRecountOpen: true, recountAnswers: product.product.details.answers, recountWeight: '12,3', recountReason: '',
    recountBlockers: [{ questionId: 'weight', message: 'Авторитетна помилка ваги' }], hasRecountChanges: true,
    onRecountWeightChange: changeWeight, onRecountAnswer: vi.fn(), onRecountTextAnswer: vi.fn() });
  const weight = screen.getByRole('textbox', { name: /Вага виробу/ });
  expect(weight.getAttribute('inputmode')).toBe('decimal');
  expect(container.querySelectorAll('#recount-weight')).toHaveLength(1);
  expect(container.querySelector('#recount-retired')).toBeNull();
  expect(screen.getByText('Історичне значення · в архіві')).toBeTruthy();
  expect(screen.getByText(/Старий нуль · історичне значення/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Старий нуль/ })).toBeNull();
  expect(weight.getAttribute('aria-invalid')).toBe('true');
  fireEvent.change(weight, { target: { value: '14,25' } });
  expect(changeWeight).toHaveBeenCalledWith('14,25');
});

it('recount displays both conflicting historical weights and requires an explicit canonical choice', () => {
  const product = { ...blankInclusionProduct, category: { code: 'SV', name: 'Сувеніри', requires_weight: 0 }, decodedAnswers: [],
    product: { id: 2384, weight: '12.3', details: { answers: { weight: '14,2' } } } };
  renderHome({ decodeData: product, config: { categories: { SV: product.category }, questions: { SV: [] } },
    isRecountOpen: true, recountAnswers: product.product.details.answers, recountWeight: '', recountReason: '',
    recountBlockers: [], hasRecountChanges: true, onRecountWeightChange: vi.fn() });
  expect(screen.getByText(/Збережена вага товару: 12.3 г; характеристика: 14,2 г/)).toBeTruthy();
  expect(screen.getByRole('textbox', { name: /Вага виробу/ }).value).toBe('');
  expect(screen.getByRole('button', { name: 'Продовжити' }).disabled).toBe(true);
});


it('SV category uses the authoritative required-weight rule despite its legacy category flag',()=>{
  renderHome({canCreateProducts:true,showCreate:true,config:{categories:{SV:{code:'SV',name:'Сувеніри',requires_weight:0}},productCreateRequirements:{SV:{requiredAnswers:['weight']}}}});
  expect(screen.getByText('Вага обов’язкова')).toBeTruthy();expect(screen.queryByText('Без ваги')).toBeNull();
});
