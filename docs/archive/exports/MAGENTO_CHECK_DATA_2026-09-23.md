> Historical record. This document describes the state/planning at the time it was written. Current behavior is defined by current code/migrations and the [maintained domain guides](../../README.md). Dates, findings and acceptance limits below are historical evidence, not current deployment claims.

## Confirmed Magento Products v1 acceptance

On 2026-09-23, the operator confirmed that all six CSV files from the fresh 40-fixture snapshot passed Magento **Check Data** with **File is valid**.

The run used a clean local restored production copy with startup and migrations through `034` healthy. Forty fresh products were created through authoritative preview/save services: two each of BR, NM, KL, CH, and AR, plus 30 SV products. Required manual names were saved through the existing manual-name preview/apply service. The explicit product-ID range was verified to contain only these fresh fixtures, with no older pending products; Magento preview reported `represented=40` and `ready=40` before snapshot creation.

| Group | CSV file | Products | Magento Check Data |
| --- | --- | ---: | --- |
| BR — Браслети | `amber-magento-BR-magento-products-v1.csv` | 2 | File is valid |
| NM — Намиста | `amber-magento-NM-magento-products-v1.csv` | 2 | File is valid |
| KL — Кулони | `amber-magento-KL-magento-products-v1.csv` | 2 | File is valid |
| CH — Чотки | `amber-magento-CH-magento-products-v1.csv` | 2 | File is valid |
| AR — Картини | `amber-magento-AR-magento-products-v1.csv` | 2 | File is valid |
| SV — Сувеніри | `amber-magento-SV-magento-products-v1.csv` | 30 | File is valid |

This records Check Data validation, not a completed Magento import. The fixture generator, manifest, reports, and generated CSVs remain local-only and are not repository deliverables. The accepted mappings and export behavior require no further changes unless a real defect is found; explicit `url_key` generation remains deferred.
