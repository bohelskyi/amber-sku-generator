# H3b disposable scale receipt — 2026-10-02

No production or real Magento access. A read-only `pg_dump` of the existing local
rehearsal database was restored only into `amber_wave2_scale_test` on the canonical
PostgreSQL 16 service at loopback port 55432. The source retained migration 049,
4979 products and 3323 active uncorrected rows with public identities. The clone
was upgraded through 056 using the normal checksum-verifying migration runner.
Synthetic headroom exists only in the clone; it was subsequently restored again
from the original local dump for the baseline repeat. No dump/credentials/product
records are committed with this receipt.

Node 20.20.2 on the local Windows development machine, PostgreSQL 16; mocked/closed
HTTP only. Measurement calls the real publication preview, then the real complete
local context revalidation under publication table locks, and compares its digest.
The revalidation transaction rolls back; it publishes nothing. The benchmark
refuses targets other than the explicitly named canonical disposable clone and
replaces global HTTP before importing business services.

| Selected products | Preview | Locked local revalidation | Returned review JSON | Maximum page input | Sampled heap / RSS peak |
| --- | --- | --- | --- | --- | --- |
| 3323, unchanged local rehearsal binding | 43.587 s | 6.585 s | 340 bytes | 457789 bytes | 40 / 133 MiB |
| 4096, 773 synthetic current products added | 40.441 s | 4.860 s | 340 bytes | 457789 bytes | 39 / 126 MiB |

These repeats overlapped other local verification, so relative timing is not a
throughput comparison. Earlier isolated repeats were 28.144 / 3.000 seconds at
3323 and 39.842 / 3.810 at 4096. Heap/RSS are samples at query/page boundaries,
including the loaded immutable schema/definitions; transient allocation between
samples may be higher. Aggregate input read was 9945445 / 12170247 bytes; it was
processed in pages and not retained as a complete product array. Unchanged binding
impact has no affected/lost/name-change entries, hence the small returned evidence.
This measures local processing, not real remote network latency or connectivity.

The first unprepared run exceeded the preview deadline. CPU profiling identified
invariant mapper/route/binding analysis repeated per product and a domain-policy
search hashing its lookup key for every candidate. Request-owned opaque preparation
and hoisting that key preserve the existing evaluator/planner output. Regression
compares prepared and unprepared diagnostics and rejects cross-context reuse.

Release ceiling: **4096 products** (32 pages, 23% above the measured real scope),
**128 products/page**, **8 MiB input/page**, **2 MiB returned review evidence**,
**60 seconds total preview**, **15 seconds final local boundary**, and **5 seconds
maximum table-lock wait**. SQL statement timeout also remains bounded at the final
boundary. Evidence/time bounds are independent of count: a large/slow case fails
closed and does not publish. No higher unmeasured ceiling is claimed.

Focused coverage additionally reviews 1004 synthetic current products with 1003
affected entries, changes the last-page lifecycle state, rejects the stale token,
then atomically records all 1002 remaining affected products in 128-item batches.
Unit tests reject 4097 products, oversized input before transfer, evidence overflow
and expired runtime; independent connections prove lifecycle serialization.

Reproduce after explicitly restoring this disposable clone:

```text
cd server
DATABASE_URL=<canonical disposable amber_wave2_scale_test URL>
node --expose-gc -r ./test/setup-env.js scripts/benchmark-magento-publication.js
node --expose-gc -r ./test/setup-env.js scripts/benchmark-magento-publication.js 4096
```

The optional headroom action intentionally mutates only that disposable clone.
Migration/checksum, full integration, unit, client and concurrency regressions
remain separate from these production-like measurements. Beyond 4096 products or
the byte/time ceilings requires further characterization and review; it must never
be bypassed by narrowing or truncating the selected publication scope.
