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
    sequence_number INTEGER,
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

// ПЕРЕВІРКА
app.post('/api/preview', (req, res) => {
    const { categoryCode, answers, weight, isCalibrated } = req.body;
    const catQuestions = questions[categoryCode] || [];
    let skuParts = [categoryCode];
    catQuestions.forEach(q => {
        const val = answers[q.id];
        skuParts.push(val ? val : 0);
    });
    const baseSku = skuParts.join('');

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

    db.all("SELECT sequence_number FROM products WHERE base_sku = ? ORDER BY sequence_number DESC LIMIT 1", [baseSku], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        let lastSeq = 0;
        if (rows.length > 0) lastSeq = rows[0].sequence_number;
        const nextSeq = lastSeq + 1;
        const nextSeqString = String(nextSeq).padStart(3, '0'); 
        const prevSeqString = lastSeq > 0 ? String(lastSeq).padStart(3, '0') : null;
        const fullProposedSku = baseSku + nextSeqString;
        const prevFullSku = lastSeq > 0 ? baseSku + prevSeqString : "Немає (Це перший)";

        res.json({ baseSku, nextSeq, fullProposedSku, prevFullSku, pricePerGram: pricePerGram.toFixed(2), totalPrice, logMessage });
    });
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

// --- НОВИЙ ЕНДПОІНТ: ВИДАЛЕННЯ ---
app.post('/api/delete', (req, res) => {
    const { skuToDelete } = req.body; // Очікуємо повний SKU, наприклад CH111002

    if (!skuToDelete || skuToDelete.length < 4) {
        return res.status(400).json({ error: "Некоректний формат артикулу" });
    }

    // 1. Розбиваємо артикул на Базу і Номер. 
    // Ми знаємо, що останні 3 символи - це номер.
    const baseSku = skuToDelete.slice(0, -3); 
    
    // 2. Перевіряємо, який останній номер в базі для цього baseSku
    db.get("SELECT sequence_number FROM products WHERE base_sku = ? ORDER BY sequence_number DESC LIMIT 1", [baseSku], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        if (!row) {
            return res.status(404).json({ error: "Артикул не знайдено в базі." });
        }

        const lastSeqInDb = row.sequence_number;
        const requestedSeq = parseInt(skuToDelete.slice(-3));

        // 3. Порівнюємо
        if (lastSeqInDb !== requestedSeq) {
            // Користувач хоче видалити 001, а в базі вже є 002. Забороняємо.
            return res.status(400).json({ 
                error: `Неможливо видалити ${skuToDelete}, бо існує новіший запис з номером ${String(lastSeqInDb).padStart(3, '0')}. Спочатку видаліть останній.` 
            });
        }

        // 4. Видаляємо
        db.run("DELETE FROM products WHERE full_sku = ?", [skuToDelete], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: `Артикул ${skuToDelete} видалено. Лічильник зменшено.` });
        });
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