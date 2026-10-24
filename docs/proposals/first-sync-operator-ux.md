# Перший синк категорії: пропозиція операторського інтерфейсу

**Статус: дизайн і план, без реалізації.** Документ спирається на код main
`75284757984d5072a7f559a886c859e7630a5f1d` і операторський бриф від 2026-10-24.
Приклади «97 × meta_title EN», «88 × історія», 186 товарів та 89/195/106 —
повідомлення оператора, а не поточні дані, отримані під час підготовки пропозиції.

Мета — дати оператору зрозумілий шлях **категорія → причина → точні товари й
значення → перевірка → підтверджена дія → результат**, зберігши чинні правила
first-sync, історії, назв, публікації та доставки. Тут не пропонується змінювати
`first-sync*`, `historical-*`, `stable-recount-exposure.js`,
`lifecycle-recovery*`, `binding-*` чи `sync-preview-domains.js`.
Нове серверне API або координація пакетів потребуватимуть окремого погодження,
окремого PR і рев'ю власника цих контрактів.

Джерела: [поточний runbook](../FIRST_SYNC_RUNBOOK.md),
[поля first-sync](../MAGENTO_FIRST_SYNC_FIELDS.md),
[інтеграція](../MAGENTO_INTEGRATION.md),
[авторизація](../AUTH_RBAC.md), [переоблік](../RECOUNT_CORRECTIONS.md),
[принципи інтерфейсу](../APPLICATION_UX.md).

## 1. Сторінка «Перший синк» у категорії

Сторінка відкривається з категорії без прихованої вимоги мати `productId`.
Вона показує категорію, чинну публікацію правил, час спостереження і наступну
дозволену дію. Відкриття сторінки, вкладки, групи або фільтра читає лише локальні
дані. Звернення до Magento починається окремою командою перевірки.

На першому екрані потрібні:

- **Охоплення:** актуальні товари; виключені з експорту; підтверджені Magento;
  потребують рішення; ще не перевірені. Кожен лічильник має визначений scope.
  Невідомий результат не показується як нуль.
- **Групи причин:** наприклад «Заголовок у пошуку · EN — 97 товарів» або
  «Потрібна перевірка історії — 88». Окремо показати число унікальних товарів і
  число діагностик: один товар може входити до кількох груп.
- **Розділи, що чекають підтвердження:** окремий повний перелік потреб категорії,
  з поясненням, що вже перевірено, що ще не перевірено й чому.
- **Останні операції:** підтверджені локальні дії, непідтверджені результати,
  передавання в чергу та підтверджена доставка Magento.

Картка групи відповідає на три запитання: що сталося, що можна зробити, що ця дія
змінить. Групування зберігає точний код, поле, мову/store scope і контекст дії.
Історичний допуск, відновлення після переобліку, вибір назви та зміна політики не
об'єднуються у кнопку «Виправити все».

Читач без потрібного дозволу бачить причину й зрозумілу передачу задачі
уповноваженому оператору. Прихована або disabled кнопка не має бути єдиним поясненням.

## 2. Робочий шлях групи

1. **Переглянути.** Відкрити точний список SKU з поточним станом, причиною,
   мовою та доступною дією. Позначити збережені діагностики як збережені, а нову
   перевірку — часом її виконання.
2. **Перевірити вибрані.** Явна read-only перевірка через існуючі служби.
   Таблиця містить значення Amber і Magento, proposed result, точний target/scope,
   супутні imports та всі blockers. «Невідомо» і порожнє значення відрізняються.
3. **Підтвердити.** Показати конкретну дію, кількість, точні SKU, publication,
   before → after, причину й те, що лишиться невирішеним. Права, stale evidence
   та обмеження пакета не замінюються checkbox-ом.
4. **Виконати вибрані N.** Використати саме переглянутий список і original service
   token/review. Зміна membership групи не розширює його. Не позначати ще не
   перевірені рядки eligible.
5. **Переглянути результат.** Окремо applied/already applied, blocked,
   unconfirmed і not started. Підтверджені попередні елементи зберігають результат
   після помилки наступного.

«Застосувати для всіх» можна показати лише після фіксації **всього конкретного
scope** та серверної перевірки кожного елемента. Це не «всі на поточній сторінці»
і не «усі, що відповідатимуть фільтру в момент apply». До появи відповідного
серверного контракту доступне лише явне обмежене виділення і наявні single-item дії.

