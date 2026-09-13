# Phase 7.0 Baseline Measurement

Generated: 2026-09-12T12:23:07.356Z

This report records measurement infrastructure and baseline evidence only. No optimization, SQL rewrite, index, cache, batching, pagination, concurrency, transaction, configuration, or migration change is included.

## Environment and dataset

- Revision: `215ac09d34065f48598bff6a4f2d0d9a4d8a12bc`
- Revision identifies the committed Phase 6D base. Phase 7.0 instrumentation and harness changes were intentionally uncommitted while these measurements were collected.
- Node: `v24.19.0`; PostgreSQL: `16.15`
- Connected database verified by query: `amber_test`
- CPU: AMD Ryzen 9 9950X3D 16-Core Processor           (32 logical); RAM: 64604956.0 KiB
- Pool maximum: 10; NBU rate override: 40
- Fixture seed: `phase7-v1`
- Scale: categories=25, products=1000, correction history=999, active correction requests=100, active drafts=25, repricing changes=500, export range=1000, lineage=50
- Sampling: 10 warm-ups + 100 samples for reads/previews; 5 warm-ups + 30 samples for writes/exports, three fresh server processes; concurrency 1 and 4 for reads.

Each process independently connected, made `SELECT current_database()` its first SQL statement, verified the `_test` suffix, repeated that check immediately before schema reset, reran immutable migrations, generated synthetic data, and executed authenticated HTTP requests through the PostgreSQL session store and active-user authorization boundary.

## Benchmark matrix and classifications

