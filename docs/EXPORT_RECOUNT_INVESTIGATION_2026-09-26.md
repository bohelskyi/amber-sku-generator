# Зникнення виправленого сувеніра з експорту — 26.09.2026

**CASE C: наявне задокументоване виключення обох записів при recount.**
За критерієм цього операторського приймання — **RELEASE-BLOCKING**: наступник
не очікує наступного експорту і може назавжди залишитися поза звичайним потоком.
UX-приймання зупинено до окремого інженерного рішення. Семантику не змінено.

## Докази й точна ідентичність

Остання операція — `product_corrections.id=1436`, audit event `3196`,
`2026-09-26T11:31:28.642Z` (14:31:28 за Києвом):
`SV23150003` / **4502** → `SV23150004` / **4848**.
Згадане приблизно `1280,0` у фактичному old payload є **`"1260,0"`**;
new payload містить число **`1260`**. Фізична вага обох рядків — `1260.000`,
фінальна ціна обох — `21700.00` UAH.

| Ознака | Джерело перед recount | Джерело після recount | Наступник після recount |
| --- | --- | --- | --- |
| Product ID / SKU | 4502 / SV23150003 | 4502 / SV23150003 | 4848 / SV23150004 |
| Стан | active | corrected | active |
| exclude_from_export | 0 | 1 | 1 |
| corrected_from_product_id | null | null | 4502 |
| corrected_to_product_id | null | 4848 | null |
| details.answers.weight | рядок `1260,0` | рядок `1260,0` | число 1260 |
| Ручна UA/EN-назва | збережена пара UX-5 | та сама пара | обидва null |
| Наявність до операції | існував | той самий рядок | нового рядка ще не було |

Стан before підтверджують старий review, correction old payload і передумови
успішного серверного apply; стан after — пряме читання обох рядків та lineage.
Історичний `old_payload.answers` також містить decoded placeholder
`symbolic_stat: 0`; фактичні збережені answers джерела його не містять, і target
його не зберіг. Це не окреме виправлення числової ваги на тому самому ID.

За дві хвилини перед цим є ще дві аналогічні операторські операції:
1434: `SV13150002` / 4501 → `SV13150005` / 4846 (`1520,0` → 1520);
1435: `SV13150003` / 4503 → `SV13150006` / 4847 (`1890,0` → 1890).
Тому загальна кількість у збереженому review і свіжому review відрізняється на 3.
Випадкових товарів для повторного виправлення не обирали.

## Діапазон і реальний localhost

Наявна вкладка in-app browser зберегла preview від **13:49:28** до цих трьох
операцій: **87 представлених, 68 готових, 19 проблемних**. Його anchors:
`AR3-7-000030` / **4085** — `SV249001` / **4845**; порядок визначається product ID.
Рядки 55/56 показували саме `SV23150003`, основну та EN-назву, ціну 21700 й
помилку `decor_weight`: «Немає додатної ваги для Magento.»
У mapper `numericWeight()` викликає `Number(value)`; для рядка `1260,0` це NaN.
Для SV він читає `details.answers.weight`, а не числову колонку `products.weight`.

Початкову вкладку не перезавантажували. У другій тимчасовій вкладці виконали
лише read-only preview: о **14:46:21** він повернув **84 представлених,
68 готових, 16 проблемних**, ті самі anchors **4085–4845**.
Фільтри готовності й мови були «Усі»; обох SKU 4502/4848 у свіжому review немає.
Старий fingerprint `0f108e755f24b277cf3ce63e9c560d5bb4fe03d1dda9ad8bec6c5cb19900e7d8`,
новий `135a1ad98ef763f530ffebc3ca9796f9a595face2b2524ee4f1aa7501e625eac`.

Product 4502 був усередині діапазону; 4848 — за його верхньою межею.
Проте **причина виключення не в цій межі**: свіжий New-preview повторно
визначає крайні eligible IDs, а наступник не eligible через прапорець 1.
Ручний діапазон, який явно охоплює наступника, також його відфільтровує.
CASE B, де eligible successor просто очікує поза frozen range, не підтвердився.

## Шлях запитів і UX-5