## 3. Чотири різні обсяги перевірки

| Обсяг | Що він означає | Що не можна стверджувати |
| --- | --- | --- |
| Категорія/мова редагування | Локальні зміни конкретного rule або policy | Що публікація зачепить лише цю категорію |
| Вибірка successor preparation | Не більше 100 selected/current products | Що знайдено всі динамічні шляхи категорії |
| Публікація | Спільна immutable binding revision і повний current-product scope | Що можна пропустити blocker іншої категорії |
| Масова операторська дія | Точний переглянутий список identities і дозволених дій | Що фільтр або groupId дає authority на майбутні товари |

### Повний перелік розділів замість першої сотні

Сьогодні [category workspace](../../client/src/components/workspace/MagentoCategoryWorkspace.jsx)
у `prepare()` передає один `productId`, коли він є в контексті.
[Successor preparation](../../server/src/services/magento/integration-successor.js)
без нього обирає перші 100 active/nonexcluded products за category/id
(рядки 202, 217–240). Literal paths можуть бути знайдені окремо, але динамічні
paths залежать від evaluated sample. Це підтверджена межа вибірки.

Потрібен **новий read model** повного category inventory: bounded evaluation всіх
релевантних current products, distinct route/path/field/language requirements,
позначки completeness, evaluated/total/not checked і точні limit/read failures.
Сторінки UI можуть бути обмежені; повнота має стосуватися інвентарю, а не
видимої сторінки. При перевищенні ресурсу — «Перевірку не завершено», без
truncated success. Відкриття сторінки не має запускати remote перевірку всіх товарів.

Заміна discovery scope чи автоматичне перенесення approvals — серверна робота.
Цей документ її не виконує і не пропонує обходити обмеження через довільний
productId або називати наявну вибірку повним оглядом.

### Чому одна категорія блокує пакет із шести

Кількість категорій не зашита як шість. Публікується одна спільна revision
поточної установки; конкретний пакет може включати шість або іншу кількість.

[Publication scope](../../server/src/services/magento/publication-scope.js)
сканує current active products усіх категорій, крім TEST-deletion identities,
у pages по 128. Чинні межі: 4096 products, 2 MiB returned evidence, 8 MiB input
page, 60 s preview і 15 s final local boundary. Це перевірка повного local scope;
вона не означає remote inspection кожного товару.

[Publication preview/apply](../../server/src/services/magento/binding-publication.js)
включає representative current-product checks та blockers, повторює точний
digest і атомарно публікує revision з handoff. Blocker affected representative
іншої категорії може зупинити всю публікацію.

Пропонований текст: **«Редагуємо Кулони · EN. Публікується спільний пакет:
6 категорій. Застосування зупинено через … у категорії …»**. Поряд — конкретне
поле, правило чи товар і точне посилання. Кнопка «Застосувати лише Кулони»
потребувала б іншої version/shared-reference моделі, описаної як окрема майбутня
задача; поточний global gate не послаблюється.

## 4. Існуючі API і дозволи

Усі наведені business endpoints мають префікс `/api` і чинний
[authentication → active-user → CSRF](../../server/src/app.js) boundary.
GET-only Magento preview часто викликається через HTTP POST, тому CSRF для
нього все одно потрібний. Actor походить із local application session.
Review hash/token не є дозволом.

