# Пакетна перевірка й локальні рішення першої синхронізації

Це standalone workflow для точного списку до 2000 SKU. Він використовує сервіси встановленого Amber через `--server-root`, не запускає застосунок, worker або міграції. Для його використання не потрібне окреме розгортання. Пакети канонічного field preview залишаються обмеженими десятьма товарами; їх створення, перевірка та послідовне виконання автоматизовані. History admission зберігає канонічну перевірку кожного товару й обмеження валідації scope до 50 за один chunk.

Підготовка коду й проходження тестів не підтверджують готовності production-каталогу. Спочатку потрібен свіжий read-only audit актуальної publication і точного handoff membership. `complete: true` у такому audit означає відповідність його scope, а не готовність полів чи успішну доставку. Production audit не входить до перевірки цього коду.

## Погоджені рішення та виключення

Пакет обирає лише `keep_local` для Manager `price/all`, доведеної фізичної ваги `decor_weight/all` або `vaha_vyrobu/all` за канонічним правилом різниці округлення, а також Amber `meta_title` і `meta_description` у `all` та `en`. Порожні чи невідомі значення, інша вага, непідтверджена відповідність полів, зміна джерела або exact Magento identity залишаються блокерами. Вибрані раніше рішення щодо довжини не переносяться на інші товари: цей workflow не підтримує нових length choices.

Кожне рішення проходить свіжий канонічний callback перед commit. Нові переходи `imported` або `name_received` заборонені навіть тоді, коли канонічний preview повернув `readyForApply: true`. Назви UA/EN із Magento під час першої синхронізації вже погоджені; надалі діють правила найменування Manager. Їх виключення тут є технічною межею цього вузького writer, а не потребою знову погоджувати бізнес-політику. Готові рядки, у яких залишилися лише initial imports `name/all` та/або `name/en`, утворюють групу `CAMPAIGN_NAME_IMPORTS_SEPARATE_PREVIEW`. Масив `review.nameOnlyPreview` збирає exact SKU, local та remote ID, plan file і незмінений канонічний `initialImports` для всієї групи. Він не містить apply-команд і не потребує ручного аналізу кожного товару. Для запису цієї групи потрібен окремо перевірений канонічний шлях імпорту назв. Змішані або інші імпорти залишаються в `CAMPAIGN_INITIAL_IMPORTS_REQUIRE_REVIEW`. Helper не створює штучних попередніх квитанцій.

Попередні термінальні квитанції та нові квитанції рівності або дозволеної порожнечі залишаються під контролем канонічного сервісу. Вони не є новим вибором авторитету для інших атрибутів. History admission не підтверджує експорт, не приймає поля й не означає готовності до надсилання. Після нової публікації старий admission не стає чинним автоматично. Для наявної незавершеної field session канонічне поновлення зберігає первісний root та квитанції; без field session потрібен новий admission root.

Жодна стадія workflow не ставить job у чергу, не виконує resync, не надсилає Magento POST/PUT/DELETE, не обробляє media й не змінює lifecycle або історію доставки. History admission додає окрему канонічну audit-квитанцію; старі записи залишаються незмінними. Подальша доставка залишається окремим чинним контрольованим процесом.

## Файли пакета

На runtime з `applyWithPreparedValidation` campaign перевіряє точні факти через
чинний callback, а відокремлену копію єдиної канонічної decision preparation —
через додатковий callback перед commit. Це прибирає одну повторну read-only
preparation у тому самому apply; для choices без імпортів зазвичай економить
тільки `BEGIN`/`COMMIT`. Старий runtime зберігає попередній шлях з окремою
preparation. Свіжі preview/apply, locked revalidation, immutable receipt verification
та послідовний fsync журналу залишаються. Ця зміна не доводить прискорення в секундах.

Збережіть поруч п'ять helpers:

- `first-sync-campaign.js` — єдина точка входу та журнал choices;
- `first-sync-campaign-preview.js` — спільний read-only review всіх discovery packets;
- `first-sync-campaign-history.js` — послідовна orchestration чинного history adapter;
- `first-sync-history-batch.js` — наявний канонічний history adapter;
- `first-sync-local-discovery.js` — точні identity, source snapshot, publication і packets до 10.

Наведені нижче `/private/...` — приклади приватного каталогу оператора, а не наявні production-шляхи. Виконуйте Node без запуску застосунку в установленому server-каталозі або надавайте `--server-root /app`. Змінні підключення й авторизації беруться з чинного середовища; не додавайте секрети до scope, команд, журналів або повідомлень.

