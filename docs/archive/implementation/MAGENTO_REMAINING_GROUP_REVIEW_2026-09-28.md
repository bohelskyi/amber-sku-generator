# Magento remaining-group review (2026-09-28)

Archived from `docs/MAGENTO_INTEGRATION.md`. A dated production observation and
option-ID inventory; its blockers were superseded by migration 043 and later
reviewed bindings. Current mappings live in the published binding, not here.

## Review

This section records the earlier candidate-only audit. Its SV numeric-key and
set-routing blockers are superseded by migration 043 and the explicit set-151
decision documented above; its IDs remain evidence, not automatic approval.

This bounded review reused `readAmberEvidence`, `auditMagentoSchema`, the pure
`buildCandidates` bootstrap function, `resolveCategories` and the existing compatibility
audit. It did not call bootstrap persistence, enqueue, publish or APPLY. PostgreSQL
reads were read-only; a fetch guard allowed only GET. There were **180 Magento GETs**
(108 schema, one category tree, 71 bounded product/store-scope observations). Binding
revision rows compared equal before/after. The local ignored evidence is
`.artifacts/magento/remaining-groups-review-2026-09-28.json`.

All identities below are **candidates, not approved bindings**. Option counts count
source-to-option rows, not distinct remote IDs. All field/store ownership still needs
explicit review. Category coverage is the existing three local candidates per route,
not every possible category output. Dynamic sizes need a product-specific preview;
exact labels alone do not prove all numeric values are supported.

| Group / route | Set | Exact option rows | Review-required / missing / compatibility |
| --- | --- | --- | --- |
| BR:all | 142 / Браслети | 29 | No unresolved finite option candidate; dynamic bracelet length only observed as Безрозмірний → 5989. Seven sampled category paths exact. Ownership still undecided. |
| NM:all | 143 / Намиста | 35 | Archived `extra=0` (Не обрано) has no evaluated output/option; bootstrap leaves a blocked placeholder. Preview omits this field only for numeric zero proven by the frozen `numeric-zero-v1` contract and the product's own immutable schema, with empty evaluator output and null binding output/option. The emission decision stays blocked; failed reconstruction, genuine/string zero and emitted values are not exempt. Eleven sampled category paths exact. |
| CH:all | 150 / Чотки | 26 | `count=9` emits `?`, no Magento option. Seven sampled category paths exact. 10/10 remote samples reverse dimensions; 9/10 round weight, and malformed size text occurs. Preserve Amber semantics; historical reversal/rounding is not an approved transform. |
| AR:all | 152 / Картини | 38 | `size=28` → `15×15` missing; two current products, both absent remotely. Current-only `29=75/78`, `30=74x80`, `31=70х70` have no published historical identity, enumerated output or option candidate, and zero current usage. Four sampled category paths exact. |
| SV souvenir≠5 | 151 / Сувеніри | 41 | Numeric source `SV.2` cannot be represented by migration 041 semantic keys: `tematyka_vyrobu` blocked despite exact metadata/labels. Zero ready category witnesses among the three bootstrap samples. Existing provisional paths below match. |
| SV souvenir=5 (stone) | Mapper 154 / Камінь; observed 151 / Сувеніри | 38 label matches; only 17 also have set-154 membership | 20/20 remote samples use 151, none 154. Set choice remains review-required; nine target memberships fail at 154. Same numeric-key blocker. Missing provisional category `Default/Камінь/Камінь сувенірний`. |

**Decisions before approval:** choose field/store ownership per group; explicitly
resolve or refuse NM extra zero, CH count 9 and AR sizes 28–31 without inventing
Magento options. CH remains `bead_length → dovzhyna_namystyny`,
`bead_width → diametr_namystyny`; reviewing changes to legacy remote dimensions, size
format and weight is separate from choosing these meanings. For SV stone, choose
151 versus 154 explicitly: 151 matches all sampled existing products and their
fields, while 154 loses required memberships and conflicts with existing product
sets. No set migration or override is approved by this report. Changing that route
alone does not resolve the numeric semantic-key contract or missing category.
Normal SV also needs supported semantic identity and ready product/name/subtype
evidence: the compatibility scan examined 100 of 771 current candidates and found
no ready subtype witness (671 unexamined). The nine null SV souvenir option
placeholders belong to the opposite route (eight under stone, one under normal);
they are conservative bootstrap review entries, **not nine missing remote options**.

