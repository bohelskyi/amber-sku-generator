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
        db.run(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_sku TEXT,
            base_sku TEXT,
            sequence_number INTEGER,
            category TEXT,
            weight REAL,
            total_price REAL,
            price_per_gram REAL,
            details TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // ДОДАЛИ КОЛОНКУ requires_weight (1 = так, 0 = ні)
        db.run(`CREATE TABLE IF NOT EXISTS categories (
            code TEXT PRIMARY KEY,
            name TEXT,
            requires_weight INTEGER DEFAULT 1
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category_code TEXT,
            key TEXT,
            label TEXT,
            sku_index INTEGER,
            FOREIGN KEY(category_code) REFERENCES categories(code)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS options (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question_id INTEGER,
            value_id INTEGER,
            label TEXT,
            FOREIGN KEY(question_id) REFERENCES questions(id)
        )`);

        db.get("SELECT count(*) as count FROM categories", (err, row) => {
            if (row && row.count === 0) {
                console.log("Empty DB. Migrating data...");
                migrateData();
            }
        });
    });
}

function migrateData() {
    const stmtCat = db.prepare("INSERT INTO categories (code, name, requires_weight) VALUES (?, ?, ?)");
    const stmtQuest = db.prepare("INSERT INTO questions (category_code, key, label, sku_index) VALUES (?, ?, ?, ?)");
    const stmtOpt = db.prepare("INSERT INTO options (question_id, value_id, label) VALUES (?, ?, ?)");

    db.serialize(() => {
        for (const [code, cat] of Object.entries(initialConfig.categories)) {
            // Для Картин (AR) та Декору (DK) вага не потрібна (стара логіка)
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
        console.log("Migration finished!");
    });
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

// --- ОНОВЛЕНИЙ PREVIEW ---
app.post('/api/preview', (req, res) => {
    const { categoryCode, answers, weight, isCalibrated } = req.body;
    
    // 1. ОТРИМУЄМО ПИТАННЯ З БАЗИ (ВИПРАВЛЕНО!)
    // Нам треба знати порядок питань (sku_index), щоб правильно скласти артикул
    db.all("SELECT key, sku_index FROM questions WHERE category_code = ? ORDER BY sku_index ASC", [categoryCode], (err, qRows) => {
        if (err) return res.status(500).json({ error: err.message });

        // Формуємо SKU базуючись на питаннях з БД
        let skuParts = [categoryCode];
        qRows.forEach(q => {
            const val = answers[q.key]; // q.key це наприклад 'raw_type', 'color'...
            skuParts.push(val ? val : 0);
        });
        const baseSku = skuParts.join('');

        // 2. Отримуємо налаштування категорії (чи треба вага)
        db.get("SELECT requires_weight FROM categories WHERE code = ?", [categoryCode], (err, catRow) => {
            if (err || !catRow) return res.status(500).json({ error: "Category not found" });

            const requiresWeight = catRow.requires_weight === 1;

            // --- Розрахунок ціни (Поки що стара логіка з файлу, наступний етап - БД) ---
            let pricePerGram = 0;
            let logMessage = "Ціни для нових категорій поки $0";
            
            // Спробуємо знайти ціну, якщо це стандартна категорія з initialConfig
            if (initialConfig.questions[categoryCode]) {
                 // ... тут стара логіка розрахунку (скорочено для читабельності, вона не змінилась) ...
                 // Якщо треба, я можу повернути повний блок розрахунку, але для custom категорій він все одно дасть 0
                 const { naturalCalibratedPrices, formedPrices, uncalibratedPrices } = initialConfig;
                 const rawType = answers['raw_type'];
                 const quality = answers['quality'];
                 const size = answers['size']; 
                 const texture = answers['texture'];
                 const processing = answers['processing'];
                 
                 if (rawType === 2) { 
                     pricePerGram = formedPrices[quality] || 0; logMessage = "Формований";
                 } else if (rawType === 1) { 
                     if (isCalibrated === 1) {
                         if (naturalCalibratedPrices[size] && naturalCalibratedPrices[size][texture]) {
                             pricePerGram = (quality === 1) ? naturalCalibratedPrices[size][texture] : naturalCalibratedPrices[size][texture] * 0.7;
                             logMessage = "Натур/Калібр";
                         }
                     } else {
                         let bp = uncalibratedPrices[size] || 0;
                         pricePerGram = (processing === 1) ? bp * 1.3 : bp;
                         logMessage = "Натур/Некалібр";
                     }
                 }
            }

            const weightVal = weight ? parseFloat(weight) : 0;
            const totalPrice = (pricePerGram * weightVal).toFixed(2);

            // --- ЛОГІКА СУФІКСУ ---
            // Якщо вага потрібна -> суфікс це вага. Якщо ні -> лічильник.
            if (!requiresWeight) {
                // ЛІЧИЛЬНИК (Sequence)
                db.all("SELECT sequence_number FROM products WHERE base_sku = ? ORDER BY sequence_number DESC LIMIT 1", [baseSku], (err, rows) => {
                    let lastSeq = rows.length > 0 ? rows[0].sequence_number : 0;
                    const nextSeq = lastSeq + 1;
                    const fullProposedSku = baseSku + String(nextSeq).padStart(3, '0');
                    const prevFullSku = lastSeq > 0 ? baseSku + String(lastSeq).padStart(3, '0') : "Немає";
                    
                    res.json({ mode: 'sequence', baseSku, nextSeq, fullProposedSku, prevFullSku, pricePerGram: pricePerGram.toFixed(2), totalPrice, logMessage });
                });
            } else {
                // ВАГА (Weight)
                const weightInt = Math.round(weightVal);
                const fullProposedSku = baseSku + String(weightInt).padStart(3, '0');

                db.get("SELECT full_sku FROM products WHERE full_sku = ?", [fullProposedSku], (err, row) => {
                    res.json({ mode: 'weight', baseSku, nextSeq: weightInt, fullProposedSku, existsInDb: !!row, pricePerGram: pricePerGram.toFixed(2), totalPrice, logMessage });
                });
            }
        });
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