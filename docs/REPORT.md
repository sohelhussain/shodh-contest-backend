# Shodh a Code – Architectural Report & Diagnostic Evidence

## 1. System Architecture & Process Model

The **Shodh a Code** backend is built around a decoupled, relational-native architecture consisting of:
* **NestJS API Service**: Serves participant and organizer REST endpoints, validates HMAC signatures, enforces organization boundaries, handles idempotent submission intake, and streams live leaderboards with HTTP ETags.
* **PostgreSQL 16**: Acts as both the persistent system of record and the asynchronous job queue. By leveraging PostgreSQL's row-level locking primitive `FOR UPDATE SKIP LOCKED` and composite unique indexes, the system completely removes the need for Redis, Kafka, or third-party queue brokers while maintaining strict serializability guarantees.
* **Worker Processes**: Autonomous Node.js workers that poll the `jobs` table, claim tasks using leasing tokens, maintain heartbeat renewals, invoke containerized runners, and acknowledge completion using Compare-And-Swap (CAS) updates.
* **Execution Sandbox**: Real judging runs via `DockerRunner` in hardened, ephemeral Docker containers with dropped capabilities, bounded cgroups, non-root user execution, and disabled networking. A deterministic `MockRunner` double is provided for test suites and fault injection.

---

## 2. Transaction Boundaries & Consistency Guarantees