**Smallest next batch:** BR only, one exact existing SKU with observed attributes,
options and categories; explicitly review ownership and GET-only preview first.
When a new draft/publication is later authorized, retain the approved KL scope in
that installation snapshot. Publications are installation-wide: a BR-only successor
would supersede the current KL publication. Do not edit the immutable KL revision.
Proceed to NM, then CH/AR/SV decisions; workflow/UI and CSV cutover follow bindings.

### Exact attribute and option inventory

For each route, base attribute codes below are exact code/membership candidates
with Magento attribute IDs. Native transport controls are separate: set →
`product.attribute_set_id`, type → `product.type_id`, status → `product.status`,
visibility → `product.visibility`, categories → `extension_attributes.category_links`,
websites → `extension_attributes.website_ids`, quantity/stock → inventory; boolean
`old_product` / `is_ownproduction` map to their custom attributes. EN uses the same
identity controls plus its approved produced text, not a second base-row write.

Option notation is `Amber question=value_id → Magento option ID` (with evaluated
label in parentheses), or `evaluated label → ID` for dynamic/band values. An exact
option label under an unresolved/blocked attribute does **not** authorize that field.

#### BR:all

Exact base attributes: `sku` (74), `name` (73), `price` (77), `decor_weight` (1483), `dovzhyna_brasletu_diuimiv` (1479), `typy_obrobky_burshtynu` (1461), `vyd_obrobky_kameniu` (1458), `faktura_namystyn` (1509), `kolir` (1455), `forma_namystyn` (1511), `typ_vykonannia` (1510), `meta_title` (84), `meta_description` (86).

Produced EN text candidates: `name`.

| Target | Exact source/output → option ID candidates |
| --- | --- |
| `dovzhyna_brasletu_diuimiv` | `Безрозмірний` → `5989` |
| `typy_obrobky_burshtynu` | `raw_type=1` → `5693` (Натуральний); `raw_type=2` → `5694` (Формований) |
| `vyd_obrobky_kameniu` | `processing=1` → `5683` (Полірований); `processing=2` → `5682` (Шліфований) |
| `faktura_namystyn` | `texture=8` → `5945` (Змішана); `texture=3` → `5944` (Матова); `texture=6` → `5944` (Матова); `texture=2` → `5943` (Напівпрозора); `texture=5` → `5943` (Напівпрозора); `texture=7` → `5988` (Пейзажна); `texture=1` → `5942` (Прозора); `texture=4` → `5942` (Прозора) |
| `kolir` | `color=4` → `5747` (Комбінований); `color=3` → `5674` (Пейзажний); `color=1` → `5670` (Світлий); `color=2` → `5671` (Темний) |
| `forma_namystyn` | `shape=2` → `5950` (Бочка); `shape=5` → `5953` (Галька); `shape=6` → `5954` (Геометрія); `shape=7` → `5984` (Змішана); `shape=1` → `5949` (Куля); `shape=3` → `5951` (Оливка); `shape=4` → `5952` (Сегменти) |
| `typ_vykonannia` | `style=1` → `5947` (Класичний); `style=2` → `5948` (Комбінований); `style=3` → `5948` (Комбінований); `style=4` → `5948` (Комбінований); `style=5` → `6059` (Шамбала) |

Exact sampled category paths (three ready local witnesses):

- `Default/Браслети` → `3`.
- `Default/Браслети/Браслети з цільного каменю бурштину` → `288`.
- `Default/Браслети/Браслети з полірованими намистинами` → `289`.
- `Default/Браслети/Браслети з змішаною фактурою намистин` → `296`.
- `Default/Браслети/Браслети світлого кольору` → `291`.
- `Default/Браслети/Браслети з намистинами: змішана форма` → `298`.
- `Default/Браслети/Шамбала` → `647`.

#### NM:all

Exact base attributes: `sku` (74), `name` (73), `price` (77), `dovzhyna_namysta_tochna` (1521), `decor_weight` (1483), `dovzhyna_namysta` (1462), `typy_obrobky_burshtynu` (1461), `vyd_obrobky_kameniu` (1458), `faktura_namystyn` (1509), `kolir` (1455), `forma_namystyn` (1511), `typ_vykonannia` (1510), `dodatkovo_namysta` (1512), `meta_title` (84), `meta_description` (86).

Produced EN text candidates: `name`, `meta_title`, `meta_description`.

