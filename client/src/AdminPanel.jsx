import { useState, useEffect } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';

export default function AdminPanel() {
    const [config, setConfig] = useState(null);
    const [selectedCat, setSelectedCat] = useState(null);
    const [selectedQuestion, setSelectedQuestion] = useState(null);

    // Додали поле requires_weight (за замовчуванням true)
    const [newCat, setNewCat] = useState({ code: '', name: '', requires_weight: true });
    const [newQuest, setNewQuest] = useState({ key: '', label: '', sku_index: '' });
    const [newOpt, setNewOpt] = useState({ value_id: '', label: '' });

    useEffect(() => { fetchConfig(); }, []);
    const fetchConfig = () => { axios.get('http://localhost:5000/api/config').then(res => setConfig(res.data)); };

    const addCategory = () => {
        if(!newCat.code || !newCat.name) return alert("Заповніть код і назву");
        axios.post('http://localhost:5000/api/admin/category', {
            ...newCat,
            requires_weight: newCat.requires_weight ? 1 : 0 // Конвертуємо в число
        }).then(() => {
            setNewCat({ code: '', name: '', requires_weight: true });
            fetchConfig();
        });
    };

    const addQuestion = () => {
        if(!selectedCat) return;
        if(!newQuest.key || !newQuest.label) return alert("Заповніть поля");
        axios.post('http://localhost:5000/api/admin/question', { ...newQuest, category_code: selectedCat.code }).then(() => {
            setNewQuest({ key: '', label: '', sku_index: '' });
            fetchConfig();
        });
    };

    const addOption = () => {
        if(!selectedQuestion) return;
        if(!newOpt.value_id || !newOpt.label) return alert("Заповніть поля");
        axios.post('http://localhost:5000/api/admin/option', { ...newOpt, question_id: selectedQuestion.q_db_id }).then(() => {
            setNewOpt({ value_id: '', label: '' });
            fetchConfig();
        });
    };

    const deleteItem = (type, id) => {
        if(!window.confirm("Видалити?")) return;
        axios.post('http://localhost:5000/api/admin/delete-item', { type, id }).then(() => {
            fetchConfig();
            if(type === 'category') setSelectedCat(null);
            if(type === 'question') setSelectedQuestion(null);
        });
    };

    if (!config) return <div className="p-10">Завантаження...</div>;
    const currentCatQuestions = selectedCat ? (config.questions[selectedCat.code] || []) : [];
    const currentOptions = selectedQuestion ? (currentCatQuestions.find(q => q.id === selectedQuestion.id)?.options || []) : [];

    return (
        <div className="min-h-screen bg-gray-100 p-4 font-sans">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-2xl font-bold text-gray-800">⚙️ Адмін-панель</h1>
                <Link to="/" className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">← Назад до калькулятора</Link>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 h-[80vh]">
                
                {/* 1. Категорії */}
                <div className="bg-white p-4 rounded shadow flex flex-col">
                    <h2 className="font-bold text-lg mb-4 border-b pb-2">1. Категорії</h2>
                    <div className="flex-1 overflow-y-auto space-y-2">
                        {Object.values(config.categories).map(cat => (
                            <div key={cat.code} onClick={() => { setSelectedCat(cat); setSelectedQuestion(null); }} className={`p-3 rounded cursor-pointer flex justify-between items-center border ${selectedCat?.code === cat.code ? 'bg-amber-100 border-amber-500' : 'hover:bg-gray-50'}`}>
                                <div>
                                    <span className="font-bold">{cat.name}</span>
                                    <span className="text-xs text-gray-500 block">Code: {cat.code} | Weight: {cat.requires_weight ? 'Yes' : 'No'}</span>
                                </div>
                                <button onClick={(e) => { e.stopPropagation(); deleteItem('category', cat.code); }} className="text-red-400 px-2">×</button>
                            </div>
                        ))}
                    </div>
                    <div className="mt-4 pt-4 border-t bg-gray-50 p-2 rounded">
                        <input className="w-full mb-2 p-1 border rounded" placeholder="Код (TEST)" value={newCat.code} onChange={e => setNewCat({...newCat, code: e.target.value.toUpperCase()})} />
                        <input className="w-full mb-2 p-1 border rounded" placeholder="Назва" value={newCat.name} onChange={e => setNewCat({...newCat, name: e.target.value})} />
                        
                        {/* Чекбокс для ваги */}
                        <div className="flex items-center mb-2">
                            <input 
                                type="checkbox" 
                                id="reqWeight"
                                checked={newCat.requires_weight} 
                                onChange={e => setNewCat({...newCat, requires_weight: e.target.checked})} 
                                className="mr-2"
                            />
                            <label htmlFor="reqWeight" className="text-sm">Вимагати введення ваги?</label>
                        </div>
                        
                        <button onClick={addCategory} className="w-full bg-green-500 text-white py-1 rounded hover:bg-green-600">Додати категорію</button>
                    </div>
                </div>

                {/* 2. Питання */}
                <div className="bg-white p-4 rounded shadow flex flex-col">
                    <h2 className="font-bold text-lg mb-4 border-b pb-2">2. Питання ({selectedCat?.name || '-'})</h2>
                    <div className="flex-1 overflow-y-auto space-y-2">
                        {currentCatQuestions.map(q => (
                            <div key={q.q_db_id} onClick={() => setSelectedQuestion(q)} className={`p-3 rounded cursor-pointer flex justify-between items-center border ${selectedQuestion?.id === q.id ? 'bg-blue-100 border-blue-500' : 'hover:bg-gray-50'}`}>
                                <div><span className="font-bold">{q.label}</span><span className="text-xs text-gray-500 block">Idx: {q.sku_index}</span></div>
                                <button onClick={(e) => { e.stopPropagation(); deleteItem('question', q.q_db_id); }} className="text-red-400 px-2">×</button>
                            </div>
                        ))}
                    </div>
                    {selectedCat && (
                        <div className="mt-4 pt-4 border-t bg-gray-50 p-2 rounded">
                            <input className="w-full mb-2 p-1 border rounded" placeholder="Key (e.g. size)" value={newQuest.key} onChange={e => setNewQuest({...newQuest, key: e.target.value})} />
                            <input className="w-full mb-2 p-1 border rounded" placeholder="Текст питання" value={newQuest.label} onChange={e => setNewQuest({...newQuest, label: e.target.value})} />
                            <input className="w-full mb-2 p-1 border rounded" type="number" placeholder="Позиція SKU (0,1...)" value={newQuest.sku_index} onChange={e => setNewQuest({...newQuest, sku_index: e.target.value})} />
                            <button onClick={addQuestion} className="w-full bg-green-500 text-white py-1 rounded hover:bg-green-600">Додати питання</button>
                        </div>
                    )}
                </div>

                {/* 3. Варіанти */}
                <div className="bg-white p-4 rounded shadow flex flex-col">
                    <h2 className="font-bold text-lg mb-4 border-b pb-2">3. Варіанти ({selectedQuestion?.label || '-'})</h2>
                    <div className="flex-1 overflow-y-auto space-y-2">
                        {currentOptions.map(opt => (
                            <div key={opt.db_id || opt.id} className="p-2 border rounded flex justify-between bg-gray-50 items-center">
                                <span>{opt.label}</span>
                                <div className="flex items-center gap-2">
                                    <span className="bg-gray-200 px-2 rounded text-sm font-mono text-gray-600">{opt.id}</span>
                                    <button onClick={() => deleteItem('option', opt.db_id)} className="text-red-400 font-bold px-2 text-xl leading-none">×</button>
                                </div>
                            </div>
                        ))}
                    </div>
                    {selectedQuestion && (
                        <div className="mt-4 pt-4 border-t bg-gray-50 p-2 rounded">
                            <input className="w-full mb-2 p-1 border rounded" type="number" placeholder="SKU Value (1,2...)" value={newOpt.value_id} onChange={e => setNewOpt({...newOpt, value_id: e.target.value})} />
                            <input className="w-full mb-2 p-1 border rounded" placeholder="Назва" value={newOpt.label} onChange={e => setNewOpt({...newOpt, label: e.target.value})} />
                            <button onClick={addOption} className="w-full bg-green-500 text-white py-1 rounded hover:bg-green-600">Додати варіант</button>
                        </div>
                    )}
                </div>

            </div>
        </div>
    );
}