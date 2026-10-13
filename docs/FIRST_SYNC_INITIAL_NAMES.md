# Початкові назви для точного legacy first-sync scope

`server/scripts/first-sync-initial-names.js` приймає початкові Magento назви через
канонічний first-sync commit для вже допущених до field review товарів. Це
окремий bounded adapter для випадку `NAME_BASELINE_REQUIRED`, коли discovery
не створює field packets, а попередній campaign names adapter потребує sealed
`nameOnlyPreview`. Жодний із цих попередніх відборів не послаблюється.

Назви `name/all` та `name/en` отримуються лише вперше. Раніше отримана мова
залишається незмінною; поточна зовнішня зміна не є новим початковим імпортом.
Потрібні чинний opaque cutover admission, точні identities та Administrator.
Ordinary/create/review, clean first без cutover admission, інші ordinary blockers
та нові імпорти інших полів відхиляються. Порожня remote назва не імпортується;
інша заповнена мова може бути прийнята, якщо повний canonical plan це дозволяє.
Невідомі name observations залишаються блокерами.

## Чому не ordinary name resolution

Ordinary name apply підвищує export revision. Після retirement CSV це може
змінити `csv_retired_revision`, не записавши відповідний first-sync progress.
Legacy admission вимагає нульового delivery state до session або точної
відповідності state останньому progress. Цей adapter використовує існуючий
`first.commit`, який атомарно зберігає назви, повний manifest, admission root,
локальні revision і захоплений після запису `historyAdmissionState`.

Невирішені price/weight/SEO поля залишаються у повному manifest. Adapter не
викликає `prepareDecision`, не додає choices і не обрізає projection. Нові
`imported`/`name_received` можуть стосуватися лише назв. Попередні terminal
receipts, explicit decisions та pending SEO evidence повинні зберегтися точно.
Канонічні equality/optional-empty/outward-pending записи інших полів можуть
увійти в повний progress; це не нові локальні choices чи імпорти цих полів.

## Scope і standalone пакет

Підготуйте один точний scope до 2000 товарів / 4 MiB. SKU, локальні IDs та
Magento IDs мають бути унікальними. Збережіть publication із завершеного
discovery/history review. `expectedDefinitionHash` не є `publicationHash`.

```json
{
  "bindingRevisionId": "11111111-1111-4111-8111-111111111111",
  "expectedDefinitionHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "installationKey": "verified-installation-key",
  "choice": "magento",
  "items": [{"sku":"SYNTHETIC-AR","productId":123,"remoteProductId":456}]
}
```

Жодних tokens, fields, цін або довільних назв у scope. `choice: "magento"`
явно фіксує затверджений напрямок початкового прийняття назв. Scope не створює
history admission: використовуйте окремий [history helper](FIRST_SYNC_HISTORY_BATCH.md).
Після admission його не потрібно повторювати тільки через запуск цього preview.

Для standalone використання скопіюйте поруч незмінений набір scripts із цього
reviewed commit: `first-sync-initial-names.js`, `first-sync-initial-name-plan.js`,
`first-sync-campaign-names.js`, `first-sync-name-commit.js`,
`first-sync-campaign-preview.js`, `first-sync-campaign.js`,
`first-sync-local-discovery.js`. Передайте встановлений server через
`--server-root`; нові залежності, endpoint, migration або worker не потрібні.
Пакет використовує канонічні сервіси встановленого server і чинне середовище;
самостійно `.env` не завантажує. Не змішуйте версії helper файлів.

## Read-only preview

Приклади шляхів нижче не є production-шляхами. Використайте фактичний server,
точну БД, чинного Administrator і приватний сталий каталог оператора.

```sh
sha256sum /private/initial-names-scope.json
node /private/helpers/first-sync-initial-names.js --mode preview \
  --server-root /installation/server \
  --input /private/initial-names-scope.json --scope-sha256 RAW_SCOPE_SHA256 \
  --output /private/initial-names-preview \
  --expected-database EXACT_DATABASE --actor-id ADMINISTRATOR_ID
```