| Target | Exact source/output → option ID candidates |
| --- | --- |
| `dovzhyna_namysta` | `Колар (30-35 см)` → `5695`; `Матіне (50-63 см)` → `5698`; `Опера (66-91 см)` → `5699`; `Принцеса (43-48 см)` → `5697`; `Роуп (120-180 см)` → `5700`; `Чокер (35-40 см)` → `5696` |
| `typy_obrobky_burshtynu` | `raw_type=1` → `5693` (Натуральний); `raw_type=2` → `5694` (Формований) |
| `vyd_obrobky_kameniu` | `processing=1` → `5683` (Полірований); `processing=2` → `5682` (Шліфований) |
| `faktura_namystyn` | `texture=8` → `5945` (Змішана); `texture=3` → `5944` (Матова); `texture=6` → `5944` (Матова); `texture=2` → `5943` (Напівпрозора); `texture=5` → `5943` (Напівпрозора); `texture=7` → `5988` (Пейзажна); `texture=1` → `5942` (Прозора); `texture=4` → `5942` (Прозора) |
| `kolir` | `color=4` → `5747` (Комбінований); `color=3` → `5674` (Пейзажний); `color=1` → `5670` (Світлий); `color=2` → `5671` (Темний) |
| `forma_namystyn` | `shape=2` → `5950` (Бочка); `shape=5` → `5953` (Галька); `shape=6` → `5954` (Геометрія); `shape=7` → `5984` (Змішана); `shape=1` → `5949` (Куля); `shape=3` → `5951` (Оливка); `shape=4` → `5952` (Сегменти) |
| `typ_vykonannia` | `style=1` → `5947` (Класичний); `style=2` → `5948` (Комбінований); `style=3` → `5948` (Комбінований); `style=4` → `5948` (Комбінований) |
| `dodatkovo_namysta` | `extra=2` → `5990` (Дитяче); `extra=1` → `5955` (З підвісками) |

Exact sampled category paths (three ready local witnesses):

- `Default/Намиста` → `4`.
- `Default/Намиста/Намиста з цільного каменю бурштину` → `284`.
- `Default/Намиста/Намиста з шліфованими намистинами` → `264`.
- `Default/Намиста/Намиста з матовою фактурою намистин` → `263`.
- `Default/Намиста/Намиста комбінованого кольору` → `274`.
- `Default/Намиста/Намиста з намистинами: галька` → `279`.
- `Default/Намиста/Класичні намиста` → `282`.
- `Default/Намиста/Намиста темного кольору` → `270`.
- `Default/Намиста/Намиста з полірованими намистинами` → `64`.
- `Default/Намиста/Намиста з прозорою фактурою намистин` → `266`.
- `Default/Намиста/Намиста з підвісками` → `73`.

#### CH:all

Exact base attributes: `sku` (74), `name` (73), `price` (77), `dovzhyna_namystyny` (1503), `diametr_namystyny` (1504), `dovzhyna_vyrobu` (1505), `vaha_vyrobu` (1506), `rozmir_kameniu` (1513), `typy_obrobky_burshtynu` (1461), `faktura_namystyn` (1509), `kolir` (1455), `forma_namystyn` (1511), `relihiina_prynalezhnist` (1514), `kilkist_namystyn` (1507), `meta_title` (84), `meta_description` (86).

Produced EN text candidates: `name`.

| Target | Exact source/output → option ID candidates |
| --- | --- |
| `typy_obrobky_burshtynu` | `raw_type=1` → `5693` (Натуральний); `raw_type=2` → `5694` (Формований) |
| `faktura_namystyn` | `texture=8` → `5945` (Змішана); `texture=3` → `5944` (Матова); `texture=6` → `5944` (Матова); `texture=2` → `5943` (Напівпрозора); `texture=5` → `5943` (Напівпрозора); `texture=7` → `5988` (Пейзажна); `texture=1` → `5942` (Прозора); `texture=4` → `5942` (Прозора) |
| `kolir` | `color=3` → `5674` (Пейзажний); `color=1` → `5670` (Світлий); `color=2` → `5671` (Темний) |
| `forma_namystyn` | `shape=2` → `5950` (Бочка); `shape=1` → `5949` (Куля); `shape=3` → `5951` (Оливка) |
| `relihiina_prynalezhnist` | `religion=1` → `5956` (Мусульманські); `religion=2` → `5957` (Християнські) |
| `kilkist_namystyn` | `count=0` → `5913` (30); `count=1` → `5914` (33); `count=2` → `5917` (39); `count=3` → `5920` (45); `count=4` → `5924` (51); `count=5` → `5926` (66); `count=6` → `5928` (75); `count=7` → `5929` (99) |

Exact sampled category paths (three ready local witnesses):

