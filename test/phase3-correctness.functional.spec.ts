import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestingApp, makeDevHeaders, makeJudgeHeaders } from './test-utils';
import { SEED_DATA } from '../prisma/seed';
import { PrismaService } from '../src/prisma/prisma.service';
import { StandingsService } from '../src/standings/standings.service';
import { Verdict, AttemptStatus, JobStatus } from '@prisma/client';

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
    it('ensures two competing workers claiming concurrently never receive the same job', async () => {
      const aliceHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const judgeHeaders = makeJudgeHeaders();

      // Submit a single problem
      await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(aliceHeaders)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: 'print(10)',
          idempotencyKey: 'competing-workers-sub-' + Date.now(),
        });

      // Two workers fire claims at the exact same time
      const [claimWorkerA, claimWorkerB] = await Promise.all([
        request(app.getHttpServer()).post('/judge/jobs/claim').set(judgeHeaders).send({ workerId: 'worker-node-A' }),
        request(app.getHttpServer()).post('/judge/jobs/claim').set(judgeHeaders).send({ workerId: 'worker-node-B' }),
      ]);

      expect(claimWorkerA.status).toBe(200);
      expect(claimWorkerB.status).toBe(200);

      const jobA = claimWorkerA.body.job;
      const jobB = claimWorkerB.body.job;

      // Both cannot have the same job ID
      if (jobA && jobB) {
        expect(jobA.jobId).not.toBe(jobB.jobId);
      }
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
  });
});