| Workflow | C | Run p50/p95 ms | Queries p50 | DB p95 ms | CPU p95 ms | ELD p95 ms | Peak RSS | Response p95 | Classification | Gate evidence |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| product_config | 1 | 46.273/48.486; 46.335/47.874; 46.222/48.137 | 31; 31; 31 | 35.634; 36.271; 35.415 | 16; 31; 16 | 12.857; 12.065; 12.82 | 101668.0 KiB; 101896.0 KiB; 102224.0 KiB | 11.9 KiB; 11.9 KiB; 11.9 KiB | **confirmed** | All three processes crossed: query p50 31 >= 20. |
| product_config | 4 | 45.779/51.218; 45.691/54.319; 45.81/53.865 | 31; 31; 31 | 41.371; 41.104; 41.292 | 32; 32; 32 | 12.074; 12.063; 12.138 | 194848.0 KiB; 202956.0 KiB; 202724.0 KiB | 11.9 KiB; 11.9 KiB; 11.9 KiB | **confirmed** | All three processes crossed: query p50 31 >= 20. |
| product_preview | 1 | 15.408/16.197; 15.408/17.326; 15.369/21.559 | 9; 9; 9 | 7.904; 8.51; 8.523 | 16; 16; 16 | 9.777; 9.851; 10.285 | 203536.0 KiB; 204152.0 KiB; 203840.0 KiB | 1.2 KiB; 1.2 KiB; 1.2 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| product_preview | 4 | 15.04/16.354; 15.047/19.408; 15.027/17.936 | 9; 9; 9 | 9.049; 9.46; 10.311 | 16; 31; 16 | 10.031; 10.187; 9.81 | 207744.0 KiB; 218044.0 KiB; 218928.0 KiB | 1.2 KiB; 1.2 KiB; 1.2 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| product_save | 1 | 19.399/20.558; 19.214/20.405; 19.37/20.701 | 15; 15; 15 | 11.756; 11.201; 12.02 | 16; 16; 16 | 10.74; 10.871; 10.703 | 210256.0 KiB; 218848.0 KiB; 219788.0 KiB | 0.0 KiB; 0.0 KiB; 0.0 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| product_decode | 1 | 14.771/15.297; 14.756/15.47; 14.772/15.218 | 8; 8; 8 | 6.72; 6.993; 6.606 | 15; 16; 15 | 0; 0; 0 | 214816.0 KiB; 223844.0 KiB; 224704.0 KiB | 2.1 KiB; 2.1 KiB; 2.1 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| product_decode | 4 | 14.348/20.47; 14.313/20.985; 14.35/20.321 | 8; 8; 8 | 8.779; 8.729; 8.62 | 16; 16; 16 | 10.277; 10.22; 10.359 | 248036.0 KiB; 239736.0 KiB; 239852.0 KiB | 2.1 KiB; 2.1 KiB; 2.1 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| recount_preview | 1 | 30.153/32.223; 30.129/31.625; 30.184/31.86 | 18; 18; 18 | 15.027; 15.419; 14.929 | 16; 16; 16 | 10.31; 10.277; 10.285 | 250872.0 KiB; 240104.0 KiB; 239684.0 KiB | 2.6 KiB; 2.6 KiB; 2.6 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| recount_preview | 4 | 29.306/31.488; 29.289/31.361; 29.136/31.094 | 18; 18; 18 | 17.307; 16.106; 16.821 | 16; 16; 16 | 10.281; 10.228; 10.129 | 252368.0 KiB; 242152.0 KiB; 243600.0 KiB | 2.6 KiB; 2.6 KiB; 2.6 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| recount_direct_apply | 1 | 30.234/34.274; 30.233/31.282; 30.152/33.995 | 36; 36; 36 | 25.927; 25.032; 25.138 | 31; 31; 16 | 10.166; 10.179; 10.084 | 252208.0 KiB; 240076.0 KiB; 241644.0 KiB | 2.6 KiB; 2.6 KiB; 2.6 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| correction_completion | 1 | 100.669/103.718; 100.859/105.483; 100.494/104.87 | 107; 107; 107 | 88.759; 91.474; 89.43 | 31; 48; 47 | 11.004; 11.142; 11.03 | 249752.0 KiB; 238524.0 KiB; 239092.0 KiB | 9.1 KiB; 9.1 KiB; 9.1 KiB | **confirmed** | All three processes crossed: query p50 107 >= 75. |
| catalog_read | 1 | 30.786/32.028; 30.848/31.839; 30.85/31.861 | 4; 4; 4 | 18.212; 17.95; 17.724 | 16; 16; 16 | 15.888; 15.962; 15.872 | 249860.0 KiB; 239312.0 KiB; 239704.0 KiB | 11.8 KiB; 11.8 KiB; 11.8 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| catalog_read | 4 | 30.519/33.014; 30.276/31.739; 30.39/32.02 | 4; 4; 4 | 21.798; 21.24; 21.092 | 16; 16; 16 | 16.355; 15.798; 15.88 | 250384.0 KiB; 239516.0 KiB; 239488.0 KiB | 11.8 KiB; 11.8 KiB; 11.8 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| schema_read | 1 | 15.403/16.121; 15.297/16.272; 15.467/15.879 | 7; 7; 7 | 6.006; 6.562; 5.777 | 16; 16; 16 | 0; 0; 0 | 246096.0 KiB; 234560.0 KiB; 235156.0 KiB | 0.3 KiB; 0.3 KiB; 0.3 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| schema_read | 4 | 15.167/17.65; 15.14/20.28; 15.259/18.454 | 7; 7; 7 | 7.577; 6.949; 6.53 | 16; 16; 31 | 0; 0; 0 | 246612.0 KiB; 235168.0 KiB; 235580.0 KiB | 0.3 KiB; 0.3 KiB; 0.3 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| pricing_read | 1 | 15.365/16.068; 15.39/16.204; 15.436/16.043 | 3; 3; 3 | 4.219; 4.289; 3.739 | 16; 16; 15 | 0; 0; 0 | 247412.0 KiB; 236816.0 KiB; 236884.0 KiB | 6.4 KiB; 6.4 KiB; 6.4 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| pricing_read | 4 | 15.132/16.286; 15.137/15.866; 15.197/15.817 | 3; 3; 3 | 4.633; 4.518; 4.298 | 16; 16; 16 | 0; 0; 0 | 251004.0 KiB; 238100.0 KiB; 238128.0 KiB | 6.4 KiB; 6.4 KiB; 6.4 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| correction_queue | 1 | 14.914/18.825; 14.848/21.954; 14.881/21.332 | 4; 4; 4 | 8.153; 8.386; 7.972 | 16; 16; 16 | 9.31; 9.908; 0 | 303864.0 KiB; 247792.0 KiB; 249156.0 KiB | 223.6 KiB; 223.6 KiB; 223.6 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| correction_queue | 4 | 27.52/31.184; 28.168/32.352; 28.18/32.655 | 4; 4; 4 | 15.18; 13.851; 14.301 | 32; 32; 31 | 14.184; 14.987; 15.395 | 313024.0 KiB; 332896.0 KiB; 327048.0 KiB | 223.6 KiB; 223.6 KiB; 223.6 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| correction_history_page | 1 | 30.609/31.483; 30.405/32.344; 30.659/31.738 | 7; 7; 7 | 25.862; 26.769; 26.388 | 16; 16; 31 | 15.471; 15.454; 15.512 | 290208.0 KiB; 264536.0 KiB; 298352.0 KiB | 104.8 KiB; 104.8 KiB; 104.8 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| correction_history_page | 4 | 29.495/38.94; 29.266/36.826; 29.311/37.703 | 7; 7; 7 | 32.454; 33.082; 32.966 | 32; 32; 32 | 14.897; 14.848; 12.927 | 293616.0 KiB; 271140.0 KiB; 281752.0 KiB | 104.8 KiB; 104.8 KiB; 104.8 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| correction_history_csv | 1 | 30.583/33.157; 30.865/32.453; 30.826/32.13 | 7; 7; 7 | 27.933; 28.499; 28.975 | 16; 16; 16 | 15.446; 15.405; 15.43 | 285680.0 KiB; 275248.0 KiB; 286808.0 KiB | 129.3 KiB; 129.3 KiB; 129.3 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| product_timeline | 1 | 74.99/81.672; 75.189/83.777; 75.286/82.454 | 9; 9; 9 | 67.252; 66.279; 66.427 | 93; 62; 78 | 13.33; 12.942; 12.932 | 322644.0 KiB; 298824.0 KiB; 312976.0 KiB | 935.9 KiB; 935.9 KiB; 935.9 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| product_timeline | 4 | 111.929/124.787; 113.407/130.143; 111.917/126.878 | 9; 9; 9 | 112.89; 118.36; 116.746 | 141; 156; 141 | 15.222; 16.053; 15.334 | 492468.0 KiB; 420420.0 KiB; 443092.0 KiB | 935.9 KiB; 935.9 KiB; 935.9 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| repricing_scenario_preview | 1 | 29.098/39.105; 29.259/49.371; 29.344/43.763 | 5; 5; 5 | 10.203; 10.512; 10.061 | 62; 78; 32 | 17.85; 19.046; 18.653 | 441536.0 KiB; 425500.0 KiB; 441968.0 KiB | 1229.2 KiB; 1229.2 KiB; 1229.2 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| repricing_scenario_preview | 4 | 82.6/95.429; 83.934/94.32; 82.772/96.333 | 5; 5; 5 | 59.75; 59.94; 58.402 | 156; 156; 157 | 26.324; 27.378; 26.64 | 451160.0 KiB; 404092.0 KiB; 399644.0 KiB | 1229.2 KiB; 1229.2 KiB; 1229.2 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| repricing_global_preview | 1 | 28.75/45.214; 33.573/47.48; 28.747/49.894 | 5; 5; 5 | 10.128; 10.453; 9.999 | 78; 78; 63 | 19.063; 19.276; 18.555 | 445160.0 KiB; 409968.0 KiB; 409532.0 KiB | 1446.9 KiB; 1446.9 KiB; 1446.9 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| repricing_global_preview | 4 | 94.314/105.238; 93.37/105.524; 93.434/105.094 | 5; 5; 5 | 65.448; 67.684; 65.729 | 171; 172; 172 | 27.012; 27.847; 26.961 | 480992.0 KiB; 451200.0 KiB; 410780.0 KiB | 1446.9 KiB; 1446.9 KiB; 1446.9 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| repricing_draft_list | 1 | 15.377/16.123; 15.338/16.521; 15.38/16.31 | 3; 3; 3 | 3.308; 3.762; 3.894 | 0; 0; 16 | 0; 0; 0 | 431052.0 KiB; 415836.0 KiB; 392256.0 KiB | 13.9 KiB; 13.9 KiB; 13.9 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| repricing_draft_list | 4 | 15.164/16.603; 15.198/16.282; 15.22/16.224 | 3; 3; 3 | 4.133; 4.154; 4.332 | 16; 16; 16 | 0; 0; 0 | 403624.0 KiB; 401724.0 KiB; 364676.0 KiB | 13.9 KiB; 13.9 KiB; 13.9 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| repricing_draft_read | 1 | 39.743/46.581; 40.459/52.071; 40.575/47.691 | 6; 6; 6 | 15.149; 16.138; 15.89 | 63; 94; 93 | 14.003; 14.071; 14.336 | 413700.0 KiB; 375152.0 KiB; 386836.0 KiB | 1230.0 KiB; 1230.0 KiB; 1230.0 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| repricing_draft_read | 4 | 96.584/110.531; 99.269/114.075; 96.603/109.058 | 6; 6; 6 | 76.08; 77.884; 74.319 | 188; 203; 173 | 20.301; 20.038; 20.23 | 456596.0 KiB; 427716.0 KiB; 424196.0 KiB | 1230.0 KiB; 1230.0 KiB; 1230.0 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| repricing_draft_create | 1 | 72.026/94.195; 74.824/88.397; 72.449/77.384 | 16; 16; 16 | 57.16; 43.54; 39.03 | 109; 109; 78 | 15.052; 14.221; 14.53 | 419948.0 KiB; 391912.0 KiB; 412668.0 KiB | 1230.0 KiB; 1230.0 KiB; 1230.0 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| repricing_draft_sync | 1 | 77.308/88.443; 77.168/82.365; 75.747/93.83 | 11; 11; 11 | 42.185; 50.226; 56.783 | 125; 78; 110 | 14.528; 14.343; 14.649 | 398736.0 KiB; 375976.0 KiB; 366856.0 KiB | 1230.0 KiB; 1230.0 KiB; 1230.0 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| repricing_apply | 1 | 657.249/679.065; 659.9/682.788; 658.329/673.009 | 915; 915; 915 | 629.148; 626.188; 626.006 | 218; 218; 218 | 10.437; 10.416; 10.402 | 383068.0 KiB; 353168.0 KiB; 348396.0 KiB | 0.3 KiB; 0.3 KiB; 0.3 KiB | **confirmed** | All three processes crossed: request p95 679.065ms >= 500ms; query p50 915 >= 75. |
| repricing_rollback | 1 | 329.099/341.989; 332.454/340.316; 334.405/341.861 | 461; 461; 461 | 318.73; 316.424; 315.509 | 125; 109; 109 | 10.315; 10.287; 10.33 | 385656.0 KiB; 332048.0 KiB; 327316.0 KiB | 0.3 KiB; 0.3 KiB; 0.3 KiB | **confirmed** | All three processes crossed: query p50 461 >= 75. |
| repricing_csv | 1 | 20.145/29.285; 22.75/29.629; 21.66/27.892 | 4; 4; 4 | 12.093; 11.203; 10.974 | 32; 16; 32 | 10.559; 10.421; 10.409 | 387876.0 KiB; 333036.0 KiB; 329596.0 KiB | 61.4 KiB; 61.4 KiB; 61.4 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| export_status | 1 | 15.34/16.412; 15.406/16.797; 15.362/16.387 | 4; 4; 4 | 5.531; 6.075; 5.51 | 16; 15; 16 | 0; 0; 0 | 387876.0 KiB; 332756.0 KiB; 329452.0 KiB | 0.2 KiB; 0.2 KiB; 0.2 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| export_status | 4 | 15.238/16.706; 15.252/16.367; 15.168/16.306 | 4; 4; 4 | 5.765; 5.783; 5.682 | 16; 16; 16 | 0; 0; 0 | 365188.0 KiB; 332096.0 KiB; 328784.0 KiB | 0.2 KiB; 0.2 KiB; 0.2 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| export_snapshot_create | 1 | 30.17/31.935; 29.488/32.984; 28.729/33.368 | 12; 12; 12 | 14.537; 17.811; 16.528 | 31; 16; 16 | 10.482; 11.031; 10.973 | 365316.0 KiB; 330548.0 KiB; 327348.0 KiB | 0.2 KiB; 0.2 KiB; 0.2 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| export_snapshot_reuse | 1 | 5.209/20.399; 5.442/19.49; 19.024/20.807 | 3; 3; 3 | 3.125; 2.982; 3.902 | 0; 16; 16 | 15.616; 15.522; 15.722 | 365668.0 KiB; 330888.0 KiB; 327608.0 KiB | 0.2 KiB; 0.2 KiB; 0.2 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| export_snapshot_download | 1 | 17.584/20.263; 5.321/19.375; 18.041/20.931 | 3; 3; 3 | 3.829; 2.877; 4.012 | 15; 16; 31 | 15.686; 15.538; 16.112 | 369600.0 KiB; 332924.0 KiB; 328732.0 KiB | 24.5 KiB; 24.5 KiB; 24.5 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |
| export_snapshot_confirmation | 1 | 8.855/24.872; 9.001/24.339; 23.077/24.693 | 9; 9; 9 | 8.121; 7.3; 8.163 | 16; 0; 0 | 15.567; 15.596; 15.841 | 369656.0 KiB; 333144.0 KiB; 328820.0 KiB | 0.1 KiB; 0.1 KiB; 0.1 KiB | **rejected** | All three representative/high-scale processes stayed below every endpoint gate. |