| API | Чинні дозволи та дані |
| --- | --- |
| `GET /magento/problem-groups/page`, `GET /magento/problem-groups/:groupId/products` | `products.view`; saved queue grouping, category/search/reason, limit ≤ 100/offset, totals перед paging |
| `GET /admin/magento-integration` | `export_templates.view`; currentPublishedId для нового preview |
| `GET /admin/magento-integration/categories/:categoryCode`, `.../fields/:field` | `export_templates.view`; pinned template/binding/catalog context, без implicit remote observation |
| `POST .../first-sync/preview` | manage + publish + `exports.view`; exact SKU/binding, fields і blockers. Чинний client panel додатково доступний Administrator; сам HTTP preview route не має окремої перевірки actual role |
| `POST .../first-sync/apply` | ті самі capabilities; service додатково перевіряє actual Administrator до/під commit boundary |
| `POST .../first-sync/batch-preview` | ті самі capabilities та actual Administrator; спеціальний packet ≤ 10 products, ≤ 8 fields/product |
| `POST .../first-sync/history-apply` | ті самі capabilities та actual Administrator; scoped history admission, не delivery acknowledgment |
| `POST /magento/name-resolution/preview`, `.../apply` | `exports.create`; ordinary single-product name choice |
| `GET /admin/magento-recovery/products/:id` | `export_templates.publish` або `exports.reconcile`; доступні дії фільтруються |
| `POST .../products/:id/lifecycle-preview`, `.../lifecycle-apply` | `exports.reconcile`; exact reviewed lifecycle recipe |
| `POST .../jobs/:id/inspect` | `export_templates.publish`; перевірка початкової операції без dispatch |
| `GET /admin/magento-integration/bindings/:id/controlled-products`, `POST .../controlled-products/resolve` | `export_templates.view`; paged picker або exact SKU list ≤ 100 |
| `POST .../controlled/preview`, `.../controlled/apply` | manage + publish + `exports.view`; apply actual Administrator; `name_rule` додатково `exports.create` |
| `GET .../bindings/:id/handoffs` | `export_templates.view`; останніх 20 handoffs і generation-aware counts |

Тут manage/publish означають `export_templates.manage` /
`export_templates.publish`. Джерела:
[Magento routes](../../server/src/routes/admin/magento-integration.routes.js),
[recovery routes](../../server/src/routes/admin/magento-recovery.routes.js),
[product routes](../../server/src/routes/public/products.routes.js),
[first-sync service](../../server/src/services/magento/first-sync.service.js),
[batch preflight](../../server/src/services/magento/first-sync-batch-preflight.js).

Для **нових масових UI-дій** пропонується зберегти actual active Administrator
і capabilities відповідної дії, як у reviewed operator wrappers. Це не зміна
наявних delegable single-item прав. Дозволи повторно перевіряються між item та
всередині чинних mutation boundaries; role demotion зі збереженим permission
також має зупиняти batch. Нова batch capability, якщо потрібна, погоджується окремо.

## 5. Карта операторських дій

| Група / дія | Що повторно використати | Scope та реальний ефект |
| --- | --- | --- |
| Назви | [names-batch](../../server/scripts/names-batch.js) → [name resolution](../../server/src/services/magento/name-resolution.service.js) | ≤ 50 exact SKU/productId. Порівнює UA/EN pairs: вибір Amber тільки коли точно рівні, інакше Magento. Зміна local names/baseline може перевести ordinary request у pending. Це не missing-name completion і не historical name lane |
| Залишити Amber значення | [first-sync-keep-local](../../server/scripts/first-sync-keep-local.js) → canonical first-sync review/applyWithPreparedValidation | CLI ≤ 2000 SKU послідовно; approved targets, scope all, тільки offered canKeepLocal; weight лише доведене historical rounding. Показати всі супутні imports, дозвіл на них окремий. Результат pending_outward_confirmation не доводить delivery |
| Дозволити оновлення після переобліку | [recover-skus](../../server/scripts/recover-skus.js) → [lifecycle recovery](../../server/src/services/magento/lifecycle-recovery.js), stable_recount_exposure | ≤ 50 exact current public SKU; `exports.reconcile` + CLI Administrator. Blocked/not_available лишаються. Recipe записує власний handoff; не додавати другий resync автоматично |
| Перевірити legacy history | [history batch](../../server/scripts/first-sync-history-batch.js) → [cutover admission](../../server/src/services/magento/first-sync-cutover-admission.js) | ≤ 50 exact SKU/local/remote IDs; actual Administrator. Scoped immutable audit first_sync_review_only; без field changes, enqueue або acknowledgment. Recount-born products потребують іншого recipe |
| Зафіксувати scope | [scope-from-skus](../../server/scripts/scope-from-skus.js), [operator-scope](../../server/scripts/operator-scope.js) | ≤ 100; Administrator + view. Обидва режими DB read-only; apply створює новий scope artifact. UI може використати server-verified selection замість файлового кроку |
| Передати в ordinary sync | [controlled-resync](../../server/scripts/controlled-resync.js) → [controlled actions](../../server/src/services/magento/binding-controlled-actions.js) | ≤ 100; Administrator + manage/publish/exports.view. Exact current publication, IDs, reason, token. Записує handoff, не запускає worker і не скидає protected/reconciliation work |

