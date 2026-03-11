import { useState, useEffect } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';

export default function AdminPanel() {
    const [config, setConfig] = useState(null);
    const [selectedCat, setSelectedCat] = useState(null);
    const [selectedQuestion, setSelectedQuestion] = useState(null);
    const [pricesData, setPricesData] = useState(null);
    const [editCat, setEditCat] = useState({ name: '', requires_weight: true });
    const [editQuestion, setEditQuestion] = useState({ label: '', sku_index: '', required: true, include_in_sku: true, input_type: 'options' });

    // Стани форм
    const [newCat, setNewCat] = useState({ code: '', name: '', requires_weight: true });
    const [newQuest, setNewQuest] = useState({ key: '', label: '', sku_index: '', required: true, include_in_sku: true, input_type: 'options' });
    const [newOpt, setNewOpt] = useState({ value_id: '', label: '', visible_if_json: '' });
    const [editOpt, setEditOpt] = useState({ id: null, value_id: '', label: '', visible_if_json: '' });

    // Стани для цін
    const [newScenario, setNewScenario] = useState({ name: '', match_json: '', axis_x_key: '', axis_y_key: '' });
    const [editScenario, setEditScenario] = useState(null);
    const [newModifier, setNewModifier] = useState({ trigger_key: '', trigger_val: '', factor: '' });
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

    useEffect(() => { fetchConfig(); }, []);

    useEffect(() => {
        if (selectedCat) fetchPrices();
        else setPricesData(null);
        setEditScenario(null);
    }, [selectedCat]);

    useEffect(() => {
        setEditOpt({ id: null, value_id: '', label: '', visible_if_json: '' });
    }, [selectedQuestion?.q_db_id]);

    const fetchConfig = () => { axios.get('/api/config').then(res => setConfig(res.data)); };
    const fetchPrices = () => { axios.get(`/api/admin/prices/${selectedCat.code}`).then(res => setPricesData(res.data)); };

    // --- CRUD функції ---
    const addCategory = () => {
        if(!newCat.code) return;
        axios.post('/api/admin/category', { ...newCat, requires_weight: newCat.requires_weight ? 1 : 0 })
             .then(() => { setNewCat({ code: '', name: '', requires_weight: true }); fetchConfig(); });
    };
    const addQuestion = () => {
        if(!selectedCat) return;
        const isTextQuestion = newQuest.input_type === 'text';
        axios.post('/api/admin/question', {
            ...newQuest,
            required: newQuest.required ? 1 : 0,
            include_in_sku: isTextQuestion ? 0 : (newQuest.include_in_sku ? 1 : 0),
            input_type: isTextQuestion ? 'text' : 'options',
            category_code: selectedCat.code
        })
             .then(() => { setNewQuest({ key: '', label: '', sku_index: '', required: true, include_in_sku: true, input_type: 'options' }); fetchConfig(); });
    };
    const addOption = () => {
        if(!selectedQuestion) return;
        if ((selectedQuestion.input_type || 'options') === 'text') {
            return alert("Для текстового питання варіанти не потрібні");
        }
        let parsedRule = null;
        try {
            parsedRule = newOpt.visible_if_json ? JSON.parse(newOpt.visible_if_json) : null;
        } catch (e) {
            return alert("Помилка JSON в visible_if");
        }

        axios.post('/api/admin/option', {
            question_id: selectedQuestion.q_db_id,
            value_id: newOpt.value_id,
            label: newOpt.label,
            visible_if_json: parsedRule
        })
             .then(() => { setNewOpt({ value_id: '', label: '', visible_if_json: '' }); fetchConfig(); });
    };
    const beginOptionEdit = (opt) => {
        setEditOpt({
            id: opt.db_id,
            value_id: String(opt.id),
            label: opt.label,
            visible_if_json: opt.visible_if_json ? formatMatchJson(opt.visible_if_json) : '',
        });
    };
    const updateOption = () => {
        if (!editOpt.id) return;
        let parsedRule = null;
        try {
            parsedRule = editOpt.visible_if_json ? JSON.parse(editOpt.visible_if_json) : null;
        } catch (e) {
            return alert("Помилка JSON в visible_if");
        }

        axios.put('/api/admin/option', {
            id: editOpt.id,
            value_id: editOpt.value_id,
            label: editOpt.label,
            visible_if_json: parsedRule,
        })
            .then(() => {
                setEditOpt({ id: null, value_id: '', label: '', visible_if_json: '' });
                fetchConfig();
            })
            .catch(err => alert(`Помилка оновлення опції: ${err.response?.data?.error || err.message}`));
    };
    const deleteItem = (type, id) => {
        if(!window.confirm("Видалити цей елемент?")) return;
        axios.post('/api/admin/delete-item', { type, id })
             .then(() => {
                 fetchConfig();
                 if(type==='category') setSelectedCat(null);
                 if(type==='scenario' || type==='modifier') fetchPrices();
             });
    };
    const updateCategory = () => {
        if (!selectedCat) return;
        axios.put('/api/admin/category', {
            code: selectedCat.code,
            name: editCat.name,
            requires_weight: editCat.requires_weight ? 1 : 0
        })
            .then(() => { fetchConfig(); });
    };

    const updateQuestion = () => {
        if (!selectedQuestion) return;
        const isTextQuestion = editQuestion.input_type === 'text';
        axios.post('/api/admin/question/update', {
            id: selectedQuestion.q_db_id,
            label: editQuestion.label,
            sku_index: editQuestion.sku_index,
            required: editQuestion.required ? 1 : 0,
            include_in_sku: isTextQuestion ? 0 : (editQuestion.include_in_sku ? 1 : 0),
            input_type: isTextQuestion ? 'text' : 'options'
        })
            .then(() => {
                fetchConfig();
                alert('Збережено');
            })
            .catch(err => {
                alert(`Помилка збереження: ${err.response?.data?.error || err.message}`);
            });
    };

    // --- Цінові функції ---
    const handlePriceChange = (scenarioId, xVal, yVal, newPrice) => {
        axios.post('/api/admin/price-cell', {
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
            parsedJson = JSON.parse(newScenario.match_json); // 1. Перетворюємо текст у об'єкт
        } catch (e) {
            return alert("Помилка в JSON! Формат: {\"key\": value}");
        }

        axios.post('/api/admin/scenario', {
            ...newScenario,
            match_json: parsedJson, // 2. Відправляємо вже об'єкт, а не рядок
            category_code: selectedCat.code
        })
            .then(() => {
                setNewScenario({ name: '', match_json: '', axis_x_key: '', axis_y_key: '' });
                fetchPrices();
            });
    };

    const beginScenarioEdit = (scen) => {
        setEditScenario({
            id: scen.id,
            name: scen.name,
            match_json: formatMatchJson(scen.match_json),
            axis_x_key: scen.axis_x_key || '',
            axis_y_key: scen.axis_y_key || '',
        });
    };

    const updateScenario = () => {
        if (!editScenario || !editScenario.id) return;
        if (!editScenario.name || !editScenario.axis_x_key) {
            return alert("Потрібні назва сценарію та вісь X");
        }

        let parsedJson;
        try {
            parsedJson = JSON.parse(editScenario.match_json || '{}');
        } catch (e) {
            return alert("Помилка в JSON умови");
        }

        axios.put('/api/admin/scenario', {
            id: editScenario.id,
            name: editScenario.name,
            match_json: parsedJson,
            axis_x_key: editScenario.axis_x_key,
            axis_y_key: editScenario.axis_y_key || null,
        })
            .then(() => {
                setEditScenario(null);
                fetchPrices();
            })
            .catch(err => alert(`Помилка оновлення сценарію: ${err.response?.data?.error || err.message}`));
    };

    const duplicateScenario = (scenarioId) => {
        axios.post('/api/admin/scenario/duplicate', { id: scenarioId })
            .then(() => fetchPrices())
            .catch(err => alert(`Помилка дублювання: ${err.response?.data?.error || err.message}`));
    };

    const addModifier = () => {
        if(!newModifier.trigger_key || !newModifier.factor) return;
        axios.post('/api/admin/modifier', { ...newModifier, category_code: selectedCat.code })
            .then(() => {
                setNewModifier({ trigger_key: '', trigger_val: '', factor: '' });
                fetchPrices();
            });
    };

    const updateModifier = (id, newFactor) => {
        axios.put('/api/admin/modifier', { id, factor: parseFloat(newFactor) });
    };

    const formatMatchJson = (value) => {
        if (value === null || value === undefined) return '{}';
        if (typeof value === 'string') return value;
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
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
    const selectedQuestionInputType = selectedQuestion ? (selectedQuestion.input_type || 'options') : 'options';

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
                if (q.include_in_sku === 1) {
                    if (indexSet.has(q.sku_index)) {
                        validationIssues.push(`Категорія ${cat.code}: дубль індексу ${q.sku_index}`);
                    }
                    indexSet.add(q.sku_index);
                }
                if ((q.input_type || 'options') !== 'text' && (!q.options || q.options.length === 0)) {
                    validationIssues.push(`Категорія ${cat.code}: питання ${q.id} без варіантів`);
                }
            });
        });
    }

    return (
        <div className="min-h-screen app-bg">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12 pb-28 space-y-8">
                <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between fade-up">
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
                    <div className="danger-panel p-5 fade-up stagger-1">
                        <div className="font-semibold text-rose-700 mb-2">Авто-валідатор виявив проблеми</div>
                        <ul className="list-disc pl-5 text-sm text-rose-700">
                            {validationIssues.map((issue, idx) => (
                                <li key={idx}>{issue}</li>
                            ))}
                        </ul>
                    </div>
                )}

                {/* Верхня частина: структура */}
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start fade-up stagger-2">
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
                                    className={`p-3 rounded-xl cursor-pointer flex justify-between items-center border transition ${selectedCat?.code === cat.code ? 'bg-[rgba(221,151,74,0.18)] border-[rgba(221,151,74,0.5)]' : 'border-slate-200 hover:bg-slate-50'}`}
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
                                    onClick={() => { setSelectedQuestion(q); setEditQuestion({ label: q.label, sku_index: q.sku_index, required: q.required === 1, include_in_sku: q.include_in_sku === 1, input_type: q.input_type || 'options' }); }}
                                    className={`p-3 rounded-xl cursor-pointer flex justify-between items-center border transition ${selectedQuestion?.id === q.id ? 'bg-[rgba(20,32,59,0.08)] border-[rgba(20,32,59,0.4)]' : 'border-slate-200 hover:bg-slate-50'}`}
                                >
                                    <div>
                                        <span className="font-semibold text-slate-800">{q.label}</span>
                                        <span className="text-xs text-slate-500 block">Key: {q.id} | Index: {q.sku_index} | {q.required === 1 ? 'Обовʼязкове' : 'Необовʼязкове'} | {q.include_in_sku === 1 ? 'Йде в SKU' : 'Лише в БД'} | Тип: {(q.input_type || 'options') === 'text' ? 'Текст' : 'Варіанти'}</span>
                                    </div>
                                    <button onClick={(e) => { e.stopPropagation(); deleteItem('question', q.q_db_id); }} className="text-rose-400 hover:text-rose-600 px-2">×</button>
                                </div>
                            ))}
                        </div>
                        {selectedQuestion && (
                            <div className="mt-4 p-3 border border-slate-200 rounded-xl bg-white/80">
                                <div className="text-xs text-slate-500 mb-2">Редагувати питання</div>
                                <input className="input-sm mb-2" placeholder="Label" value={editQuestion.label} onChange={e => setEditQuestion({...editQuestion, label: e.target.value})}/>
                                <input className="input-sm mb-2" type="number" placeholder="Index" value={editQuestion.sku_index} onChange={e => setEditQuestion({...editQuestion, sku_index: e.target.value})} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown}/>
                                <select className="input-sm mb-2" value={editQuestion.input_type} onChange={e => setEditQuestion({...editQuestion, input_type: e.target.value, include_in_sku: e.target.value === 'text' ? false : editQuestion.include_in_sku })}>
                                    <option value="options">Варіанти</option>
                                    <option value="text">Текстове поле</option>
                                </select>
                                <label className="flex items-center text-sm mb-2"><input type="checkbox" checked={editQuestion.required} onChange={e => setEditQuestion({...editQuestion, required: e.target.checked})} className="mr-2"/> Обовʼязкове</label>
                                <label className="flex items-center text-sm mb-2"><input type="checkbox" checked={editQuestion.include_in_sku} disabled={editQuestion.input_type === 'text'} onChange={e => setEditQuestion({...editQuestion, include_in_sku: e.target.checked})} className="mr-2"/> Додавати в SKU</label>
                                <button onClick={updateQuestion} className="btn btn-primary w-full">Зберегти</button>
                            </div>
                        )}
                        {selectedCat && (
                            <div className="mt-4 pt-4 border-t border-slate-200 bg-slate-50/70 p-3 rounded-xl">
                                <input className="input-sm mb-2" placeholder="Key (size)" value={newQuest.key} onChange={e => setNewQuest({...newQuest, key: e.target.value})}/>
                                <input className="input-sm mb-2" placeholder="Label" value={newQuest.label} onChange={e => setNewQuest({...newQuest, label: e.target.value})}/>
                                <input className="input-sm mb-2" type="number" placeholder="Index" value={newQuest.sku_index} onChange={e => setNewQuest({...newQuest, sku_index: e.target.value})} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown}/>
                                <select className="input-sm mb-2" value={newQuest.input_type} onChange={e => setNewQuest({...newQuest, input_type: e.target.value, include_in_sku: e.target.value === 'text' ? false : newQuest.include_in_sku })}>
                                    <option value="options">Варіанти</option>
                                    <option value="text">Текстове поле</option>
                                </select>
                                <label className="flex items-center text-sm mb-2"><input type="checkbox" checked={newQuest.required} onChange={e => setNewQuest({...newQuest, required: e.target.checked})} className="mr-2"/> Обовʼязкове</label>
                                <label className="flex items-center text-sm mb-2"><input type="checkbox" checked={newQuest.include_in_sku} disabled={newQuest.input_type === 'text'} onChange={e => setNewQuest({...newQuest, include_in_sku: e.target.checked})} className="mr-2"/> Додавати в SKU</label>
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
                            {selectedQuestionInputType === 'text' && (
                                <div className="p-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-600">
                                    Для текстового питання варіанти не використовуються.
                                </div>
                            )}
                            {currentOptions.map(opt => (
                                <div key={opt.db_id} className="p-2 border border-slate-200 rounded-xl flex justify-between bg-white/80 items-center">
                                    <div>
                                        <span className="text-sm text-slate-700">{opt.label}</span>
                                        <span className="text-[11px] text-slate-500 block">
                                            visible_if: {opt.visible_if_json ? formatMatchJson(opt.visible_if_json) : 'always'}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="bg-slate-100 px-2 rounded text-xs text-slate-600">{opt.id}</span>
                                        <button onClick={() => beginOptionEdit(opt)} className="btn btn-outline text-xs px-2 py-1">Редагувати</button>
                                        <button onClick={() => deleteItem('option', opt.db_id)} className="text-rose-400 hover:text-rose-600 font-bold px-2">×</button>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {editOpt.id && (
                            <div className="mt-4 p-3 border border-slate-200 rounded-xl bg-white/80">
                                <div className="text-xs text-slate-500 mb-2">Редагувати опцію</div>
                                <input
                                    className="input-sm mb-2"
                                    type="number"
                                    placeholder="Value ID"
                                    value={editOpt.value_id}
                                    onChange={e => setEditOpt({...editOpt, value_id: e.target.value})}
                                    onWheel={handleNumberWheel}
                                    onKeyDown={handleNumberKeyDown}
                                />
                                <input
                                    className="input-sm mb-2"
                                    placeholder="Label"
                                    value={editOpt.label}
                                    onChange={e => setEditOpt({...editOpt, label: e.target.value})}
                                />
                                <input
                                    className="input-sm font-mono text-xs mb-2"
                                    placeholder='visible_if JSON, напр: {"raw_type":1,"is_calibrated":[0,2]}'
                                    value={editOpt.visible_if_json}
                                    onChange={e => setEditOpt({...editOpt, visible_if_json: e.target.value})}
                                />
                                <div className="flex gap-2">
                                    <button onClick={updateOption} className="btn btn-primary w-full">Зберегти</button>
                                    <button onClick={() => setEditOpt({ id: null, value_id: '', label: '', visible_if_json: '' })} className="btn btn-outline w-full">Скасувати</button>
                                </div>
                            </div>
                        )}
                        {selectedQuestion && selectedQuestionInputType !== 'text' && (
                            <div className="mt-4 pt-4 border-t border-slate-200 bg-slate-50/70 p-3 rounded-xl">
                                <input className="input-sm mb-2" type="number" placeholder="Value ID" value={newOpt.value_id} onChange={e => setNewOpt({...newOpt, value_id: e.target.value})} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown}/>
                                <input className="input-sm mb-2" placeholder="Label" value={newOpt.label} onChange={e => setNewOpt({...newOpt, label: e.target.value})}/>
                                <input className="input-sm font-mono text-xs mb-2" placeholder='visible_if JSON, напр: {"raw_type":1,"is_calibrated":[0,2]}' value={newOpt.visible_if_json} onChange={e => setNewOpt({...newOpt, visible_if_json: e.target.value})}/>
                                <button onClick={addOption} className="btn btn-amber w-full">Додати</button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Нижня частина: ціни */}
                {selectedCat && pricesData && (
                    <div className="card p-6 sm:p-8 border-t-4 border-[rgba(20,32,59,0.4)] fade-up">
                        <div className="section-title mb-6">
                            <div>
                                <p className="eyebrow">Ціни</p>
                                <h2 className="section-title-text">Управління цінами ({selectedCat.name})</h2>
                            </div>
                        </div>

                        {/* Список сценаріїв */}
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
                                            <div className="flex flex-wrap gap-2">
                                                <button onClick={() => beginScenarioEdit(scen)} className="btn btn-outline text-xs">Редагувати</button>
                                                <button onClick={() => duplicateScenario(scen.id)} className="btn btn-outline text-xs">Дублювати</button>
                                                <button onClick={() => deleteItem('scenario', scen.id)} className="btn btn-outline text-xs">Видалити сценарій</button>
                                            </div>
                                        </div>
                                        <p className="text-xs text-slate-500 mb-4 bg-white px-2 py-1 inline-block rounded">Умова: {formatMatchJson(scen.match_json)}</p>

                                        {editScenario?.id === scen.id && (
                                            <div className="mb-4 p-3 border border-slate-200 rounded-xl bg-white">
                                                <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                                                    <input
                                                        className="input-sm"
                                                        placeholder="Назва"
                                                        value={editScenario.name}
                                                        onChange={e => setEditScenario({ ...editScenario, name: e.target.value })}
                                                    />
                                                    <input
                                                        className="input-sm font-mono text-xs"
                                                        placeholder='JSON умова'
                                                        value={editScenario.match_json}
                                                        onChange={e => setEditScenario({ ...editScenario, match_json: e.target.value })}
                                                    />
                                                    <input
                                                        className="input-sm"
                                                        placeholder="Вісь X key"
                                                        value={editScenario.axis_x_key}
                                                        onChange={e => setEditScenario({ ...editScenario, axis_x_key: e.target.value })}
                                                    />
                                                    <input
                                                        className="input-sm"
                                                        placeholder="Вісь Y key"
                                                        value={editScenario.axis_y_key}
                                                        onChange={e => setEditScenario({ ...editScenario, axis_y_key: e.target.value })}
                                                    />
                                                </div>
                                                <div className="mt-3 flex gap-2">
                                                    <button onClick={updateScenario} className="btn btn-primary text-xs">Зберегти сценарій</button>
                                                    <button onClick={() => setEditScenario(null)} className="btn btn-outline text-xs">Скасувати</button>
                                                </div>
                                            </div>
                                        )}

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
                                                                            onKeyDown={(e) => { if (e.key === '-') e.preventDefault(); handleNumberKeyDown(e); }} // Блокуємо мінус
                                                                            onWheel={handleNumberWheel}
                                                                            className="w-full h-full p-2 text-center focus:bg-amber-50 outline-none min-w-[60px]"
                                                                            defaultValue={cell ? cell.price : ''}
                                                                            placeholder="-"
                                                                            onBlur={(e) => {
                                                                                if(e.target.value < 0) e.target.value = 0; // Скидаємо в 0, якщо раптом ввели мінус
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

                        {/* Додавання нового сценарію */}
                        <div className="mt-8 p-4 border border-dashed border-slate-300 rounded-2xl bg-slate-50/70">
                            <h4 className="font-semibold text-slate-700 mb-2">Додати нову таблицю цін (Сценарій)</h4>
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                                <input className="input-sm" placeholder="Назва (напр. Некалібровані)" value={newScenario.name} onChange={e => setNewScenario({...newScenario, name: e.target.value})} />
                                <input className="input-sm font-mono text-xs" placeholder='JSON: {"raw_type":1, "is_calibrated":2}' value={newScenario.match_json} onChange={e => setNewScenario({...newScenario, match_json: e.target.value})} />
                                <input className="input-sm" placeholder="Вісь X Key (напр. size)" value={newScenario.axis_x_key} onChange={e => setNewScenario({...newScenario, axis_x_key: e.target.value})} />
                                <input className="input-sm" placeholder="Вісь Y Key (напр. processing)" value={newScenario.axis_y_key} onChange={e => setNewScenario({...newScenario, axis_y_key: e.target.value})} />
                            </div>
                            <button onClick={addScenario} className="btn btn-primary mt-3">Створити сценарій</button>
                        </div>

                        {/* Модифікатори */}
                        <div className="mt-12 border-t border-slate-200 pt-6">
                            <h3 className="font-semibold text-lg mb-4 text-slate-800">Модифікатори (Знижки / Націнки)</h3>
                            <div className="space-y-2 mb-4">
                                {pricesData.modifiers.map(mod => (
                                    <div key={mod.id} className="flex flex-wrap items-center gap-3 p-3 bg-[rgba(221,151,74,0.14)] border border-[rgba(221,151,74,0.35)] rounded-xl">
                                        <span className="text-sm">Якщо <b>{mod.trigger_key}</b> = {mod.trigger_val}</span>
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm text-slate-600">Множник:</span>
                                            <input
                                                type="number"
                                                className="input-xs w-24 text-center font-semibold"
                                                defaultValue={mod.factor}
                                                onBlur={(e) => updateModifier(mod.id, e.target.value)}
                                                onWheel={handleNumberWheel}
                                                onKeyDown={handleNumberKeyDown}
                                            />
                                        </div>
                                        <button onClick={() => deleteItem('modifier', mod.id)} className="text-rose-500 hover:text-rose-700 px-2 font-bold">×</button>
                                    </div>
                                ))}
                            </div>

                            <div className="flex flex-wrap gap-2 items-center bg-slate-100 p-3 rounded-xl">
                                <span className="text-sm font-semibold">Новий:</span>
                                <input className="input-xs w-28" placeholder="Key (quality)" value={newModifier.trigger_key} onChange={e => setNewModifier({...newModifier, trigger_key: e.target.value})} />
                                <input className="input-xs w-24" type="number" placeholder="Val (2)" value={newModifier.trigger_val} onChange={e => setNewModifier({...newModifier, trigger_val: e.target.value})} onWheel={handleNumberWheel} onKeyDown={handleNumberKeyDown} />
                                <input
                                    className="input-xs w-24"
                                    type="number"
                                    min="0"
                                    placeholder="Factor (0.7)"
                                    value={newModifier.factor}
                                    onChange={e => {
                                        if(e.target.value >= 0) setNewModifier({...newModifier, factor: e.target.value})
                                    }}
                                    onWheel={handleNumberWheel}
                                    onKeyDown={handleNumberKeyDown}
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
