import { useState, useEffect } from 'react';
import axios from 'axios';

function App() {
  const [config, setConfig] = useState(null);
  const [selectedCat, setSelectedCat] = useState(null);
  const [answers, setAnswers] = useState({});
  const [isCalibrated, setIsCalibrated] = useState(null);
  const [weight, setWeight] = useState('');
  
  const [previewData, setPreviewData] = useState(null); 
  const [history, setHistory] = useState([]);
  const [skuToDelete, setSkuToDelete] = useState('');
  const formatUah = (value) => (value !== null && value !== undefined ? `${value} ₴` : '---');
  const formatUsd = (value) => (Number(value) > 0 ? `$${value}` : '---');
  const [copyMessage, setCopyMessage] = useState('');

  useEffect(() => {
    axios.get('http://localhost:5000/api/config').then(res => setConfig(res.data));
    fetchHistory();
  }, []);

  const fetchHistory = () => { axios.get('http://localhost:5000/api/products').then(res => setHistory(res.data)); };

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
    axios.post('http://localhost:5000/api/preview', payload).then(res => { setPreviewData(res.data); });
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
    axios.post('http://localhost:5000/api/save', payload).then(res => {
        fetchHistory();
        handleStart(null);
    });
  };

  const handleCancel = () => { handleStart(null); };

  const handleDelete = (sku) => {
    if(!sku) return;
    if(!window.confirm(`Видалити ${sku}?`)) return;
    axios.post('http://localhost:5000/api/delete', { skuToDelete: sku })
        .then(res => { alert(res.data.message); setSkuToDelete(''); fetchHistory(); })
        .catch(err => { alert("ПОМИЛКА: " + (err.response?.data?.error || err.message)); });
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

  if (!config) return <div className="p-10">Завантаження...</div>;

  return (
    <div className="min-h-screen bg-gray-100 p-8 font-sans">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-6 text-amber-600">Amber SKU Manager</h1>

        {!selectedCat && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Object.values(config.categories).map(cat => (
              <button 
                key={cat.code}
                onClick={() => handleStart(cat.code)}
                className="p-6 bg-white rounded shadow hover:bg-amber-50 border border-gray-200 text-xl font-semibold transition duration-200"
              >
                {cat.name} <br/> <span className="text-sm text-gray-500">({cat.code})</span>
              </button>
            ))}
          </div>
        )}

        {selectedCat && !previewData && (
          <div className="bg-white p-6 rounded shadow-lg">
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-2xl font-bold">{config.categories[selectedCat].name}</h2>
                <button onClick={() => setSelectedCat(null)} className="text-gray-500 hover:text-red-500">× Скасувати</button>
            </div>
            <div className="space-y-6">
                {config.questions[selectedCat]?.map(q => (
                    <div key={q.id}>
                        <label className="block text-sm font-medium text-gray-700 mb-2">{q.label}</label>
                        <div className="flex flex-wrap gap-2">
                            {q.options.map(opt => (
                                <button key={opt.id} onClick={() => handleAnswer(q.id, opt.id)} className={`px-4 py-2 rounded border transition duration-200 ${answers[q.id] === opt.id ? 'bg-amber-500 text-white border-amber-600' : 'bg-gray-50 hover:bg-gray-100'}`}>
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                        {q.id === 'raw_type' && answers['raw_type'] === 1 && (
                            <div className="mt-4 p-4 bg-blue-50 border border-blue-100 rounded">
                                <label className="block text-sm font-medium text-blue-800 mb-2">{config.extraConfig.is_calibrated.label}</label>
                                <div className="flex gap-2">
                                     {config.extraConfig.is_calibrated.options.map(opt => (
                                         <button key={opt.id} onClick={() => setIsCalibrated(prev => prev === opt.id ? null : opt.id)} className={`px-4 py-2 rounded border ${isCalibrated === opt.id ? 'bg-blue-600 text-white' : 'bg-white'}`}>{opt.label}</button>
                                     ))}
                                </div>
                            </div>
                        )}
                    </div>
                ))}

                {isWeightRequired && (
                    <div className="pt-4 border-t">
                        <label className="block text-sm font-medium text-gray-700 mb-2">Вага виробу (г)</label>
                        <input 
                            type="number" 
                            min="0" // 1. Р”Р»СЏ Р±СЂР°СѓР·РµСЂР°
                            onKeyDown={(e) => e.key === '-' && e.preventDefault()} // 2. Р—Р°Р±РѕСЂРѕРЅР° РЅР°С‚РёСЃРєР°РЅРЅСЏ РєР»Р°РІС–С€С– "-"
                            value={weight}
                            onChange={(e) => {
                                // 3. Р”РѕРґР°С‚РєРѕРІР° РїРµСЂРµРІС–СЂРєР° РїСЂРё РІСЃС‚Р°РІС†С– С‚РµРєСЃС‚Сѓ
                                const val = e.target.value;
                                if (val < 0) return; 
                                setWeight(val);
                            }}
                            className="w-full p-3 border rounded text-lg outline-none ring-2 ring-transparent focus:ring-amber-500" 
                            placeholder="0.00"
                        />
                    </div>
                )}
                <button onClick={handlePreview} className="w-full py-4 bg-blue-600 text-white text-xl font-bold rounded hover:bg-blue-700 shadow">ПЕРЕВІРИТИ АРТИКУЛ</button>
            </div>
          </div>
        )}

        {previewData && (
            <div className="bg-white p-8 rounded shadow-xl border-t-4 border-amber-500">
                <h2 className="text-2xl font-bold text-gray-800 mb-6 text-center">Перевірка Артикулу</h2>
                {previewData.mode === 'sequence' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                        <div className="p-4 bg-gray-100 rounded text-center opacity-75">
                            <p className="text-sm text-gray-500 uppercase font-bold">Останній в базі</p>
                            <div className="text-2xl font-mono text-gray-600 my-2">{previewData.prevFullSku}</div>
                        </div>
                        <div className="p-4 bg-green-50 border-2 border-green-500 rounded text-center transform scale-105 shadow-md">
                            <p className="text-sm text-green-600 uppercase font-bold">Буде створено</p>
                            <div className="text-3xl font-mono font-bold text-green-700 my-2">{previewData.fullProposedSku}</div>
                            <button onClick={() => handleCopyText(previewData.fullProposedSku, 'SKU')} className="mt-2 px-3 py-1 text-sm bg-white border border-green-300 rounded hover:bg-green-100">Копіювати SKU</button>
                            <button onClick={() => previewData.totalPriceUah && handleCopyText(`${previewData.totalPriceUah} ₴`, 'Ціну')} className="mt-2 ml-2 px-3 py-1 text-sm bg-white border border-green-300 rounded hover:bg-green-100">Копіювати ціну</button>
                            <p className="text-xl font-bold text-gray-800">{formatUah(previewData.totalPriceUah)}</p>
                            <p className="text-sm text-gray-600">{formatUsd(previewData.totalPrice)}</p>
                            {previewData.uahRate && <p className="text-xs text-gray-500">1 USD = {previewData.uahRate} ₴</p>}
                        </div>
                    </div>
                ) : (
                    <div className="mb-8">
                        <div className={`p-6 border-2 rounded text-center shadow-md ${previewData.existsInDb ? 'bg-yellow-50 border-yellow-400' : 'bg-green-50 border-green-500'}`}>
                            <p className={`text-sm uppercase font-bold ${previewData.existsInDb ? 'text-yellow-700' : 'text-green-600'}`}>{previewData.existsInDb ? 'УВАГА: ТАКИЙ АРТИКУЛ ВЖЕ ІСНУЄ' : 'НОВИЙ УНІКАЛЬНИЙ АРТИКУЛ'}</p>
                            <div className="text-4xl font-mono font-bold text-gray-800 my-4">{previewData.fullProposedSku}</div>
                            <button onClick={() => handleCopyText(previewData.fullProposedSku, 'SKU')} className="mb-3 px-3 py-1 text-sm bg-white border border-green-300 rounded hover:bg-green-100">Копіювати SKU</button>
                            <button onClick={() => previewData.totalPriceUah && handleCopyText(`${previewData.totalPriceUah} ₴`, 'Ціну')} className="mb-3 ml-2 px-3 py-1 text-sm bg-white border border-green-300 rounded hover:bg-green-100">Копіювати ціну</button>
                            <p className="text-2xl font-bold text-gray-800">{formatUah(previewData.totalPriceUah)}</p>
                            <p className="text-sm text-gray-600">{formatUsd(previewData.totalPrice)}</p>
                            {previewData.uahRate && <p className="text-xs text-gray-500">1 USD = {previewData.uahRate} ₴</p>}
                        </div>
                    </div>
                )}
                {copyMessage && <div className="text-center mb-4 text-sm text-green-700">{copyMessage}</div>}
                {parseFloat(previewData.pricePerGram) > 0 && (
                    <div className="text-center mb-8 text-gray-600">
                        <p>Ціна за грам: <strong>{formatUah(previewData.pricePerGramUah)}</strong> <span className="text-sm">({formatUsd(previewData.pricePerGram)})</span></p>
                    </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                    <button onClick={handleCancel} className="py-4 bg-gray-200 text-gray-800 font-bold rounded hover:bg-gray-300">ВІДМІНИТИ</button>
                    <button onClick={handleSave} className="py-4 bg-green-600 text-white font-bold rounded hover:bg-green-700">ЗБЕРЕГТИ</button>
                </div>
            </div>
        )}
        {!selectedCat && (
            <div className="mt-12 p-6 bg-red-50 border border-red-200 rounded">
                <h3 className="text-lg font-bold text-red-700 mb-2">Коригування помилок</h3>
                <div className="flex gap-4">
                    <input type="text" value={skuToDelete} onChange={(e) => setSkuToDelete(e.target.value)} placeholder="Введіть повний артикул..." className="flex-1 p-3 border rounded"/>
                    <button onClick={() => handleDelete(skuToDelete)} className="px-6 bg-red-600 text-white font-bold rounded hover:bg-red-700">ВИДАЛИТИ</button>
                </div>
            </div>
        )}
        <div className="mt-8">
            <h3 className="text-xl font-bold mb-4">Останні збережені</h3>
            <div className="bg-white shadow overflow-hidden rounded-md">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Артикул</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Кат.</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Вага</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Дія</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {history.map(item => (
                            <tr key={item.id}>
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-mono font-bold text-gray-800">{item.full_sku}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{config.categories[item.category]?.name}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{item.weight > 0 ? `${item.weight}г` : '-'}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm">
                                    {!selectedCat && <button onClick={() => handleDelete(item.full_sku)} className="text-red-500 font-bold text-xs border border-red-200 px-2 py-1 rounded">Видалити</button>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
      </div>
    </div>
  );
}
export default App;
