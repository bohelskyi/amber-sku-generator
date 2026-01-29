const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { categories, questions, extraConfig, naturalCalibratedPrices, formedPrices, uncalibratedPrices } = require('./data_config');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(bodyParser.json());

const db = new sqlite3.Database('./amber.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to the SQLite database.');
});

db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_sku TEXT,
    base_sku TEXT,
    sequence_number INTEGER, -- Для картин це лічильник, для ювелірки це вага
    category TEXT,
    weight REAL,
    total_price REAL,
    price_per_gram REAL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

app.get('/api/config', (req, res) => {
    res.json({ categories, questions, extraConfig });
});

// --- ПЕРЕВІРКА ТА ГЕНЕРАЦІЯ ---
app.post('/api/preview', (req, res) => {
    const { categoryCode, answers, weight, isCalibrated } = req.body;
    
    // 1. Формуємо базу артикулу
    const catQuestions = questions[categoryCode] || [];
    let skuParts = [categoryCode];
    catQuestions.forEach(q => {
        const val = answers[q.id];
        skuParts.push(val ? val : 0);
    });
    const baseSku = skuParts.join('');

    // 2. Рахуємо ціну
    let pricePerGram = 0;
    let logMessage = "";
    const rawType = answers['raw_type'];
    const quality = answers['quality'];
    const size = answers['size']; 
    const texture = answers['texture'];
    const processing = answers['processing'];

    if (rawType === 2) { 
        pricePerGram = formedPrices[quality] || 0;
        logMessage = "Формований";
    } else if (rawType === 1) { 
        if (isCalibrated === 1) {
            if (naturalCalibratedPrices[size] && naturalCalibratedPrices[size][texture]) {
                let basePrice = naturalCalibratedPrices[size][texture];
                if (quality === 1) {
                    pricePerGram = basePrice;
                    logMessage = "Натур/Калібр/1сорт";
                } else if (quality === 2) {
                    pricePerGram = basePrice * 0.7;
                    logMessage = "Натур/Калібр/2сорт (-30%)";
                }
            }
        } else {
            let baseUncalibratedPrice = uncalibratedPrices[size] || 0;
            if (processing === 2) {
                pricePerGram = baseUncalibratedPrice;
                logMessage = "Натур/Некалібр/Шліф";
            } else if (processing === 1) {
                pricePerGram = baseUncalibratedPrice * 1.3;
                logMessage = "Натур/Некалібр/Полір (+30%)";
            }
        }
    }

    const weightVal = weight ? parseFloat(weight) : 0;
    const totalPrice = (pricePerGram * weightVal).toFixed(2);

    // --- ГОЛОВНА ЗМІНА ЛОГІКИ ---
    
    // Категорії, де використовуємо лічильник (стара логіка)
    const sequenceCategories = ['AR', 'DK'];
    const isSequenceBased = sequenceCategories.includes(categoryCode);

    if (isSequenceBased) {
        // ЛОГІКА ЛІЧИЛЬНИКА (Декор, Картини)
        db.all("SELECT sequence_number FROM products WHERE base_sku = ? ORDER BY sequence_number DESC LIMIT 1", [baseSku], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            let lastSeq = 0;
            if (rows.length > 0) lastSeq = rows[0].sequence_number;
            
            const nextSeq = lastSeq + 1;
            const suffix = String(nextSeq).padStart(3, '0');
            const fullProposedSku = baseSku + suffix;
            
            const prevSeqString = lastSeq > 0 ? String(lastSeq).padStart(3, '0') : null;
            const prevFullSku = lastSeq > 0 ? baseSku + prevSeqString : "Немає (Перший запис)";

            res.json({
                mode: 'sequence', // Мітка для фронтенда
                baseSku,
                nextSeq, // Це піде в sequence_number
                fullProposedSku,
                prevFullSku,
                pricePerGram: pricePerGram.toFixed(2),
                totalPrice,
                logMessage
            });
        });
    } else {
        // ЛОГІКА ВАГИ (Браслети, Чотки і т.д.)
        // Суфікс = округлена вага
        const weightInt = Math.round(weightVal);
        const suffix = String(weightInt).padStart(3, '0');
        const fullProposedSku = baseSku + suffix;

        // Перевіряємо, чи такий артикул вже є в базі
        db.get("SELECT full_sku FROM products WHERE full_sku = ?", [fullProposedSku], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            
            res.json({
                mode: 'weight', // Мітка для фронтенда
                baseSku,
                nextSeq: weightInt, // В колонку sequence_number запишемо вагу, щоб було красиво
                fullProposedSku,
                existsInDb: !!row, // true, якщо такий вже є
                pricePerGram: pricePerGram.toFixed(2),
                totalPrice,
                logMessage
            });
        });
    }
});

// ЗБЕРЕЖЕННЯ
app.post('/api/save', (req, res) => {
    const { fullSku, baseSku, nextSeq, category, weight, totalPrice, pricePerGram, details } = req.body;
    const stmt = db.prepare(`INSERT INTO products (full_sku, base_sku, sequence_number, category, weight, total_price, price_per_gram, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(fullSku, baseSku, nextSeq, category, weight, totalPrice, pricePerGram, JSON.stringify(details), function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
    stmt.finalize();
});

// ВИДАЛЕННЯ
app.post('/api/delete', (req, res) => {
    const { skuToDelete } = req.body; 

    if (!skuToDelete || skuToDelete.length < 4) return res.status(400).json({ error: "Некоректний формат" });

    // Визначаємо категорію з перших букв артикулу (BR, AR...)
    const catCode = skuToDelete.substring(0, 2); 
    const sequenceCategories = ['AR', 'DK'];
    const isSequenceBased = sequenceCategories.includes(catCode);

    // Логіка видалення
    if (isSequenceBased) {
        // ДЛЯ КАРТИН/ДЕКОРУ: Перевіряємо чи це останній
        const baseSku = skuToDelete.slice(0, -3); 
        db.get("SELECT sequence_number FROM products WHERE base_sku = ? ORDER BY sequence_number DESC LIMIT 1", [baseSku], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: "Артикул не знайдено." });

            const lastSeqInDb = row.sequence_number;
            const requestedSeq = parseInt(skuToDelete.slice(-3));

            if (lastSeqInDb !== requestedSeq) {
                return res.status(400).json({ error: `Неможливо видалити ${skuToDelete}, бо існує новіший запис. Видаляйте з кінця.` });
            }
            
            deleteItem(skuToDelete, res);
        });
    } else {
        // ДЛЯ ЮВЕЛІРКИ: Видаляємо без перевірки порядку (бо вага не залежить одна від одної)
        deleteItem(skuToDelete, res);
    }
});

function deleteItem(sku, res) {
    db.run("DELETE FROM products WHERE full_sku = ?", [sku], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: "Артикул не знайдено." });
        res.json({ success: true, message: `Артикул ${sku} успішно видалено.` });
    });
}

app.get('/api/products', (req, res) => {
    db.all("SELECT * FROM products ORDER BY created_at DESC LIMIT 50", [], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(rows);
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});