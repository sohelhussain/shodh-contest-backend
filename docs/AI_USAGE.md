# AI Assistance & Verification Disclosure

## 1. What AI Generated

AI assistance was utilized in the development of **Shodh a Code** across the following areas:
* **Boilerplate Architecture & Schema Design**: Scaffolded the Prisma schema definitions, enum definitions, composite index specifications, and NestJS module boundaries.
* **Runner Sandbox Harness**: Generated the initial child process spawning code for Docker flags (`--network none`, `--memory`, `--cpus`, `--read-only`, tmpfs mounts, wall-time timeouts) and the MockRunner double.
* **Test Suite Scaffolding**: Generated functional test suites covering HTTP authentication, authorization matrix, concurrency races, and out-of-order rejudge completions.
* **Documentation & Diagnostic Scripts**: Drafted the OpenAPI configuration, load test script (`scripts/load_test.ts`), and bottleneck analysis script (`scripts/bottleneck_investigation.ts`).

---

## 2. What Was Verified & How

Every component, constraint, and metric was empirically verified against real running software:

| Component | Verification Method | Demonstrated Evidence |
| :--- | :--- | :--- |
| **Relational Schema & Invariants** | Executed Prisma migrations and deterministic seed on real PostgreSQL 16. Tested unique constraints with parallel requests. | Zero migration errors; concurrent duplicate submissions safely deduplicated. |
| **Auth & Isolation Boundaries** | Functional tests asserting 401 on missing/bad HMAC, 404 on cross-organization access, and 403 on role escalation. | All 18 Phase 1 authorization tests passed. |
| **Real Docker Sandbox** | Executed real Python containers with test cases targeting `--network none` (socket connection rejected), read-only rootfs (write failed), and non-root execution (UID=65534). | Real Docker tests passed with `execution_mode=docker`. |
| **Worker Queue & CAS Updates** | Simulated competing workers, lease expiration recovery, and out-of-order rejudges. | Verified in Phase 2 and Phase 3 functional tests. |
| **Standings Determinism** | Compared served leaderboard ranks against standings rebuilt from scratch purely from stored records. | Strict equality confirmed (`rebuilt == served`). |
| **Injected Failpoint Recovery** | Injected `FAILPOINT=runner_crash`, verified automatic retry and final stored outcome. | Real trace captured in `results/injected-failure.log`. |
| **Performance Benchmarking** | Ran concurrent load script measuring p50/p95/p99 latencies, and ran `EXPLAIN ANALYZE` before and after adding a composite index. | Real execution output captured in `results/load-test.txt` and `results/explain-analyze.txt`. |

**Rule of Evidence**: No test result, query plan, or performance figure in this repository is fabricated. All outputs are derived from actual CLI and script executions recorded in the `/results/` directory.
