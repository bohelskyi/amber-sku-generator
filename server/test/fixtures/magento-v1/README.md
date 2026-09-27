# Magento Products v1 synthetic fixtures

These independent synthetic fixtures characterize the system Magento mapper; passing them does not approve every business mapping or prove a Magento import. Current export behavior is documented in [Exports](../../../../docs/EXPORTS.md), and published definitions in [Export templates](../../../../docs/EXPORT_TEMPLATES.md).

`contract.js` contains hand-authored answers, semantic bindings and dictionaries. `expected-rows.js` defines complete expected cells. `goldens.json` stores exact UTF-8 CSV strings, including quoting, Unicode, CR/LF, sparse EN cells, no BOM and no final newline. Tests compare bytes without normalization; expected data must not be generated from mapper output.

Run from `server/` with the repository's Node 20 toolchain:

```text
node --test test/magento-v1-characterization.test.js test/magento-v1-categories.test.js test/magento-v1-goldens.test.js
```

Only after reviewing intended fixture changes, the standard-library Python authoring utility can encode the independent expected cells (from repository root):

```text
python server/test/fixtures/magento-v1/write-goldens.py
git diff -- server/test/fixtures/magento-v1/goldens.json
```

The original branch/commit, compatibility register, counts and historical limitations are preserved in the [PR1A characterization record](../../../../docs/archive/exports/MAGENTO_V1_CHARACTERIZATION_2026-09-23.md). References there to future PR1B work or an absent recount fix describe that checkpoint only.
