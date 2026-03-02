import { useState, useEffect } from 'react';
import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
});

function App() {
  const [config, setConfig] = useState(null);
  const [selectedCat, setSelectedCat] = useState(null);
  const [answers, setAnswers] = useState({});
  const [isCalibrated, setIsCalibrated] = useState(null);
  const [weight, setWeight] = useState('');

  const [previewData, setPreviewData] = useState(null);
  const [history, setHistory] = useState([]);
  const [skuToDelete, setSkuToDelete] = useState('');
  const [skuToDecode, setSkuToDecode] = useState('');
  const [decodeData, setDecodeData] = useState(null);
  const [decodeError, setDecodeError] = useState('');
  const formatUah = (value) => (value !== null && value !== undefined ? `${value} ₴` : '---');
  const formatUsd = (value) => (Number(value) > 0 ? `$${value}` : '---');
  const [copyMessage, setCopyMessage] = useState('');
  const handleNumberWheel = (event) => {
    if (document.activeElement === event.currentTarget) {
      event.currentTarget.blur();
    }
  };
  const handleNumberKeyDown = (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
    }
  };
  const questionsForSelected = selectedCat && config ? (config.questions?.[selectedCat] || []) : [];
  const requiredCount = questionsForSelected.filter(q => q.required === 1).length;
  const answeredRequiredCount = questionsForSelected.filter(q => q.required === 1 && answers[q.id] !== undefined).length;
  const progressPercent = selectedCat ? (requiredCount === 0 ? 100 : Math.round((answeredRequiredCount / requiredCount) * 100)) : 0;

  useEffect(() => {
    api.get('/config').then(res => setConfig(res.data));
    fetchHistory();
  }, []);

  const fetchHistory = () => { api.get('/products').then(res => setHistory(res.data)); };

  const handleStart = (catCode) => {
    setSelectedCat(catCode);
    setAnswers({});
    setIsCalibrated(null);
    setPreviewData(null);
    setWeight('');
  };

  const handleAnswer = (qId, valId) => {
    const selectedValue = parseInt(valId);
    if (answers[qId] === selectedValue) {
      const newAnswers = { ...answers };
      delete newAnswers[qId];
      setAnswers(newAnswers);
    } else {
      const newAnswers = { ...answers, [qId]: selectedValue };
      setAnswers(newAnswers);
      if (qId === 'raw_type' && selectedValue === 2) setIsCalibrated(null);
    }
  };

  // --- РћРЎРќРћР’РќРђ Р—РњР†РќРђ РўРЈРў ---
  // Р‘РµСЂРµРјРѕ РЅР°Р»Р°С€С‚СѓРІР°РЅРЅСЏ РїСЂСЏРјРѕ Р· РєР°С‚РµгРѕСЂС–С—
  const categoryConfig = selectedCat && config ? config.categories[selectedCat] : null;
  const isWeightRequired = categoryConfig ? (categoryConfig.requires_weight === 1) : true;

  const handlePreview = () => {
    if (isWeightRequired && !weight) return alert("Введіть вагу!");
    if (parseFloat(weight) < 0) return alert("Вага не може бути від'ємною!");
    const requiredQuestions = config?.questions?.[selectedCat] || [];
    const missingRequired = requiredQuestions
      .filter(q => q.required === 1)
      .filter(q => answers[q.id] === undefined);
    if (missingRequired.length > 0) {
      return alert(`Будь ласка, заповніть обов'язкові питання: ${missingRequired.map(q => q.label).join(', ')}`);
    }
    const payload = {
      categoryCode: selectedCat,
      answers,
      weight: isWeightRequired ? weight : 0,
      isCalibrated: isCalibrated === null ? 0 : isCalibrated
    };
    api.post('/preview', payload).then(res => { setPreviewData(res.data); });
  };

  const handleSave = () => {
    if (!previewData) return;
    const payload = {
      fullSku: previewData.fullProposedSku,
      baseSku: previewData.baseSku,
      nextSeq: previewData.nextSeq,
      category: selectedCat,
      weight: isWeightRequired ? weight : 0,
      totalPrice: previewData.totalPrice,
      pricePerGram: previewData.pricePerGram,
      details: { answers, isCalibrated, logMessage: previewData.logMessage }
    };
    api.post('/save', payload).then(res => {
      fetchHistory();
      handleStart(null);
    });
  };

  const handleCancel = () => { handleStart(null); };

  const handleDelete = (sku) => {
    if(!sku) return;
    if(!window.confirm(`Видалити ${sku}?`)) return;
    api.post('/delete', { skuToDelete: sku })
      .then(res => { alert(res.data.message); setSkuToDelete(''); fetchHistory(); })
      .catch(err => { alert("ПОМИЛКА: " + (err.response?.data?.error || err.message)); });
  };

  const handleDecode = (skuValue = skuToDecode) => {
    const normalizedSku = skuValue.trim().toUpperCase();
    if (!normalizedSku) {
      setDecodeData(null);
      setDecodeError('Введіть артикул для розшифровки.');
      return;
    }

    api.post('/decode', { sku: normalizedSku })
      .then((res) => {
        setSkuToDecode(normalizedSku);
        setDecodeData(res.data);
        setDecodeError('');
      })
      .catch((err) => {
        setDecodeData(null);
        setDecodeError(err.response?.data?.error || err.message);
      });
  };

  const handleDecodeInputChange = (value) => {
    setSkuToDecode(value.toUpperCase());
    setDecodeData(null);
    setDecodeError('');
  };

  const formatDecodedSuffix = (suffix) => {
    if (!suffix || suffix.type === 'none') return 'Без фінального суфікса';
    if (suffix.type === 'weight') return suffix.value !== null ? `${suffix.value} г` : suffix.raw;
    if (suffix.type === 'sequence') return suffix.raw || String(suffix.value || '');
    return suffix.raw || '---';
  };

  const handleCopyText = async (text, label) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage(`${label} скопійовано`);
      setTimeout(() => setCopyMessage(''), 1500);
    } catch (err) {
      setCopyMessage('Не вдалося скопіювати');
      setTimeout(() => setCopyMessage(''), 1500);
    }
  };

  if (!config) return (
    <div className="min-h-screen app-bg flex items-center justify-center">
      <div className="card p-8 text-center">
        <div className="text-lg font-semibold text-slate-700">Завантаження...</div>
        <div className="mt-2 text-sm text-slate-500">Підтягуємо конфігурацію та історію.</div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen app-bg">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-8">
        <header className="card-hero p-6 sm:p-8 fade-up">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="eyebrow">Amber Studio</p>
              <h1 className="page-title">Amber SKU Manager</h1>
              <p className="mt-2 text-sm sm:text-base text-slate-600 max-w-2xl">
                Створюйте артикули, перевіряйте унікальність і тримайте історію під рукою —
                усе в одному робочому просторі.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="chip">
                  {selectedCat ? `Категорія: ${config.categories[selectedCat]?.name}` : 'Оберіть категорію'}
                </span>
                <span className="chip">Історія: {history.length}</span>
              </div>
            </div>
            <div className="stat-tile max-w-xs">
              <div className="stat-label">Категорій</div>
              <div className="stat-value">{Object.keys(config.categories).length}</div>
            </div>
          </div>
        </header>

        {copyMessage && (
          <div className="toast">{copyMessage}</div>
        )}

        {!selectedCat && (
          <div className="grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
            <section className="card p-6 sm:p-8 fade-up stagger-1">
              <div className="section-title mb-6">
                <div>
                  <h2 className="section-title-text">Категорії виробів</h2>
                  <p className="section-subtitle">Оберіть групу для старту розрахунку артикула.</p>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {Object.values(config.categories).map(cat => (
                  <button
                    key={cat.code}
                    onClick={() => handleStart(cat.code)}
                    className="category-card"
                  >
                    <div className="text-xs uppercase tracking-[0.28em] text-slate-500">{cat.code}</div>
                    <div className="mt-2 text-lg font-semibold text-slate-900">{cat.name}</div>
                    <div className="mt-3 text-xs text-slate-500">
                      {cat.requires_weight === 1 ? 'Потрібна вага' : 'Вага не потрібна'}
                    </div>
                  </button>
                ))}
              </div>
            </section>
            <div className="space-y-6 fade-up stagger-2">
              <div className="card p-6 sm:p-8">
                <p className="eyebrow">Процес</p>
                <h3 className="section-title-text">3 кроки до артикула</h3>
                <div className="mt-5 space-y-4">
                  <div className="step-line">
                    <div className="step-dot">1</div>
                    <div>
                      <div className="text-sm font-semibold text-slate-800">Оберіть категорію</div>
                      <div className="text-xs text-slate-500">Система підставить потрібні параметри.</div>
                    </div>
                  </div>
                  <div className="step-line">
                    <div className="step-dot">2</div>
                    <div>
                      <div className="text-sm font-semibold text-slate-800">Заповніть характеристики</div>
                      <div className="text-xs text-slate-500">Опції автоматично формують SKU.</div>
                    </div>
                  </div>
                  <div className="step-line">
                    <div className="step-dot">3</div>
                    <div>
                      <div className="text-sm font-semibold text-slate-800">Перевірте та збережіть</div>
                      <div className="text-xs text-slate-500">Порівняння з базою і готова ціна.</div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="card p-6 sm:p-8">
                <p className="eyebrow">Decoder</p>
                <h3 className="section-title-text">Розшифрувати артикул</h3>
                <p className="section-subtitle mt-2">
                  Введіть готовий SKU, щоб побачити категорію та вибрані характеристики.
                </p>
                <div className="mt-5 flex flex-col gap-3">
                  <input
                    type="text"
                    value={skuToDecode}
                    onChange={(e) => handleDecodeInputChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleDecode();
                    }}
                    placeholder="Наприклад, BN123456001"
                    className="input"
                  />
                  <button onClick={() => handleDecode()} className="btn btn-primary">
                    Розшифрувати
                  </button>
                </div>

                {decodeError && (
                  <div className="danger-panel p-4 mt-4 text-sm">
                    {decodeError}
                  </div>
                )}

                {decodeData && (
                  <div className="info-panel mt-4 p-4 space-y-4">
                    <div className="flex flex-wrap gap-2">
                      <span className="chip">{decodeData.category.code}</span>
                      <span className="chip">{decodeData.category.name}</span>
                      <span className="chip">
                        {decodeData.existsInDb ? 'Є в базі' : 'Не знайдено в базі'}
                      </span>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 text-sm text-slate-700">
                      <div>
                        <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Базовий SKU</div>
                        <div className="mt-1 font-mono font-semibold text-slate-900">{decodeData.baseSku}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-[0.2em] text-slate-500">
                          {decodeData.suffix.type === 'weight' ? 'Вага' : decodeData.suffix.type === 'sequence' ? 'Порядковий номер' : 'Суфікс'}
                        </div>
                        <div className="mt-1 font-semibold text-slate-900">{formatDecodedSuffix(decodeData.suffix)}</div>
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white/80">
                      {decodeData.decodedAnswers.map((item) => (
                        <div key={item.key} className="flex items-start justify-between gap-3 px-4 py-3 border-b border-slate-200 last:border-b-0">
                          <div className="text-sm font-medium text-slate-700">{item.label}</div>
                          <div className="text-sm text-right text-slate-900">
                            {item.value_label}
                            {item.value_id !== null && (
                              <span className="block text-xs font-mono text-slate-500">{item.value_id}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {selectedCat && !previewData && (
          <div className="grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
            <section className="card p-6 sm:p-8 fade-up">
              <div className="section-title mb-6">
                <div>
                  <p className="eyebrow">Крок 1</p>
                  <h2 className="section-title-text">{config.categories[selectedCat].name}</h2>
                  <p className="section-subtitle">Заповніть параметри виробу для генерації артикула.</p>
                </div>
                <button onClick={() => setSelectedCat(null)} className="btn btn-ghost">Скасувати</button>
              </div>

              <div className="space-y-6">
                {config.questions[selectedCat]?.map(q => (
                  <div key={q.id} className="rounded-2xl border border-slate-200 bg-white/80 p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <label className="text-sm font-semibold text-slate-700">{q.label}</label>
                      {q.required === 1 && <span className="chip">Обов'язкове</span>}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {q.options.map(opt => (
                        <button
                          key={opt.id}
                          onClick={() => handleAnswer(q.id, opt.id)}
                          className={`option-pill ${answers[q.id] === opt.id ? 'option-pill-active' : 'option-pill-idle'}`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    {q.id === 'raw_type' && answers['raw_type'] === 1 && (
                      <div className="info-panel mt-4 p-4">
                        <label className="block text-sm font-semibold text-slate-800 mb-3">{config.extraConfig.is_calibrated.label}</label>
                        <div className="flex flex-wrap gap-2">
                          {config.extraConfig.is_calibrated.options.map(opt => (
                            <button
                              key={opt.id}
                              onClick={() => setIsCalibrated(prev => prev === opt.id ? null : opt.id)}
                              className={`option-pill ${isCalibrated === opt.id ? 'option-pill-active' : 'option-pill-idle'}`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {isWeightRequired && (
                  <div className="rounded-2xl border border-slate-200 bg-white/80 p-5">
                    <label className="block text-sm font-semibold text-slate-700">Вага виробу (г)</label>
                    <input
                      type="number"
                      min="0" // 1. Р”Р»СЏ Р±СЂР°СѓР·РµСЂР°
                    onKeyDown={(e) => {
                      if (e.key === '-') e.preventDefault();
                      handleNumberKeyDown(e);
                    }} // 2. Р—Р°Р±РѕСЂРѕРЅР° РЅР°С‚РёСЃРєР°РЅРЅСЏ РєР»Р°РІС–С€С– "-"
                    onWheel={handleNumberWheel}
                      value={weight}
                      onChange={(e) => {
                        // 3. Р”РѕРґР°С‚РєРѕРІР° РїСЂРµРІС–СЂРєР° РїСЂРё РІСЃС‚Р°РІС†С– С‚РµРєСЃС‚Сѓ
                        const val = e.target.value;
                        if (val < 0) return;
                        setWeight(val);
                      }}
                      className="input mt-3"
                      placeholder="0.00"
                    />
                    <p className="mt-2 text-xs text-slate-500">Введіть фактичну вагу виробу в грамах.</p>
                  </div>
                )}

                <button onClick={handlePreview} className="btn btn-primary w-full py-4 text-base sm:text-lg">
                  Перевірити артикул
                </button>
              </div>
            </section>
            <aside className="space-y-6 fade-up stagger-1">
              <div className="card p-6 sm:p-8">
                <p className="eyebrow">Підсумок</p>
                <h3 className="section-title-text">{config.categories[selectedCat].name}</h3>
                <div className="mt-4 space-y-3 text-sm text-slate-600">
                  <div className="flex items-center justify-between">
                    <span>Обов'язкові</span>
                    <span className="font-semibold text-slate-800">{answeredRequiredCount}/{requiredCount}</span>
                  </div>
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Готовність</span>
                    <span className="font-semibold text-slate-800">{progressPercent}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Вага</span>
                    <span className="font-semibold text-slate-800">
                      {isWeightRequired ? (weight ? `${weight} г` : 'Потрібна') : 'Не потрібна'}
                    </span>
                  </div>
                </div>
              </div>
              <div className="card p-6 sm:p-8">
                <p className="eyebrow">Порада</p>
                <h3 className="section-title-text">Працюйте швидко</h3>
                <p className="section-subtitle mt-2">
                  Натисніть опцію ще раз, щоб зняти вибір. Це дозволяє швидко змінювати параметри.
                </p>
              </div>
            </aside>
          </div>
        )}

        {previewData && (
          <section className="card p-6 sm:p-8 border-t-4 border-[rgba(221,151,74,0.7)] fade-up">
            <div className="section-title mb-6">
              <div>
                <p className="eyebrow">Крок 2</p>
                <h2 className="section-title-text">Перевірка артикула</h2>
                <p className="section-subtitle">Порівняння з базою та розрахунок ціни.</p>
              </div>
            </div>

            {previewData.mode === 'sequence' ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
                <div className="stat-card opacity-80">
                  <p className="text-xs uppercase tracking-[0.28em] text-slate-500 font-semibold">Останній в базі</p>
                  <div className="text-2xl font-mono text-slate-600 my-3">{previewData.prevFullSku}</div>
                </div>
                <div className="stat-card stat-card-hero">
                  <p className="text-xs uppercase tracking-[0.28em] text-slate-800 font-semibold">Буде створено</p>
                  <div className="text-3xl font-mono font-bold text-slate-900 my-3">{previewData.fullProposedSku}</div>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <button onClick={() => handleCopyText(previewData.fullProposedSku, 'SKU')} className="btn btn-outline text-xs px-3 py-1.5">Копіювати SKU</button>
                    <button onClick={() => previewData.totalPriceUah && handleCopyText(`${previewData.totalPriceUah} ₴`, 'Ціну')} className="btn btn-outline text-xs px-3 py-1.5">Копіювати ціну</button>
                  </div>
                  <p className="mt-4 text-2xl font-semibold text-slate-800">{formatUah(previewData.totalPriceUah)}</p>
                  <p className="text-sm text-slate-600">{formatUsd(previewData.totalPrice)}</p>
                  {previewData.uahRate && <p className="text-xs text-slate-500">1 USD = {previewData.uahRate} ₴</p>}
                </div>
              </div>
            ) : (
              <div className="mb-8">
                <div className={`stat-card ${previewData.existsInDb ? 'border-[rgba(221,151,74,0.7)] bg-[rgba(221,151,74,0.16)]' : 'border-[rgba(20,32,59,0.35)] bg-[rgba(20,32,59,0.06)]'}`}>
                  <p className={`text-xs uppercase tracking-[0.28em] font-semibold ${previewData.existsInDb ? 'text-[#8a5f2b]' : 'text-slate-800'}`}>
                    {previewData.existsInDb ? 'УВАГА: ТАКИЙ АРТИКУЛ ВЖЕ ІСНУЄ' : 'НОВИЙ УНІКАЛЬНИЙ АРТИКУЛ'}
                  </p>
                  <div className="text-4xl font-mono font-bold text-slate-800 my-4">{previewData.fullProposedSku}</div>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <button onClick={() => handleCopyText(previewData.fullProposedSku, 'SKU')} className="btn btn-outline text-xs px-3 py-1.5">Копіювати SKU</button>
                    <button onClick={() => previewData.totalPriceUah && handleCopyText(`${previewData.totalPriceUah} ₴`, 'Ціну')} className="btn btn-outline text-xs px-3 py-1.5">Копіювати ціну</button>
                  </div>
                  <p className="mt-4 text-2xl font-semibold text-slate-800">{formatUah(previewData.totalPriceUah)}</p>
                  <p className="text-sm text-slate-600">{formatUsd(previewData.totalPrice)}</p>
                  {previewData.uahRate && <p className="text-xs text-slate-500">1 USD = {previewData.uahRate} ₴</p>}
                </div>
              </div>
            )}

            {parseFloat(previewData.pricePerGram) > 0 && (
              <div className="text-center mb-8 text-slate-600">
                <p>Ціна за грам: <strong>{formatUah(previewData.pricePerGramUah)}</strong> <span className="text-sm">({formatUsd(previewData.pricePerGram)})</span></p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button onClick={handleCancel} className="btn btn-outline py-3">Відмінити</button>
              <button onClick={handleSave} className="btn btn-amber py-3">Зберегти</button>
            </div>
          </section>
        )}

        <section className="card p-6 sm:p-8 fade-up">
          <div className="section-title mb-4">
            <div>
              <h3 className="section-title-text">Останні збережені</h3>
              <p className="section-subtitle">Швидкий доступ до останніх 15 записів.</p>
            </div>
          </div>
          <div className="table-wrap">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="table-head">
                  <tr>
                    <th className="table-cell text-left">Артикул</th>
                    <th className="table-cell text-left">Категорія</th>
                    <th className="table-cell text-left">Вага</th>
                    <th className="table-cell text-left">Ціна</th>
                    <th className="table-cell text-left">Дія</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {history.map(item => (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td className="table-cell whitespace-nowrap text-sm font-mono font-semibold text-slate-800">{item.full_sku}</td>
                      <td className="table-cell whitespace-nowrap text-sm text-slate-500">{config.categories[item.category]?.name}</td>
                      <td className="table-cell whitespace-nowrap text-sm text-slate-500">{item.weight > 0 ? `${item.weight}г` : '-'}</td>
                      <td className="table-cell whitespace-nowrap text-sm text-slate-500">{item.total_price ? `$${item.total_price}` : '-'}</td>
                      <td className="table-cell whitespace-nowrap text-sm">
                        {!selectedCat && (
                          <div className="flex flex-wrap gap-2">
                            <button onClick={() => handleCopyText(item.full_sku, 'SKU')} className="btn btn-outline text-xs px-2 py-1">Копіювати SKU</button>
                            <button onClick={() => handleDecode(item.full_sku)} className="btn btn-outline text-xs px-2 py-1">Розшифрувати</button>
                            <button onClick={() => item.total_price && handleCopyText(`$${item.total_price}`, 'Ціну')} className="btn btn-outline text-xs px-2 py-1">Копіювати ціну</button>
                            <button onClick={() => handleDelete(item.full_sku)} className="btn btn-danger text-xs px-2 py-1">Видалити</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {!selectedCat && (
          <section className="fade-up stagger-2">
            <details className="collapsible">
              <summary className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="eyebrow">Додаткові дії</p>
                  <h3 className="collapse-title">Коригування помилок</h3>
                  <p className="section-subtitle">Видалення помилково збереженого артикула.</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="collapse-toggle collapse-toggle-closed">Показати</span>
                  <span className="collapse-toggle collapse-toggle-open">Сховати</span>
                </div>
              </summary>
              <div className="mt-4 flex flex-col sm:flex-row gap-3">
                <input
                  type="text"
                  value={skuToDelete}
                  onChange={(e) => setSkuToDelete(e.target.value)}
                  placeholder="Введіть повний артикул..."
                  className="input"
                />
                <button onClick={() => handleDelete(skuToDelete)} className="btn btn-danger px-6">Видалити</button>
              </div>
            </details>
          </section>
        )}
      </div>
    </div>
  );
}

export default App;
