# AI Assistance & Verification Disclosure

## 1. What AI Generated

AI assistance was utilized in the development of **Shodh a Code** across the following areas:
* **Boilerplate Architecture & Schema Design**: Scaffolded the Prisma schema definitions, enum definitions, composite index specifications, and NestJS module boundaries.
* **Runner Sandbox Harness**: Generated the child process spawning code for Docker flags (`--network none`, `--memory`, `--cpus`, `--read-only`, tmpfs mounts, wall-time timeouts) and the MockRunner double.
* **Test Suite Scaffolding**: Generated functional test suites covering HTTP authentication, authorization matrix, multi-process concurrency races, memory limits, pids limits, crash before ack, and out-of-order rejudge completions.
* **Documentation & Diagnostic Scripts**: Drafted the OpenAPI configuration, fast 50k bulk seeder (`scripts/seed_50k.ts`), 3,000-request load test script (`scripts/load_test.ts`), and bottleneck analysis script (`scripts/bottleneck_investigation.ts`).

---

## 2. What Was Verified & How

Every component, constraint, and metric was empirically verified against real running software:

| Component | Verification Method | Demonstrated Evidence |
| :--- | :--- | :--- |
| **Relational Schema & Invariants** | Executed Prisma migrations and deterministic seed on real PostgreSQL 16. Tested unique constraints with parallel requests. | Zero migration errors; concurrent duplicate submissions safely deduplicated. |
| **Multi-Process Race Isolation** | Spawned **two distinct OS Node processes** concurrently against PostgreSQL using `FOR UPDATE SKIP LOCKED`. | Process barrier proved mutual exclusion; exactly one process claimed the job. |
| **Real Docker Sandbox** | Executed real Python containers with test cases targeting `--network none` (socket blocked), read-only rootfs (write blocked), non-root execution (UID=65534), memory limits (OOM 137 kill), and pids limits (fork bomb blocked). | 100% passed with `execution_mode=docker`. |
| **Worker Queue & CAS Updates** | Tested crash after judging before ack (`FAILPOINT=crash_before_ack`), lease expiry re-claim, and out-of-order rejudges. | Verified in Phase 2 and Phase 3 functional tests; no duplicate points awarded. |
| **Standings Determinism** | Compared served leaderboard ranks against standings rebuilt from scratch on the full 50,000+ submission dataset. | Strict equality confirmed (`rebuilt == served`). |
| **Performance Benchmarking** | Ran 3,000 operations at concurrency 32 on 50,000 rows (70% leaderboard, 30% submissions), measuring API intake separately from queue delay and worker execution. | Real execution output captured in `results/load-test.txt` (884.17 req/s, 0 errors). |
| **Query Plan Optimization** | Ran `EXPLAIN (ANALYZE, BUFFERS)` on 50,000 rows before and after adding `idx_submissions_perf_tuning`. | Recorded in `results/explain-analyze.txt`. |

**Rule of Evidence**: No test result, query plan, or performance figure in this repository is fabricated. All outputs are derived from actual CLI and script executions recorded in the `/results/` directory.
