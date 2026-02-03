import { useState, useEffect } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';

export default function AdminPanel() {
    const [config, setConfig] = useState(null);
    const [selectedCat, setSelectedCat] = useState(null);
    const [selectedQuestion, setSelectedQuestion] = useState(null);
    const [pricesData, setPricesData] = useState(null);
    const [editCat, setEditCat] = useState({ name: '', requires_weight: true });
    const [editQuestion, setEditQuestion] = useState({ label: '', sku_index: '' });

    // РЎС‚Р°РЅРё С„РѕСЂРј
    const [newCat, setNewCat] = useState({ code: '', name: '', requires_weight: true });
    const [newQuest, setNewQuest] = useState({ key: '', label: '', sku_index: '' });
    const [newOpt, setNewOpt] = useState({ value_id: '', label: '' });
    
    // РќРѕРІС– СЃС‚Р°РЅРё РґР»СЏ С†С–РЅ
    const [newScenario, setNewScenario] = useState({ name: '', match_json: '', axis_x_key: '', axis_y_key: '' });
    const [newModifier, setNewModifier] = useState({ trigger_key: '', trigger_val: '', factor: '' });

    useEffect(() => { fetchConfig(); }, []);
    
    useEffect(() => {
        if (selectedCat) fetchPrices();
        else setPricesData(null);
    }, [selectedCat]);

    const fetchConfig = () => { axios.get('http://localhost:5000/api/config').then(res => setConfig(res.data)); };
    const fetchPrices = () => { axios.get(`http://localhost:5000/api/admin/prices/${selectedCat.code}`).then(res => setPricesData(res.data)); };

    // --- CRUD Р¤РЈРќРљР¦Р†Р‡ ---
    const addCategory = () => {
        if(!newCat.code) return;
        axios.post('http://localhost:5000/api/admin/category', { ...newCat, requires_weight: newCat.requires_weight ? 1 : 0 })
             .then(() => { setNewCat({ code: '', name: '', requires_weight: true }); fetchConfig(); });
    };
    const addQuestion = () => {
        if(!selectedCat) return;
        axios.post('http://localhost:5000/api/admin/question', { ...newQuest, category_code: selectedCat.code })
             .then(() => { setNewQuest({ key: '', label: '', sku_index: '' }); fetchConfig(); });
    };
    const addOption = () => {
        if(!selectedQuestion) return;
        axios.post('http://localhost:5000/api/admin/option', { ...newOpt, question_id: selectedQuestion.q_db_id })
             .then(() => { setNewOpt({ value_id: '', label: '' }); fetchConfig(); });
    };
    const deleteItem = (type, id) => {
        if(!window.confirm("Видалити цей елемент?")) return;
        axios.post('http://localhost:5000/api/admin/delete-item', { type, id })
             .then(() => { 
                 fetchConfig(); 
                 if(type==='category') setSelectedCat(null);
                 if(type==='scenario' || type==='modifier') fetchPrices();
             });
    };
    const updateCategory = () => {
        if (!selectedCat) return;
        axios.put('http://localhost:5000/api/admin/category', { 
            code: selectedCat.code, 
            name: editCat.name, 
            requires_weight: editCat.requires_weight ? 1 : 0 
        })
            .then(() => { fetchConfig(); });
    };

    const updateQuestion = () => {
        if (!selectedQuestion) return;
        axios.put('http://localhost:5000/api/admin/question', { 
            id: selectedQuestion.q_db_id, 
            label: editQuestion.label, 
            sku_index: editQuestion.sku_index 
        })
            .then(() => { fetchConfig(); });
    };

    // --- Р¦Р†РќРћР’Р† Р¤РЈРќРљР¦Р†Р‡ ---
    const handlePriceChange = (scenarioId, xVal, yVal, newPrice) => {
        axios.post('http://localhost:5000/api/admin/price-cell', {
            scenario_id: scenarioId,
            x_val: xVal,
            y_val: yVal,
            price: parseFloat(newPrice)
        });
    };

    const addScenario = () => {
        if(!newScenario.name || !newScenario.match_json || !newScenario.axis_x_key) return alert("Заповніть назву, JSON умови та вісь X");
        
        let parsedJson;
        try {
            parsedJson = JSON.parse(newScenario.match_json); // 1. РџРµСЂРµС‚РІРѕСЂСЋС”РјРѕ С‚РµРєСЃС‚ РЅР° РѕР±'С”РєС‚ С‚СѓС‚
        } catch (e) {
            return alert("Помилка в JSON! Формат: {\"key\": value}");
        }

        axios.post('http://localhost:5000/api/admin/scenario', { 
            ...newScenario, 
            match_json: parsedJson, // 2. Р’С–РґРїСЂР°РІР»СЏС”РјРѕ РІР¶Рµ РѕР±'С”РєС‚, Р° РЅРµ СЂСЏРґРѕРє
            category_code: selectedCat.code 
        })
            .then(() => {
                setNewScenario({ name: '', match_json: '', axis_x_key: '', axis_y_key: '' });
                fetchPrices();
            });
    };

    const addModifier = () => {
        if(!newModifier.trigger_key || !newModifier.factor) return;
        axios.post('http://localhost:5000/api/admin/modifier', { ...newModifier, category_code: selectedCat.code })
            .then(() => {
                setNewModifier({ trigger_key: '', trigger_val: '', factor: '' });
                fetchPrices();
            });
    };

    const updateModifier = (id, newFactor) => {
        axios.put('http://localhost:5000/api/admin/modifier', { id, factor: parseFloat(newFactor) });
    };

    if (!config) return <div className="p-10">Завантаження...</div>;
    const currentCatQuestions = selectedCat ? (config.questions[selectedCat.code] || []) : [];
    const currentOptions = selectedQuestion ? (currentCatQuestions.find(q => q.id === selectedQuestion.id)?.options || []) : [];

    return (
        <div className="min-h-screen bg-gray-100 p-4 font-sans pb-40">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-2xl font-bold text-gray-800">⚙️ Адмін-панель</h1>
                <Link to="/" className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">← Назад до калькулятора</Link>
            </div>

            {/* Р’Р•Р РҐРќРЇ Р§РђРЎРўРРќРђ: РЎРўР РЈРљРўРЈР Рђ */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12 items-start">
                {/* 1. Категорії */}
                <div className="bg-white p-4 rounded shadow flex flex-col">
                    <h2 className="font-bold text-lg mb-4 border-b pb-2">1. Категорії</h2>
                    <div className="h-96 overflow-y-auto space-y-2 pr-2">
                        {Object.values(config.categories).map(cat => (
                            <div key={cat.code} onClick={() => { setSelectedCat(cat); setSelectedQuestion(null); setEditCat({ name: cat.name, requires_weight: cat.requires_weight === 1 }); }} className={`p-3 rounded cursor-pointer flex justify-between items-center border ${selectedCat?.code === cat.code ? 'bg-amber-100 border-amber-500' : 'hover:bg-gray-50'}`}>
                                <div><span className="font-bold">{cat.name}</span><span className="text-xs text-gray-500 block">Code: {cat.code}</span></div>
                                <button onClick={(e) => { e.stopPropagation(); deleteItem('category', cat.code); }} className="text-red-400 px-2">×</button>
                            </div>
                        ))}
                    </div>
                    {selectedCat && (
                        <div className="mt-3 p-2 border rounded bg-white">
                            <div className="text-xs text-gray-500 mb-2">Редагувати категорію: {selectedCat.code}</div>
                            <input className="w-full mb-2 p-1 border rounded" placeholder="Name" value={editCat.name} onChange={e => setEditCat({...editCat, name: e.target.value})} />
                            <label className="flex items-center text-sm"><input type="checkbox" checked={editCat.requires_weight} onChange={e => setEditCat({...editCat, requires_weight: e.target.checked})} className="mr-2"/> Потрібна вага?</label>
                            <button onClick={updateCategory} className="w-full bg-blue-600 text-white py-1 rounded hover:bg-blue-700 mt-2">Зберегти</button>
                        </div>
                    )}
                    <div className="mt-4 pt-4 border-t bg-gray-50 p-2 rounded">
                        <input className="w-full mb-2 p-1 border rounded" placeholder="Code" value={newCat.code} onChange={e => setNewCat({...newCat, code: e.target.value.toUpperCase()})} />
                        <input className="w-full mb-2 p-1 border rounded" placeholder="Name" value={newCat.name} onChange={e => setNewCat({...newCat, name: e.target.value})} />
                        <label className="flex items-center text-sm"><input type="checkbox" checked={newCat.requires_weight} onChange={e => setNewCat({...newCat, requires_weight: e.target.checked})} className="mr-2"/> Потрібна вага?</label>
                        <button onClick={addCategory} className="w-full bg-green-500 text-white py-1 rounded hover:bg-green-600 mt-2">Додати</button>
                    </div>
                </div>

                {/* 2. Питання */}
                <div className="bg-white p-4 rounded shadow flex flex-col">
                    <h2 className="font-bold text-lg mb-4 border-b pb-2">2. Питання</h2>
                    <div className="h-96 overflow-y-auto space-y-2 pr-2">
                        {currentCatQuestions.map(q => (
                            <div key={q.q_db_id} onClick={() => { setSelectedQuestion(q); setEditQuestion({ label: q.label, sku_index: q.sku_index }); }} className={`p-3 rounded cursor-pointer flex justify-between items-center border ${selectedQuestion?.id === q.id ? 'bg-blue-100 border-blue-500' : 'hover:bg-gray-50'}`}>
                                <div><span className="font-bold">{q.label}</span><span className="text-xs text-gray-500 block">Key: {q.id} | Index: {q.sku_index}</span></div>
                                <button onClick={(e) => { e.stopPropagation(); deleteItem('question', q.q_db_id); }} className="text-red-400 px-2">×</button>
                            </div>
                        ))}
                    </div>
                    {selectedQuestion && (
                        <div className="mt-3 p-2 border rounded bg-white">
                            <div className="text-xs text-gray-500 mb-2">Редагувати питання</div>
                            <input className="w-full mb-2 p-1 border rounded" placeholder="Label" value={editQuestion.label} onChange={e => setEditQuestion({...editQuestion, label: e.target.value})}/>
                            <input className="w-full mb-2 p-1 border rounded" type="number" placeholder="Index" value={editQuestion.sku_index} onChange={e => setEditQuestion({...editQuestion, sku_index: e.target.value})}/>
                            <button onClick={updateQuestion} className="w-full bg-blue-600 text-white py-1 rounded hover:bg-blue-700">Зберегти</button>
                        </div>
                    )}
                    {selectedCat && <div className="mt-4 pt-4 border-t bg-gray-50 p-2 rounded"><input className="w-full mb-2 p-1 border rounded" placeholder="Key (size)" value={newQuest.key} onChange={e => setNewQuest({...newQuest, key: e.target.value})}/><input className="w-full mb-2 p-1 border rounded" placeholder="Label" value={newQuest.label} onChange={e => setNewQuest({...newQuest, label: e.target.value})}/><input className="w-full mb-2 p-1 border rounded" type="number" placeholder="Index" value={newQuest.sku_index} onChange={e => setNewQuest({...newQuest, sku_index: e.target.value})}/><button onClick={addQuestion} className="w-full bg-green-500 text-white py-1 rounded hover:bg-green-600">Додати</button></div>}
                </div>

                {/* 3. Варіанти */}
                <div className="bg-white p-4 rounded shadow flex flex-col">
                    <h2 className="font-bold text-lg mb-4 border-b pb-2">3. Варіанти</h2>
                    <div className="h-96 overflow-y-auto space-y-2 pr-2">
                        {currentOptions.map(opt => (
                            <div key={opt.db_id} className="p-2 border rounded flex justify-between bg-gray-50 items-center">
                                <span>{opt.label}</span>
                                <div className="flex items-center gap-2"><span className="bg-gray-200 px-2 rounded text-sm">{opt.id}</span><button onClick={() => deleteItem('option', opt.db_id)} className="text-red-400 font-bold px-2">×</button></div>
                            </div>
                        ))}
                    </div>
                    {selectedQuestion && <div className="mt-4 pt-4 border-t bg-gray-50 p-2 rounded"><input className="w-full mb-2 p-1 border rounded" type="number" placeholder="Value ID" value={newOpt.value_id} onChange={e => setNewOpt({...newOpt, value_id: e.target.value})}/><input className="w-full mb-2 p-1 border rounded" placeholder="Label" value={newOpt.label} onChange={e => setNewOpt({...newOpt, label: e.target.value})}/><button onClick={addOption} className="w-full bg-green-500 text-white py-1 rounded hover:bg-green-600">Додати</button></div>}
                </div>
            </div>

            {/* РќРР–РќРЇ Р§РђРЎРўРРќРђ: Р¦Р†РќР */}
            {selectedCat && pricesData && (
                <div className="bg-white p-6 rounded shadow border-t-4 border-blue-500">
                    <h2 className="text-2xl font-bold mb-6 text-gray-800">💰 Управління цінами ({selectedCat.name})</h2>
                    
                    {/* РЎРџРРЎРћРљ РЎР¦Р•РќРђР Р†Р‡Р’ */}
                    <div className="space-y-10">
                        {pricesData.scenarios.map(scen => {
                            const qX = currentCatQuestions.find(q => q.id === scen.axis_x_key);
                            const qY = currentCatQuestions.find(q => q.id === scen.axis_y_key);
                            const optionsX = qX ? qX.options : [];
                            const optionsY = qY ? qY.options : [{id: 0, label: 'Base'}];

                            return (
                                <div key={scen.id} className="border p-4 rounded bg-gray-50 relative">
                                    <div className="flex justify-between items-center mb-2">
                                        <h3 className="font-bold text-lg text-blue-800">{scen.name}</h3>
                                        <button onClick={() => deleteItem('scenario', scen.id)} className="text-red-500 hover:text-red-700 font-bold px-3 py-1 border border-red-200 rounded bg-white">Видалити сценарій</button>
                                    </div>
                                    <p className="text-xs text-gray-500 mb-4 bg-gray-100 p-1 inline-block rounded">Умова: {scen.match_json}</p>

                                    <div className="overflow-x-auto">
                                        <table className="min-w-full bg-white border">
                                            <thead>
                                                <tr>
                                                    <th className="border p-2 bg-gray-100 text-left min-w-[150px]">{qX?.label || 'X'} \ {qY?.label || 'Y'}</th>
                                                    {optionsY.map(y => <th key={y.id} className="border p-2 bg-gray-100 text-sm">{y.label}</th>)}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {optionsX.map(x => (
                                                    <tr key={x.id}>
                                                        <td className="border p-2 font-bold bg-gray-50 text-sm">{x.label}</td>
                                                        {optionsY.map(y => {
                                                            const cell = scen.matrix.find(m => m.x_val === x.id && m.y_val === y.id);
                                                            return (
                                                                <td key={y.id} className="border p-0">
                                                                    <input 
                                                                        type="number" 
                                                                        min="0" 
                                                                        onKeyDown={(e) => e.key === '-' && e.preventDefault()} // <-- Р‘Р»РѕРєСѓС”РјРѕ РјС–РЅСѓСЃ
                                                                        className="w-full h-full p-2 text-center focus:bg-blue-50 outline-none min-w-[60px]"
                                                                        defaultValue={cell ? cell.price : ''}
                                                                        placeholder="-"
                                                                        onBlur={(e) => {
                                                                            if(e.target.value < 0) e.target.value = 0; // РЎРєРёРґР°С”РјРѕ РІ 0, СЏРєС‰Рѕ СЏРєРѕСЃСЊ РІРІРµР»Рё РјС–РЅСѓСЃ
                                                                            handlePriceChange(scen.id, x.id, y.id, e.target.value);
                                                                        }}
                                                                    />
                                                                </td>
                                                            );
                                                        })}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Р”РћР”РђР’РђРќРќРЇ РќРћР’РћР“Рћ РЎР¦Р•РќРђР Р†Р® */}
                    <div className="mt-8 p-4 border border-dashed border-gray-400 rounded bg-gray-50">
                        <h4 className="font-bold text-gray-700 mb-2">➕ Додати нову таблицю цін (Сценарій)</h4>
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                            <input className="p-2 border rounded" placeholder="Назва (напр. Некалібровані)" value={newScenario.name} onChange={e => setNewScenario({...newScenario, name: e.target.value})} />
                            <input className="p-2 border rounded font-mono text-sm" placeholder='JSON: {"raw_type":1, "is_calibrated":0}' value={newScenario.match_json} onChange={e => setNewScenario({...newScenario, match_json: e.target.value})} />
                            <input className="p-2 border rounded" placeholder="Вісь X Key (напр. size)" value={newScenario.axis_x_key} onChange={e => setNewScenario({...newScenario, axis_x_key: e.target.value})} />
                            <input className="p-2 border rounded" placeholder="Вісь Y Key (напр. processing)" value={newScenario.axis_y_key} onChange={e => setNewScenario({...newScenario, axis_y_key: e.target.value})} />
                        </div>
                        <button onClick={addScenario} className="mt-2 bg-gray-700 text-white px-4 py-2 rounded hover:bg-gray-800">Створити сценарій</button>
                    </div>

                    {/* РњРћР”РР¤Р†РљРђРўРћР Р */}
                    <div className="mt-12 border-t pt-6">
                        <h3 className="font-bold text-lg mb-4">Модифікатори (Знижки / Націнки)</h3>
                        <div className="space-y-2 mb-4">
                            {pricesData.modifiers.map(mod => (
                                <div key={mod.id} className="flex items-center gap-4 p-2 bg-yellow-50 border border-yellow-200 rounded">
                                    <span className="text-sm">Якщо <b>{mod.trigger_key}</b> = {mod.trigger_val}</span>
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm text-gray-600">Множник:</span>
                                        <input 
                                            type="number" 
                                            className="w-20 p-1 border rounded text-center font-bold"
                                            defaultValue={mod.factor}
                                            onBlur={(e) => updateModifier(mod.id, e.target.value)}
                                        />
                                    </div>
                                    <button onClick={() => deleteItem('modifier', mod.id)} className="text-red-500 hover:text-red-700 px-2 font-bold">×</button>
                                </div>
                            ))}
                        </div>
                        
                        <div className="flex gap-2 items-center bg-gray-100 p-2 rounded">
                            <span className="text-sm font-bold">Новий:</span>
                            <input className="w-24 p-1 border rounded" placeholder="Key (quality)" value={newModifier.trigger_key} onChange={e => setNewModifier({...newModifier, trigger_key: e.target.value})} />
                            <input className="w-24 p-1 border rounded" type="number" placeholder="Val (2)" value={newModifier.trigger_val} onChange={e => setNewModifier({...newModifier, trigger_val: e.target.value})} />
                            <input 
                                className="w-24 p-1 border rounded" 
                                type="number" 
                                min="0" 
                                placeholder="Factor (0.7)" 
                                value={newModifier.factor} 
                                onChange={e => {
                                    if(e.target.value >= 0) setNewModifier({...newModifier, factor: e.target.value})
                                }} 
                            />
                            <button onClick={addModifier} className="bg-green-600 text-white px-3 py-1 rounded">Додати</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