1. `useProductRecount` надсилає `POST /api/recount/apply`.
   `products.routes.js` викликає `applyProductRecount()` із actor context.
   Авторизація, active-user/CSRF, transaction і source-state revalidation збережені.
2. `product.service.js` вставляє новий active рядок з `exclude_from_export=1`,
   встановлює джерелу corrected/exclude=1, зв'язки й durable correction/audit.
   Це наявна поведінка, прямо описана в `RECOUNT_CORRECTIONS.md` і `EXPORTS.md`;
   відповідні production-файли не змінені в UX-5 чи цьому розслідуванні.
3. Успішну відповідь перехоплює `client/src/lib/api.js`, подія
   `notifyExportReviewChanged({kind:'product'})` потрапляє до
   `useProductExportController.refreshAfterProductChange()` за наявності handoff.
4. Controller інвалідує стару перевірку/response ticket і надсилає
   `exportsApi.preview(evidence.intent)` → **POST /api/export/preview,
   `{mode:'new'}`**. Він повторює початковий intent, без resolved SKU/ID anchors.
   Новий response/fingerprint замінює preview. Початкова невизначена операція
   створення, якщо вона є, зберігає власні payload/key/evidence.
5. `exports.routes.js` → `previewExport()` → `resolveNewExportRange()`:
   `id > confirmed cursor AND COALESCE(exclude_from_export,0)=0`.
   `getExportRows()` повторює exclusion-фільтр. Наступника немає вже у серверній
   вибірці; React не одержує його як рядок review і не підміняє попередника.

Логи підтверджують часовий порядок останньої операції:
`11:31:28.689Z` apply 200, request `a2922ba0-1e81-4969-9191-a33944980875`;
`11:31:28.714Z` export preview 200, request `9ae5f9aa-cbb6-4022-8226-90cc00047d09`;
`11:31:28.721Z` export status 200. Тіла історичних HTTP-запитів/відповідей
не логуються: їхню форму встановлено з controller/route і регресії, а не
видано за перехоплений мережевий payload.

## Pending, exposure і курсор

Локальний confirmed cursor — **4063**. `/api/export/status` показує **84**
нові eligible товари, від **4085** до **4845**. Product 4848 не врахований.
Для 4502/4848 немає рядків `product_export_revisions`, отже немає й
product-snapshot exposure, яке могло б перенести проблему в price stream.

Свіжий поточний review ще має 16 помилок, тому зараз snapshot створити не можна.
Якби незмінне членство цього діапазону стало ready, його snapshot/confirmation
просунув би курсор максимум до **4845**, не до 4848. Але наступник навіть тоді
**не залишиться pending**: exclusion вже прибирає його незалежно від курсора.

Після створення пізнішого eligible товару з ID > 4848 новий snapshot може
містити його та при confirmation просунути курсор повз 4848 через `GREATEST`.
Наступник і далі не матиме exposure. Навіть гіпотетичне пізніше зняття прапорця
вже не повернуло б ID нижче курсора до New-stream. Звичайного runtime-командного
шляху повернення `exclude_from_export` з 1 у 0 у перевіреному коді немає.

Отже твердження «оновлена версія потрапить у наступний експорт» тут було б
неправдивим. Розширення діапазону або новий preview саме по собі не допоможе.
Задокументовану стару exclusion-політику не називаємо новою регресією UX-5;
її конфлікт із workflow «виправити для експорту» є блокером цього релізного приймання.

Додатково: наступник не успадкував ручну Magento-назву. Вага після recount
мапиться як `1260`, але навіть після окремого рішення про eligibility
потрібно врахувати `manual_name_required`. Автоматичного перенесення назви не додано.

## Регресія та перевірка

Додано `server/integration-test/11-export-recount-exclusion.cases.js` у єдиний
послідовний integration entrypoint. Синтетичні fixtures створюються лише в `_test`.
Тест через авторизовані HTTP routes відтворює старий comma-answer → проблемний
New-preview → справжній recount → нові ID/SKU/exclusion/history → повторний
New-preview зі зміненим fingerprint → explicit successor range → capture/confirm
поточного діапазону → відсутність pending → пізніший товар/capture/confirm →
курсор повз наступника без його exposure. Перевіряє кінцеву БД, а не лише HTTP status.