- `Default/Чотки` → `7`.
- `Default/Чотки/Чотки з цільного каменю бурштину` → `82`.
- `Default/Чотки/Чотки з прозорими намистинами` → `256`.
- `Default/Чотки/Чотки світлого кольору` → `97`.
- `Default/Чотки/Чотки з намистинами у формі бочки` → `87`.
- `Default/Чотки/Християнські чотки` → `85`.
- `Default/Чотки/Чотки на 30 намистин` → `89`.

#### AR:all

Exact base attributes: `sku` (74), `name` (73), `price` (77), `kartynyy` (1470), `rozmir_kartyny` (1480), `sklo` (1501), `dodatkovo_kartyny` (1520), `kartyny_pidsvitka` (1532), `meta_title` (84), `meta_description` (86).

Produced EN text candidates: `name`.

| Target | Exact source/output → option ID candidates |
| --- | --- |
| `kartynyy` | `type=1` → `5721` (Ікони); `type=7` → `5725` (Мозаїка); `type=5` → `5727` (Натюрморти); `type=3` → `5724` (Панно); `type=2` → `5723` (Пейзажі); `type=6` → `5934` (Портрети); `type=4` → `5935` (Символіка) |
| `rozmir_kartyny` | `size=24` → `6033` (100×100); `size=1` → `5802` (10×15); `size=22` → `6030` (110×50); `size=27` → `6045` (110×60); `size=25` → `6035` (120×150); `size=26` → `6036` (120×180); `size=2` → `5804` (15×20); `size=3` → `5803` (15×40); `size=4` → `5805` (20×20); `size=5` → `5806` (20×30); `size=21` → `6021` (22×26); `size=6` → `5899` (30×30); `size=7` → `5940` (30×40); `size=8` → `5903` (30×50); `size=9` → `5941` (30×60); `size=23` → `6031` (40×100); `size=10` → `5907` (40×40); `size=11` → `5909` (40×60); `size=12` → `5911` (40×80); `size=13` → `5974` (50×50); `size=14` → `5975` (50×70); `size=15` → `5976` (60×80); `size=16` → `5977` (60×90); `size=18` → `5979` (70×100); `size=19` → `5980` (70×140); `size=20` → `5981` (80×120); `size=17` → `5978` (80×80) |
| `sklo` | `glass=1` → `5888` (Зі склом) |
| `dodatkovo_kartyny` | `additional=2` → `5983` (На бархаті); `additional=1` → `5982` (На полотні) |
| `kartyny_pidsvitka` | `backlight=1` → `6041` (З підсвіткою) |

Exact sampled category paths (three ready local witnesses):

- `Default/Картини` → `21`.
- `Default/Картини/Натюрморти` → `223`.
- `Default/Картини/Символіка` → `33`.
- `Default/Картини/Мозаїка` → `224`.

#### SV.souvenir=value_id:5

Exact base attributes: `sku` (74), `name` (73), `price` (77), `kamin_obrobka` (1531), `kolir` (1455), `fraction` (1534).

Produced EN text candidates: `name`.

Unresolved/blocked attributes: `decor_weight` (review_required), `rozmir_suveniriv` (review_required), `suveniry` (review_required), `tematyka_vyrobu` (blocked), `vyd_ptakha` (review_required), `vyd_roslyny` (review_required), `vyd_symvoliky` (review_required), `kamin_suvenirnyi` (review_required), `typy_obrobky_burshtynu` (review_required).

| Target | Exact source/output → option ID candidates |
| --- | --- |
| `suveniry` | `souvenir=5` → `5733` (Камінь сувенірний) |
| `vyd_ptakha` | `bird=6` → `6029` (Лелека); `bird=1` → `6024` (Орел); `bird=2` → `6025` (Пава); `bird=3` → `6026` (Сова); `bird=4` → `6027` (Сокіл); `bird=5` → `6028` (Фазан); `bird=7` → `6034` (Фенікс) |
| `vyd_roslyny` | `plants=3` → `5999` (Ікебана); `plants=1` → `5997` (Дерева); `plants=2` → `5998` (Квіти) |
| `vyd_symvoliky` | `symbolic_stat=2` → `6001` (Військова); `symbolic_stat=6` → `6005` (Корпоративна); `symbolic_stat=4` → `6002` (Професійна); `symbolic_stat=5` → `6004` (Релігійна); `symbolic_stat=3` → `6003` (Спортивна); `symbolic_stat=1` → `6000` (Українська) |
| `kamin_obrobka` | `stone_processing=0` → `6040` (Необроблений); `stone_processing=1` → `6039` (Полірований) |
| `kamin_suvenirnyi` | `additional_stone=1` → `6020` (З інклюзом); `additional_stone=2` → `6038` (На підставці) |
| `kolir` | `color=3` → `5747` (Комбінований); `color=4` → `5674` (Пейзажний); `color=1` → `5670` (Світлий); `color=2` → `5671` (Темний) |
| `typy_obrobky_burshtynu` | `material=1` → `5693` (Натуральний); `material=2` → `5694` (Формований) |
| `fraction` | `0-2` → `6048`; `10-20` → `6051`; `100-200` → `6054`; `1000+` → `6058`; `2-5` → `6049`; `20-50` → `6052`; `200-300` → `6055`; `300-500` → `6056`; `5-10` → `6050`; `50-100` → `6053`; `500-1000` → `6057` |