## Один точний scope, без ручної роботи з кожним пакетом

1. Отримайте один свіжий audit JSON. Звірте поточну publication, immutable handoff membership, стан запитів і групи причин. Не використовуйте загальну кількість `needs_attention` як кількість history blockers. Відокремте вже доставлені товари та іншу незавершену роботу на основі доказів, а не позиції у списку.
2. Підготуйте один `candidates.json` у форматі [FIRST_SYNC_LOCAL_DISCOVERY.md](FIRST_SYNC_LOCAL_DISCOVERY.md). Він містить exact SKU, локальний product ID, category та точні погоджені пари local/remote. `remoteProductId: null` дозволяє отримати ID тільки з канонічного ordinary preview. Укажіть нові `bindingRevisionId` та `expectedDefinitionHash`, якщо вони вже відомі. Срібні вироби залиште останніми за підтвердженою категорією; SV у цьому каталозі означає сувеніри. Послідовність scope зберігається.
3. Запустіть discovery один раз для всього списку. Оберіть `--limit` рівним кількості товарів, максимум 2000. Не покладайтеся на default 10.

```sh
node /private/first-sync-campaign.js --stage discovery \
  --server-root /app --input /private/candidates.json \
  --output-dir /private/discovery-01 --offset 0 --limit 1000 \
  --expected-database DATABASE --actor-id ACTOR --installation-key amber
```

Число 1000 у прикладі потрібно замінити на фактичну довжину погодженого scope. Discovery використовує PostgreSQL read-only pool і GET-only Magento transport. Створені пакети по 10 не потрібно переносити або запускати вручну. Якщо discovery перервалося до фінального manifest, повторіть ту саму read-only стадію в новому каталозі; проміжний journal не є execution plan.

4. Запустіть спільний review після discovery. Окрім field review, він автоматично створить `history-scope.json`, якщо є точні доступні legacy history proposals без інших discovery blockers. Відбір використовує canonical observed identity, повний source snapshot і точну policy чинного history adapter. Nonlegacy proposals не включаються. Descriptor `historyScope` містить raw SHA-256 і count; `null` означає, що такого відбору немає. Жодний admission від цього не виконується.

```sh
sha256sum /private/candidates.json
node /private/first-sync-campaign.js --stage review \
  --server-root /app --input /private/candidates.json \
  --scope-sha256 RAW_CANDIDATES_SHA256 \
  --discovery-manifest /private/discovery-01/manifest.json \
  --output-dir /private/review-before-history-01 \
  --expected-database DATABASE --actor-id ACTOR --installation-key amber
```

Звірте один автоматично створений history scope та згруповані винятки з audit. Для fresh history preview і подальшого погодженого admission використовуються цей самий scope та raw SHA-256; helper сам розбиває перевірку на chunks до 50. Якщо history stage не потрібна, цей review можна використати відразу для choices, без повторної перевірки всіх пакетів.

```sh
sha256sum /private/review-before-history-01/history-scope.json
node /private/first-sync-campaign.js --stage history \
  --server-root /app --mode preview --input /private/review-before-history-01/history-scope.json \
  --scope-sha256 RAW_HISTORY_SCOPE_SHA256 --output /private/history-review-01 \
  --expected-database DATABASE --actor-id ACTOR

node /private/first-sync-campaign.js --stage history \
  --server-root /app --mode apply --input /private/review-before-history-01/history-scope.json \
  --scope-sha256 RAW_HISTORY_SCOPE_SHA256 --output /private/history-run-01 \
  --expected-database DATABASE --actor-id ACTOR
```

Admission завжди отримує свіжий канонічний review; збережений preview token не повторюється. Ordinary workflow або clean first без доведеного admission root не вважаються `already_admitted`. Після підтверджених admission повторіть discovery у новому каталозі: попередня field evidence не стає execution plan автоматично.

5. Зробіть один aggregate review усіх packet files. Він перевіряє raw scope hash, повний discovery journal, publication, actor, database, packet hashes та належність кожного поля точному кандидату. Потім викликає незмінений canonical preflight послідовно для кожного пакета до 10. Це не бізнес-запис: транзакції для канонічних locks завершуються rollback; forced read-only pool тут несумісний з `FOR SHARE`.