Не виводити однакову кнопку для всіх груп із `FIRST_SYNC_*`.
Рішення залежить від свіжого server-offered action і точної історії конкретного
товару. `accept_remote` не створює нового setter; populated canonical weight,
SKU-driving answer та derived EN text залишаються під чинними обмеженнями.

Пакет `first-sync/batch-preview` має власний вузький контракт: до 10 товарів,
до 8 полів/товар, expected product/remote identity/definition, approved
SEO/price/rounded-weight decisions. Він не є готовим generic API для категорії
або для всіх 2000 SKU, які приймає keep-local CLI.

## 6. Незмінний review, журнал і часткова помилка

### Що вже гарантують інструменти

[Operator runtime](../../server/scripts/operator-cli.js) для чотирьох wrappers
зв'язує command, actor, database/target fingerprint, Magento origin, hash
розгорнутого коду, payload і planHash. Preview використовує dedicated read-only
pool та GET-only transport. Apply споживає збережений envelope і original
service token/review; не отримує нову згоду прихованим повторним preview.
[Authority helper](../../server/scripts/operator-authority.js) повторює active
capabilities та Administrator перевірку в існуючій authority-lock межі.

Файли створюються exclusive; prepared checkpoint fsync перед service call,
receipt — після. Раніше підтверджені item не відкочуються через помилку наступного.
Невдалий запис журналу після можливого commit — unconfirmed, а не доказ rollback.

**Keep-local відрізняється:** apply отримує fresh canonical review per item,
валідує переходи й пише результат; немає `--plan-hash` цього runtime.
Item-level review failures можуть продовжувати цикл, global authority/publication
failures його зупиняють. Це не готовий web «застосувати показаний plan».

**History batch також відрізняється:** pin точних input bytes через scope SHA,
prepared/receipt journal і fresh per-item observation під час apply.
Звичайні preview tokens діагностичні. Apply зупиняється на першому non-admitted;
unknown outcome не дозволяє сліпий новий token. Exact canonical receipt recovery
є, але CLI не автоматизує його. Див. [history contract](../FIRST_SYNC_HISTORY_BATCH.md).

Універсального replay для всіх дій немає. Ordinary name-resolution apply не має
exact-token receipt lookup, який є у first-sync apply чи controlled actions.
Після втрати відповіді stale-token refusal сам по собі не доводить rollback.
Для кожного action потрібен окремий read-only спосіб визначити outcome; де немає
достатнього durable receipt linkage, це прогалина майбутнього серверного контракту.
Не підтверджувати успіх лише збігом назв і не повторювати name apply автоматично.

Деплой між review/apply операційно вимагає нового preview і перегляду.
`OPERATOR_CONTEXT_CHANGED` звіряє реальні bytes/target/origin, а не подію
identical-byte redeploy. Apply не запускається одночасно з іншою масовою операцією;
сьогодні це операційне правило, **не автоматичний global mass-operation gate**.

### Що потрібно спроєктувати для web batch

Новий orchestration layer має викликати існуючі services без переписування
їхніх mutation rules. Не запускати CLI у subprocess через HTTP.

Потрібен durable run з exact membership і окремими item attempts, versioned
review evidence, original service token/review та canonical receipt references.
Конкретний storage/API/schema — відкрите серверне рішення для окремого PR;
цей документ не додає endpoint або migration і не називає їх наявними.

Поведінка:

- Перед apply перевірити exact scope, actor/capabilities, publication і stale evidence.
  Не підміняти старий перегляд новим без підтвердження.
- Перед кожною item mutation зберегти prepared intent; підтвердження бере тільки
  canonical service receipt. Всі choices одного product лишаються атомарними.
- На перший mutation error або unknown outcome зупинити наступні item. Попередні
  success залишаються; решта — not started. Немає обіцянки global rollback.
- Зупинка не скасовує вже підтверджене; не починати наступний item. Reload читає
  original run і не створює нову операцію.
- Unconfirmed відновлюється через перевірку original receipt/job/token. Retry з
  новим preview допустимий лише після визначення попереднього outcome.