Query counts include the PostgreSQL-backed session read and active-user/RBAC reads. Inspected domain-only expectations:

- `product_config`: 2 + 3 per category, plus authentication/session.
- `product_preview`: 6-7 domain queries, plus authentication/session.
- `product_save`: 10-11 domain queries, plus authentication/session.
- `product_decode`: 6 domain queries, plus authentication/session.
- `recount_preview`: 16-17 domain queries, plus authentication/session.
- `recount_direct_apply`: 31-34 domain queries, plus authentication/session.
- `correction_completion`: 52-56 domain queries without drafts, plus authentication/session.
- `catalog_read`: 2 domain queries, plus authentication/session.
- `schema_read`: 5 domain queries, plus authentication/session.
- `pricing_read`: 1 domain query, plus authentication/session.
- `correction_queue`: 2 domain queries, plus authentication/session.
- `correction_history_page`: 5 domain queries, plus authentication/session.
- `correction_history_csv`: 5 domain queries, plus authentication/session.
- `product_timeline`: 6-7 domain queries, plus authentication/session.
- `repricing_scenario_preview`: 3 domain queries, plus authentication/session.
- `repricing_global_preview`: batched context reads; constant query count by category.
- `repricing_draft_list`: 1 domain query, plus authentication/session.
- `repricing_draft_read`: 4-5 domain queries, plus authentication/session.
- `repricing_draft_create`: 11-12 domain queries, plus authentication/session.
- `repricing_draft_sync`: 9-10 domain queries, plus authentication/session.
- `repricing_apply`: about 12 + 2 per changed product, plus authentication/session.
- `repricing_rollback`: about 6 + 1 per changed product, plus authentication/session.
- `repricing_csv`: 2 domain queries, plus authentication/session.
- `export_status`: 2-3 domain queries, plus authentication/session.
- `export_snapshot_create`: 8-9 domain queries, plus authentication/session.
- `export_snapshot_reuse`: 1 domain query, plus authentication/session.
- `export_snapshot_download`: 1 domain query, plus authentication/session.
- `export_snapshot_confirmation`: transactional constant query count, plus authentication/session.