```sh
sha256sum /private/candidates.json
node /private/first-sync-campaign.js --stage review \
  --server-root /app --input /private/candidates.json \
  --scope-sha256 RAW_CANDIDATES_SHA256 \
  --discovery-manifest /private/discovery-02/manifest.json \
  --output-dir /private/choices-review-01 \
  --expected-database DATABASE --actor-id ACTOR --installation-key amber
```

Перегляньте `choices-review-01/review.json`: counts, grouped exceptions, `nameOnlyPreview` та sealed selections у referenced plans. Винятки discovery також зберігаються, включно з history, identity, lifecycle, порожніми полями та nonrounding weight. `complete` стосується перевіреного slice, а `remainingInput` показує неперевірений залишок. `complete` не означає, що всі товари готові до apply або до Magento delivery.

6. Для погодженого review використовуйте raw `reviewSha256`, надрукований на попередній стадії. Він відрізняється від канонічного hash старого local-batch CLI. Один запуск послідовно обробить усі sealed selections, зберігаючи квитанцію після кожного SKU.

```sh
node /private/first-sync-campaign.js --stage choices \
  --server-root /app --mode apply --review /private/choices-review-01 \
  --review-sha256 RAW_REVIEW_SHA256 --output /private/choices-run-01 \
  --expected-database DATABASE --actor-id ACTOR --installation-key amber
```

## Продовження та невизначені результати

`--mode resume` приймає той самий scope/review hash, actor, database, publication, hash визначених критичних файлів коду та вже створений output directory. Цей hash охоплює adapters і перелічені в них канонічні сервіси, а не кожну транзитивну залежність установленого server. Для choices повторіть команду вище з `--mode resume`; для history — відповідну history-команду з `--mode resume`. Новий preview не підставляється під старий журнал.

До кожного виклику, який може записати рішення, fsync зберігає `prepared`; після виклику — підтверджену `receipt`. Під час resume історичні записані квитанції додатково звіряються read-only із канонічною БД. Вони доводять тільки попередній commit; актуальна authority та усі захисні перевірки для наступного товару виконуються знову. Підтверджені товари повторно не записуються. Збережені безпечні блокери залишаються винятками й автоматично не повторюються. Якщо history resume пропускає весь уже оброблений scope, він перевіряє минулі audits, а не актуальну authority чи чинність admission. Для нового field етапу завжди потрібен свіжий discovery/preview.

`prepared` без остаточної квитанції, `unconfirmed`, обрізаний journal, невідповідний header або недоведена квитанція зупиняють продовження. Не редагуйте й не обрізайте journal вручну: структурні перевірки не є цифровим підписом кожного діагностичного тексту. Навіть канонічний idempotent replay без fresh callback не визнається новим успішним choices-записом. Помилка publication, actor або permission зупиняє весь запуск. Не видаляйте такі записи й не створюйте новий apply для тієї самої операції з невизначеним результатом: спочатку потрібне окреме read-only з'ясування фактичного commit.

Exclusive `run.lock` не дозволяє паралельні writers. Після штатного виходу lock видаляється. Після аварійного завершення він може залишитися. Helper його не краде: оператор спочатку має підтвердити відсутність попереднього процесу й перевірити journal. Видалення лише stale lock не знімає блокування unresolved intent. Не запускайте дві копії однієї кампанії в різних каталогах.

У choices `complete` означає завершення проходу вибраних операцій; `allRecorded` окремо показує, чи кожна має підтверджений запис. Для history `complete` також означає завершений прохід, навіть якщо збережено відомі блокери; у цьому разі процес повертає exit code 2. Жоден із цих прапорців не підтверджує зовнішню доставку. Групи винятків можуть перетинатися за SKU, тому їх кількості не слід просто додавати. Зберігайте output у приватному сталому каталозі, який переживає перезапуск або заміну контейнера. Після завершення зберігайте review directory та journal разом. Не переносіть лише `review.json`: hash references потрібні для перевірки всього погодженого набору.

## Межі та перевірки

Input і кожен packet/plan обмежені 4 MiB; кількість SKU — 2000. Discovery result evidence і сукупність packet plans мають окремі обмеження загального розміру. Журнали execution обмежені 32 MiB. Файли створюються приватними й не перезаписуються. Великі, некоректні або неповні набори блокуються до бізнес-дії.

Під час підготовки виконуються synthetic unit tests та PostgreSQL 16 integration tests із disposable `*_test` databases. HTTP у цих fixtures синтетичний. Свіжий production audit, фактичні review counts, готовність бізнес-scope та подальша Magento delivery залишаються окремими необхідними перевірками оператора.