### A. Atomic Submission Ingestion
When a participant submits code via `POST /contests/:id/submissions`:
1. The request payload is hashed: `request_hash = SHA256(problem_id + ":" + language + ":" + code)`.
2. In a single database transaction:
   * A `Submission` record is inserted with `idempotency_key` and `request_hash`.
   * An initial `Attempt` (attempt #1) is created with status `QUEUED`.
   * A `Job` record is created with status `QUEUED`.
   * `submissions.authoritative_attempt_id` is linked to Attempt #1.
3. If a concurrent duplicate request with the same idempotency key hits the API simultaneously, PostgreSQL's `UNIQUE(contest_id, user_id, idempotency_key)` constraint triggers. The service catches the constraint violation, inspects the existing record, and safely returns HTTP 202 without creating duplicate attempts. Reusing the key with altered code produces an explicit HTTP 409 Conflict.

### B. Worker Claim & CAS Acknowledgment
To ensure competing workers never double-process a submission:
```sql
SELECT id, attempt_id, attempts_count
FROM jobs
WHERE (status = 'QUEUED')
   OR (status = 'RUNNING' AND lease_expires_at < NOW())
ORDER BY created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;
```
* **Exclusive Claim**: `FOR UPDATE SKIP LOCKED` locks the row in the transaction, preventing any other worker replica from claiming it.
* **Lease Token Assignment**: The claiming worker issues a UUID `lease_token` and sets `lease_expires_at = NOW() + INTERVAL '30 seconds'`.
* **CAS Completion**:
```sql
UPDATE attempts
SET status = 'COMPLETED', verdict = $verdict, score = $score, ...
WHERE id = $attemptId AND status = 'RUNNING' AND lease_token = $leaseToken;
```
If a worker crashes or network stalls, its lease expires. Another worker reclaims the job. If the original worker returns late, its CAS update updates 0 rows, causing the late worker to cleanly discard its result.

---

## 3. Retry and Rejudging Lifecycle

### A. Authoritative Attempt Tracking
Every submission maintains an `authoritative_attempt_id` pointer referencing the single attempt that determines user standings.
* When an organizer triggers a rejudge via `POST /submissions/:id/rejudge`, a new attempt (e.g. Attempt #2) is queued, preserving historical attempts.
* **Resolution Invariant**: An attempt is authoritative if and only if it is the latest `COMPLETED` attempt that is not `INFRA_FAILURE`.
* When an attempt completes, it inspects whether a higher attempt number exists. If Attempt #2 completed, a delayed late completion of Attempt #1 will update its own row but will **never** alter the `authoritative_attempt_id` pointer or touch standings.
* Standings recalculation and authoritative pointer updates occur atomically inside the exact same database transaction.

### B. Standings Rebuild Determinism
The `StandingsService.rebuildStandings(contestId)` engine recalculates total points and penalty minutes purely from authoritative records stored in PostgreSQL:
* **Points**: Awarded for first accepted attempt per problem.
* **Penalty**: 10 minutes per wrong attempt before the accepted attempt + elapsed minutes from contest start.
* Functional verification (`test/phase3-correctness.functional.spec.ts`) proves that `rebuiltStandings == servedStandings` under race conditions and out-of-order completions.

---

## 4. Sandbox Isolation & Resource Limits

Submitted Python code is executed in isolated containers under the following constraints:
* **Network Isolation**: `--network none` prohibits all inbound and outbound network connectivity.
* **Resource Bounds**: Memory capped at 128MB (`--memory 128m --memory-swap 128m`), CPU allocation capped at 0.5 cores (`--cpus 0.5`), and process limit capped at 32 PIDs (`--pids-limit 32`).
* **Filesystem Protection**: Root filesystem is mounted read-only (`--read-only`). The source code is mounted read-only (`:ro`) in a per-execution temporary directory. Only `/tmp` is mounted as an unexecutable tmpfs (`--tmpfs /tmp:rw,noexec,nosuid,size=16m`).
* **Privilege De-escalation**: Executed as unprivileged user `nobody:nobody` (`65534:65534`), with `--cap-drop ALL` and `--security-opt no-new-privileges`.
* **Container Lifecycle**: Wall-time watchdog triggers SIGKILL if execution exceeds limits. Ephemeral containers and host temp directories are purged in `finally` blocks.

---

## 5. Performance Evidence & Bottleneck Investigation

### A. Measured Workload Performance
A concurrent workload of 80 operations was executed with 8 concurrent workers (50% Submissions, 50% Leaderboard reads):
* **Throughput**: 227.92 requests/second
* **Error Rate**: 0.0% (0 errors)
* **Latency Percentiles**:
  * p50: 23 ms
  * p90: 80 ms
  * p95: 156 ms
  * p99: 163 ms
* **API Intake Overhead**: Submissions ingested in ~47.92 ms, while program execution occurs asynchronously in workers.

### B. EXPLAIN ANALYZE Bottleneck Investigation
Query: User submissions lookup during standings recalculation and participant views:
```sql
SELECT id, contest_id, problem_id, user_id, created_at
FROM submissions
WHERE contest_id = 'contest-alpha-live' 
  AND user_id = 'user-org1-participant1' 
  AND problem_id = 'prob-two-sum'
ORDER BY created_at ASC;
```

#### Before Optimization:
* **Query Plan**: Bitmap Heap Scan on `submissions_contest_id_user_id_idx` -> Heap Filter on `problem_id` (333 rows removed) -> Explicit Quicksort on `created_at`.
* **Execution Cost**: 89.73..90.57
* **Planning Time**: 0.365 ms, **Execution Time**: 0.280 ms

#### Optimization Applied:
```sql
CREATE INDEX idx_submissions_perf_tuning 
ON submissions (contest_id, user_id, problem_id, created_at ASC);
```

#### After Optimization:
* **Query Plan**: Eliminates filtering and sorting phases by aligning the multi-column index directly with filter and sort predicates.
* **Execution Time**: Reduced to 0.267 ms; planning time dropped from 0.365 ms to 0.188 ms (48% reduction in planner overhead).
* **Correctness**: Preserved 100% of rows and rankings.

---

## 6. One Investigated Failure: Runner Crash & Recovery

### Injected Failpoint (`FAILPOINT=runner_crash`)
During automated testing, a controlled failure was injected into the runner execution pipeline:
1. **Submission Accepted**: `submissionId=eab039c1-4a0f-422e-a3bc-6da76d0a012c`, attempt #1 queued.
2. **Worker Claim**: Worker 1 claimed the job with lease token `cca25c62-6efe-4506-a2d7-a8b2b9a8fdb4`.
3. **Injected Crash**: Runner encountered `FAILPOINT=runner_crash`, logged an error trace, and mapped the failure to verdict `INFRA_FAILURE`.
4. **Retry Handling**: Because `attempts_count < MAX_ATTEMPTS (3)`, the worker marked Attempt #1 as `FAILED` with `INFRA_FAILURE` (awarding 0 score and 0 wrong-attempt penalty), and requeued the job to `QUEUED`.
5. **Recovery**: Worker 2 claimed the requeued job, executed the solution cleanly, completed with `ACCEPTED`, awarded 100 points, and updated the authoritative attempt pointer.
6. **Log Evidence**: Saved at `results/injected-failure.log`.

---

## 7. Known Limitations

1. **Host Kernel Sharing**: Docker containers share the host Linux kernel. In untrusted environments, container breakouts targeting kernel vulnerabilities remain a theoretical risk.
2. **PostgreSQL Polling**: Workers currently poll PostgreSQL every 500ms using `FOR UPDATE SKIP LOCKED`. Under thousands of idle worker replicas, polling overhead can be optimized using PostgreSQL `LISTEN / NOTIFY` or advisory locks.
3. **Single Postgres Primary**: Standings and queue transactions run against a single primary database. Scaling beyond 10,000 requests/sec would benefit from read replicas for leaderboard queries and table partitioning on `submissions` by `contest_id`.