End-of-run cardinalities (setup scale plus deterministic mutation samples):

- Run 1: categories=25, products=1105, corrections=1069, correction_requests=135, drafts=0, repricing_items=451, export_snapshots=140.
- Run 2: categories=25, products=1105, corrections=1069, correction_requests=135, drafts=0, repricing_items=451, export_snapshots=140.
- Run 3: categories=25, products=1105, corrections=1069, correction_requests=135, drafts=0, repricing_items=451, export_snapshots=140.

## EXPLAIN (ANALYZE, BUFFERS) observations

Plans were captured after `ANALYZE`, twice per target (first and warm), in explicit transactions that were always rolled back. Expression literals were sanitized before writing artifacts.

| Target | Temp | Execution ms | Significant nodes | Shared read | Temp blocks | Max estimate ratio |
| --- | --- | ---: | --- | ---: | ---: | ---: |
| catalog_hydration | first | 0.157 | Sort, Hash Join, Seq Scan, Hash | 0 | 0 | 1.04 |
| catalog_hydration | warm | 0.116 | Sort, Hash Join, Seq Scan, Hash | 0 | 0 | 1.04 |
| schema_lookup | first | 0.053 | Sort, Nested Loop, Seq Scan | 0 | 0 | 1.00 |
| schema_lookup | warm | 0.07 | Sort, Nested Loop, Seq Scan | 0 | 0 | 1.00 |
| product_sequence_common | first | 0.776 | Limit, Sort, Bitmap Heap Scan, Bitmap Index Scan | 0 | 0 | 1035.00 |
| product_sequence_common | warm | 0.476 | Limit, Sort, Bitmap Heap Scan, Bitmap Index Scan | 0 | 0 | 1035.00 |
| product_variation_rare | first | 0.05 | Seq Scan | 0 | 0 | 1.00 |
| product_variation_rare | warm | 0.046 | Seq Scan | 0 | 0 | 1.00 |
| pricing_context | first | 0.036 | Sort, Nested Loop, Seq Scan | 0 | 0 | 2.00 |
| pricing_context | warm | 0.032 | Sort, Nested Loop, Seq Scan | 0 | 0 | 2.00 |
| correction_queue_common | first | 0.027 | Limit, Sort, Index Scan | 0 | 0 | 1.00 |
| correction_queue_common | warm | 0.032 | Limit, Sort, Index Scan | 0 | 0 | 1.00 |
| correction_history_page | first | 0.404 | Limit, Sort, Seq Scan | 0 | 0 | 5.34 |
| correction_history_page | warm | 0.436 | Limit, Sort, Seq Scan | 0 | 0 | 5.34 |
| repricing_candidates | first | 1.591 | Sort, Seq Scan | 0 | 0 | 164.33 |
| repricing_candidates | warm | 1.446 | Sort, Seq Scan | 0 | 0 | 164.33 |
| timeline_recursive_lineage | first | 0.171 | Sort, Recursive Union, Bitmap Heap Scan, Bitmap Index Scan, Nested Loop, WorkTable Scan, CTE Scan | 0 | 0 | 3.00 |
| timeline_recursive_lineage | warm | 0.157 | Sort, Recursive Union, Bitmap Heap Scan, Bitmap Index Scan, Nested Loop, WorkTable Scan, CTE Scan | 0 | 0 | 3.00 |
| export_range_common | first | 1.107 | Sort, Bitmap Heap Scan, Bitmap Index Scan | 0 | 0 | 178.83 |
| export_range_common | warm | 0.872 | Sort, Bitmap Heap Scan, Bitmap Index Scan | 0 | 0 | 178.83 |

