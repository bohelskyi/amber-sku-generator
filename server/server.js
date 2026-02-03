const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const initialConfig = require('./data_config');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(bodyParser.json());

const db = new sqlite3.Database('./amber.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to SQLite database.');
    initDb();
});

function initDb() {
    db.serialize(() => {
        // --- ПРОДУКТИ ---
        db.run(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_sku TEXT, base_sku TEXT, sequence_number INTEGER, category TEXT,
            weight REAL, total_price REAL, price_per_gram REAL, details TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // --- СТРУКТУРА (Категорії, Питання, Опції) ---
        db.run(`CREATE TABLE IF NOT EXISTS categories (code TEXT PRIMARY KEY, name TEXT, requires_weight INTEGER DEFAULT 1)`);
        db.run(`CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, category_code TEXT, key TEXT, label TEXT, sku_index INTEGER,
            FOREIGN KEY(category_code) REFERENCES categories(code)
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS options (
            id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER, value_id INTEGER, label TEXT,
            FOREIGN KEY(question_id) REFERENCES questions(id)
        )`);

        // --- ЦІНИ (НОВІ ТАБЛИЦІ) ---
        
        // 1. Сценарії: Визначають, коли застосовувати ціну (напр. "Натуральний Калібрований")
        // match_json: {"raw_type": 1, "is_calibrated": 1}
        // axis_x_key: "size", axis_y_key: "texture" (Які питання формують таблицю)
        db.run(`CREATE TABLE IF NOT EXISTS price_scenarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category_code TEXT,
            name TEXT,
            match_json TEXT, 
            axis_x_key TEXT,
            axis_y_key TEXT
        )`);

        // 2. Матриця цін: Конкретні цифри
        // x_val: 1 (ID розміру), y_val: 2 (ID фактури), price: 5.0
        db.run(`CREATE TABLE IF NOT EXISTS price_matrix (
            scenario_id INTEGER,
            x_val INTEGER,
            y_val INTEGER,
            price REAL,
            FOREIGN KEY(scenario_id) REFERENCES price_scenarios(id)
        )`);

        // 3. Модифікатори: Знижки/Націнки
        // trigger_key: "quality", trigger_val: 2, factor: 0.7 (-30%)
        db.run(`CREATE TABLE IF NOT EXISTS price_modifiers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category_code TEXT,
            trigger_key TEXT,
            trigger_val INTEGER,
            factor REAL
        )`);

        db.get("SELECT count(*) as count FROM categories", (err, row) => {
            if (row && row.count === 0) {
                console.log("Empty DB. Migrating data & prices...");
                migrateData();
            }
        });
    });
}

function migrateData() {
    // 1. Міграція структури (як минулого разу)
    const stmtCat = db.prepare("INSERT INTO categories (code, name, requires_weight) VALUES (?, ?, ?)");
    const stmtQuest = db.prepare("INSERT INTO questions (category_code, key, label, sku_index) VALUES (?, ?, ?, ?)");
    const stmtOpt = db.prepare("INSERT INTO options (question_id, value_id, label) VALUES (?, ?, ?)");

    db.serialize(() => {
        for (const [code, cat] of Object.entries(initialConfig.categories)) {
            const reqWeight = (code === 'AR' || code === 'DK') ? 0 : 1;
            stmtCat.run(code, cat.name, reqWeight);
            
            const questions = initialConfig.questions[code] || [];
            questions.forEach(q => {
                stmtQuest.run(code, q.id, q.label, q.sku_index, function(err) {
                    if (err) console.error(err);
                    const qId = this.lastID;
                    q.options.forEach(opt => {
                        stmtOpt.run(qId, opt.id, opt.label);
                    });
                });
            });
        }

        // 2. МІГРАЦІЯ ЦІН (Хардкод -> БД)
        // Це одноразова логіка, щоб ти не вбивав ціни вручну з нуля
        migratePricesToDB();
    });
}

function migratePricesToDB() {
    const { naturalCalibratedPrices, formedPrices, uncalibratedPrices } = initialConfig;

    // --- СЦЕНАРІЙ 1: ФОРМОВАНИЙ (CH, BR, NM...) ---
    // Для всіх ювелірних категорій додамо сценарій "Формований"
    // Залежить тільки від Quality (вісь X)
    ['CH', 'BR', 'NM', 'KL'].forEach(cat => {
        db.run(`INSERT INTO price_scenarios (category_code, name, match_json, axis_x_key, axis_y_key) 
                VALUES (?, 'Формований', ?, 'quality', NULL)`, 
                [cat, JSON.stringify({ raw_type: 2 })], function(err) {
            
            const scenarioId = this.lastID;
            // Заповнюємо ціни: 1с=3, 2с=2, 3с=1
            const stmt = db.prepare("INSERT INTO price_matrix (scenario_id, x_val, y_val, price) VALUES (?, ?, ?, ?)");
            stmt.run(scenarioId, 1, 0, 3);
            stmt.run(scenarioId, 2, 0, 2);
            stmt.run(scenarioId, 3, 0, 1);
            stmt.finalize();
        });
    });

    // --- СЦЕНАРІЙ 2: НАТУРАЛЬНИЙ КАЛІБРОВАНИЙ (CH, BR...) ---
    // Залежить від Size (X) та Texture (Y)
    ['CH', 'BR', 'NM', 'KL'].forEach(cat => {
        db.run(`INSERT INTO price_scenarios (category_code, name, match_json, axis_x_key, axis_y_key) 
                VALUES (?, 'Натур. Калібрований', ?, 'size', 'texture')`, 
                [cat, JSON.stringify({ raw_type: 1, is_calibrated: 1 })], function(err) {
            
            const scenarioId = this.lastID;
            const stmt = db.prepare("INSERT INTO price_matrix (scenario_id, x_val, y_val, price) VALUES (?, ?, ?, ?)");
            
            // Проходимось по об'єкту цін з файлу
            for (const [sizeId, textures] of Object.entries(naturalCalibratedPrices)) {
                for (const [texId, price] of Object.entries(textures)) {
                    stmt.run(scenarioId, sizeId, texId, price);
                }
            }
            stmt.finalize();
        });

        // МОДИФІКАТОР: 2 сорт = -30% (factor 0.7)
        db.run("INSERT INTO price_modifiers (category_code, trigger_key, trigger_val, factor) VALUES (?, 'quality', 2, 0.7)", [cat]);
    });

    // --- СЦЕНАРІЙ 3: НАТУРАЛЬНИЙ НЕКАЛІБРОВАНИЙ ---
    // Залежить від Size (X) та Processing (Y) (але в Чотках Processing нема в питаннях data_config, тому це спрацює тільки там де є таке питання)
    // Для спрощення, міграція перенесе основні ціни.
    
    console.log("Prices migrated to DB!");
}
// --- API ---

app.get('/api/config', (req, res) => {
    const config = { categories: {}, questions: {}, extraConfig: initialConfig.extraConfig }; 

    db.all("SELECT * FROM categories", (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        
        rows.forEach(r => {
            config.categories[r.code] = { 
                name: r.name, 
                code: r.code,
                requires_weight: r.requires_weight // Передаємо налаштування ваги на фронт
            };
        });

        db.all(`SELECT q.id as q_db_id, q.category_code, q.key, q.label as q_label, q.sku_index,
                       o.id as o_db_id, o.value_id, o.label as o_label
                FROM questions q
                LEFT JOIN options o ON q.id = o.question_id
                ORDER BY q.category_code, q.sku_index, o.value_id`, (err, rows) => {
            
            if (err) return res.status(500).json({error: err.message});
            const tempQuestions = {};
            rows.forEach(row => {
                if (!tempQuestions[row.q_db_id]) {
                    tempQuestions[row.q_db_id] = {
                        q_db_id: row.q_db_id,
                        id: row.key,
                        label: row.q_label,
                        sku_index: row.sku_index,
                        cat: row.category_code,
                        options: []
                    };
                }
                if (row.o_db_id) {
                    tempQuestions[row.q_db_id].options.push({
                        db_id: row.o_db_id,
                        id: row.value_id,
                        label: row.o_label
                    });
                }
            });
            Object.values(tempQuestions).forEach(q => {
                if (!config.questions[q.cat]) config.questions[q.cat] = [];
                config.questions[q.cat].push(q);
            });
            res.json(config);
        });
    });
});

app.get('/api/admin/prices/:catCode', (req, res) => {
    const { catCode } = req.params;
    const data = { scenarios: [], modifiers: [] };

    db.serialize(() => {
        // Отримуємо сценарії та їх матриці
        db.all("SELECT * FROM price_scenarios WHERE category_code = ?", [catCode], (err, rows) => {
            if(err) return res.status(500).json(err);
            if(rows.length === 0) return res.json(data);

            let pending = rows.length;
            rows.forEach(scen => {
                db.all("SELECT * FROM price_matrix WHERE scenario_id = ?", [scen.id], (err, matrix) => {
                    data.scenarios.push({ ...scen, matrix });
                    pending--;
                    if(pending === 0) finalize();
                });
            });
        });

        function finalize() {
            db.all("SELECT * FROM price_modifiers WHERE category_code = ?", [catCode], (err, mods) => {
                data.modifiers = mods;
                res.json(data);
            });
        }
    });
});

// --- API: ЗБЕРЕЖЕННЯ ЦІНИ (ЯЧЕЙКИ) ---
app.post('/api/admin/price-cell', (req, res) => {
    const { scenario_id, x_val, y_val, price } = req.body;
    // UPSERT (Вставити або Оновити)
    db.run(`DELETE FROM price_matrix WHERE scenario_id = ? AND x_val = ? AND y_val = ?`, [scenario_id, x_val, y_val], () => {
        const stmt = db.prepare("INSERT INTO price_matrix (scenario_id, x_val, y_val, price) VALUES (?, ?, ?, ?)");
        stmt.run(scenario_id, x_val, y_val, price, function(err) {
            if(err) return res.status(500).json(err);
            res.json({success: true});
        });
        stmt.finalize();
    });
});

// --- API: ДОДАВАННЯ СЦЕНАРІЮ ---
app.post('/api/admin/scenario', (req, res) => {
    const { category_code, name, match_json, axis_x_key, axis_y_key } = req.body;
    const stmt = db.prepare("INSERT INTO price_scenarios (category_code, name, match_json, axis_x_key, axis_y_key) VALUES (?, ?, ?, ?, ?)");
    stmt.run(category_code, name, JSON.stringify(match_json), axis_x_key, axis_y_key, function(err){
        res.json({id: this.lastID});
    });
});

// Додати модифікатор
app.post('/api/admin/modifier', (req, res) => {
    const { category_code, trigger_key, trigger_val, factor } = req.body;
    const stmt = db.prepare("INSERT INTO price_modifiers (category_code, trigger_key, trigger_val, factor) VALUES (?, ?, ?, ?)");
    stmt.run(category_code, trigger_key, trigger_val, factor, function(err) {
        if(err) return res.status(500).json(err);
        res.json({id: this.lastID});
    });
    stmt.finalize();
});

// Оновити модифікатор
app.put('/api/admin/modifier', (req, res) => {
    const { id, factor } = req.body;
    const stmt = db.prepare("UPDATE price_modifiers SET factor = ? WHERE id = ?");
    stmt.run(factor, id, function(err) {
        if(err) return res.status(500).json(err);
        res.json({success: true});
    });
    stmt.finalize();
});

// Оновлення функції видалення (додаємо type === 'modifier' і 'scenario')
app.post('/api/admin/delete-item', (req, res) => {
    const { type, id } = req.body;
    let sql = "";
    
    if (type === 'category') sql = "DELETE FROM categories WHERE code = ?";
    else if (type === 'question') sql = "DELETE FROM questions WHERE id = ?";
    else if (type === 'option') sql = "DELETE FROM options WHERE id = ?";
    else if (type === 'modifier') sql = "DELETE FROM price_modifiers WHERE id = ?"; // <--- Додали
    else if (type === 'scenario') { // <--- Додали каскадне видалення сценарію
        db.serialize(() => {
            db.run("DELETE FROM price_matrix WHERE scenario_id = ?", [id]);
            db.run("DELETE FROM price_scenarios WHERE id = ?", [id], (err) => {
                if(err) return res.status(500).json(err);
                res.json({success: true});
            });
        });
        return;
    }
    
    if (sql) {
        db.run(sql, [id], function(err) {
            if(err) return res.status(500).json(err);
            res.json({success: true});
        });
    } else {
        res.status(400).json({ error: "Invalid type" });
    }
});

// --- НОВА ЛОГІКА PREVIEW (РОЗРАХУНОК ЦІНИ ПО БД) ---
app.post('/api/preview', (req, res) => {
    const { categoryCode, answers, weight, isCalibrated } = req.body;

    // 1. SKU Generation
    db.all("SELECT key, sku_index FROM questions WHERE category_code = ? ORDER BY sku_index ASC", [categoryCode], (err, qRows) => {
        let skuParts = [categoryCode];
        qRows.forEach(q => {
            const val = answers[q.key];
            skuParts.push(val ? val : 0);
        });
        const baseSku = skuParts.join('');

        // 2. Price Calculation
        db.all("SELECT * FROM price_scenarios WHERE category_code = ?", [categoryCode], (err, scenarios) => {
            let pricePerGram = 0;
            let logMessage = "Ціна не знайдена";

            // Шукаємо підходящий сценарій
            const activeScenario = scenarios.find(scen => {
                const rules = JSON.parse(scen.match_json);
                // Перевіряємо, чи відповіді користувача співпадають з правилами сценарію
                for (const [key, val] of Object.entries(rules)) {
                    if (key === 'is_calibrated') {
                        // isCalibrated передається окремо, не в answers
                        if (val !== (isCalibrated || 0)) return false;
                    } else {
                        if (answers[key] !== val) return false;
                    }
                }
                return true;
            });

            if (activeScenario) {
                // Знайшли сценарій! Тепер шукаємо ціну в матриці
                const xVal = answers[activeScenario.axis_x_key] || 0;
                const yVal = activeScenario.axis_y_key ? (answers[activeScenario.axis_y_key] || 0) : 0;

                db.get("SELECT price FROM price_matrix WHERE scenario_id = ? AND x_val = ? AND y_val = ?", 
                    [activeScenario.id, xVal, yVal], (err, row) => {
                    
                    if (row) {
                        pricePerGram = row.price;
                        logMessage = `${activeScenario.name} (Base: $${row.price})`;

                        // 3. Застосовуємо модифікатори
                        db.all("SELECT * FROM price_modifiers WHERE category_code = ?", [categoryCode], (err, mods) => {
                            mods.forEach(mod => {
                                if (answers[mod.trigger_key] === mod.trigger_val) {
                                    pricePerGram *= mod.factor;
                                    logMessage += ` + Mod (${Math.round((mod.factor-1)*100)}%)`;
                                }
                            });

                            finishCalculation(pricePerGram, logMessage);
                        });
                    } else {
                        logMessage = `${activeScenario.name} (Нема ціни для комбінації)`;
                        finishCalculation(0, logMessage);
                    }
                });
            } else {
                finishCalculation(0, "Немає сценарію для цих параметрів");
            }
        });

        function finishCalculation(price, log) {
            const weightVal = weight ? parseFloat(weight) : 0;
            const totalPrice = (price * weightVal).toFixed(2);
            
            // Логіка SKU (Sequence vs Weight)
            db.get("SELECT requires_weight FROM categories WHERE code = ?", [categoryCode], (err, catRow) => {
                const requiresWeight = catRow && catRow.requires_weight === 1;

                if (!requiresWeight) {
                    db.all("SELECT sequence_number FROM products WHERE base_sku = ? ORDER BY sequence_number DESC LIMIT 1", [baseSku], (err, rows) => {
                        let lastSeq = rows.length > 0 ? rows[0].sequence_number : 0;
                        const nextSeq = lastSeq + 1;
                        const fullProposedSku = baseSku + String(nextSeq).padStart(3, '0');
                        const prevFullSku = lastSeq > 0 ? baseSku + String(lastSeq).padStart(3, '0') : "Немає";
                        res.json({ mode: 'sequence', baseSku, nextSeq, fullProposedSku, prevFullSku, pricePerGram: price.toFixed(2), totalPrice, logMessage: log });
                    });
                } else {
                    const weightInt = Math.round(weightVal);
                    const fullProposedSku = baseSku + String(weightInt).padStart(3, '0');
                    db.get("SELECT full_sku FROM products WHERE full_sku = ?", [fullProposedSku], (err, row) => {
                        res.json({ mode: 'weight', baseSku, nextSeq: weightInt, fullProposedSku, existsInDb: !!row, pricePerGram: price.toFixed(2), totalPrice, logMessage: log });
                    });
                }
            });
        }
    });
});

app.post('/api/save', (req, res) => {
    const { fullSku, baseSku, nextSeq, category, weight, totalPrice, pricePerGram, details } = req.body;
    const stmt = db.prepare(`INSERT INTO products (full_sku, base_sku, sequence_number, category, weight, total_price, price_per_gram, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(fullSku, baseSku, nextSeq, category, weight, totalPrice, pricePerGram, JSON.stringify(details), function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
    stmt.finalize();
});

// Додавання категорії з прапорцем ваги
app.post('/api/admin/category', (req, res) => {
    const { code, name, requires_weight } = req.body;
    if (!code || !name) return res.status(400).json({ error: "Code and Name required" });
    
    const stmt = db.prepare("INSERT INTO categories (code, name, requires_weight) VALUES (?, ?, ?)");
    // Якщо requires_weight не передали, вважаємо 1 (так)
    stmt.run(code, name, requires_weight !== undefined ? requires_weight : 1, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: code, name }); 
    });
    stmt.finalize();
});

app.post('/api/admin/question', (req, res) => {
    const { category_code, key, label, sku_index } = req.body;
    const stmt = db.prepare("INSERT INTO questions (category_code, key, label, sku_index) VALUES (?, ?, ?, ?)");
    stmt.run(category_code, key, label, sku_index, function(err) { if (err) return res.status(500).json({ error: err.message }); res.json({ id: this.lastID }); });
    stmt.finalize();
});

app.post('/api/admin/option', (req, res) => {
    const { question_id, value_id, label } = req.body;
    const stmt = db.prepare("INSERT INTO options (question_id, value_id, label) VALUES (?, ?, ?)");
    stmt.run(question_id, value_id, label, function(err) { if (err) return res.status(500).json({ error: err.message }); res.json({ id: this.lastID }); });
    stmt.finalize();
});

app.post('/api/admin/delete-item', (req, res) => {
    const { type, id } = req.body; 
    let sql = "";
    if (type === 'category') sql = "DELETE FROM categories WHERE code = ?";
    else if (type === 'question') sql = "DELETE FROM questions WHERE id = ?";
    else if (type === 'option') sql = "DELETE FROM options WHERE id = ?";
    const stmt = db.prepare(sql);
    stmt.run(id, function(err) { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); });
    stmt.finalize();
});

// Видалення товару
app.post('/api/delete', (req, res) => {
    const { skuToDelete } = req.body; 
    if (!skuToDelete || skuToDelete.length < 4) return res.status(400).json({ error: "Некоректний формат" });
    db.run("DELETE FROM products WHERE full_sku = ?", [skuToDelete], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: "Артикул не знайдено." });
        res.json({ success: true, message: `Артикул ${skuToDelete} успішно видалено.` });
    });
});

app.get('/api/products', (req, res) => {
    db.all("SELECT * FROM products ORDER BY created_at DESC LIMIT 50", [], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(rows);
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});