Це characterization regression наявного небажаного результату: зелений тест
доводить відтворення, а не усунення блокера.

- Node **20.20.2**, зовнішній preload guard і журнал child workers.
- PostgreSQL **16.15**, **127.0.0.1:56432 / amber_test**; фактичне ім'я
  перевірено перед runner. Лише canonical `postgres-test` із наявним тимчасовим
  зовнішнім Compose override; без fallback на іншу БД.
- Focused reproduction: **1/1 PASS**.
- Повний server integration suite: **206/206 PASS**, без пропусків.
- Client UX-5 + workspace routes: **31/31 PASS**; зокрема повтор `{mode:'new'}`,
  stale/failure/principal fencing і незмінність uncertain command identity.
- `node --check` нового case та `git diff --check`: **PASS**.
  `postgres-test` зупинено після перевірок.
- Production server/client код не виправлявся; додано лише regression та звіт.
  Повні unit/lint/build результати попереднього UX-5 наведено в його аудиті;
  їх не видаємо за заново виконані в цьому розслідуванні.

## Неблокуючий висновок щодо налаштувань

Перевірено реальну форму `/exports/new/template` і `Settings` /
`ControlledExportOptions` без створення сесії чи збереження налаштувань.
У цій локальній конфігурації рекомендовану публікацію ще не вибрано;
explicit dropdown має дві доступні публікації. Полірування не повинно приховати
цю причину недоступності рекомендованого режиму.

| Контроль | Поточне значення | Потреба у звичайній роботі |
| --- | --- | --- |
| Назва експорту | Обов'язкова назва durable session у списку/історії; не поле CSV | Можна запропонувати редаговану назву за замовчуванням |
| Нові товари / власний діапазон | Queue після cursor або повтор за product-ID anchors | Нові товари — звичайний вибір; власний діапазон — окрема дія |
| Рекомендований / обрана версія | Active selection або pin точної immutable publication | Показувати людську назву/версію та одну дію «Змінити шаблон» |
| Опублікована версія | Потрібна лише для explicit pin; не draft і не «latest» сімейства | Відкривати всередині зміни шаблону; зберегти явний вибір при відсутній active publication |
| UUID | Ручне введення family/version IDs; зараз уже collapsed details лише в explicit mode | Залишити тільки у вторинних технічних подробицях |

Одночасно показувати всі ці рішення в основному сценарії не потрібно.
Після вирішення correctness-питання доречні компактний підсумок «Нові товари ·
назва шаблону · vN», зрозумілі дії зміни й запропонована назва. Права,
відсутність автоматичного fallback і точна publication identity мають зберегтися.
Редизайн не реалізовано.

## Межа рішення

Не виконувати successor substitution, зміну exclusion, cursor, range чи confirmation
в межах UX-5. Окремо погодити:

1. Вузький серверний шлях нормалізації **еквівалентного** числового представлення
   ваги без створення нової ідентичності, або обґрунтоване прийняття decimal comma
   mapper-ом. Це можливі напрями для окремого проєктування, не готові правила;
   SV.weight залишається pricing-sensitive, allowlist інформаційного редагування
   не розширюється автоматично.
2. Політику eligibility/recovery вже створених виключених наступників з урахуванням
   predecessor exposure, підтверджених файлів, monotonic cursor та ручних назв.
   Просте зняття прапорця або обіцянка «наступного експорту» недостатні.

Корисна localhost-БД читалася через local Docker service `postgres`, database
`amber`, у `BEGIN TRANSACTION READ ONLY`; production не відкривали. Нових
виправлень, корисних snapshots/confirmations чи змін каталогу/користувачів не виконували.
Stage, commit, push та операції перемикання/очищення гілки не виконувалися.

Фінальний worktree: **49 змінених tracked + 6 нових файлів, 0 staged**.
Із цього розслідування: новий regression case, його реєстрація у
`critical-flows.test.js`, цей звіт і уточнення acceptance status у плані та
post-UX-5 аудиті. Решта — збережена попередня робота UX-5. Production logic,
міграції, залежності та спільна конфігурація в цьому розслідуванні не змінені.
