import { useState, useEffect } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';

export default function AdminPanel() {
    const [config, setConfig] = useState(null);
    const [selectedCat, setSelectedCat] = useState(null);
    const [selectedQuestion, setSelectedQuestion] = useState(null);
    const [pricesData, setPricesData] = useState(null);
    const [editCat, setEditCat] = useState({ name: '', requires_weight: true });
    const [editQuestion, setEditQuestion] = useState({ label: '', sku_index: '', required: true });

    // РЎС‚Р°РЅРё С„РѕСЂРј
    const [newCat, setNewCat] = useState({ code: '', name: '', requires_weight: true });
    const [newQuest, setNewQuest] = useState({ key: '', label: '', sku_index: '', required: true });
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
        axios.post('http://localhost:5000/api/admin/question', { ...newQuest, required: newQuest.required ? 1 : 0, category_code: selectedCat.code })
             .then(() => { setNewQuest({ key: '', label: '', sku_index: '', required: true }); fetchConfig(); });
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
        axios.post('http://localhost:5000/api/admin/question/update', {
            id: selectedQuestion.q_db_id,
            label: editQuestion.label,
            sku_index: editQuestion.sku_index,
            required: editQuestion.required ? 1 : 0
        })
            .then(() => {
                fetchConfig();
                alert('Збережено');
            })
            .catch(err => {
                alert(`Помилка збереження: ${err.response?.data?.error || err.message}`);
            });
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

    if (!config) return (
        <div className="min-h-screen app-bg flex items-center justify-center">
            <div className="card p-8 text-center">
                <div className="text-lg font-semibold text-slate-700">Завантаження...</div>
                <div className="mt-2 text-sm text-slate-500">Збираємо конфігурацію та цінові сценарії.</div>
            </div>
        </div>
    );
    const currentCatQuestions = selectedCat ? (config.questions[selectedCat.code] || []) : [];
    const currentOptions = selectedQuestion ? (currentCatQuestions.find(q => q.id === selectedQuestion.id)?.options || []) : [];

    const validationIssues = [];
    if (config && config.categories && config.questions) {
        Object.values(config.categories).forEach(cat => {
            const questions = config.questions[cat.code] || [];
            const keySet = new Set();
            const indexSet = new Set();
            questions.forEach(q => {
                if (!q.label || q.label.trim().length === 0) {
                    validationIssues.push(`Категорія ${cat.code}: питання ${q.id} без назви`);
                }
                if (keySet.has(q.id)) {
                    validationIssues.push(`Категорія ${cat.code}: дубль key ${q.id}`);
                }
                keySet.add(q.id);
                if (indexSet.has(q.sku_index)) {
                    validationIssues.push(`Категорія ${cat.code}: дубль індексу ${q.sku_index}`);
                }
                indexSet.add(q.sku_index);
                if (!q.options || q.options.length === 0) {
                    validationIssues.push(`Категорія ${cat.code}: питання ${q.id} без варіантів`);
                }
            });
        });
    }

    return (
        <div className="min-h-screen app-bg">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12 pb-28 space-y-8">
                <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <p className="eyebrow">Admin Workspace</p>
                        <h1 className="page-title">Адмін-панель</h1>
                        <p className="mt-2 text-sm sm:text-base text-slate-600 max-w-2xl">
                            Керуйте структурою категорій, питаннями та прайсами в одному місці.
                        </p>
                    </div>
                    <Link to="/" className="btn btn-primary">Назад до калькулятора</Link>
                </header>

                {validationIssues.length > 0 && (
                    <div className="danger-panel p-5">
                        <div className="font-semibold text-rose-700 mb-2">Авто-валідатор виявив проблеми</div>
                        <ul className="list-disc pl-5 text-sm text-rose-700">
                            {validationIssues.map((issue, idx) => (
                                <li key={idx}>{issue}</li>
                            ))}
                        </ul>
                    </div>
                )}

                {/* Р’Р•Р РҐРќРЇ Р§РђРЎРўРРќРђ: РЎРўР РЈРљРўРЈР Рђ */}
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
                    {/* 1. Категорії */}
                    <div className="card p-5 sm:p-6 flex flex-col">
                        <div className="section-title mb-4">
                            <h2 className="section-title-text">1. Категорії</h2>
                        </div>
                        <div className="h-96 overflow-y-auto space-y-2 pr-2">
                            {Object.values(config.categories).map(cat => (
                                <div
                                    key={cat.code}
                                    onClick={() => { setSelectedCat(cat); setSelectedQuestion(null); setEditCat({ name: cat.name, requires_weight: cat.requires_weight === 1 }); }}
                                    className={`p-3 rounded-xl cursor-pointer flex justify-between items-center border transition ${selectedCat?.code === cat.code ? 'bg-amber-100 border-amber-400' : 'border-slate-200 hover:bg-slate-50'}`}
                                >
                                    <div>
                                        <span className="font-semibold text-slate-800">{cat.name}</span>
                                        <span className="text-xs text-slate-500 block">Code: {cat.code}</span>
                                    </div>
                                    <button onClick={(e) => { e.stopPropagation(); deleteItem('category', cat.code); }} className="text-rose-400 hover:text-rose-600 px-2">×</button>
                                </div>
                            ))}
                        </div>
                        {selectedCat && (
                            <div className="mt-4 p-3 border border-slate-200 rounded-xl bg-white/80">
                                <div className="text-xs text-slate-500 mb-2">Редагувати категорію: {selectedCat.code}</div>
                                <input className="input-sm mb-2" placeholder="Name" value={editCat.name} onChange={e => setEditCat({...editCat, name: e.target.value})} />
                                <label className="flex items-center text-sm"><input type="checkbox" checked={editCat.requires_weight} onChange={e => setEditCat({...editCat, requires_weight: e.target.checked})} className="mr-2"/> Потрібна вага?</label>
                                <button onClick={updateCategory} className="btn btn-primary w-full mt-3">Зберегти</button>
                            </div>
                        )}
                        <div className="mt-4 pt-4 border-t border-slate-200 bg-slate-50/70 p-3 rounded-xl">
                            <input className="input-sm mb-2" placeholder="Code" value={newCat.code} onChange={e => setNewCat({...newCat, code: e.target.value.toUpperCase()})} />
                            <input className="input-sm mb-2" placeholder="Name" value={newCat.name} onChange={e => setNewCat({...newCat, name: e.target.value})} />
                            <label className="flex items-center text-sm"><input type="checkbox" checked={newCat.requires_weight} onChange={e => setNewCat({...newCat, requires_weight: e.target.checked})} className="mr-2"/> Потрібна вага?</label>
                            <button onClick={addCategory} className="btn btn-amber w-full mt-3">Додати</button>
                        </div>
                    </div>

                    {/* 2. Питання */}
                    <div className="card p-5 sm:p-6 flex flex-col">
                        <div className="section-title mb-4">
                            <h2 className="section-title-text">2. Питання</h2>
                        </div>
                        <div className="h-96 overflow-y-auto space-y-2 pr-2">
                            {currentCatQuestions.map(q => (
                                <div
                                    key={q.q_db_id}
                                    onClick={() => { setSelectedQuestion(q); setEditQuestion({ label: q.label, sku_index: q.sku_index, required: q.required === 1 }); }}
                                    className={`p-3 rounded-xl cursor-pointer flex justify-between items-center border transition ${selectedQuestion?.id === q.id ? 'bg-sky-100 border-sky-400' : 'border-slate-200 hover:bg-slate-50'}`}
                                >
                                    <div>
                                        <span className="font-semibold text-slate-800">{q.label}</span>
                                        <span className="text-xs text-slate-500 block">Key: {q.id} | Index: {q.sku_index} | {q.required === 1 ? 'Обовʼязкове' : 'Необовʼязкове'}</span>
                                    </div>
                                    <button onClick={(e) => { e.stopPropagation(); deleteItem('question', q.q_db_id); }} className="text-rose-400 hover:text-rose-600 px-2">×</button>
                                </div>
                            ))}
                        </div>
                        {selectedQuestion && (
                            <div className="mt-4 p-3 border border-slate-200 rounded-xl bg-white/80">
                                <div className="text-xs text-slate-500 mb-2">Редагувати питання</div>
                                <input className="input-sm mb-2" placeholder="Label" value={editQuestion.label} onChange={e => setEditQuestion({...editQuestion, label: e.target.value})}/>
                                <input className="input-sm mb-2" type="number" placeholder="Index" value={editQuestion.sku_index} onChange={e => setEditQuestion({...editQuestion, sku_index: e.target.value})}/>
                                <label className="flex items-center text-sm mb-2"><input type="checkbox" checked={editQuestion.required} onChange={e => setEditQuestion({...editQuestion, required: e.target.checked})} className="mr-2"/> Обовʼязкове</label>
                                <button onClick={updateQuestion} className="btn btn-primary w-full">Зберегти</button>
                            </div>
                        )}
                        {selectedCat && (
                            <div className="mt-4 pt-4 border-t border-slate-200 bg-slate-50/70 p-3 rounded-xl">
                                <input className="input-sm mb-2" placeholder="Key (size)" value={newQuest.key} onChange={e => setNewQuest({...newQuest, key: e.target.value})}/>
                                <input className="input-sm mb-2" placeholder="Label" value={newQuest.label} onChange={e => setNewQuest({...newQuest, label: e.target.value})}/>
                                <input className="input-sm mb-2" type="number" placeholder="Index" value={newQuest.sku_index} onChange={e => setNewQuest({...newQuest, sku_index: e.target.value})}/>
                                <label className="flex items-center text-sm mb-2"><input type="checkbox" checked={newQuest.required} onChange={e => setNewQuest({...newQuest, required: e.target.checked})} className="mr-2"/> Обовʼязкове</label>
                                <button onClick={addQuestion} className="btn btn-amber w-full">Додати</button>
                            </div>
                        )}
                    </div>

                    {/* 3. Варіанти */}
                    <div className="card p-5 sm:p-6 flex flex-col">
                        <div className="section-title mb-4">
                            <h2 className="section-title-text">3. Варіанти</h2>
                        </div>
                        <div className="h-96 overflow-y-auto space-y-2 pr-2">
                            {currentOptions.map(opt => (
                                <div key={opt.db_id} className="p-2 border border-slate-200 rounded-xl flex justify-between bg-white/80 items-center">
                                    <span className="text-sm text-slate-700">{opt.label}</span>
                                    <div className="flex items-center gap-2">
                                        <span className="bg-slate-100 px-2 rounded text-xs text-slate-600">{opt.id}</span>
                                        <button onClick={() => deleteItem('option', opt.db_id)} className="text-rose-400 hover:text-rose-600 font-bold px-2">×</button>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {selectedQuestion && (
                            <div className="mt-4 pt-4 border-t border-slate-200 bg-slate-50/70 p-3 rounded-xl">
                                <input className="input-sm mb-2" type="number" placeholder="Value ID" value={newOpt.value_id} onChange={e => setNewOpt({...newOpt, value_id: e.target.value})}/>
                                <input className="input-sm mb-2" placeholder="Label" value={newOpt.label} onChange={e => setNewOpt({...newOpt, label: e.target.value})}/>
                                <button onClick={addOption} className="btn btn-amber w-full">Додати</button>
                            </div>
                        )}
                    </div>
                </div>

                {/* РќРР–РќРЇ Р§РђРЎРўРРќРђ: Р¦Р†РќР */}
                {selectedCat && pricesData && (
                    <div className="card p-6 sm:p-8 border-t-4 border-sky-400">
                        <div className="section-title mb-6">
                            <div>
                                <p className="eyebrow">Ціни</p>
                                <h2 className="section-title-text">Управління цінами ({selectedCat.name})</h2>
                            </div>
                        </div>

                        {/* РЎРџРРЎРћРљ РЎР¦Р•РќРђР Р†Р‡Р’ */}
                        <div className="space-y-10">
                            {pricesData.scenarios.map(scen => {
                                const qX = currentCatQuestions.find(q => q.id === scen.axis_x_key);
                                const qY = currentCatQuestions.find(q => q.id === scen.axis_y_key);
                                const optionsX = qX ? qX.options : [];
                                const optionsY = qY ? qY.options : [{id: 0, label: 'Base'}];

                                return (
                                    <div key={scen.id} className="border border-slate-200 p-4 rounded-2xl bg-slate-50/80 relative">
                                        <div className="flex flex-wrap justify-between items-center gap-3 mb-3">
                                            <h3 className="font-semibold text-lg text-slate-800">{scen.name}</h3>
                                            <button onClick={() => deleteItem('scenario', scen.id)} className="btn btn-outline text-xs">Видалити сценарій</button>
                                        </div>
                                        <p className="text-xs text-slate-500 mb-4 bg-white px-2 py-1 inline-block rounded">Умова: {scen.match_json}</p>

                                        <div className="overflow-x-auto">
                                            <table className="min-w-full bg-white border border-slate-200 rounded-xl">
                                                <thead>
                                                    <tr className="table-head">
                                                        <th className="table-cell text-left min-w-[150px]">{qX?.label || 'X'} \ {qY?.label || 'Y'}</th>
                                                        {optionsY.map(y => <th key={y.id} className="table-cell text-left text-xs">{y.label}</th>)}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {optionsX.map(x => (
                                                        <tr key={x.id} className="border-t border-slate-100">
                                                            <td className="table-cell font-semibold bg-slate-50 text-xs text-slate-700">{x.label}</td>
                                                            {optionsY.map(y => {
                                                                const cell = scen.matrix.find(m => m.x_val === x.id && m.y_val === y.id);
                                                                return (
                                                                    <td key={y.id} className="border-l border-slate-100 p-0">
                                                                        <input
                                                                            type="number"
                                                                            min="0"
                                                                            onKeyDown={(e) => e.key === '-' && e.preventDefault()} // <-- Р‘Р»РѕРєСѓС”РјРѕ РјС–РЅСѓСЃ
                                                                            className="w-full h-full p-2 text-center focus:bg-amber-50 outline-none min-w-[60px]"
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
                        <div className="mt-8 p-4 border border-dashed border-slate-300 rounded-2xl bg-slate-50/70">
                            <h4 className="font-semibold text-slate-700 mb-2">Додати нову таблицю цін (Сценарій)</h4>
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                                <input className="input-sm" placeholder="Назва (напр. Некалібровані)" value={newScenario.name} onChange={e => setNewScenario({...newScenario, name: e.target.value})} />
                                <input className="input-sm font-mono text-xs" placeholder='JSON: {"raw_type":1, "is_calibrated":0}' value={newScenario.match_json} onChange={e => setNewScenario({...newScenario, match_json: e.target.value})} />
                                <input className="input-sm" placeholder="Вісь X Key (напр. size)" value={newScenario.axis_x_key} onChange={e => setNewScenario({...newScenario, axis_x_key: e.target.value})} />
                                <input className="input-sm" placeholder="Вісь Y Key (напр. processing)" value={newScenario.axis_y_key} onChange={e => setNewScenario({...newScenario, axis_y_key: e.target.value})} />
                            </div>
                            <button onClick={addScenario} className="btn btn-primary mt-3">Створити сценарій</button>
                        </div>

                        {/* РњРћР”РР¤Р†РљРђРўРћР Р */}
                        <div className="mt-12 border-t border-slate-200 pt-6">
                            <h3 className="font-semibold text-lg mb-4 text-slate-800">Модифікатори (Знижки / Націнки)</h3>
                            <div className="space-y-2 mb-4">
                                {pricesData.modifiers.map(mod => (
                                    <div key={mod.id} className="flex flex-wrap items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                                        <span className="text-sm">Якщо <b>{mod.trigger_key}</b> = {mod.trigger_val}</span>
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm text-slate-600">Множник:</span>
                                            <input
                                                type="number"
                                                className="input-xs w-24 text-center font-semibold"
                                                defaultValue={mod.factor}
                                                onBlur={(e) => updateModifier(mod.id, e.target.value)}
                                            />
                                        </div>
                                        <button onClick={() => deleteItem('modifier', mod.id)} className="text-rose-500 hover:text-rose-700 px-2 font-bold">×</button>
                                    </div>
                                ))}
                            </div>

                            <div className="flex flex-wrap gap-2 items-center bg-slate-100 p-3 rounded-xl">
                                <span className="text-sm font-semibold">Новий:</span>
                                <input className="input-xs w-28" placeholder="Key (quality)" value={newModifier.trigger_key} onChange={e => setNewModifier({...newModifier, trigger_key: e.target.value})} />
                                <input className="input-xs w-24" type="number" placeholder="Val (2)" value={newModifier.trigger_val} onChange={e => setNewModifier({...newModifier, trigger_val: e.target.value})} />
                                <input
                                    className="input-xs w-24"
                                    type="number"
                                    min="0"
                                    placeholder="Factor (0.7)"
                                    value={newModifier.factor}
                                    onChange={e => {
                                        if(e.target.value >= 0) setNewModifier({...newModifier, factor: e.target.value})
                                    }}
                                />
                                <button onClick={addModifier} className="btn btn-amber">Додати</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