- Publication, source, identity, rights або selected values змінилися — старий
  plan більше не дає apply. Оператор бачить, що саме треба перевірити заново.
- Межі item/packet залишаються чинними; нові chunking та exclusive-run coordination
  погоджуються окремо. Не дробити global publication для обходу її gate.

## 7. Конкретні зміни правил і товарів

### «Змінених полів: 0»

[changedFields](../../client/src/lib/magento-category-workspace.js) порівнює
template expressions, lookup tables та source descriptors. Окремі binding policy
decisions у це число не входять. [Category workspace](../../client/src/components/workspace/MagentoCategoryWorkspace.jsx)
передає changed.length у [publication UI](../../client/src/components/workspace/MagentoPublicationActions.jsx).

Показувати окремо **«Змінено виразів: X», «Змінено правил передавання: Y»,
«Змінено відповідностей: Z»**. Рахувати current saved → draft identity,
не кількість кліків. Policy identity включає category/route/row/target/store;
поруч before → after, мова, незбережено/збережено/опубліковано.
Повернення до початкового значення повертає відповідний count до 0.

EN content має server-required `authoritative_create_update`.
EN identity/routing controls (`sku`, `product_type`, `attribute_set_code`,
`store_view_code`) мають `magento_managed` і не є writable content.
[Domain planner](../../server/src/services/magento/sync-preview-domains.js), рядки
144–156, є джерелом цього розрізнення. Client filtering не змінює серверну
валідацію і не переписує раніше збережені choices автоматично.

### «186 товарів — змінились дані»

Publication response має identity/route/reason для affected products, але не
повний field-by-field before/after для кожного. Internal projections входять у
review proof; у public response їх немає.
Обмежені `checked[].comparisons` уже дають current/expected/action/policy для
перевірених representatives: [preview view](../../server/src/services/magento/integration-readiness.js)
і [diagnostic view](../../server/src/services/magento/product-diagnostic-view.js).

Перший крок: чесно показати local impact і дозволити explicit деталь вибраного
товару. Нова remote observation має власний timestamp і не прикидається доказом
того самого publication snapshot.

Повний per-product diff масової операції потребує bounded server report із
зафіксованим scope/evidence. Не генерувати diff з тексту delivery_changed і не
робити сотні implicit GET при відкритті списку.

## 8. Прогрес, ETA і непідтверджені результати

Прогрес має дві незалежні частини:

1. **Рішення в Amber:** перевірено/застосовано/already applied/blocked/unconfirmed/not started.
2. **Доставка:** pending handoff/enrolled/waiting/protected/needs attention/verified synced.

`readyForOutbound`, повний first-sync manifest `complete`, локальний receipt і
підтверджена Magento generation — різні результати. Окремий успішний field receipt
не завершує весь товар.

[Handoff status](../../server/src/services/magento/binding-handoff.js) уже рахує
стан точного generation для останніх 20 handoffs; worker enrolls до 25 pending
items/pass. Наявні counts не є кількістю first-sync field blockers і не мають ETA.
Це вже охороняє [publication regression](../../client/test/magento-publication.test.jsx),
зокрема сценарій aggregate attention без вигаданих first-sync counts.

Спочатку показати completed/total, останній прогрес, paused/stopped і причину.
ETA — лише позначена оцінка-діапазон із достатніх фактичних completed durations
цієї стадії/кохорти. За малої вибірки, паузи, timeout або protected work:
**«Час поки не можна оцінити»**. Таймер не підтверджує результат.

`MAGENTO_TIMEOUT` трактувати за фазою:

- GET-preview не вдався: **«Не вдалося перевірити. Перевірити ще раз»**.
  Це не твердження, що write відбувся.
- Після dispatch/apply втрачено відповідь: **«Результат не підтверджено»**.
  Доступний original-operation inspect/reconcile за чинним контрактом;
  не запускати новий job, apply або resend.
- HTTP 500 без доказу transport cause: **«Перевірка недоступна»**,
  без вигаданої причини «Magento не відповідає».

## 9. Прогалини API з брифу A7, A9, A10

### A7: Meta Title (EN) та значення

[Saved diagnostic sanitation](../../server/src/services/magento/sync-problems.js)
зберігає target/scope, але не довільні Amber/Magento values.
Тому «Заголовок у пошуку · EN» можна показати з відомого scope; самі значення
не можна чесно відновити із saved queue card.

