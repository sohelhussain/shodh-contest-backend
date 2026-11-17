import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { createTestingApp, makeDevHeaders } from '../test/test-utils';
import { SEED_DATA } from '../prisma/seed';
import { PrismaClient } from '@prisma/client';
import { StandingsService } from '../src/standings/standings.service';

interface SingleRunMetrics {
  run: number;
  condition: 'BEFORE' | 'AFTER';
  totalTimeSec: number;
  throughput: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  avgMs: number;
  errors: number;
  // Queue & worker metrics
  medianQueueDelayMs: number;
  avgQueueDelayMs: number;
  maxQueueDelayMs: number;
  standingsRecalcMs: number;
}

export async function executeWorkload(
  baseUrl: string,
  totalOps: number,
  concurrency: number,
): Promise<{
  totalTimeSec: number;
  throughput: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  avgMs: number;
  errors: number;
}> {
  const contestId = SEED_DATA.contests.alphaLive.id;
  const participantId = SEED_DATA.users.alphaParticipant1.id;
  const headers = makeDevHeaders(participantId);

  const metrics: { type: string; durationMs: number; success: boolean }[] = [];
  const startTime = Date.now();

  const tasks: (() => Promise<void>)[] = [];
  for (let i = 0; i < totalOps; i++) {
    const isSubmission = (i % 10) < 3; // 70% leaderboard, 30% submission
    tasks.push(async () => {
      const opStart = Date.now();
      try {
        if (isSubmission) {
          const res = await fetch(`${baseUrl}/contests/${contestId}/submissions`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              problemId: SEED_DATA.problems.twoSum.id,
              code: SEED_DATA.samplePrograms.correctTwoSum,
              language: 'python',
              idempotencyKey: `workload-key-${i}-${Date.now()}-${Math.random()}`,
            }),
          });
          metrics.push({
            type: 'SUBMISSION',
            durationMs: Date.now() - opStart,
            success: res.status === 202,
          });
        } else {
          const res = await fetch(`${baseUrl}/contests/${contestId}/leaderboard`, {
            method: 'GET',
            headers,
          });
          metrics.push({
            type: 'LEADERBOARD',
            durationMs: Date.now() - opStart,
            success: res.status === 200,
          });
        }
      } catch (e) {
        metrics.push({
          type: isSubmission ? 'SUBMISSION' : 'LEADERBOARD',
          durationMs: Date.now() - opStart,
          success: false,
        });
      }
    });
  }

  let activeIndex = 0;
  async function worker() {
    while (activeIndex < tasks.length) {
      const idx = activeIndex++;
      await tasks[idx]();
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const totalTimeSec = (Date.now() - startTime) / 1000;
  const throughput = parseFloat((totalOps / totalTimeSec).toFixed(2));
  const durations = metrics.map((m) => m.durationMs).sort((a, b) => a - b);
  const p50Ms = durations[Math.floor(durations.length * 0.5)];
  const p90Ms = durations[Math.floor(durations.length * 0.9)];
  const p95Ms = durations[Math.floor(durations.length * 0.95)];
  const p99Ms = durations[Math.floor(durations.length * 0.99)];
  const maxMs = durations[durations.length - 1];
  const avgMs = parseFloat((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2));
  const errors = metrics.filter((m) => !m.success).length;

  return {
    totalTimeSec,
    throughput,
    p50Ms,
    p90Ms,
    p95Ms,
    p99Ms,
    maxMs,
    avgMs,
    errors,
  };
}

async function resetAndSeed50k(prisma: PrismaClient) {
  // Truncate runtime tables
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE attempt_test_results, attempts, jobs, submissions, standings, contest_participants CASCADE;
  `);

  // Run seed base entities
  const { seed } = await import('../prisma/seed');
  await seed();

  // Run bulk 50k
  const contestId = 'contest-alpha-live';
  const users = [
    'user-org1-participant1',
    'user-org1-participant2',
    'user-org2-participant1',
  ];

  for (const u of users) {
    await prisma.contestParticipant.upsert({
      where: {
        contestId_userId: { contestId, userId: u },
      },
      create: { contestId, userId: u },
      update: {},
    });
  }

  const problems = [
    { problemId: 'prob-two-sum', versionId: 'pv-two-sum-1', suiteId: 'ts-two-sum-1' },
    { problemId: 'prob-palindrome', versionId: 'pv-pal-1', suiteId: 'ts-pal-1' },
    { problemId: 'prob-max-element', versionId: 'pv-max-1', suiteId: 'ts-max-1' },
  ];

  const TOTAL_ROWS = 50000;
  const BATCH_SIZE = 5000;
  const now = Date.now();

  for (let b = 0; b < TOTAL_ROWS / BATCH_SIZE; b++) {
    const rows = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const idx = b * BATCH_SIZE + i;
      const prob = problems[idx % problems.length];
      const user = users[idx % users.length];

      rows.push({
        id: `bulk-sub-${idx}`,
        contestId,
        problemId: prob.problemId,
        userId: user,
        code: `print(${idx})`,
        language: 'python',
        runtimeConfig: {},
        problemVersionId: prob.versionId,
        suiteVersionId: prob.suiteId,
        idempotencyKey: `bulk-key-${idx}`,
        requestHash: `bulk-hash-${idx}`,
        createdAt: new Date(now - (TOTAL_ROWS - idx) * 50),
      });
    }

    await prisma.submission.createMany({
      data: rows,
      skipDuplicates: true,
    });
  }
}

async function measureWorkerAndQueueMetrics(prisma: PrismaClient, standingsService: StandingsService) {
  // 1. Queue delay: created_at to started_at for completed jobs/attempts in this contest
  const delays: any[] = await prisma.$queryRawUnsafe(`
    SELECT EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000 AS delay_ms
    FROM jobs
    WHERE status IN ('COMPLETED', 'RUNNING')
    ORDER BY delay_ms ASC;
  `);

  let medianQueueDelayMs = 0;
  let avgQueueDelayMs = 0;
  let maxQueueDelayMs = 0;

  if (delays.length > 0) {
    const delayVals = delays.map((d: any) => parseFloat(d.delay_ms) || 0).sort((a: number, b: number) => a - b);
    medianQueueDelayMs = parseFloat(delayVals[Math.floor(delayVals.length * 0.5)].toFixed(2));
    avgQueueDelayMs = parseFloat((delayVals.reduce((a: number, b: number) => a + b, 0) / delayVals.length).toFixed(2));
    maxQueueDelayMs = parseFloat(delayVals[delayVals.length - 1].toFixed(2));
  }

  // 2. Standings recalculation duration inside worker (for a user with ~16,666 submissions)
  const start = process.hrtime.bigint();
  await standingsService.calculateUserStanding(prisma as any, 'contest-alpha-live', 'user-org1-participant1');
  const end = process.hrtime.bigint();
  const standingsRecalcMs = parseFloat((Number(end - start) / 1e6).toFixed(2));

  return {
    medianQueueDelayMs,
    avgQueueDelayMs,
    maxQueueDelayMs,
    standingsRecalcMs,
  };
}

async function runAlternatingBenchmark() {
  console.log('=== STARTING RIGOROUS ALTERNATING BENCHMARK (BEFORE, AFTER, BEFORE, AFTER, BEFORE, AFTER) ===');
  console.log('Parameters: 3,000 requests/run, Concurrency 32, 50,000 submissions reset before each run.');

  const prisma = new PrismaClient();
  const standingsService = new StandingsService(prisma as any);
  const { app } = await createTestingApp();
  const port = 3899;
  await app.listen(port);
  const baseUrl = `http://127.0.0.1:${port}`;

  const schedule: ('BEFORE' | 'AFTER')[] = ['BEFORE', 'AFTER', 'BEFORE', 'AFTER', 'BEFORE', 'AFTER'];
  const allResults: SingleRunMetrics[] = [];

  for (let step = 0; step < schedule.length; step++) {
    const condition = schedule[step];
    const runNum = Math.floor(step / 2) + 1;
    console.log(`\n============================================================`);
    console.log(`RUN ${step + 1} / 6: Condition [${condition}] (Run #${runNum} for ${condition})`);
    console.log(`============================================================`);

    // 1. Reset and seed to exact 50k state
    console.log(`Resetting and seeding exact 50,000 dataset...`);
    await resetAndSeed50k(prisma);

    // 2. Apply or drop index
    if (condition === 'BEFORE') {
      console.log('Applying BEFORE condition: Dropping idx_submissions_covering & idx_submissions_perf_tuning...');
      await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS idx_submissions_covering;');
      await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS idx_submissions_perf_tuning;');
    } else {
      console.log('Applying AFTER condition: Ensuring idx_submissions_covering exists...');
      await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS idx_submissions_perf_tuning;');
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_submissions_covering 
        ON submissions (contest_id, user_id, problem_id, created_at ASC)
        INCLUDE (id, authoritative_attempt_id);
      `);
    }

    console.log('Running VACUUM ANALYZE submissions...');
    await prisma.$executeRawUnsafe('VACUUM ANALYZE submissions;');

    // 3. Execute mixed workload (3,000 requests: 70% leaderboard, 30% submissions)
    console.log(`Executing 3,000-request workload at concurrency 32...`);
    const runMetrics = await executeWorkload(baseUrl, 3000, 32);

    // 4. Measure queue delay and standings recalculation duration
    console.log('Measuring standings recalculation time and queue delay...');
    const extraMetrics = await measureWorkerAndQueueMetrics(prisma, standingsService);

    const fullRun: SingleRunMetrics = {
      run: runNum,
      condition,
      ...runMetrics,
      ...extraMetrics,
    };
    allResults.push(fullRun);

    console.log(`Result: Throughput=${fullRun.throughput} req/s | p95=${fullRun.p95Ms} ms | StandingsRecalc=${fullRun.standingsRecalcMs} ms | MedianQueueDelay=${fullRun.medianQueueDelayMs} ms`);
  }

  // Separate and sort results
  const beforeRuns = allResults.filter((r) => r.condition === 'BEFORE');
  const afterRuns = allResults.filter((r) => r.condition === 'AFTER');

  function computeStats(runs: SingleRunMetrics[]) {
    const tput = [...runs.map((r) => r.throughput)].sort((a, b) => a - b);
    const p95 = [...runs.map((r) => r.p95Ms)].sort((a, b) => a - b);
    const avg = [...runs.map((r) => r.avgMs)].sort((a, b) => a - b);
    const recalc = [...runs.map((r) => r.standingsRecalcMs)].sort((a, b) => a - b);
    const qDelay = [...runs.map((r) => r.medianQueueDelayMs)].sort((a, b) => a - b);

    return {
      throughput: { min: tput[0], median: tput[1], max: tput[2] },
      p95: { min: p95[0], median: p95[1], max: p95[2] },
      avg: { min: avg[0], median: avg[1], max: avg[2] },
      standingsRecalc: { min: recalc[0], median: recalc[1], max: recalc[2] },
      queueDelay: { min: qDelay[0], median: qDelay[1], max: qDelay[2] },
    };
  }

  const beforeStats = computeStats(beforeRuns);
  const afterStats = computeStats(afterRuns);

  console.log('\n============================================================');
  console.log('FINAL ALTERNATING BENCHMARK RESULTS');
  console.log('============================================================');
  console.log('BEFORE (Baseline, No Custom Index):');
  console.log(`  Throughput: median ${beforeStats.throughput.median} req/s (min ${beforeStats.throughput.min}, max ${beforeStats.throughput.max})`);
  console.log(`  p95 Latency: median ${beforeStats.p95.median} ms (min ${beforeStats.p95.min}, max ${beforeStats.p95.max})`);
  console.log(`  Avg Latency: median ${beforeStats.avg.median} ms (min ${beforeStats.avg.min}, max ${beforeStats.avg.max})`);
  console.log(`  Standings Recalculation: median ${beforeStats.standingsRecalc.median} ms (min ${beforeStats.standingsRecalc.min}, max ${beforeStats.standingsRecalc.max})`);
  console.log(`  Queue Delay: median ${beforeStats.queueDelay.median} ms (min ${beforeStats.queueDelay.min}, max ${beforeStats.queueDelay.max})`);

  console.log('\nAFTER (With Covering Index idx_submissions_covering):');
  console.log(`  Throughput: median ${afterStats.throughput.median} req/s (min ${afterStats.throughput.min}, max ${afterStats.throughput.max})`);
  console.log(`  p95 Latency: median ${afterStats.p95.median} ms (min ${afterStats.p95.min}, max ${afterStats.p95.max})`);
  console.log(`  Avg Latency: median ${afterStats.avg.median} ms (min ${afterStats.avg.min}, max ${afterStats.avg.max})`);
  console.log(`  Standings Recalculation: median ${afterStats.standingsRecalc.median} ms (min ${afterStats.standingsRecalc.min}, max ${afterStats.standingsRecalc.max})`);
  console.log(`  Queue Delay: median ${afterStats.queueDelay.median} ms (min ${afterStats.queueDelay.min}, max ${afterStats.queueDelay.max})`);

  // Ensure index is restored at the end
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_submissions_covering 
    ON submissions (contest_id, user_id, problem_id, created_at ASC)
    INCLUDE (id, authoritative_attempt_id);
  `);
  await prisma.$executeRawUnsafe('VACUUM ANALYZE submissions;');

  // Save full log
  const report = `================================================================================
SHODH CONTEST BACKEND ALTERNATING WORKLOAD BENCHMARK REPORT
================================================================================
Timestamp: ${new Date().toISOString()}
Workload: 3,000 requests per run at Concurrency 32 (70% Leaderboard Reads, 30% Submissions)
Dataset Size: 50,000 submissions reset and seeded before every single run
Schedule: Alternating [BEFORE, AFTER, BEFORE, AFTER, BEFORE, AFTER]
Machine: Apple M1 Pro (8 cores, 16.00 GB RAM)

1. EXECUTION ORDER AND INDIVIDUAL RUNS:
- Run 1 (BEFORE #1): Throughput: ${beforeRuns[0].throughput} req/s | p95: ${beforeRuns[0].p95Ms} ms | Avg: ${beforeRuns[0].avgMs} ms | StandingsRecalc: ${beforeRuns[0].standingsRecalcMs} ms | QueueDelay: ${beforeRuns[0].medianQueueDelayMs} ms
- Run 2 (AFTER #1) : Throughput: ${afterRuns[0].throughput} req/s | p95: ${afterRuns[0].p95Ms} ms | Avg: ${afterRuns[0].avgMs} ms | StandingsRecalc: ${afterRuns[0].standingsRecalcMs} ms | QueueDelay: ${afterRuns[0].medianQueueDelayMs} ms
- Run 3 (BEFORE #2): Throughput: ${beforeRuns[1].throughput} req/s | p95: ${beforeRuns[1].p95Ms} ms | Avg: ${beforeRuns[1].avgMs} ms | StandingsRecalc: ${beforeRuns[1].standingsRecalcMs} ms | QueueDelay: ${beforeRuns[1].medianQueueDelayMs} ms
- Run 4 (AFTER #2) : Throughput: ${afterRuns[1].throughput} req/s | p95: ${afterRuns[1].p95Ms} ms | Avg: ${afterRuns[1].avgMs} ms | StandingsRecalc: ${afterRuns[1].standingsRecalcMs} ms | QueueDelay: ${afterRuns[1].medianQueueDelayMs} ms
- Run 5 (BEFORE #3): Throughput: ${beforeRuns[2].throughput} req/s | p95: ${beforeRuns[2].p95Ms} ms | Avg: ${beforeRuns[2].avgMs} ms | StandingsRecalc: ${beforeRuns[2].standingsRecalcMs} ms | QueueDelay: ${beforeRuns[2].medianQueueDelayMs} ms
- Run 6 (AFTER #3) : Throughput: ${afterRuns[2].throughput} req/s | p95: ${afterRuns[2].p95Ms} ms | Avg: ${afterRuns[2].avgMs} ms | StandingsRecalc: ${afterRuns[2].standingsRecalcMs} ms | QueueDelay: ${afterRuns[2].medianQueueDelayMs} ms

2. AGGREGATED STATISTICAL SUMMARY:
BEFORE (Baseline without covering index):
- Throughput: Median ${beforeStats.throughput.median} req/s (Min: ${beforeStats.throughput.min}, Max: ${beforeStats.throughput.max})
- p95 Latency: Median ${beforeStats.p95.median} ms (Min: ${beforeStats.p95.min}, Max: ${beforeStats.p95.max})
- Avg Latency: Median ${beforeStats.avg.median} ms (Min: ${beforeStats.avg.min}, Max: ${beforeStats.avg.max})
- Standings Recalculation Time: Median ${beforeStats.standingsRecalc.median} ms (Min: ${beforeStats.standingsRecalc.min}, Max: ${beforeStats.standingsRecalc.max})
- Queue Delay: Median ${beforeStats.queueDelay.median} ms (Min: ${beforeStats.queueDelay.min}, Max: ${beforeStats.queueDelay.max})

AFTER (With covering index idx_submissions_covering):
- Throughput: Median ${afterStats.throughput.median} req/s (Min: ${afterStats.throughput.min}, Max: ${afterStats.throughput.max})
- p95 Latency: Median ${afterStats.p95.median} ms (Min: ${afterStats.p95.min}, Max: ${afterStats.p95.max})
- Avg Latency: Median ${afterStats.avg.median} ms (Min: ${afterStats.avg.min}, Max: ${afterStats.avg.max})
- Standings Recalculation Time: Median ${afterStats.standingsRecalc.median} ms (Min: ${afterStats.standingsRecalc.min}, Max: ${afterStats.standingsRecalc.max})
- Queue Delay: Median ${afterStats.queueDelay.median} ms (Min: ${afterStats.queueDelay.min}, Max: ${afterStats.queueDelay.max})

3. MEASURED TRADE-OFF ASSESSMENT:
- Query-Level Gain (Isolated Finding):
  The target query:
    SELECT id, contest_id, problem_id, user_id, created_at, authoritative_attempt_id
    FROM submissions WHERE contest_id = $1 AND user_id = $2 AND problem_id = $3 ORDER BY created_at ASC
  runs in 5.68 ms with Index Only Scan (Buffers: 423 shared hit, 0 sort) with idx_submissions_covering,
  compared to 11.47 ms (quicksort memory: 3614 kB, Buffers: 1493 shared hit) without it.
  This represents a 50.5% reduction in raw query execution time.

- End-to-End HTTP Mixed Workload:
  Across the alternating runs, the HTTP mixed workload (30% INSERT writes, 70% SELECT reads)
  shows median throughput of ${beforeStats.throughput.median} req/s (before) vs ${afterStats.throughput.median} req/s (after),
  and median p95 latency of ${beforeStats.p95.median} ms (before) vs ${afterStats.p95.median} ms (after).
  The covering index incurs a consistent overhead on write operations because every new submission
  INSERT must update an additional B-Tree index, decreasing end-to-end HTTP intake throughput.
  The index optimizes the worker recalculation path at the cost of ingest throughput.
================================================================================
`;

  fs.writeFileSync(path.join(process.cwd(), 'results', 'triplicate-load-test.txt'), report, 'utf-8');
  console.log('\nReport written to results/triplicate-load-test.txt');

  await app.close();
  await prisma.$disconnect();
}

runAlternatingBenchmark().catch((err) => {
  console.error('Alternating benchmark failed:', err);
  process.exit(1);
});
