import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestingApp, makeDevHeaders, makeJudgeHeaders } from './test-utils';
import { SEED_DATA } from '../prisma/seed';
import { PrismaService } from '../src/prisma/prisma.service';
import { StandingsService } from '../src/standings/standings.service';
import { Verdict, AttemptStatus, JobStatus } from '@prisma/client';
import { fork } from 'child_process';
import * as path from 'path';

describe('Phase 3 Functional Tests: Correctness, Concurrency, Retries, Rejudge, and Standings Rebuild', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let standingsService: StandingsService;

  beforeAll(async () => {
    const context = await createTestingApp();
    app = context.app;
    prisma = context.prisma;
    standingsService = app.get(StandingsService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. Concurrency: Parallel submissions with identical idempotency key', () => {
    it('handles parallel concurrent requests with the same idempotency key without duplicate rows or 500 errors', async () => {
      const aliceHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const idempotencyKey = 'race-concurrent-key-' + Date.now();

      const payload = {
        problemId: SEED_DATA.problems.twoSum.id,
        code: SEED_DATA.samplePrograms.correctTwoSum,
        language: 'python',
        idempotencyKey,
      };

      // Fire 5 concurrent requests simultaneously
      const results = await Promise.all([
        request(app.getHttpServer()).post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`).set(aliceHeaders).send(payload),
        request(app.getHttpServer()).post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`).set(aliceHeaders).send(payload),
        request(app.getHttpServer()).post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`).set(aliceHeaders).send(payload),
        request(app.getHttpServer()).post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`).set(aliceHeaders).send(payload),
        request(app.getHttpServer()).post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`).set(aliceHeaders).send(payload),
      ]);

      // All responses must be successful (200 or 202)
      results.forEach((res) => {
        expect([200, 202]).toContain(res.status);
        expect(res.body.id).toBeDefined();
      });

      // All must return the exact same submission ID
      const firstId = results[0].body.id;
      results.forEach((res) => {
        expect(res.body.id).toBe(firstId);
      });

      // Assert database has exactly 1 submission, 1 attempt, and 1 job
      const submissions = await prisma.submission.findMany({
        where: {
          contestId: SEED_DATA.contests.alphaLive.id,
          userId: SEED_DATA.users.alphaParticipant1.id,
          idempotencyKey,
        },
      });
      expect(submissions.length).toBe(1);

      const attempts = await prisma.attempt.findMany({
        where: { submissionId: firstId },
      });
      expect(attempts.length).toBe(1);

      const jobs = await prisma.job.findMany({
        where: { attemptId: attempts[0].id },
      });
      expect(jobs.length).toBe(1);
    });
  });

  describe('2. Competing Workers & FOR UPDATE SKIP LOCKED Mutual Exclusion', () => {
    it('spawns two separate Node processes against the same DB and ensures they never receive the same job', async () => {
      // First clean up any pre-existing queued or orphaned jobs to ensure clean slate
      await prisma.job.updateMany({
        where: { status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'COMPLETED' },
      });

      const aliceHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);

      // Submit a single problem
      const subRes = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(aliceHeaders)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: 'print(10)',
          idempotencyKey: 'competing-separate-nodes-' + Date.now(),
        });

      expect(subRes.status).toBe(202);

      const runnerScript = path.join(process.cwd(), 'dist/test/competing-worker-runner.js');

      // Spawn two distinct Node processes
      const proc1 = fork(runnerScript, ['proc-worker-1']);
      const proc2 = fork(runnerScript, ['proc-worker-2']);

      const readyBarrier = new Promise<void>((resolve) => {
        let readyCount = 0;
        const checkReady = (msg: any) => {
          if (msg && msg.ready) {
            readyCount++;
            if (readyCount === 2) resolve();
          }
        };
        proc1.on('message', checkReady);
        proc2.on('message', checkReady);
      });

      // Wait for both worker processes to be booted and connected
      await readyBarrier;

      // Trigger simultaneous claim in both processes
      const claim1Promise = new Promise<any>((resolve) => {
        proc1.on('message', (msg: any) => {
          if (msg && msg.success !== undefined) resolve(msg);
        });
      });
      const claim2Promise = new Promise<any>((resolve) => {
        proc2.on('message', (msg: any) => {
          if (msg && msg.success !== undefined) resolve(msg);
        });
      });

      proc1.send({ action: 'claim' });
      proc2.send({ action: 'claim' });

      const [res1, res2] = await Promise.all([claim1Promise, claim2Promise]);

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);

      const job1 = res1.result;
      const job2 = res2.result;

      // Mutual exclusion check: exactly one process can claim this single job
      const claimedJobs = [job1, job2].filter(Boolean);
      expect(claimedJobs.length).toBe(1);
      if (job1 && job2) {
        expect(job1.jobId).not.toBe(job2.jobId);
      }
    });

    it('dispatch interruption: worker dies before claiming, resumed worker processes job cleanly', async () => {
      const aliceHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const judgeHeaders = makeJudgeHeaders();

      // Submit
      const subRes = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(aliceHeaders)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: 'print("interruption-test")',
          idempotencyKey: 'dispatch-interrupt-' + Date.now(),
        });
      expect(subRes.status).toBe(202);

      // Verify job is initially QUEUED
      const jobs = await prisma.job.findMany({
        where: { attempt: { submissionId: subRes.body.id } },
      });
      expect(jobs.length).toBe(1);
      expect(jobs[0].status).toBe(JobStatus.QUEUED);

      // Resumed worker claims cleanly
      const claimRes = await request(app.getHttpServer())
        .post('/judge/jobs/claim')
        .set(judgeHeaders)
        .send({ workerId: 'worker-resumed' });

      expect(claimRes.status).toBe(200);
      expect(claimRes.body.job).toBeDefined();
      expect(claimRes.body.job.jobId).toBe(jobs[0].id);
    });

    it('crash after judging but before ack: job replays, no duplicate score awarded', async () => {
      const aliceHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const judgeHeaders = makeJudgeHeaders();

      // Submit
      const subRes = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(aliceHeaders)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: SEED_DATA.samplePrograms.correctTwoSum,
          idempotencyKey: 'crash-before-ack-' + Date.now(),
        });
      expect(subRes.status).toBe(202);

      // Worker 1 claims job
      const claim1 = await request(app.getHttpServer())
        .post('/judge/jobs/claim')
        .set(judgeHeaders)
        .send({ workerId: 'worker-crash-before-ack' });

      const job1 = claim1.body.job;
      expect(job1).toBeDefined();

      // Worker 1 crashes before sending ack / complete.
      // Lease expires:
      await prisma.job.update({
        where: { id: job1.jobId },
        data: { leaseExpiresAt: new Date(Date.now() - 5000) },
      });

      // Worker 2 claims the replayed job
      const claim2 = await request(app.getHttpServer())
        .post('/judge/jobs/claim')
        .set(judgeHeaders)
        .send({ workerId: 'worker-replay-ack' });

      const job2 = claim2.body.job;
      expect(job2).toBeDefined();
      expect(job2.jobId).toBe(job1.jobId);
      expect(job2.leaseToken).not.toBe(job1.leaseToken);

      // Worker 2 completes attempt successfully
      const compRes = await request(app.getHttpServer())
        .post(`/judge/attempts/${job2.attemptId}/complete`)
        .set(judgeHeaders)
        .send({
          workerId: 'worker-replay-ack',
          leaseToken: job2.leaseToken,
          verdict: Verdict.ACCEPTED,
          score: 100,
          executionTimeMs: 25,
          testResults: [],
        });

      expect(compRes.status).toBe(200);

      // Stale Worker 1 wakes up and tries to complete late
      const staleComp = await request(app.getHttpServer())
        .post(`/judge/attempts/${job1.attemptId}/complete`)
        .set(judgeHeaders)
        .send({
          workerId: 'worker-crash-before-ack',
          leaseToken: job1.leaseToken,
          verdict: Verdict.ACCEPTED,
          score: 100,
          executionTimeMs: 25,
          testResults: [],
        });

      expect(staleComp.status).toBe(200);
      expect(staleComp.body.staleWorker).toBe(true); // Stale worker discarded

      // Verify standing has exactly 100 score, no duplicate points awarded
      const standing = await prisma.standing.findUnique({
        where: {
          contestId_userId: {
            contestId: SEED_DATA.contests.alphaLive.id,
            userId: SEED_DATA.users.alphaParticipant1.id,
          },
        },
      });
      expect(standing?.totalScore).toBe(100);
    });
  });

  describe('3. Fault Recovery: Abandoned Work & Bounded Retries', () => {
    it('reclaims expired lease after worker dies / network partition and increments attemptsCount', async () => {
      const aliceHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const judgeHeaders = makeJudgeHeaders();

      const subRes = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(aliceHeaders)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: 'print(99)',
          idempotencyKey: 'recovery-expired-lease-' + Date.now(),
        });

      // Worker 1 claims
      const claim1 = await request(app.getHttpServer())
        .post('/judge/jobs/claim')
        .set(judgeHeaders)
        .send({ workerId: 'worker-crashed' });

      const job = claim1.body.job;
      expect(job).toBeDefined();

      // Simulate worker crash / lease expiry by setting lease_expires_at into the past
      await prisma.job.update({
        where: { id: job.jobId },
        data: {
          leaseExpiresAt: new Date(Date.now() - 60000), // expired 1 min ago
        },
      });

      // Worker 2 claims: should reclaim the expired job
      const claim2 = await request(app.getHttpServer())
        .post('/judge/jobs/claim')
        .set(judgeHeaders)
        .send({ workerId: 'worker-recovery' });

      expect(claim2.body.job).toBeDefined();
      expect(claim2.body.job.jobId).toBe(job.jobId);
      expect(claim2.body.job.leaseToken).not.toBe(job.leaseToken);

      // Verify attemptsCount incremented in DB
      const dbJob = await prisma.job.findUnique({ where: { id: job.jobId } });
      expect(dbJob?.attemptsCount).toBeGreaterThanOrEqual(2);
    });

    it('bounds retries by MAX_ATTEMPTS (3), then marks job FAILED with INFRA_FAILURE and score 0', async () => {
      const aliceHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const judgeHeaders = makeJudgeHeaders();

      const subRes = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(aliceHeaders)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: 'print(99)',
          idempotencyKey: 'max-attempts-bound-' + Date.now(),
        });

      // Claim 1
      const c1 = await request(app.getHttpServer()).post('/judge/jobs/claim').set(judgeHeaders).send({ workerId: 'w1' });
      const jobId = c1.body.job.jobId;

      // Expire lease
      await prisma.job.update({ where: { id: jobId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });

      // Claim 2
      await request(app.getHttpServer()).post('/judge/jobs/claim').set(judgeHeaders).send({ workerId: 'w2' });
      await prisma.job.update({ where: { id: jobId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });

      // Claim 3 (MAX_ATTEMPTS reached: attemptsCount becomes 3)
      await request(app.getHttpServer()).post('/judge/jobs/claim').set(judgeHeaders).send({ workerId: 'w3' });
      await prisma.job.update({ where: { id: jobId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });

      // Claim 4: Exceeds MAX_ATTEMPTS (3) -> job marked FAILED with INFRA_FAILURE
      const c4 = await request(app.getHttpServer()).post('/judge/jobs/claim').set(judgeHeaders).send({ workerId: 'w4' });

      const finalJob = await prisma.job.findUnique({ where: { id: jobId } });
      expect(finalJob?.status).toBe(JobStatus.FAILED);

      const finalAttempt = await prisma.attempt.findUnique({ where: { id: c1.body.job.attemptId } });
      expect(finalAttempt?.status).toBe(AttemptStatus.FAILED);
      expect(finalAttempt?.verdict).toBe(Verdict.INFRA_FAILURE);
      expect(finalAttempt?.score).toBe(0);
    });
  });

  describe('4. Rejudge & Authoritative Attempt Invariants', () => {
    it('creates new attempt during rejudge, preserves earlier attempts, and updates authoritative pointer', async () => {
      const orgHeaders = makeDevHeaders(SEED_DATA.users.alphaOrganizer.id);
      const aliceHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const judgeHeaders = makeJudgeHeaders();

      // Alice submits wrong answer
      const subRes = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(aliceHeaders)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: 'print("wrong")',
          idempotencyKey: 'rejudge-test-sub-' + Date.now(),
        });
      const submissionId = subRes.body.id;

      // Judge Attempt 1 as WRONG_ANSWER
      const claim1 = await request(app.getHttpServer()).post('/judge/jobs/claim').set(judgeHeaders).send({ workerId: 'w1' });
      const job1 = claim1.body.job;
      await request(app.getHttpServer())
        .post(`/judge/attempts/${job1.attemptId}/complete`)
        .set(judgeHeaders)
        .send({
          workerId: 'w1',
          leaseToken: job1.leaseToken,
          verdict: Verdict.WRONG_ANSWER,
          score: 0,
          executionTimeMs: 25,
          testResults: [],
        });

      // Verify Attempt 1 is authoritative and verdict is WRONG_ANSWER
      let sub = await prisma.submission.findUnique({
        where: { id: submissionId },
        include: { authoritativeAttempt: true, attempts: true },
      });
      expect(sub?.authoritativeAttemptId).toBe(job1.attemptId);
      expect(sub?.authoritativeAttempt?.verdict).toBe(Verdict.WRONG_ANSWER);
      expect(sub?.attempts.length).toBe(1);

      // Organizer triggers rejudge
      const rejudgeRes = await request(app.getHttpServer())
        .post(`/submissions/${submissionId}/rejudge`)
        .set(orgHeaders)
        .send({});

      expect(rejudgeRes.status).toBe(202);
      expect(rejudgeRes.body.attemptNo).toBe(2);

      // Judge Attempt 2 as ACCEPTED
      const claim2 = await request(app.getHttpServer()).post('/judge/jobs/claim').set(judgeHeaders).send({ workerId: 'w2' });
      const job2 = claim2.body.job;
      expect(job2.attemptNo).toBe(2);

      await request(app.getHttpServer())
        .post(`/judge/attempts/${job2.attemptId}/complete`)
        .set(judgeHeaders)
        .send({
          workerId: 'w2',
          leaseToken: job2.leaseToken,
          verdict: Verdict.ACCEPTED,
          score: 100,
          executionTimeMs: 30,
          testResults: [],
        });

      // Verify Attempt 2 is now authoritative, Attempt 1 is preserved
      sub = await prisma.submission.findUnique({
        where: { id: submissionId },
        include: { authoritativeAttempt: true, attempts: true },
      });
      expect(sub?.authoritativeAttemptId).toBe(job2.attemptId);
      expect(sub?.authoritativeAttempt?.verdict).toBe(Verdict.ACCEPTED);
      expect(sub?.attempts.length).toBe(2);
    });

    it('out-of-order completion: delayed result from replaced attempt does not change authoritative pointer or standings', async () => {
      const orgHeaders = makeDevHeaders(SEED_DATA.users.alphaOrganizer.id);
      const aliceHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const judgeHeaders = makeJudgeHeaders();

      // Alice submits
      const subRes = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(aliceHeaders)
        .send({
          problemId: SEED_DATA.problems.palindrome.id,
          code: 'print("YES")',
          idempotencyKey: 'out-of-order-sub-' + Date.now(),
        });
      const submissionId = subRes.body.id;

      // Worker 1 claims Attempt 1
      const claim1 = await request(app.getHttpServer()).post('/judge/jobs/claim').set(judgeHeaders).send({ workerId: 'slow-worker' });
      const job1 = claim1.body.job;

      // Meanwhile, organizer rejudges immediately creating Attempt 2
      const rejudgeRes = await request(app.getHttpServer())
        .post(`/submissions/${submissionId}/rejudge`)
        .set(orgHeaders)
        .send({});

      // Worker 2 claims Attempt 2
      const claim2 = await request(app.getHttpServer()).post('/judge/jobs/claim').set(judgeHeaders).send({ workerId: 'fast-worker' });
      const job2 = claim2.body.job;

      // Fast worker completes Attempt 2 FIRST with ACCEPTED
      await request(app.getHttpServer())
        .post(`/judge/attempts/${job2.attemptId}/complete`)
        .set(judgeHeaders)
        .send({
          workerId: 'fast-worker',
          leaseToken: job2.leaseToken,
          verdict: Verdict.ACCEPTED,
          score: 200,
          executionTimeMs: 20,
          testResults: [],
        });

      // Verify Attempt 2 is authoritative
      let sub = await prisma.submission.findUnique({ where: { id: submissionId } });
      expect(sub?.authoritativeAttemptId).toBe(job2.attemptId);

      // Slow worker arrives LATE with result for Attempt 1
      const lateComplete = await request(app.getHttpServer())
        .post(`/judge/attempts/${job1.attemptId}/complete`)
        .set(judgeHeaders)
        .send({
          workerId: 'slow-worker',
          leaseToken: job1.leaseToken,
          verdict: Verdict.WRONG_ANSWER,
          score: 0,
          executionTimeMs: 50,
          testResults: [],
        });

      expect(lateComplete.status).toBe(200);

      // Critical invariant check: authoritative attempt MUST REMAIN Attempt 2!
      sub = await prisma.submission.findUnique({ where: { id: submissionId } });
      expect(sub?.authoritativeAttemptId).toBe(job2.attemptId);

      // Verify Attempt 1 results are stored in DB
      const attempt1 = await prisma.attempt.findUnique({ where: { id: job1.attemptId } });
      expect(attempt1?.status).toBe(AttemptStatus.COMPLETED);
      expect(attempt1?.verdict).toBe(Verdict.WRONG_ANSWER);
    });
  });

  describe('5. Standings Rebuild Verification: rebuilt == served standings', () => {
    it('verifies that rebuildStandings() produces the exact same rankings as served standings', async () => {
      const contestId = SEED_DATA.contests.alphaLive.id;

      // 1. Get currently served leaderboard
      const servedLeaderboard = await standingsService.getLeaderboard(contestId);

      // 2. Trigger rebuildStandings purely from stored attempts
      await standingsService.rebuildStandings(contestId);

      // 3. Get rebuilt leaderboard
      const rebuiltLeaderboard = await standingsService.getLeaderboard(contestId);

      // 4. Assert strict equality of ranks, scores, penalties, and order
      expect(rebuiltLeaderboard.entries.length).toBe(servedLeaderboard.entries.length);

      for (let i = 0; i < servedLeaderboard.entries.length; i++) {
        const served = servedLeaderboard.entries[i];
        const rebuilt = rebuiltLeaderboard.entries[i];

        expect(rebuilt.userId).toBe(served.userId);
        expect(rebuilt.rank).toBe(served.rank);
        expect(rebuilt.totalScore).toBe(served.totalScore);
        expect(rebuilt.totalPenalty).toBe(served.totalPenalty);
        expect(rebuilt.lastAcceptedAt).toBe(served.lastAcceptedAt);
      }
    });

    it('verifies full row equality (rank, user, score, penalty, last accepted) on a 50k-submission dataset', async () => {
      const contestId = SEED_DATA.contests.alphaLive.id;

      // 1. Bulk seed 50,000 real submissions in database if not already present
      const currentCount = await prisma.submission.count({ where: { contestId } });
      if (currentCount < 50000) {
        const users = [
          SEED_DATA.users.alphaParticipant1.id,
          SEED_DATA.users.alphaParticipant2.id,
        ];
        const prob = SEED_DATA.problems.twoSum;
        const batchSize = 5000;
        const needed = 50000 - currentCount;
        for (let b = 0; b < needed / batchSize; b++) {
          const rows = [];
          for (let i = 0; i < batchSize; i++) {
            const idx = b * batchSize + i;
            rows.push({
              id: `test-50k-sub-${idx}-${Date.now()}`,
              contestId,
              problemId: prob.id,
              userId: users[idx % users.length],
              code: `print(${idx})`,
              language: 'python',
              runtimeConfig: {},
              problemVersionId: 'pv-two-sum-1',
              suiteVersionId: 'ts-two-sum-1',
              idempotencyKey: `test-50k-key-${idx}-${Date.now()}`,
              requestHash: `test-50k-hash-${idx}`,
            });
          }
          await prisma.submission.createMany({ data: rows, skipDuplicates: true });
        }
      }

      const totalCount = await prisma.submission.count({ where: { contestId } });
      expect(totalCount).toBeGreaterThanOrEqual(50000);

      // 2. Fetch served standings before rebuild
      const served = await standingsService.getLeaderboard(contestId);
      expect(served.entries.length).toBeGreaterThanOrEqual(2);

      // 3. Rebuild standings purely from stored database records using contest_participants
      await standingsService.rebuildStandings(contestId);

      // 4. Fetch rebuilt standings
      const rebuilt = await standingsService.getLeaderboard(contestId);

      // 5. Strict equality check: fail on ANY difference in row count or field value
      expect(rebuilt.entries.length).toBe(served.entries.length);

      for (let i = 0; i < served.entries.length; i++) {
        const s = served.entries[i];
        const r = rebuilt.entries[i];

        expect(r.rank).toBe(s.rank);
        expect(r.userId).toBe(s.userId);
        expect(r.username).toBe(s.username);
        expect(r.totalScore).toBe(s.totalScore);
        expect(r.totalPenalty).toBe(s.totalPenalty);
        expect(r.lastAcceptedAt).toBe(s.lastAcceptedAt);
      }
    });
  });
});