Plan candidate classifications:

- `plan_catalog_hydration`: **rejected** — All three first/warm plan pairs stayed below every plan gate.
- `plan_schema_lookup`: **rejected** — All three first/warm plan pairs stayed below every plan gate.
- `plan_product_sequence_common`: **confirmed** — All three first/warm plan pairs crossed the estimate ratio gate. This is a plan-quality finding; endpoint latency must still justify any optimization experiment.
- `plan_product_variation_rare`: **rejected** — All three first/warm plan pairs stayed below every plan gate.
- `plan_pricing_context`: **rejected** — All three first/warm plan pairs stayed below every plan gate.
- `plan_correction_queue_common`: **rejected** — All three first/warm plan pairs stayed below every plan gate.
- `plan_correction_history_page`: **rejected** — All three first/warm plan pairs stayed below every plan gate.
- `plan_repricing_candidates`: **confirmed** — All three first/warm plan pairs crossed the estimate ratio gate. This is a plan-quality finding; endpoint latency must still justify any optimization experiment.
- `plan_timeline_recursive_lineage`: **rejected** — All three first/warm plan pairs stayed below every plan gate.
- `plan_export_range_common`: **confirmed** — All three first/warm plan pairs crossed the estimate ratio gate. This is a plan-quality finding; endpoint latency must still justify any optimization experiment.

