const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const https = require('https');
const initialConfig = require('./data_config');

const app = express();
const PORT = 5000;

const NBU_USD_URL = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json';
let cachedUsdUahRate = null;
let cachedUsdUahDate = null;

function getKyivDateString() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' });
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https
            .get(url, (res) => {
                let raw = '';
                res.on('data', (chunk) => {
                    raw += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        return reject(new Error(`NBU HTTP ${res.statusCode}`));
                    }
                    try {
                        resolve(JSON.parse(raw));
                    } catch (err) {
                        reject(err);
                    }
                });
            })
            .on('error', reject);
    });
}

async function getUsdUahRate() {
    const today = getKyivDateString();
    if (cachedUsdUahRate && cachedUsdUahDate === today) return cachedUsdUahRate;

    const data = await fetchJson(NBU_USD_URL);
    const rate = data && data[0] && data[0].rate ? Number(data[0].rate) : null;
    if (!rate) throw new Error('NBU rate missing');

    cachedUsdUahRate = rate;
    cachedUsdUahDate = today;
    return rate;
}

app.use(cors());
app.use(bodyParser.json());

const db = new sqlite3.Database('./amber.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to SQLite database.');
    initDb();
});

function initDb() {
    db.serialize(() => {
        // --- РџР РћР”РЈРљРўР ---
        db.run(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_sku TEXT, base_sku TEXT, sequence_number INTEGER, category TEXT,
            weight REAL, total_price REAL, price_per_gram REAL, details TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // --- РЎРўР РЈРљРўРЈР Рђ (РљР°С‚РµРіРѕСЂС–С—, РџРёС‚Р°РЅРЅСЏ, РћРїС†С–С—) ---
        db.run(`CREATE TABLE IF NOT EXISTS categories (code TEXT PRIMARY KEY, name TEXT, requires_weight INTEGER DEFAULT 1)`);
        db.run(`CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, category_code TEXT, key TEXT, label TEXT, sku_index INTEGER, required INTEGER DEFAULT 1,
            FOREIGN KEY(category_code) REFERENCES categories(code)
        )`);
        // Add required column for existing DBs (ignore error if already exists)
        db.run("ALTER TABLE questions ADD COLUMN required INTEGER DEFAULT 1", () => {});
        db.run("UPDATE questions SET required = 1 WHERE required IS NULL");
        db.run(`CREATE TABLE IF NOT EXISTS options (
            id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER, value_id INTEGER, label TEXT,
            FOREIGN KEY(question_id) REFERENCES questions(id)
        )`);

        // --- Р¦Р†РќР (РќРћР’Р† РўРђР‘Р›РР¦Р†) ---
        
        // 1. РЎС†РµРЅР°СЂС–С—: Р’РёР·РЅР°С‡Р°СЋС‚СЊ, РєРѕР»Рё Р·Р°СЃС‚РѕСЃРѕРІСѓРІР°С‚Рё С†С–РЅСѓ (РЅР°РїСЂ. "РќР°С‚СѓСЂР°Р»СЊРЅРёР№ РљР°Р»С–Р±СЂРѕРІР°РЅРёР№")
        // match_json: {"raw_type": 1, "is_calibrated": 1}
        // axis_x_key: "size", axis_y_key: "texture" (РЇРєС– РїРёС‚Р°РЅРЅСЏ С„РѕСЂРјСѓСЋС‚СЊ С‚Р°Р±Р»РёС†СЋ)
        db.run(`CREATE TABLE IF NOT EXISTS price_scenarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category_code TEXT,
            name TEXT,
            match_json TEXT, 
            axis_x_key TEXT,
            axis_y_key TEXT
        )`);

        // 2. РњР°С‚СЂРёС†СЏ С†С–РЅ: РљРѕРЅРєСЂРµС‚РЅС– С†РёС„СЂРё
        // x_val: 1 (ID СЂРѕР·РјС–СЂСѓ), y_val: 2 (ID С„Р°РєС‚СѓСЂРё), price: 5.0
        db.run(`CREATE TABLE IF NOT EXISTS price_matrix (
            scenario_id INTEGER,
            x_val INTEGER,
            y_val INTEGER,
            price REAL,
            FOREIGN KEY(scenario_id) REFERENCES price_scenarios(id)
        )`);

        // 3. РњРѕРґРёС„С–РєР°С‚РѕСЂРё: Р—РЅРёР¶РєРё/РќР°С†С–РЅРєРё
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

        // Ensure sequence-based categories (override any existing DB values)
        db.run("UPDATE categories SET requires_weight = 0 WHERE code IN ('AR', 'DK', 'SK')");
    });
}

function migrateData() {
    // 1. РњС–РіСЂР°С†С–СЏ СЃС‚СЂСѓРєС‚СѓСЂРё (СЏРє РјРёРЅСѓР»РѕРіРѕ СЂР°Р·Сѓ)
    const stmtCat = db.prepare("INSERT INTO categories (code, name, requires_weight) VALUES (?, ?, ?)");
    const stmtQuest = db.prepare("INSERT INTO questions (category_code, key, label, sku_index, required) VALUES (?, ?, ?, ?, ?)");
    const stmtOpt = db.prepare("INSERT INTO options (question_id, value_id, label) VALUES (?, ?, ?)");

    db.serialize(() => {
        for (const [code, cat] of Object.entries(initialConfig.categories)) {
            const reqWeight = (code === 'AR' || code === 'DK' || code === 'SK') ? 0 : 1;
            stmtCat.run(code, cat.name, reqWeight);
            
            const questions = initialConfig.questions[code] || [];
            questions.forEach(q => {
                stmtQuest.run(code, q.id, q.label, q.sku_index, 1, function(err) {
                    if (err) console.error(err);
                    const qId = this.lastID;
                    q.options.forEach(opt => {
                        stmtOpt.run(qId, opt.id, opt.label);
                    });
                });
            });
        }

        // 2. РњР†Р“Р РђР¦Р†РЇ Р¦Р†Рќ (РҐР°СЂРґРєРѕРґ -> Р‘Р”)
        // Р¦Рµ РѕРґРЅРѕСЂР°Р·РѕРІР° Р»РѕРіС–РєР°, С‰РѕР± С‚Рё РЅРµ РІР±РёРІР°РІ С†С–РЅРё РІСЂСѓС‡РЅСѓ Р· РЅСѓР»СЏ
        migratePricesToDB();
    });
}

function migratePricesToDB() {
    const { naturalCalibratedPrices, formedPrices, uncalibratedPrices } = initialConfig;

    // --- РЎР¦Р•РќРђР Р†Р™ 1: Р¤РћР РњРћР’РђРќРР™ (CH, BR, NM...) ---
    // Р”Р»СЏ РІСЃС–С… СЋРІРµР»С–СЂРЅРёС… РєР°С‚РµРіРѕСЂС–Р№ РґРѕРґР°РјРѕ СЃС†РµРЅР°СЂС–Р№ "Р¤РѕСЂРјРѕРІР°РЅРёР№"
    // Р—Р°Р»РµР¶РёС‚СЊ С‚С–Р»СЊРєРё РІС–Рґ Quality (РІС–СЃСЊ X)
    ['CH', 'BR', 'NM', 'KL'].forEach(cat => {
        db.run(`INSERT INTO price_scenarios (category_code, name, match_json, axis_x_key, axis_y_key) 
                VALUES (?, 'Р¤РѕСЂРјРѕРІР°РЅРёР№', ?, 'quality', NULL)`, 
                [cat, JSON.stringify({ raw_type: 2 })], function(err) {
            
            const scenarioId = this.lastID;
            // Р—Р°РїРѕРІРЅСЋС”РјРѕ С†С–РЅРё: 1СЃ=3, 2СЃ=2, 3СЃ=1
            const stmt = db.prepare("INSERT INTO price_matrix (scenario_id, x_val, y_val, price) VALUES (?, ?, ?, ?)");
            stmt.run(scenarioId, 1, 0, 3);
            stmt.run(scenarioId, 2, 0, 2);
            stmt.run(scenarioId, 3, 0, 1);
            stmt.finalize();
        });
    });

    // --- РЎР¦Р•РќРђР Р†Р™ 2: РќРђРўРЈР РђР›Р¬РќРР™ РљРђР›Р†Р‘Р РћР’РђРќРР™ (CH, BR...) ---
    // Р—Р°Р»РµР¶РёС‚СЊ РІС–Рґ Size (X) С‚Р° Texture (Y)
    ['CH', 'BR', 'NM', 'KL'].forEach(cat => {
        db.run(`INSERT INTO price_scenarios (category_code, name, match_json, axis_x_key, axis_y_key) 
                VALUES (?, 'РќР°С‚СѓСЂ. РљР°Р»С–Р±СЂРѕРІР°РЅРёР№', ?, 'size', 'texture')`, 
                [cat, JSON.stringify({ raw_type: 1, is_calibrated: 1 })], function(err) {
            
            const scenarioId = this.lastID;
            const stmt = db.prepare("INSERT INTO price_matrix (scenario_id, x_val, y_val, price) VALUES (?, ?, ?, ?)");
            
            // РџСЂРѕС…РѕРґРёРјРѕСЃСЊ РїРѕ РѕР±'С”РєС‚Сѓ С†С–РЅ Р· С„Р°Р№Р»Сѓ
            for (const [sizeId, textures] of Object.entries(naturalCalibratedPrices)) {
                for (const [texId, price] of Object.entries(textures)) {
                    stmt.run(scenarioId, sizeId, texId, price);
                }
            }
            stmt.finalize();
        });

        // РњРћР”РР¤Р†РљРђРўРћР : 2 СЃРѕСЂС‚ = -30% (factor 0.7)
        db.run("INSERT INTO price_modifiers (category_code, trigger_key, trigger_val, factor) VALUES (?, 'quality', 2, 0.7)", [cat]);
    });

    // --- РЎР¦Р•РќРђР Р†Р™ 3: РќРђРўРЈР РђР›Р¬РќРР™ РќР•РљРђР›Р†Р‘Р РћР’РђРќРР™ ---
    // Р—Р°Р»РµР¶РёС‚СЊ РІС–Рґ Size (X) С‚Р° Processing (Y) (Р°Р»Рµ РІ Р§РѕС‚РєР°С… Processing РЅРµРјР° РІ РїРёС‚Р°РЅРЅСЏС… data_config, С‚РѕРјСѓ С†Рµ СЃРїСЂР°С†СЋС” С‚С–Р»СЊРєРё С‚Р°Рј РґРµ С” С‚Р°РєРµ РїРёС‚Р°РЅРЅСЏ)
    // Р”Р»СЏ СЃРїСЂРѕС‰РµРЅРЅСЏ, РјС–РіСЂР°С†С–СЏ РїРµСЂРµРЅРµСЃРµ РѕСЃРЅРѕРІРЅС– С†С–РЅРё.
    
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
                requires_weight: r.requires_weight // РџРµСЂРµРґР°С”РјРѕ РЅР°Р»Р°С€С‚СѓРІР°РЅРЅСЏ РІР°РіРё РЅР° С„СЂРѕРЅС‚
            };
        });

        db.all(`SELECT q.id as q_db_id, q.category_code, q.key, q.label as q_label, q.sku_index, q.required,
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
                        required: row.required,
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
        // РћС‚СЂРёРјСѓС”РјРѕ СЃС†РµРЅР°СЂС–С— С‚Р° С—С… РјР°С‚СЂРёС†С–
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

// --- API: Р—Р‘Р•Р Р•Р–Р•РќРќРЇ Р¦Р†РќР (РЇР§Р•Р™РљР) ---
app.post('/api/admin/price-cell', (req, res) => {
    const { scenario_id, x_val, y_val, price } = req.body;
    // UPSERT (Р’СЃС‚Р°РІРёС‚Рё Р°Р±Рѕ РћРЅРѕРІРёС‚Рё)
    db.run(`DELETE FROM price_matrix WHERE scenario_id = ? AND x_val = ? AND y_val = ?`, [scenario_id, x_val, y_val], () => {
        const stmt = db.prepare("INSERT INTO price_matrix (scenario_id, x_val, y_val, price) VALUES (?, ?, ?, ?)");
        stmt.run(scenario_id, x_val, y_val, price, function(err) {
            if(err) return res.status(500).json(err);
            res.json({success: true});
        });
        stmt.finalize();
    });
});

// --- API: Р”РћР”РђР’РђРќРќРЇ РЎР¦Р•РќРђР Р†Р® ---
app.post('/api/admin/scenario', (req, res) => {
    const { category_code, name, match_json, axis_x_key, axis_y_key } = req.body;
    const stmt = db.prepare("INSERT INTO price_scenarios (category_code, name, match_json, axis_x_key, axis_y_key) VALUES (?, ?, ?, ?, ?)");
    stmt.run(category_code, name, JSON.stringify(match_json), axis_x_key, axis_y_key, function(err){
        res.json({id: this.lastID});
    });
});

// Р”РѕРґР°С‚Рё РјРѕРґРёС„С–РєР°С‚РѕСЂ
app.post('/api/admin/modifier', (req, res) => {
    const { category_code, trigger_key, trigger_val, factor } = req.body;
    const stmt = db.prepare("INSERT INTO price_modifiers (category_code, trigger_key, trigger_val, factor) VALUES (?, ?, ?, ?)");
    stmt.run(category_code, trigger_key, trigger_val, factor, function(err) {
        if(err) return res.status(500).json(err);
        res.json({id: this.lastID});
    });
    stmt.finalize();
});

// РћРЅРѕРІРёС‚Рё РјРѕРґРёС„С–РєР°С‚РѕСЂ
app.put('/api/admin/modifier', (req, res) => {
    const { id, factor } = req.body;
    const stmt = db.prepare("UPDATE price_modifiers SET factor = ? WHERE id = ?");
    stmt.run(factor, id, function(err) {
        if(err) return res.status(500).json(err);
        res.json({success: true});
    });
    stmt.finalize();
});

// РћРЅРѕРІР»РµРЅРЅСЏ С„СѓРЅРєС†С–С— РІРёРґР°Р»РµРЅРЅСЏ (РґРѕРґР°С”РјРѕ type === 'modifier' С– 'scenario')
app.post('/api/admin/delete-item', (req, res) => {
    const { type, id } = req.body;
    let sql = "";
    
    if (type === 'category') sql = "DELETE FROM categories WHERE code = ?";
    else if (type === 'question') sql = "DELETE FROM questions WHERE id = ?";
    else if (type === 'option') sql = "DELETE FROM options WHERE id = ?";
    else if (type === 'modifier') sql = "DELETE FROM price_modifiers WHERE id = ?"; // <--- Р”РѕРґР°Р»Рё
    else if (type === 'scenario') { // <--- Р”РѕРґР°Р»Рё РєР°СЃРєР°РґРЅРµ РІРёРґР°Р»РµРЅРЅСЏ СЃС†РµРЅР°СЂС–СЋ
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

// --- РќРћР’Рђ Р›РћР“Р†РљРђ PREVIEW (Р РћР—Р РђРҐРЈРќРћРљ Р¦Р†РќР РџРћ Р‘Р”) ---
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
            let logMessage = "Р¦С–РЅР° РЅРµ Р·РЅР°Р№РґРµРЅР°";

            // РЁСѓРєР°С”РјРѕ РїС–РґС…РѕРґСЏС‰РёР№ СЃС†РµРЅР°СЂС–Р№
            const activeScenario = scenarios.find(scen => {
                const rules = JSON.parse(scen.match_json);
                // РџРµСЂРµРІС–СЂСЏС”РјРѕ, С‡Рё РІС–РґРїРѕРІС–РґС– РєРѕСЂРёСЃС‚СѓРІР°С‡Р° СЃРїС–РІРїР°РґР°СЋС‚СЊ Р· РїСЂР°РІРёР»Р°РјРё СЃС†РµРЅР°СЂС–СЋ
                for (const [key, val] of Object.entries(rules)) {
                    if (key === 'is_calibrated') {
                        // isCalibrated РїРµСЂРµРґР°С”С‚СЊСЃСЏ РѕРєСЂРµРјРѕ, РЅРµ РІ answers
                        if (val !== (isCalibrated || 0)) return false;
                    } else {
                        if (answers[key] !== val) return false;
                    }
                }
                return true;
            });

            if (activeScenario) {
                // Р—РЅР°Р№С€Р»Рё СЃС†РµРЅР°СЂС–Р№! РўРµРїРµСЂ С€СѓРєР°С”РјРѕ С†С–РЅСѓ РІ РјР°С‚СЂРёС†С–
                const xVal = answers[activeScenario.axis_x_key] || 0;
                const yVal = activeScenario.axis_y_key ? (answers[activeScenario.axis_y_key] || 0) : 0;

                db.get("SELECT price FROM price_matrix WHERE scenario_id = ? AND x_val = ? AND y_val = ?", 
                    [activeScenario.id, xVal, yVal], (err, row) => {
                    
                    if (row) {
                        pricePerGram = row.price;
                        logMessage = `${activeScenario.name} (Base: $${row.price})`;

                        // 3. Р—Р°СЃС‚РѕСЃРѕРІСѓС”РјРѕ РјРѕРґРёС„С–РєР°С‚РѕСЂРё
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
                        logMessage = `${activeScenario.name} (РќРµРјР° С†С–РЅРё РґР»СЏ РєРѕРјР±С–РЅР°С†С–С—)`;
                        finishCalculation(0, logMessage);
                    }
                });
            } else {
                finishCalculation(0, "РќРµРјР°С” СЃС†РµРЅР°СЂС–СЋ РґР»СЏ С†РёС… РїР°СЂР°РјРµС‚СЂС–РІ");
            }
        });

        function finishCalculation(price, log) {
            const weightVal = weight ? parseFloat(weight) : 0;
            const totalPrice = (price * weightVal).toFixed(2);

            const buildCurrencyPayload = (uahRate) => {
                if (!uahRate) {
                    return { uahRate: null, pricePerGramUah: null, totalPriceUah: null };
                }
                const pricePerGramUah = (price * uahRate).toFixed(2);
                const totalPriceUah = (Number(totalPrice) * uahRate).toFixed(2);
                return { uahRate, pricePerGramUah, totalPriceUah };
            };

            const sendResponse = (currencyPayload) => {
                // Логіка SKU (Sequence vs Weight)
                db.get("SELECT requires_weight FROM categories WHERE code = ?", [categoryCode], (err, catRow) => {
                    const requiresWeight = catRow && catRow.requires_weight === 1 && categoryCode !== 'SK';

                    if (!requiresWeight) {
                        db.all("SELECT sequence_number FROM products WHERE base_sku = ? ORDER BY sequence_number DESC LIMIT 1", [baseSku], (err, rows) => {
                            let lastSeq = rows.length > 0 ? rows[0].sequence_number : 0;
                            const nextSeq = lastSeq + 1;
                            const fullProposedSku = baseSku + String(nextSeq).padStart(3, '0');
                            const prevFullSku = lastSeq > 0 ? baseSku + String(lastSeq).padStart(3, '0') : "РќРµРјР°С”";
                            res.json({ mode: 'sequence', baseSku, nextSeq, fullProposedSku, prevFullSku, pricePerGram: price.toFixed(2), totalPrice, logMessage: log, ...currencyPayload });
                        });
                    } else {
                        const weightInt = Math.round(weightVal);
                        const fullProposedSku = baseSku + String(weightInt).padStart(3, '0');
                        db.get("SELECT full_sku FROM products WHERE full_sku = ?", [fullProposedSku], (err, row) => {
                            res.json({ mode: 'weight', baseSku, nextSeq: weightInt, fullProposedSku, existsInDb: !!row, pricePerGram: price.toFixed(2), totalPrice, logMessage: log, ...currencyPayload });
                        });
                    }
                });
            };

            getUsdUahRate()
                .then((uahRate) => {
                    sendResponse(buildCurrencyPayload(uahRate));
                })
                .catch((err) => {
                    console.error('NBU rate error:', err.message || err);
                    sendResponse(buildCurrencyPayload(null));
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

// Р”РѕРґР°РІР°РЅРЅСЏ РєР°С‚РµРіРѕСЂС–С— Р· РїСЂР°РїРѕСЂС†РµРј РІР°РіРё
app.post('/api/admin/category', (req, res) => {
    const { code, name, requires_weight } = req.body;
    if (!code || !name) return res.status(400).json({ error: "Code and Name required" });
    
    const stmt = db.prepare("INSERT INTO categories (code, name, requires_weight) VALUES (?, ?, ?)");
    // РЇРєС‰Рѕ requires_weight РЅРµ РїРµСЂРµРґР°Р»Рё, РІРІР°Р¶Р°С”РјРѕ 1 (С‚Р°Рє)
    stmt.run(code, name, requires_weight !== undefined ? requires_weight : 1, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: code, name }); 
    });
    stmt.finalize();
});

// Оновити категорію (name, requires_weight)
app.put('/api/admin/category', (req, res) => {
    const { code, name, requires_weight } = req.body;
    if (!code || !name) return res.status(400).json({ error: "Code and Name required" });
    const stmt = db.prepare("UPDATE categories SET name = ?, requires_weight = ? WHERE code = ?");
    stmt.run(name, requires_weight !== undefined ? requires_weight : 1, code, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
    stmt.finalize();
});

app.post('/api/admin/question', (req, res) => {
    const { category_code, key, label, sku_index, required } = req.body;
    const stmt = db.prepare("INSERT INTO questions (category_code, key, label, sku_index, required) VALUES (?, ?, ?, ?, ?)");
    stmt.run(category_code, key, label, sku_index, required !== undefined ? required : 1, function(err) { if (err) return res.status(500).json({ error: err.message }); res.json({ id: this.lastID }); });
    stmt.finalize();
});

// Оновити питання (label, sku_index, required)
app.put('/api/admin/question', (req, res) => {
    const { id, label, sku_index, required } = req.body;
    if (!id || label === undefined) return res.status(400).json({ error: "Id and Label required" });
    const stmt = db.prepare("UPDATE questions SET label = ?, sku_index = ?, required = ? WHERE id = ?");
    stmt.run(label, sku_index, required !== undefined ? required : 1, id, function(err) { 
        if (err) return res.status(500).json({ error: err.message }); 
        res.json({ success: true }); 
    });
    stmt.finalize();
});

// Fallback for clients/environments where PUT is blocked
app.post('/api/admin/question/update', (req, res) => {
    const { id, label, sku_index, required } = req.body;
    if (!id || label === undefined) return res.status(400).json({ error: "Id and Label required" });
    const stmt = db.prepare("UPDATE questions SET label = ?, sku_index = ?, required = ? WHERE id = ?");
    stmt.run(label, sku_index, required !== undefined ? required : 1, id, function(err) { 
        if (err) return res.status(500).json({ error: err.message }); 
        res.json({ success: true }); 
    });
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

// Р’РёРґР°Р»РµРЅРЅСЏ С‚РѕРІР°СЂСѓ
app.post('/api/delete', (req, res) => {
    const { skuToDelete } = req.body; 
    if (!skuToDelete || skuToDelete.length < 4) return res.status(400).json({ error: "РќРµРєРѕСЂРµРєС‚РЅРёР№ С„РѕСЂРјР°С‚" });
    db.run("DELETE FROM products WHERE full_sku = ?", [skuToDelete], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: "РђСЂС‚РёРєСѓР» РЅРµ Р·РЅР°Р№РґРµРЅРѕ." });
        res.json({ success: true, message: `РђСЂС‚РёРєСѓР» ${skuToDelete} СѓСЃРїС–С€РЅРѕ РІРёРґР°Р»РµРЅРѕ.` });
    });
});

app.get('/api/products', (req, res) => {
    db.all("SELECT * FROM products ORDER BY created_at DESC LIMIT 15", [], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(rows);
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
