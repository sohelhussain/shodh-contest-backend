import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestingApp, makeDevHeaders, makeJudgeHeaders } from './test-utils';
import { SEED_DATA } from '../prisma/seed';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Phase 1 Functional Tests: Data Model, Auth, API, Rules & Invariants', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const context = await createTestingApp();
    app = context.app;
    prisma = context.prisma;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. Authentication & Dev HMAC Fixture', () => {
    it('rejects requests without x-dev-user-id and x-dev-signature headers with 401', async () => {
      const res = await request(app.getHttpServer()).get('/contests');
      expect(res.status).toBe(401);
      expect(res.body.error_type).toBe('BUSINESS_RULE_ERROR');
      expect(res.body.code).toBe('AUTH_REQUIRED');
    });

    it('rejects requests with invalid HMAC signature with 401', async () => {
      const res = await request(app.getHttpServer())
        .get('/contests')
        .set('x-dev-user-id', SEED_DATA.users.alphaOrganizer.id)
        .set('x-dev-signature', 'invalid_signature_hex_value');

      expect(res.status).toBe(401);
      expect(res.body.error_type).toBe('BUSINESS_RULE_ERROR');
      expect(res.body.code).toBe('INVALID_SIGNATURE');
    });

    it('authenticates valid HMAC signature for existing user', async () => {
      const headers = makeDevHeaders(SEED_DATA.users.alphaOrganizer.id);
      const res = await request(app.getHttpServer())
        .get('/contests')
        .set(headers);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('2. Authorization, Role Boundaries & Cross-Organization Isolation', () => {
    it('returns 404 for cross-organization objects ("Knowing an ID must never grant access")', async () => {
      // User from org-beta attempts to access contest in org-alpha
      const headers = makeDevHeaders(SEED_DATA.users.betaParticipant1.id);
      const res = await request(app.getHttpServer())
        .get(`/contests/${SEED_DATA.contests.alphaLive.id}`)
        .set(headers);

      expect(res.status).toBe(404);
      expect(res.body.error_type).toBe('BUSINESS_RULE_ERROR');
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('returns 403 when a participant attempts an organizer action in their own org', async () => {
      // Participant in org-alpha attempts to create a problem in org-alpha contest
      const headers = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const res = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/problems`)
        .set(headers)
        .send({
          title: 'Unauthorized Problem',
          description: 'Desc',
          points: 100,
          timeLimitMs: 2000,
          memoryLimitMb: 128,
          testCases: [{ input: '1\n', expectedOutput: '1\n' }],
        });

      expect(res.status).toBe(403);
      expect(res.body.error_type).toBe('BUSINESS_RULE_ERROR');
      expect(res.body.code).toBe('ORGANIZER_REQUIRED');
    });

    it('allows organizer to create a problem with version 1 and immutable test suite', async () => {
      const headers = makeDevHeaders(SEED_DATA.users.alphaOrganizer.id);
      const res = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/problems`)
        .set(headers)
        .send({
          title: 'GCD Problem',
          description: 'Compute greatest common divisor',
          points: 150,
          timeLimitMs: 1000,
          memoryLimitMb: 64,
          testCases: [
            { input: '12 18\n', expectedOutput: '6\n', isHidden: false, orderIndex: 0 },
            { input: '100 25\n', expectedOutput: '25\n', isHidden: true, orderIndex: 1 },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.initialVersionId).toBeDefined();
      expect(res.body.initialSuiteId).toBeDefined();
    });
  });

  describe('3. Contest Rules, Submissions, and Idempotency', () => {
    it('rejects submissions if contest is not active (future contest)', async () => {
      const headers = makeDevHeaders(SEED_DATA.users.betaParticipant1.id);
      const res = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.betaFuture.id}/submissions`)
        .set(headers)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: 'print(1)',
          idempotencyKey: 'key-future-1',
        });

      expect(res.status).toBe(422);
      expect(res.body.error_type).toBe('BUSINESS_RULE_ERROR');
      expect(res.body.code).toBe('CONTEST_NOT_ACTIVE');
    });

    it('rejects submissions if user has not joined the contest', async () => {
      // Remove user from contest_participants temporarily or use another user
      const unjoinedUser = await prisma.user.create({
        data: {
          username: 'unjoined_user',
          email: 'unjoined@alpha.org',
          memberships: {
            create: { organizationId: SEED_DATA.orgs.alpha.id, role: 'PARTICIPANT' },
          },
        },
      });

      const headers = makeDevHeaders(unjoinedUser.id);
      const res = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(headers)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: 'print(1)',
          idempotencyKey: 'key-unjoined-1',
        });

      expect(res.status).toBe(403);
      expect(res.body.error_type).toBe('BUSINESS_RULE_ERROR');
      expect(res.body.code).toBe('USER_NOT_JOINED');
    });

    it('accepts valid submission and atomically creates submission, attempt 1, and job (returns 202)', async () => {
      const headers = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const idempotencyKey = 'alice-sub-initial-001';

      const res = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(headers)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: SEED_DATA.samplePrograms.correctTwoSum,
          language: 'python',
          idempotencyKey,
        });

      expect(res.status).toBe(202);
      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('QUEUED');

      // Verify DB atomicity: submission, attempt, and job exist
      const sub = await prisma.submission.findUnique({
        where: { id: res.body.id },
        include: {
          attempts: true,
          authoritativeAttempt: true,
        },
      });
      expect(sub).toBeDefined();
      expect(sub.authoritativeAttemptId).toBe(res.body.attemptId);
      expect(sub.attempts.length).toBe(1);
      expect(sub.attempts[0].attemptNo).toBe(1);

      const job = await prisma.job.findUnique({
        where: { attemptId: sub.attempts[0].id },
      });
      expect(job).toBeDefined();
      expect(job.status).toBe('QUEUED');
    });

    it('idempotency: same key + same payload returns same submission id (200/202)', async () => {
      const headers = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const idempotencyKey = 'alice-sub-idempotent-test';

      // First submit
      const res1 = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(headers)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: SEED_DATA.samplePrograms.correctTwoSum,
          language: 'python',
          idempotencyKey,
        });
      expect(res1.status).toBe(202);
      const submissionId = res1.body.id;

      // Second submit with identical payload
      const res2 = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(headers)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: SEED_DATA.samplePrograms.correctTwoSum,
          language: 'python',
          idempotencyKey,
        });

      expect([200, 202]).toContain(res2.status);
      expect(res2.body.id).toBe(submissionId);
    });

    it('idempotency conflict: same key + different payload returns 409 Conflict', async () => {
      const headers = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const idempotencyKey = 'alice-sub-conflict-test';

      // First submit
      const res1 = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(headers)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: 'print(1)',
          language: 'python',
          idempotencyKey,
        });
      expect(res1.status).toBe(202);

      // Second submit with altered code
      const res2 = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(headers)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: 'print(999999)',
          language: 'python',
          idempotencyKey,
        });

      expect(res2.status).toBe(409);
      expect(res2.body.error_type).toBe('BUSINESS_RULE_ERROR');
      expect(res2.body.code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  describe('4. Privacy, Code Protection & Redaction', () => {
    it('prevents participants from viewing another participant private submission code (403)', async () => {
      // Alice submits
      const aliceHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const subRes = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(aliceHeaders)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: 'import secret\nprint("private")',
          idempotencyKey: 'alice-private-sub',
        });
      const submissionId = subRes.body.id;

      // Bob tries to view Alice's submission
      const bobHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant2.id);
      const viewRes = await request(app.getHttpServer())
        .get(`/submissions/${submissionId}`)
        .set(bobHeaders);

      expect(viewRes.status).toBe(403);
      expect(viewRes.body.error_type).toBe('BUSINESS_RULE_ERROR');
    });

    it('allows organizer to view any participant submission code in their organization', async () => {
      const aliceHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const subRes = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(aliceHeaders)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: 'print("alice-code")',
          idempotencyKey: 'alice-org-view-test',
        });
      const submissionId = subRes.body.id;

      const orgHeaders = makeDevHeaders(SEED_DATA.users.alphaOrganizer.id);
      const viewRes = await request(app.getHttpServer())
        .get(`/submissions/${submissionId}`)
        .set(orgHeaders);

      expect(viewRes.status).toBe(200);
      expect(viewRes.body.code).toBe('print("alice-code")');
    });
  });

  describe('5. Error Classes Hierarchy & Distinct Response Shapes', () => {
    it('returns structured 400 validation error shape for invalid input', async () => {
      const headers = makeDevHeaders(SEED_DATA.users.alphaOrganizer.id);
      const res = await request(app.getHttpServer())
        .post('/contests')
        .set(headers)
        .send({
          // missing required title and organizationId
          description: 'Only description provided',
        });

      expect(res.status).toBe(400);
      expect(res.body.error_type).toBe('VALIDATION_ERROR');
      expect(res.body.statusCode).toBe(400);
      expect(Array.isArray(res.body.details)).toBe(true);
      expect(res.body.details.length).toBeGreaterThan(0);
    });

    it('returns structured business rule error shape for business failures', async () => {
      const headers = makeDevHeaders(SEED_DATA.users.alphaOrganizer.id);
      const res = await request(app.getHttpServer())
        .post('/contests')
        .set(headers)
        .send({
          organizationId: SEED_DATA.orgs.alpha.id,
          title: 'Invalid Time Contest',
          startTime: '2026-11-17T20:00:00.000Z',
          endTime: '2026-11-17T19:00:00.000Z', // end before start!
        });

      expect(res.status).toBe(400);
      expect(res.body.error_type).toBe('BUSINESS_RULE_ERROR');
      expect(res.body.code).toBe('INVALID_CONTEST_WINDOW');
    });
  });

  describe('6. Stable Ordering and Cursor Pagination', () => {
    it('lists submissions with stable ordering and cursor pagination', async () => {
      const headers = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);

      // Create 3 submissions
      for (let i = 1; i <= 3; i++) {
        await request(app.getHttpServer())
          .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
          .set(headers)
          .send({
            problemId: SEED_DATA.problems.twoSum.id,
            code: `print(${i})`,
            idempotencyKey: `pagination-sub-${i}`,
          });
      }

      // Fetch page 1 with limit 2
      const page1 = await request(app.getHttpServer())
        .get(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions?limit=2`)
        .set(headers);

      expect(page1.status).toBe(200);
      expect(page1.body.items.length).toBe(2);
      expect(page1.body.next_cursor).toBeDefined();

      // Fetch page 2 using next_cursor
      const page2 = await request(app.getHttpServer())
        .get(
          `/contests/${SEED_DATA.contests.alphaLive.id}/submissions?limit=2&cursor=${page1.body.next_cursor}`,
        )
        .set(headers);

      expect(page2.status).toBe(200);
      expect(page2.body.items.length).toBeGreaterThanOrEqual(1);
      // Ensure no overlapping items between pages
      const page1Ids = page1.body.items.map((i: any) => i.id);
      const page2Ids = page2.body.items.map((i: any) => i.id);
      expect(page1Ids.some((id: string) => page2Ids.includes(id))).toBe(false);
    });
  });

  describe('7. Judge Endpoints Separation', () => {
    it('rejects participant attempting to call judge-only endpoints', async () => {
      const participantHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);
      const res = await request(app.getHttpServer())
        .post('/judge/jobs/claim')
        .set(participantHeaders)
        .send({ workerId: 'fake-worker' });

      // Judge endpoints require x-judge-token
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('JUDGE_AUTH_REQUIRED');
    });

    it('allows worker with valid x-judge-token to claim queued jobs via FOR UPDATE SKIP LOCKED', async () => {
      const judgeHeaders = makeJudgeHeaders();
      const res = await request(app.getHttpServer())
        .post('/judge/jobs/claim')
        .set(judgeHeaders)
        .send({ workerId: 'worker-node-test-1' });

      expect(res.status).toBe(200);
      expect(res.body.job).toBeDefined();
      if (res.body.job) {
        expect(res.body.job.leaseToken).toBeDefined();
        expect(res.body.job.code).toBeDefined();
        expect(res.body.job.testCases.length).toBeGreaterThan(0);
      }
    });
  });
});