Існуючий explicit [first-sync panel](../../client/src/components/attention/MagentoFirstSyncFields.jsx)
отримує validated local/remote known/present/value для exact target+scope.
Його можна повторно використати, зберігши unknown ≠ empty, publication, authority
та stale-response guards. Поточна first-sync відповідь не має top-level
`observedAt` / `generatedAt`: авторитетний час спостереження потребує окремого
уточнення контракту. Клієнт може показати час отримання відповіді, не називаючи
його часом Magento-спостереження. Target-based product comparisons не замінюють
повного EN first-sync ledger.

Якщо потрібні values **без нового explicit read прямо у saved card**, необхідний
окремий typed bounded server projection із same-observation values, scope і часом.
Це план, не зміна збережених diagnostics у поточному UI раунді.

Схожа межа стосується DOMAIN_POLICY_REVIEW_REQUIRED: fresh product/publication
blockers зберігають operation/requiredPolicy, але persisted sanitizer їх відкидає.
Відомий storeViews context дозволяє точний EN rule link; за відсутніх/неоднозначних
даних не вгадувати потрібний рядок.

### A9: generic 500 та Magento outage

[Magento transport error](../../server/src/services/magento/errors.js) може бути
звичайним Error; [HTTP serializer](../../server/src/http/errors.js) не завжди
повертає його transport code/status як public error. Отже generic
`500 {error:"Internal server error"}` не доводить Magento outage.

Client може пояснювати **відомі** safe transport codes/statuses і bounded-limit
errors, зберігаючи original-operation state. Повна задача потребує окремого
серверного error contract: allowlisted public code, phase, retryable read hint,
safe request correlation і збереження uncertain-write семантики, без секретів
або сирих Magento відповідей. Не прирівнювати всі 500 до Cloudflare 523.

Існуючі explicit bounded GET-only повторні перевірки:
`POST .../product-preview` та `POST .../jobs/:id/inspect`.
Inspect не є continue/reconcile/apply; назва «Перевірити ще раз» не дає дозволу
підмінити його write endpoint. Причина bounded identity limit потребує пояснення
межі; звичайний retry не обіцяє її усунути.

### A10: виключені з експорту

[Product register](../../server/src/services/product/product-queries.js) не
повертає exclusion flag/count/filter. Його cursor не має такого filter binding.
[Coverage summary](../../server/src/services/magento/sync-problems.js) виключає
відповідні rows із denominator, але не повертає число excluded.

Не віднімати unrelated totals і не сканувати всі сторінки клієнтом для
лічильника «приховано:106». Потрібен окремий authoritative register contract:
normalized exclusion state, точний scope total/count, bounded filter та
filter-bound cursor, збережений `history.view` boundary. Client counter/filter
робиться після цього API. Різниця Amber 89 / Magento 195 сама не доводить, що всі 106
мають одну й ту саму причину.

Таблиця покриття на Products уже є й має regression:
[SyncCoverage](../../client/src/components/app/SyncCoverage.jsx),
[product entry test](../../client/test/product-root-integration.test.jsx).
Її зберегти; coverage:null не перетворюється на нуль.

## 10. Недоступне значення під час переобліку

[Native product preview](../../server/src/services/product.service.js), рядки
427–439, повертає fieldErrors із загальним повідомленням.
[Validator](../../server/src/services/product/product-validation.js) враховує
semantic ID, archived, visible_if/hidden_if і exact inherited previous answer.
[Client blockers](../../client/src/lib/recount-blockers.js) уже мають loaded
question/options і visibleOptions, але не показують пояснення та список.

Поряд із полем «Що за птах» запропоновано показати:

- збережене недоступне значення;
- доступні labels із semantic IDs за поточними завантаженими правилами;
- відому причину: archived, hidden by condition або відсутнє у поточному списку;
- дію «Змінити вибір», із збереженням інших введених даних.

Якщо причина не доведена snapshot-ом, показати потребу актуальної перевірки.
Не вгадувати відповідь зі SKU/назви, не підставляти першу опцію чи0,
не активувати archived values і не змінювати правила успадкування.
Остаточна серверна перевірка лишається authority. Це окрема presentation задача,
а не масове first-sync виправлення історичних відповідей.

## 11. Етапи реалізації після погодження