#### SV.souvenir!=value_id:5

Exact base attributes: `sku` (74), `name` (73), `price` (77), `decor_weight` (1483), `rozmir_suveniriv` (1530), `suveniry` (1471), `vyd_statuetky` (1526), `vyd_ptakha` (1529), `vyd_roslyny` (1524), `vyd_symvoliky` (1525), `nastlni_ihry` (1527), `kolir` (1455), `typy_obrobky_burshtynu` (1461).

Produced EN text candidates: `name`.

Unresolved/blocked attributes: `tematyka_vyrobu` (blocked).

| Target | Exact source/output → option ID candidates |
| --- | --- |
| `suveniry` | `souvenir=6` → `5736` (Брелоки); `souvenir=9` → `6037` (Годинники); `souvenir=7` → `6019` (Лампи); `souvenir=2` → `5732` (Настільні ігри); `souvenir=4` → `5734` (Письмові набори); `souvenir=3` → `5735` (Ручки); `souvenir=8` → `5738` (Скриньки); `souvenir=1` → `5729` (Статуетки) |
| `vyd_statuetky` | `statuette=7` → `6015` (Авто); `statuette=3` → `6011` (Військова техніка); `statuette=6` → `6013` (Вітрильники); `statuette=2` → `6010` (Дерева та квіти); `statuette=4` → `6014` (Зодіаки); `statuette=5` → `6012` (Символіка); `statuette=1` → `6009` (Тварини) |
| `vyd_ptakha` | `bird=6` → `6029` (Лелека); `bird=1` → `6024` (Орел); `bird=2` → `6025` (Пава); `bird=3` → `6026` (Сова); `bird=4` → `6027` (Сокіл); `bird=5` → `6028` (Фазан); `bird=7` → `6034` (Фенікс) |
| `vyd_roslyny` | `plants=3` → `5999` (Ікебана); `plants=1` → `5997` (Дерева); `plants=2` → `5998` (Квіти) |
| `vyd_symvoliky` | `symbolic_stat=2` → `6001` (Військова); `symbolic_stat=6` → `6005` (Корпоративна); `symbolic_stat=4` → `6002` (Професійна); `symbolic_stat=5` → `6004` (Релігійна); `symbolic_stat=3` → `6003` (Спортивна); `symbolic_stat=1` → `6000` (Українська) |
| `nastlni_ihry` | `table_games=3` → `6018` (Доміно); `table_games=2` → `6017` (Нарди); `table_games=1` → `6016` (Шахи); `table_games=4` → `6022` (Шашки/дама) |
| `kolir` | `color=3` → `5747` (Комбінований); `color=4` → `5674` (Пейзажний); `color=1` → `5670` (Світлий); `color=2` → `5671` (Темний) |
| `typy_obrobky_burshtynu` | `material=1` → `5693` (Натуральний); `material=2` → `5694` (Формований) |

`tematyka_vyrobu` label matches cannot become semantic bindings under the current
numeric source-key contract. Existing option identities: `Ссавці` → `5962`; `Птахи` → `5963`; `Риби` → `5964`; `Плазуни` → `5965`; `Земноводні` → `5966`; `Безхребетні` → `6023`.

### SV provisional category paths

All six bootstrap SV products fail overall evaluation, so these are exact tree
observations for provisional evaluator paths, not approved/sendable category plans.

| Route | Exact paths / IDs | Missing path |
| --- | --- | --- |
| Normal | `Default/Сувеніри` → 10; `Default/Сувеніри/Статуетки` → 38; `Default/Сувеніри/Статуетки/Тварини` → 39; `Default/Сувеніри/Статуетки/Символіка` → 610 | None among these provisional paths; other subtypes unexamined. |
| Stone | `Default/Камінь` → 380; `Default/Камінь/Полірований` → 640 | `Default/Камінь/Камінь сувенірний` |
