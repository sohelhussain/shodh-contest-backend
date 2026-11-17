import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestingApp, makeDevHeaders, makeJudgeHeaders } from './test-utils';
import { SEED_DATA } from '../prisma/seed';
import { PrismaService } from '../src/prisma/prisma.service';
import { DockerRunner } from '../src/runner/docker-runner';
import { MockRunner } from '../src/runner/mock-runner';
import { Verdict, AttemptStatus } from '@prisma/client';
import { execSync } from 'child_process';

describe('Phase 2 Functional Tests: Worker, Real DockerRunner Sandbox, MockRunner, and Invariants', () => {
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

  describe('1. MockRunner: Deterministic verdicts and failpoint control', () => {
    const mockRunner = new MockRunner();
    const defaultLimits = {
      cpus: 0.5,
      memoryMb: 128,
      pidsLimit: 32,
      wallTimeMs: 2000,
      outputLimitBytes: 65536,
    };

    it('returns ACCEPTED for correct two-sum code', async () => {
      const res = await mockRunner.run(
        SEED_DATA.samplePrograms.correctTwoSum,
        SEED_DATA.problems.twoSum.testCases,
        defaultLimits,
        100,
      );
      expect(res.executionMode).toBe('mock');
      expect(res.verdict).toBe(Verdict.ACCEPTED);
      expect(res.score).toBe(100);
      expect(res.testResults.length).toBe(SEED_DATA.problems.twoSum.testCases.length);
      expect(res.testResults.every((t) => t.passed)).toBe(true);
    });

    it('returns WRONG_ANSWER for wrong answer program', async () => {
      const res = await mockRunner.run(
        SEED_DATA.samplePrograms.wrongAnswer,
        SEED_DATA.problems.twoSum.testCases,
        defaultLimits,
        100,
      );
      expect(res.verdict).toBe(Verdict.WRONG_ANSWER);
      expect(res.score).toBe(0);
    });

    it('returns RUNTIME_ERROR for runtime crashing program', async () => {
      const res = await mockRunner.run(
        SEED_DATA.samplePrograms.runtimeError,
        SEED_DATA.problems.twoSum.testCases,
        defaultLimits,
        100,
      );
      expect(res.verdict).toBe(Verdict.RUNTIME_ERROR);
      expect(res.score).toBe(0);
    });

    it('returns TIME_LIMIT for infinite loop program', async () => {
      const res = await mockRunner.run(
        SEED_DATA.samplePrograms.infiniteLoop,
        SEED_DATA.problems.twoSum.testCases,
        defaultLimits,
        100,
      );
      expect(res.verdict).toBe(Verdict.TIME_LIMIT);
      expect(res.score).toBe(0);
    });

    it('returns OUTPUT_LIMIT for excessive output program', async () => {
      const res = await mockRunner.run(
        SEED_DATA.samplePrograms.excessiveOutput,
        SEED_DATA.problems.twoSum.testCases,
        defaultLimits,
        100,
      );
      expect(res.verdict).toBe(Verdict.OUTPUT_LIMIT);
      expect(res.score).toBe(0);
    });

    it('handles FAILPOINT=runner_crash mapping to INFRA_FAILURE', async () => {
      process.env.FAILPOINT = 'runner_crash';
      const res = await mockRunner.run(
        SEED_DATA.samplePrograms.correctTwoSum,
        SEED_DATA.problems.twoSum.testCases,
        defaultLimits,
        100,
      );
      expect(res.verdict).toBe(Verdict.INFRA_FAILURE);
      expect(res.score).toBe(0);
      delete process.env.FAILPOINT;
    });
  });

  describe('2. DockerRunner: Real sandboxed container execution (execution_mode=docker)', () => {
    const dockerRunner = new DockerRunner();
    const sandboxLimits = {
      cpus: 0.5,
      memoryMb: 128,
      pidsLimit: 32,
      wallTimeMs: 2500,
      outputLimitBytes: 65536,
    };

    it('[execution_mode=docker] executes correct Python solution in isolated container and returns ACCEPTED', async () => {
      const res = await dockerRunner.run(
        SEED_DATA.samplePrograms.correctTwoSum,
        SEED_DATA.problems.twoSum.testCases,
        sandboxLimits,
        100,
      );

      expect(res.executionMode).toBe('docker');
      expect(res.verdict).toBe(Verdict.ACCEPTED);
      expect(res.score).toBe(100);
      expect(res.testResults.length).toBe(SEED_DATA.problems.twoSum.testCases.length);
      expect(res.testResults.every((t) => t.passed)).toBe(true);
    });

    it('[execution_mode=docker] returns WRONG_ANSWER when output does not match expected output', async () => {
      const res = await dockerRunner.run(
        'print("wrong answer")',
        SEED_DATA.problems.twoSum.testCases,
        sandboxLimits,
        100,
      );

      expect(res.executionMode).toBe('docker');
      expect(res.verdict).toBe(Verdict.WRONG_ANSWER);
      expect(res.score).toBe(0);
      expect(res.testResults[0].passed).toBe(false);
    });

    it('[execution_mode=docker] captures RUNTIME_ERROR for uncaught Python exceptions', async () => {
      const res = await dockerRunner.run(
        'import sys\nraise ZeroDivisionError("Test crash")',
        SEED_DATA.problems.twoSum.testCases,
        sandboxLimits,
        100,
      );

      expect(res.executionMode).toBe('docker');
      expect(res.verdict).toBe(Verdict.RUNTIME_ERROR);
      expect(res.score).toBe(0);
      expect(res.testResults[0].error).toContain('ZeroDivisionError');
    });

    it('[execution_mode=docker] enforces wall-time watchdog and returns TIME_LIMIT', async () => {
      const tightLimits = { ...sandboxLimits, wallTimeMs: 1200 };
      const res = await dockerRunner.run(
        'import time\nwhile True:\n    time.sleep(0.1)\n',
        [SEED_DATA.problems.twoSum.testCases[0]],
        tightLimits,
        100,
      );

      expect(res.executionMode).toBe('docker');
      expect(res.verdict).toBe(Verdict.TIME_LIMIT);
      expect(res.score).toBe(0);
    });

    it('[execution_mode=docker] truncates excessive output and flags OUTPUT_LIMIT', async () => {
      const tinyOutputLimits = { ...sandboxLimits, outputLimitBytes: 1024 };
      const res = await dockerRunner.run(
        'print("X" * 100000)',
        [SEED_DATA.problems.twoSum.testCases[0]],
        tinyOutputLimits,
        100,
      );

      expect(res.executionMode).toBe('docker');
      expect(res.verdict).toBe(Verdict.OUTPUT_LIMIT);
      expect(res.score).toBe(0);
    });

    it('[execution_mode=docker] sandbox security: blocks outbound network access (--network none)', async () => {
      const networkTestCode = `
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(1.0)
try:
    s.connect(("8.8.8.8", 53))
    print("NETWORK_ACCESSIBLE")
except Exception as e:
    print("NETWORK_BLOCKED")
`;
      const res = await dockerRunner.run(
        networkTestCode,
        [{ id: 'net-1', input: '', expectedOutput: 'NETWORK_BLOCKED', isHidden: false }],
        sandboxLimits,
        100,
      );

      expect(res.verdict).toBe(Verdict.ACCEPTED);
      expect(res.testResults[0].passed).toBe(true);
    });

    it('[execution_mode=docker] sandbox security: enforces read-only root filesystem (--read-only)', async () => {
      const roTestCode = `
try:
    with open('/root_file_test.txt', 'w') as f:
        f.write('hacked')
    print('RO_BYPASS')
except OSError:
    print('RO_ENFORCED')
`;
      const res = await dockerRunner.run(
        roTestCode,
        [{ id: 'ro-1', input: '', expectedOutput: 'RO_ENFORCED', isHidden: false }],
        sandboxLimits,
        100,
      );

      expect(res.verdict).toBe(Verdict.ACCEPTED);
    });

    it('[execution_mode=docker] sandbox security: executes as non-root user (nobody: 65534)', async () => {
      const userTestCode = `
import os
print(f"UID={os.getuid()}:GID={os.getgid()}")
`;
      const res = await dockerRunner.run(
        userTestCode,
        [{ id: 'user-1', input: '', expectedOutput: 'UID=65534:GID=65534', isHidden: false }],
        sandboxLimits,
        100,
      );

      expect(res.verdict).toBe(Verdict.ACCEPTED);
    });

    it('[execution_mode=docker] sandbox cleanup: containers are removed and no temporary sandbox containers leak', async () => {
      const containersBefore = execSync(
        'docker ps -a --filter "name=shodh-sandbox-" -q',
      ).toString().trim();
      expect(containersBefore).toBe('');

      await dockerRunner.run(
        'print("clean")',
        [{ id: 'clean-1', input: '', expectedOutput: 'clean', isHidden: false }],
        sandboxLimits,
        100,
      );

      const containersAfter = execSync(
        'docker ps -a --filter "name=shodh-sandbox-" -q',
      ).toString().trim();
      expect(containersAfter).toBe('');
    });
  });

  describe('3. Worker Protocol, Job Claims, Heartbeat & CAS Invariants', () => {
    it('worker claims next eligible job via FOR UPDATE SKIP LOCKED with lease_token', async () => {
      const aliceHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);

      // Submit new problem solution
      const subRes = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(aliceHeaders)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: SEED_DATA.samplePrograms.correctTwoSum,
          idempotencyKey: 'worker-claim-test-sub-1',
        });

      const submissionId = subRes.body.id;
      const judgeHeaders = makeJudgeHeaders();

      // Worker claims job
      const claimRes = await request(app.getHttpServer())
        .post('/judge/jobs/claim')
        .set(judgeHeaders)
        .send({ workerId: 'test-worker-101' });

      expect(claimRes.status).toBe(200);
      expect(claimRes.body.job).toBeDefined();
      expect(claimRes.body.job.submissionId).toBe(submissionId);
      expect(claimRes.body.job.leaseToken).toBeDefined();

      const leaseToken = claimRes.body.job.leaseToken;
      const attemptId = claimRes.body.job.attemptId;
      const jobId = claimRes.body.job.jobId;

      // Extend lease via heartbeat
      const hbRes = await request(app.getHttpServer())
        .post(`/judge/jobs/${jobId}/heartbeat`)
        .set(judgeHeaders)
        .send({ workerId: 'test-worker-101', leaseToken });

      expect(hbRes.status).toBe(200);
      expect(hbRes.body.success).toBe(true);

      // Complete attempt with CAS
      const compRes = await request(app.getHttpServer())
        .post(`/judge/attempts/${attemptId}/complete`)
        .set(judgeHeaders)
        .send({
          workerId: 'test-worker-101',
          leaseToken,
          verdict: Verdict.ACCEPTED,
          score: 100,
          executionTimeMs: 35,
          testResults: [
            { testCaseId: claimRes.body.job.testCases[0].id, passed: true, executionTimeMs: 15 },
          ],
        });

      expect(compRes.status).toBe(200);
      expect(compRes.body.success).toBe(true);
      expect(compRes.body.staleWorker).toBe(false);

      // Verify DB attempt status is COMPLETED
      const attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
      expect(attempt?.status).toBe(AttemptStatus.COMPLETED);
      expect(attempt?.verdict).toBe(Verdict.ACCEPTED);
      expect(attempt?.score).toBe(100);
    });

    it('stale worker protection: rejects completion if lease_token does not match (0 rows updated, discard)', async () => {
      const aliceHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);

      const subRes = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(aliceHeaders)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: 'print(42)',
          idempotencyKey: 'stale-worker-test-sub',
        });

      const judgeHeaders = makeJudgeHeaders();
      const claimRes = await request(app.getHttpServer())
        .post('/judge/jobs/claim')
        .set(judgeHeaders)
        .send({ workerId: 'worker-primary' });

      const attemptId = claimRes.body.job.attemptId;

      // Stale worker attempts completion with expired/wrong lease_token
      const compRes = await request(app.getHttpServer())
        .post(`/judge/attempts/${attemptId}/complete`)
        .set(judgeHeaders)
        .send({
          workerId: 'worker-stale-rogue',
          leaseToken: 'invalid-expired-lease-token',
          verdict: Verdict.WRONG_ANSWER,
          score: 0,
          executionTimeMs: 50,
          testResults: [],
        });

      expect(compRes.status).toBe(200);
      expect(compRes.body.success).toBe(false);
      expect(compRes.body.staleWorker).toBe(true);
    });
  });

  describe('4. Hidden Test Case Protection', () => {
    it('never leaks hidden test input or expected output to participant attempt response', async () => {
      const aliceHeaders = makeDevHeaders(SEED_DATA.users.alphaParticipant1.id);

      // Submit two sum
      const subRes = await request(app.getHttpServer())
        .post(`/contests/${SEED_DATA.contests.alphaLive.id}/submissions`)
        .set(aliceHeaders)
        .send({
          problemId: SEED_DATA.problems.twoSum.id,
          code: SEED_DATA.samplePrograms.correctTwoSum,
          idempotencyKey: 'hidden-test-leak-check',
        });

      // Claim and complete with full test results
      const judgeHeaders = makeJudgeHeaders();
      const claimRes = await request(app.getHttpServer())
        .post('/judge/jobs/claim')
        .set(judgeHeaders)
        .send({ workerId: 'worker-leak-tester' });

      const job = claimRes.body.job;
      await request(app.getHttpServer())
        .post(`/judge/attempts/${job.attemptId}/complete`)
        .set(judgeHeaders)
        .send({
          workerId: 'worker-leak-tester',
          leaseToken: job.leaseToken,
          verdict: Verdict.ACCEPTED,
          score: 100,
          executionTimeMs: 40,
          testResults: job.testCases.map((tc: any) => ({
            testCaseId: tc.id,
            passed: true,
            executionTimeMs: 10,
            output: tc.expectedOutput,
          })),
        });

      // Participant fetches attempt details
      const detailsRes = await request(app.getHttpServer())
        .get(`/attempts/${job.attemptId}`)
        .set(aliceHeaders);

      expect(detailsRes.status).toBe(200);
      const hiddenResults = detailsRes.body.testResults.filter(
        (tr: any) => tr.testCase.isHidden,
      );
      expect(hiddenResults.length).toBeGreaterThan(0);
      for (const hr of hiddenResults) {
        // Assert hidden input and output are redacted (null)
        expect(hr.testCase.input).toBeNull();
        expect(hr.testCase.expectedOutput).toBeNull();
      }
    });
  });
});