## Phase timer observations

| Workflow / phase | Run p50/p95 ms | Observed samples |
| --- | --- | --- |
| catalog_read c1 / `catalog.hydration` | 0.014/0.022; 0.013/0.022; 0.011/0.021 | 100; 100; 100 |
| catalog_read c4 / `catalog.hydration` | 0.008/0.015; 0.009/0.016; 0.009/0.015 | 400; 400; 400 |
| correction_history_page c1 / `catalog.hydration` | 0.012/0.018; 0.012/0.017; 0.012/0.02 | 100; 100; 100 |
| correction_history_page c1 / `correction_history.normalization` | 0.173/0.299; 0.176/0.286; 0.149/0.312 | 100; 100; 100 |
| correction_history_page c4 / `catalog.hydration` | 0.008/0.013; 0.009/0.013; 0.009/0.016 | 400; 400; 400 |
| correction_history_page c4 / `correction_history.normalization` | 0.09/0.14; 0.089/0.164; 0.098/0.194 | 400; 400; 400 |
| correction_history_csv c1 / `catalog.hydration` | 0.01/0.013; 0.011/0.016; 0.01/0.018 | 30; 30; 30 |
| correction_history_csv c1 / `correction_history.normalization` | 0.421/0.654; 0.417/0.872; 0.446/0.774 | 30; 30; 30 |
| correction_history_csv c1 / `correction_history.csv` | 1.101/2.051; 1.179/2.073; 1.206/1.9 | 30; 30; 30 |
| repricing_scenario_preview c1 / `repricing.projection_and_tokens` | 9.514/13.425; 8.913/13.112; 9.204/11.838 | 100; 100; 100 |
| repricing_scenario_preview c4 / `repricing.projection_and_tokens` | 31.71/34.527; 30.924/34.875; 31.412/35.047 | 400; 400; 400 |
| repricing_global_preview c1 / `repricing.projection_and_tokens` | 12.287/16.257; 12.15/16.346; 12.871/15.521 | 100; 100; 100 |
| repricing_global_preview c4 / `repricing.projection_and_tokens` | 47.478/61.795; 46.985/59.658; 47.042/59.859 | 400; 400; 400 |
| export_snapshot_create c1 / `export.shaping` | 1.004/1.376; 0.972/1.115; 1.014/1.195 | 30; 30; 30 |
| export_snapshot_create c1 / `export.csv` | 0.241/0.53; 0.217/0.418; 0.236/0.443 | 30; 30; 30 |

## Suspected hotspots ranked by evidence

