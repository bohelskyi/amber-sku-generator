// Конфігурація категорій, питань та цін

const categories = {
    BR: { name: "Браслети", code: "BR" },
    NM: { name: "Намиста", code: "NM" },
    CH: { name: "Чотки", code: "CH" },
    KL: { name: "Кулони", code: "KL" },
    DK: { name: "Декор", code: "DK" },
    SK: { name: "Сувенірний камінь", code: "SK" },
    AR: { name: "Картини", code: "AR" }
};

const questions = {
    BR: [
        { id: 'raw_type', label: 'Тип сировини', sku_index: 0, options: [{id: 1, label: 'Натуральний'}, {id: 2, label: 'Формований'}] },
        { id: 'processing', label: 'Обробка', sku_index: 1, options: [{id: 1, label: 'Поліровані'}, {id: 2, label: 'Шліфовані'}] },
        { id: 'quality', label: 'Якість', sku_index: 2, options: [{id: 1, label: '1 сорт - чисті'}, {id: 2, label: '2 сорт - природні включення'}, {id: 3, label: '3 сорт - все інше'}] },
        { id: 'texture', label: 'Фактура', sku_index: 3, options: [{id: 1, label: 'Прозорий'}, {id: 2, label: 'Напівпрозорий'}, {id: 3, label: 'Матовий'}, {id: 4, label: 'Прозорий-жовтий'}, {id: 5, label: 'Напівпрозорий-жовтий'}, {id: 6, label: 'Матовий-жовтий'}, {id: 7, label: 'Пейзажний'}, {id: 8, label: 'Змішаний'}] },
        { id: 'color', label: 'Колір', sku_index: 4, options: [{id: 1, label: 'Світлий'}, {id: 2, label: 'Темний'}, {id: 3, label: 'Пейзажний'}, {id: 4, label: 'Комбінований'}] },
        { id: 'size', label: 'Розмір', sku_index: 5, options: [{id: 1, label: '5-10 Ø'}, {id: 2, label: '10-15 Ø'}, {id: 3, label: '15+ Ø'}, {id: 4, label: '0-1'}, {id: 5, label: '1-2'}, {id: 6, label: '2-5'}] },
        { id: 'shape', label: 'Форма', sku_index: 6, options: [{id: 1, label: 'Куля'}, {id: 2, label: 'Бочка'}, {id: 3, label: 'Оливка'}, {id: 4, label: 'Сегменти'}, {id: 5, label: 'Галька'}, {id: 6, label: 'Геометрія'}] },
        { id: 'style', label: 'Виконання', sku_index: 7, options: [{id: 1, label: 'Класичний'}, {id: 2, label: 'Комбіновані'}] },
    ],

    NM: [
        { id: 'raw_type', label: 'Тип сировини', sku_index: 0, options: [{id: 1, label: 'Натуральний'}, {id: 2, label: 'Формований'}] },
        { id: 'processing', label: 'Обробка', sku_index: 1, options: [{id: 1, label: 'Поліровані'}, {id: 2, label: 'Шліфовані'}] },
        { id: 'quality', label: 'Якість', sku_index: 2, options: [{id: 1, label: 'I сорт — чисті'}, {id: 2, label: 'II сорт — природні'}, {id: 3, label: 'III сорт — все інше'}] },
        { id: 'texture', label: 'Фактура', sku_index: 3, options: [{id: 1, label: 'Прозорий'}, {id: 2, label: 'Напівпрозорий'}, {id: 3, label: 'Матовий'}, {id: 4, label: 'Прозорий — жовтий'}, {id: 5, label: 'Напівпрозорий — жовтий'}, {id: 6, label: 'Матовий — жовтий'}, {id: 7, label: 'Пейзажний'}, {id: 8, label: 'Змішаний'}] },
        { id: 'color', label: 'Колір', sku_index: 4, options: [{id: 1, label: 'Світлий'}, {id: 2, label: 'Темний'}, {id: 3, label: 'Пейзажний'}, {id: 4, label: 'Комбінований'}] },
        { id: 'size', label: 'Розмір', sku_index: 5, options: [{id: 1, label: '5-10 Ø'}, {id: 2, label: '10-15 Ø'}, {id: 3, label: '15+ Ø'}, {id: 4, label: '0-1'}, {id: 5, label: '1-2'}, {id: 6, label: '2-5'}] },
        { id: 'shape', label: 'Форма', sku_index: 6, options: [{id: 1, label: 'Куля'}, {id: 2, label: 'Бочка'}, {id: 3, label: 'Оливка'}, {id: 4, label: 'Сегменти'}, {id: 5, label: 'Галька'}, {id: 6, label: 'Геометрія'}] },
        { id: 'style', label: 'Виконання', sku_index: 7, options: [{id: 1, label: 'Класичний'}, {id: 2, label: 'Комбіновані'}] },
        { id: 'extra', label: 'Додатково', sku_index: 8, options: [{id: 1, label: 'З підвісками'}] },
    ],

    CH: [
        { id: 'raw_type', label: 'Тип сировини', sku_index: 0, options: [{id: 1, label: 'Натуральний'}, {id: 2, label: 'Формований'}] },
        { id: 'quality', label: 'Якість', sku_index: 1, options: [{id: 1, label: 'I сорт — чисті'}, {id: 2, label: 'II сорт — природні включення'}, {id: 3, label: 'III сорт — все інше'}] },
        { id: 'texture', label: 'Фактура', sku_index: 2, options: [{id: 1, label: 'Прозорий'}, {id: 2, label: 'Напівпрозорий'}, {id: 3, label: 'Матовий'}, {id: 4, label: 'Прозорий — жовтий'}, {id: 5, label: 'Напівпрозорий — жовтий'}, {id: 6, label: 'Матовий — жовтий'}, {id: 7, label: 'Пейзажний'}] },
        { id: 'color', label: 'Колір', sku_index: 3, options: [{id: 1, label: 'Світлий'}, {id: 2, label: 'Темний'}, {id: 3, label: 'Пейзажний'}] },
        { id: 'size', label: 'Розмір', sku_index: 4, options: [{id: 1, label: '5-10 Ø'}, {id: 2, label: '10-15 Ø'}, {id: 3, label: '15+ Ø'}] },
        { id: 'shape', label: 'Форма', sku_index: 5, options: [{id: 1, label: 'Куля'}, {id: 2, label: 'Бочка'}, {id: 3, label: 'Оливка'}] },
        { id: 'religion', label: 'Релігія', sku_index: 6, options: [{id: 1, label: 'Мусульманські'}, {id: 2, label: 'Православні'}] },
        { id: 'count', label: 'Кількість намистин', sku_index: 7, options: [{id: 1, label: '31'}, {id: 2, label: '41'}, {id: 3, label: '45'}] },
    ],

    KL: [
        { id: 'raw_type', label: 'Тип сировини', sku_index: 0, options: [{id: 1, label: 'Натуральний'}, {id: 2, label: 'Формований'}] },
        { id: 'processing', label: 'Обробка', sku_index: 1, options: [{id: 1, label: 'Поліровані'}, {id: 2, label: 'Шліфовані'}] },
        { id: 'quality', label: 'Якість', sku_index: 2, options: [{id: 1, label: 'I сорт — чисті'}, {id: 2, label: 'II сорт — природні'}, {id: 3, label: 'III сорт — все інше'}] },
        { id: 'texture', label: 'Фактура', sku_index: 3, options: [{id: 1, label: 'Прозорий'}, {id: 2, label: 'Напівпрозорий'}, {id: 3, label: 'Матовий'}, {id: 4, label: 'Прозорий — жовтий'}, {id: 5, label: 'Напівпрозорий — жовтий'}, {id: 6, label: 'Матовий — жовтий'}, {id: 7, label: 'Пейзажний'}] },
        { id: 'color', label: 'Колір', sku_index: 4, options: [{id: 1, label: 'Світлий (жовтий)'}, {id: 2, label: 'Темний (всі інші)'}] },
        { id: 'size', label: 'Розмір', sku_index: 5, options: [{id: 1, label: '5-10 Ø'}, {id: 2, label: '10-15 Ø'}, {id: 3, label: '15+ Ø'}, {id: 4, label: '0-1'}, {id: 5, label: '1-2'}, {id: 6, label: '2-5'}] },
        { id: 'type', label: 'Тип кулону', sku_index: 6, options: [{id: 1, label: 'Природна форма'}, {id: 2, label: 'Підвіска'}, {id: 3, label: 'Кабашон'}] },
        { id: 'shape', label: 'Форма', sku_index: 7, options: [{id: 1, label: 'Коло'}, {id: 2, label: 'Овал'}, {id: 3, label: 'Серце'}] },
    ],

    DK: [
        { id: 'category', label: 'Сувеніри', sku_index: 0, options: [{id: 1, label: 'Статуетки'}, {id: 2, label: 'Брелоки'}, {id: 3, label: 'Лампи'}, {id: 4, label: 'Настільні ігри'}, {id: 5, label: 'Письмові набори'}, {id: 6, label: 'Скриньки'}, {id: 7, label: 'Інше'}] },
        { id: 'color', label: 'Колір', sku_index: 1, options: [{id: 1, label: 'Світлий'}, {id: 2, label: 'Темний'}, {id: 3, label: 'Змішаний'}] },
        { id: 'theme', label: 'Тематика', sku_index: 2, options: [{id: 1, label: 'Фауна'}, {id: 2, label: 'Знак зодіаку'}, {id: 3, label: 'Символіка'}, {id: 4, label: 'Морська'}, {id: 5, label: 'Машини'}] },
        { id: 'extra', label: 'Додатково', sku_index: 3, options: [{id: 1, label: 'З підсвіткою'}] },
    ],

    SK: [
        { id: 'weight_group', label: 'Розмірна група', sku_index: 0, options: [{id: 1, label: 'до 50г'}, {id: 2, label: '50-100г'}, {id: 3, label: '100-200г'}, {id: 4, label: '200г - 500г'}, {id: 5, label: '500г+'}] },
        { id: 'texture', label: 'Фактура', sku_index: 1, options: [{id: 1, label: 'Прозорий'}, {id: 2, label: 'Напівпрозорий'}, {id: 3, label: 'Матовий'}, {id: 4, label: 'Прозорий — жовтий'}, {id: 5, label: 'Напівпрозорий — жовтий'}, {id: 6, label: 'Матовий — жовтий'}, {id: 7, label: 'Пейзажний'}, {id: 8, label: 'Шаруватий'}] },
        { id: 'extra', label: 'Додатково', sku_index: 2, options: [{id: 1, label: 'З інклюзією'}] },
    ],

    AR: [
        { id: 'type', label: 'Тип картини', sku_index: 0, options: [{id: 1, label: 'Ікони'}, {id: 2, label: 'Пейзажі'}, {id: 3, label: 'Панно'}, {id: 4, label: 'Символіка'}, {id: 5, label: 'Натюрморти'}] },
        { id: 'size', label: 'Розмір картини', sku_index: 1, options: [{id: 1, label: '10x15'}, {id: 2, label: '15x20'}, {id: 3, label: '20x30'}, {id: 4, label: '30x40'}, {id: 5, label: '30x50'}, {id: 6, label: '30x60'}, {id: 7, label: '40x60'}, {id: 8, label: '40x80'}, {id: 9, label: '60x80'}, {id: 0, label: '80x120'}] },
        { id: 'frame', label: 'Рамка', sku_index: 2, options: [{id: 1, label: 'Світла'}, {id: 2, label: 'Темна'}, {id: 3, label: 'Золота'}] },
        { id: 'glass', label: 'Скло', sku_index: 3, options: [{id: 1, label: 'Зі склом'}, {id: 2, label: 'Без скла'}] },
    ]
};