Кожна самостійна тема та кожний новий API-контракт — окремий PR. Напрями нижче
не об'єднують словник, фільтрацію політик, навігацію і лічильники в одну зміну.

| Напрям | Результат | Межа |
| --- | --- | --- |
| Client clarity | Scope, єдиний словник, exact field/language links, policy counts, причини disabled, recount option explanation | Чинні API та server policy |
| Read-only category inventory | Повний або явно incomplete перелік pending domains; A7/A10 projection за погодженим контрактом | Окреме серверне рев'ю, без apply |
| Exact review UI | Точний selection, before/after, blockers/imports, original tokens, stale/access lifetimes | Без generic mass mutation |
| Durable batch coordination | Один action type за PR, prepared/receipt journal, restart та uncertainty recovery | Existing services, окремо погоджені API/storage/migrations |
| Progress і перевірка доставки | Реальні item/handoff/generation counts; ETA після достатніх вимірів | Ніяких auto-resend чи synthetic success |

Не включати нові scripts, runtime/service fixes або migration до docs-only PR.
A9 public-error contract і per-category publication — окремі серверні рішення;
останнє не є передумовою ясного повідомлення про чинний спільний пакет.

## 12. Критерії приймання майбутніх змін

- Категорія з > 100 товарами і рідкісним path після 100: повний інвентар або explicit
  incomplete; productId не є прихованим способом знайти потрібний розділ.
- Групи не зливають різні field/scope/actions; original diagnostics доступні;
  кількості diagnostics і unique products відрізняються.
- Exact subset; paging/search не розширюють apply. Duplicates, missing/retired
  products, identity/publication/source drift відмовляють до mutation.
- 401, pending/disabled, permission loss і Administrator demotion між item та
  під authority lock відмовляють; CSRF для unsafe methods збережений.
- Preview без domain/remote writes. Чинні lock-taking read protocols не змушують
  працювати через несумісний pool лише заради назви read-only.
- Лише server-offered choices; супутні imports видимі; atomic per-product choices,
  immutable terminal receipts, eligibility та final revalidation збережені.
- Item1 confirmed, item2 unknown/error: item1 збережено, item3 not started.
  Reload читає original journal; failed checkpoint не запускає write чи retry.
- Timeout після dispatch веде до original-operation inspection; generic 500 не
  видається за доведений outage. Жодного auto-resend або нового job.
- Blocker іншої категорії видно й пояснено; global publication/lost-coverage
  approval не обходиться.
- Policy-only change має відповідний count; revert повертає 0; не плутати
  expression count, saved choice, publication та delivery.
- Saved card не вигадує values; scoped fresh preview зберігає known/present/value.
  Exclusion count/filter не виводяться з нееквівалентних totals.
- Handoff progress не підміняється first-sync counts; paused/unknown ETA чесний.
- Recount зберігає semantic 0, calibration 2, archived inheritance та введені дані;
  server refusal не приховується.
- Client тести чекають фактичний rendered state і правильну response identity;
  існуючі assertions не пропускаються й не послаблюються.
- Серверні regressions використовують реальні services; race tests — незалежні
  connections і кінцевий стан. Інтеграції лише на disposable PostgreSQL 16
  `*_test` за [AGENTS](../../AGENTS.md).

Наявні орієнтири:
[operator authority tests](../../server/test/operator-authority-access-transaction.test.js),
[names](../../server/test/operator-names-batch.test.js),
[recovery](../../server/test/operator-recover-skus.test.js),
[controlled resync](../../server/test/operator-controlled-resync.test.js),
[history batch](../../server/test/first-sync-history-batch.test.js),
[keep-local](../../server/test/first-sync-keep-local.test.js),
[history integration](../../server/integration-test/first-sync-history-admission-batch.test.js),
[first-sync panel](../../client/test/attention-first-sync-fields.test.jsx),
[publication UI](../../client/test/magento-publication.test.jsx),
[recount blockers](../../client/test/recount-blockers.test.js).

## Межі перевірки цього документа

Під час підготовки читалися лише repository code/docs і бриф. Скрипти, CLI modes,
тести, DB, Magento та production/staging не запускалися; env/credentials не
читалися. Висновки підтверджують контракти зазначеного commit, не deployment,
реальний стан товарів або приймання оператором.