1. **product_config (c1) — confirmed.** All three processes crossed: query p50 31 >= 20.
2. **product_config (c4) — confirmed.** All three processes crossed: query p50 31 >= 20.
3. **correction_completion (c1) — confirmed.** All three processes crossed: query p50 107 >= 75.
4. **repricing_apply (c1) — confirmed.** All three processes crossed: request p95 679.065ms >= 500ms; query p50 915 >= 75.
5. **repricing_rollback (c1) — confirmed.** All three processes crossed: query p50 461 >= 75.
6. **plan_product_sequence_common — confirmed.** All three first/warm plan pairs crossed the estimate ratio gate. This is a plan-quality finding; endpoint latency must still justify any optimization experiment.
7. **plan_repricing_candidates — confirmed.** All three first/warm plan pairs crossed the estimate ratio gate. This is a plan-quality finding; endpoint latency must still justify any optimization experiment.
8. **plan_export_range_common — confirmed.** All three first/warm plan pairs crossed the estimate ratio gate. This is a plan-quality finding; endpoint latency must still justify any optimization experiment.

## Optimization checkpoints

- `product_config`: checkpoint 7.1 may test the smallest query-count/work reduction isolated to the crossed gate; preserve HTTP behavior, transaction/lock ordering, immutable history, and all domain invariants. Re-run this exact case and correctness suite before considering it.
- `correction_completion`: checkpoint 7.1 may test the smallest query-count/work reduction isolated to the crossed gate; preserve HTTP behavior, transaction/lock ordering, immutable history, and all domain invariants. Re-run this exact case and correctness suite before considering it.
- `repricing_apply`: checkpoint 7.1 may test the smallest query-count/work reduction isolated to the crossed gate; preserve HTTP behavior, transaction/lock ordering, immutable history, and all domain invariants. Re-run this exact case and correctness suite before considering it.
- `repricing_rollback`: checkpoint 7.1 may test the smallest query-count/work reduction isolated to the crossed gate; preserve HTTP behavior, transaction/lock ordering, immutable history, and all domain invariants. Re-run this exact case and correctness suite before considering it.
- `plan_product_sequence_common`: first repeat the plan measurement at a larger representative cardinality. Its estimate-ratio gate crossed, but execution stayed below the single-query latency gate; no SQL or index experiment is authorized yet.
- `plan_repricing_candidates`: first repeat the plan measurement at a larger representative cardinality. Its estimate-ratio gate crossed, but execution stayed below the single-query latency gate; no SQL or index experiment is authorized yet.
- `plan_export_range_common`: first repeat the plan measurement at a larger representative cardinality. Its estimate-ratio gate crossed, but execution stayed below the single-query latency gate; no SQL or index experiment is authorized yet.

## Confirmed candidate measurement records

### `product_config`

1. **Measured:** Authenticated configuration request latency, total/domain fingerprint counts, DB time, response bytes, CPU, memory, and c1/c4 behavior.
2. **Reproduction:** `npm run benchmark:phase7` with categories=25; inspect `product_config` at c1 and c4 in all three run artifacts.
3. **Baseline:** request p50/p95 46.273/48.486ms; 46.335/47.874ms; 46.222/48.137ms; query p50 31; 31; 31; DB p95 35.634ms; 36.271ms; 35.415ms.
4. **Suspected cause:** The category-dependent fingerprint executes 25 times per request; the request has 31 total queries including session/RBAC.
5. **Smallest possible next experiment:** In checkpoint 7.1 only, prototype the smallest set-based catalog/schema read behind the existing service shape and compare it against this exact baseline.
6. **Correctness risks:** Category/question/option ordering, visibility rules, immutable schema selection, and the public JSON shape.
7. **Required verification:** Exact HTTP contract tests, catalog/SKU schema integration coverage, 25-category c1/c4 benchmark, query fingerprints, and final data-state assertions.

### `correction_completion`

1. **Measured:** Completion-only authenticated request latency and query fingerprints after deterministic request creation and claim setup.
2. **Reproduction:** `npm run benchmark:phase7`; inspect `correction_completion` with 100 active requests and the 999-row correction-history fixture.
3. **Baseline:** request p50/p95 100.669/103.718ms; 100.859/105.483ms; 100.494/104.87ms; query p50 107; 107; 107; DB p95 88.759ms; 91.474ms; 89.43ms.
4. **Suspected cause:** Several preview/schema/pricing reads repeat during final-state revalidation; two dominant fingerprints each execute 25 times per completion sample.
5. **Smallest possible next experiment:** In checkpoint 7.1 only, trace the repeated fingerprints to call sites and test reuse of an already transaction-consistent read model without moving any lock or revalidation boundary.
6. **Correctness risks:** Claim ownership epoch, target-based recount validation, final-state revalidation, SKU reservation, correction immutability, and lock ordering.
7. **Required verification:** Existing claim/race/final-state integration tests plus three-run completion benchmarks with identical request setup and database-state assertions.

### `repricing_apply`