const extraConfig = {
    is_calibrated: { 
        label: "Сировина калібрована?", 
        options: [
            {id: 1, label: "Так (Калібрована)"},
            {id: 2, label: "Напівкалібрована"},
            {id: 0, label: "Ні (Некалібрована)"}
        ] 
    }
};

const naturalCalibratedPrices = {
    1: { 1: 3, 2: 3.5, 3: 5, 4: 4, 5: 4.5, 6: 8, 7: 10, 8: 5 },  // Розмір 5-10
    2: { 1: 4.5, 2: 5, 3: 8, 4: 6, 5: 7, 6: 10, 7: 12, 8: 8 },  // Розмір 10-15
    3: { 1: 6, 2: 7, 3: 10, 4: 8, 5: 10, 6: 12, 7: 15, 8: 10 }  // Розмір 15+
};

const formedPrices = {
    1: 3, // 1 сорт
    2: 2, // 2 сорт
    3: 1  // 3 сорт
};

const uncalibratedPrices = {
    // Розміри тут інші за твоїм описом: 4=(0-1/відсів), 5=(1-2), 6=(2-5)
    // Ціни для ШЛІФОВАНОГО
    4: 0.3,
    5: 0.5,
    6: 1.0
};

module.exports = { categories, questions, extraConfig, naturalCalibratedPrices, formedPrices, uncalibratedPrices };