Preview використовує enforced PostgreSQL read-only pool і GET-only Magento
transport. Для кожного SKU виконується свіжий ordinary preview та canonical
inspection. `NAME_BASELINE_REQUIRED` залишається у review як невирішена ordinary
діагностика; його не видаляють із report. Підтверджується готовність саме
початкових names receipts, а не outward delivery. Ціни не перечитуються через
новий catalog discovery, але звичайний canonical inspection та його history
reads залишаються обов'язковими.

Новий каталог містить `scope.json`, fsynced `results.jsonl` і `review.json`.
Review показує точні нові UA/EN назви, source snapshot, незмінний preview token,
hash повного prepared manifest, prior progress, history root, publication і
решту blockers. Загальна межа review/journal — 32 MiB. Файли приватні, існуючі
шляхи не перезаписуються. Використовувати можна тільки завершений review з
`complete: true`, `globalFailure: null`; blocked rows не виконуються.
`preview.lock` залишається після збою запису/fsync artifacts та робить review непридатним,
навіть якщо `review.json` уже читається. Не видаляйте цей marker для обходу
перевірки: повторіть read-only preview у новому каталозі.
Після успішного fsync усіх artifacts і каталогу seal уже збережений. Якщо
помилка виникла лише при фінальному cleanup marker, error містить
`reviewSealed: true`; loader однаково вимагає відсутній marker і всі hashes.
Невдалий fsync видалення marker може повернути його після crash, блокуючи apply.

## Apply та відновлення

Перед apply перевірте selected scope, точні назви й `deliveryEffect` із review.
Apply потребує SHA256 точних bytes `review.json` і незмінного `scope.json` поруч.

```sh
sha256sum /private/initial-names-preview/review.json
node /private/helpers/first-sync-initial-names.js --mode apply \
  --server-root /installation/server --review /private/initial-names-preview \
  --review-sha256 RAW_REVIEW_SHA256 --output /private/initial-names-run \
  --expected-database EXACT_DATABASE --actor-id ADMINISTRATOR_ID
```

Apply не переобирає назви: свіжі identity, source, token, publication, progress,
повний prepared hash і нові names повинні точно відповідати review. Existing
SKU/public-identity guards, Administrator lock, transaction CAS, protected
dispatch та canonical setters залишаються чинними. Немає автоматичних
price/SEO choices, ordinary name apply або прямого enqueue/Magento write.

**Зміна назв може створити чи оновити ordinary automatic sync request і desired
generation через чинні product triggers.** Worker може пізніше обробити цей
request під звичайними guards. Цей побічний ефект явно показано в preview і
receipt; місцевий commit не підтверджує delivery.

Підтверджені receipts fsync-записуються перед наступним SKU. Помилка зупиняє
tail; batch не атомарний між товарами. `--mode resume` використовує той самий
review/hash/output і перевіряє immutable canonical receipts перед пропуском
завершених товарів. Header також фіксує actor, database, publication та hash
визначених adapter/canonical файлів; це не hash усіх транзитивних залежностей.

`prepared` без receipt, unknown COMMIT outcome, malformed journal або blocker
зупиняють resume. Після output failure або невизначеного commit зберігається
`run.lock`: навіть читабельний receipt після невдалого fsync не дозволяє
автоматично продовжити tail. Не повторюйте apply з новим каталогом після невизначеного
результату: потрібне окреме read-only з'ясування canonical receipt. Helper не
видаляє stale lock, не підміняє token і не повторює непідтверджений запис.
Після підтверджених names потрібні нові field discovery/review для решти
choices: source, revision і preview tokens могли змінитися.

Exit 0 означає завершений preview без blockers або підтверджені commits усіх
selected rows. Exit 2 — завершений звіт із blockers/неперевіреним tail. Exit 1 —
setup/output failure; він сам собою не доводить rollback. Зіставляйте counts і
receipts. Не змішуйте history admission, local names receipt та delivery.

## Перевірки

Synthetic unit tests перевіряють scope, immutable full plan, старі receipts,
stale evidence, private artifacts та journal outcomes. PostgreSQL regressions
використовують genuine cutover/legacy admission, відсутню common name baseline,
нульову session та existing progress; перевіряють read-only preview, atomic
rollback, history-state continuity і втрату відповіді після COMMIT. Усі fixture
HTTP responses синтетичні; production execution не входить до цих тестів.