1. **Measured:** Authenticated scenario apply over the requested 500-change axis (451 active changed products after the 50-link lineage fixture), including request/DB time and per-fingerprint counts.
2. **Reproduction:** `npm run benchmark:phase7`; inspect `repricing_apply` after deterministic price reset in each sample.
3. **Baseline:** request p50/p95 657.249/679.065ms; 659.9/682.788ms; 658.329/673.009ms; query p50 915; 915; 915; DB p95 629.148ms; 626.188ms; 626.006ms.
4. **Suspected cause:** One product UPDATE and one repricing-item INSERT per changed product dominate: each fingerprint executes 451 times per request.
5. **Smallest possible next experiment:** In checkpoint 7.1 only, benchmark the smallest write-count reduction that keeps the same transaction and ascending product-lock order; do not change concurrency semantics.
6. **Correctness risks:** Atomic apply, product state tokens, manual/automatic price meanings, immutable batch evidence, audit attribution, idempotency, and deadlock avoidance.
7. **Required verification:** All repricing concurrency/final-state/rollback tests plus three-run apply benchmarks at multiple changed-product axes and exact batch/item/product-state comparisons.

### `repricing_rollback`

1. **Measured:** Authenticated rollback for the same 451-item applied batch, including request/DB time and per-fingerprint counts.
2. **Reproduction:** `npm run benchmark:phase7`; each measured rollback follows a newly prepared deterministic apply.
3. **Baseline:** request p50/p95 329.099/341.989ms; 332.454/340.316ms; 334.405/341.861ms; query p50 461; 461; 461; DB p95 318.73ms; 316.424ms; 315.509ms.
4. **Suspected cause:** The product UPDATE fingerprint executes once for each rolled-back item and dominates the 461 total queries.
5. **Smallest possible next experiment:** In checkpoint 7.1 only, benchmark the smallest write-count reduction while preserving the single transaction, batch lock, ordered product locks, and exact historical payload checks.
6. **Correctness risks:** Rollback atomicity, exact payload validation, immutable historical items, product state restoration, audit attribution, and lock ordering.
7. **Required verification:** Rollback race/idempotency/final-state integration tests plus three-run rollback benchmarks and byte/row-equivalent restored state.

Confirmed plan-estimate findings are not yet endpoint optimization candidates: their execution times stayed below the single-query gate. The smallest next step is measurement at a larger representative cardinality before considering an index or SQL experiment.


## Instrumentation overhead

- Method: 5 rounds; 100 warm-ups and 500 samples per mode; requested 2ms asynchronous PostgreSQL-shaped delay (observed raw median about 15.5ms on this Windows host).
- Detailed collection disabled: median 0.000% overhead; gate < 2%.
- Enabled request/query summary: median 0.000% overhead; gate < 5%.
- Result: **passed**.


## Client build context

- `index-shmU_usP.js`: 292.1 KiB uncompressed.
- `index-DaiEu7XN.css`: 111.3 KiB uncompressed.
- `amber-logo-white-orange-CQKzfCEk.png`: 100.8 KiB uncompressed.
- `AdminPage-CgzTTr9d.js`: 71.0 KiB uncompressed.
- `RepricingPage-DCNp4mZv.js`: 59.8 KiB uncompressed.
- `useProductRecount-BfVYA9SS.js`: 38.9 KiB uncompressed.
- `AppPage-D1dP242n.js`: 29.6 KiB uncompressed.
- `CorrectionHistoryPage-Cpix5VPP.js`: 20.5 KiB uncompressed.
- `CorrectionRequestsPage-BXxCucjk.js`: 17.6 KiB uncompressed.
- `RolesPage-Bn3F6REF.js`: 14.8 KiB uncompressed.
- Client sizes are context only and do not authorize a client optimization.

## Areas explicitly left alone

- All migrations 000-028, indexes, constraints, triggers, transaction boundaries, and lock ordering.
- Global pricing-context batching and timeline bulk hydration, which already avoid the previously suspected N+1 patterns.
- HTTP/JSON/CSV contracts, permissions, SKU/pricing/recount/repricing behavior, export immutability, and migration checksum handling.
- Pagination semantics, caches, denormalization, streaming, concurrency, and client bundle composition.

## Acceptance criteria and reproduction

- Run `npm run benchmark:phase7` from `server/` with canonical `TEST_DATABASE_URL` and PostgreSQL 16.
- The command refuses missing or connected non-`_test` databases before migrations, reset, plans, fixtures, or HTTP startup.
- Raw sanitized plans are under `plans-run-*`; per-process metrics are `run-*.json`.
- `state-validation/run-*.json` proves three-process execution of independent post-request database assertions for every mutation/export case.
- A candidate is confirmed only if the same gate is crossed in all three fresh process repetitions.
- Phase 7.0 stops at evidence. Any checkpoint 7.1 experiment requires separate review.
