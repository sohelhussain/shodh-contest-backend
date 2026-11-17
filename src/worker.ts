import { PrismaClient, AttemptStatus, JobStatus, Verdict } from '@prisma/client';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import { appLogger } from './common/logging/logger';
import { RunnerFactory } from './runner/runner.factory';
import { StandingsService } from './standings/standings.service';
import { PrismaService } from './prisma/prisma.service';

dotenv.config();

const workerId = `worker-${process.env.HOSTNAME || process.pid}-${crypto.randomBytes(3).toString('hex')}`;
const pollIntervalMs = parseInt(process.env.WORKER_POLL_INTERVAL_MS || '500', 10);
const leaseSeconds = parseInt(process.env.LEASE_SECONDS || '30', 10);
const heartbeatSeconds = parseInt(process.env.HEARTBEAT_SECONDS || '10', 10);
const maxAttempts = parseInt(process.env.MAX_ATTEMPTS || '3', 10);

const prisma = new PrismaClient();
const standingsService = new StandingsService(prisma as any);
let isRunning = true;

const logger = appLogger.child({
  worker_id: workerId,
  execution_mode: process.env.RUNNER_MODE || 'docker',
});

logger.info({ pollIntervalMs, leaseSeconds, heartbeatSeconds, maxAttempts }, 'Judge worker process starting');

async function claimNextJob() {
  return prisma.$transaction(async (tx) => {
    // 1. Raw SQL FOR UPDATE SKIP LOCKED
    const jobs: any[] = await tx.$queryRawUnsafe(`
      SELECT id, attempt_id, attempts_count
      FROM jobs
      WHERE (status = 'QUEUED')
         OR (status = 'RUNNING' AND lease_expires_at < NOW())
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED;
    `);

    if (!jobs || jobs.length === 0) {
      return null;
    }

    const candidate = jobs[0];
    const newAttemptsCount = candidate.attempts_count + 1;

    // Check max attempts
    if (newAttemptsCount > maxAttempts) {
      logger.warn({ job_id: candidate.id, attempts_count: newAttemptsCount }, 'Job exceeded MAX_ATTEMPTS, marking FAILED');
      await tx.job.update({
        where: { id: candidate.id },
        data: { status: JobStatus.FAILED },
      });
      await tx.attempt.update({
        where: { id: candidate.attempt_id },
        data: {
          status: AttemptStatus.FAILED,
          verdict: Verdict.INFRA_FAILURE,
          score: 0,
        },
      });
      return null;
    }

    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000);

    // Update Job
    await tx.job.update({
      where: { id: candidate.id },
      data: {
        status: JobStatus.RUNNING,
        leaseToken,
        leaseExpiresAt,
        workerId,
        attemptsCount: newAttemptsCount,
      },
    });

    // Update Attempt
    await tx.attempt.update({
      where: { id: candidate.attempt_id },
      data: {
        status: AttemptStatus.RUNNING,
        leaseToken,
        leaseExpiresAt,
        workerId,
      },
    });

    // Fetch details
    const attempt = await tx.attempt.findUnique({
      where: { id: candidate.attempt_id },
      include: {
        submission: true,
        problemVersion: true,
        suiteVersion: {
          include: {
            testCases: { orderBy: { orderIndex: 'asc' } },
          },
        },
      },
    });

    return {
      jobId: candidate.id,
      attemptId: attempt.id,
      submissionId: attempt.submission.id,
      contestId: attempt.submission.contestId,
      userId: attempt.submission.userId,
      attemptNo: attempt.attemptNo,
      leaseToken,
      code: attempt.submission.code,
      language: attempt.submission.language,
      runtimeConfig: attempt.submission.runtimeConfig,
      problemVersion: attempt.problemVersion,
      testCases: attempt.suiteVersion.testCases,
    };
  });
}

async function heartbeat(jobId: string, leaseToken: string) {
  const newExpiresAt = new Date(Date.now() + leaseSeconds * 1000);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.job.updateMany({
        where: { id: jobId, leaseToken, status: JobStatus.RUNNING },
        data: { leaseExpiresAt: newExpiresAt },
      });
      await tx.attempt.updateMany({
        where: { leaseToken, status: AttemptStatus.RUNNING },
        data: { leaseExpiresAt: newExpiresAt },
      });
    });
  } catch (err: any) {
    logger.warn({ jobId, err: err.message }, 'Failed to extend lease heartbeat');
  }
}

async function processJob(jobPayload: NonNullable<Awaited<ReturnType<typeof claimNextJob>>>) {
  const jobLogger = logger.child({
    submission_id: jobPayload.submissionId,
    attempt_id: jobPayload.attemptId,
    execution_mode: process.env.RUNNER_MODE || 'docker',
  });

  jobLogger.info({ attemptNo: jobPayload.attemptNo }, 'Claimed job, starting execution');

  // Check failpoint: crash_after_claim
  if (process.env.FAILPOINT === 'crash_after_claim') {
    jobLogger.error('FAILPOINT=crash_after_claim triggered! Process terminating immediately.');
    process.exit(1);
  }

  // Start heartbeat interval
  const heartbeatTimer = setInterval(() => {
    heartbeat(jobPayload.jobId, jobPayload.leaseToken);
  }, heartbeatSeconds * 1000);

  try {
    const limits = {
      cpus: parseFloat(process.env.RUN_CPUS || '0.5'),
      memoryMb: parseInt(process.env.RUN_MEMORY_MB || '128', 10),
      pidsLimit: parseInt(process.env.RUN_PIDS_LIMIT || '32', 10),
      wallTimeMs: parseInt(process.env.RUN_WALL_TIME_MS || '3000', 10),
      outputLimitBytes: parseInt(process.env.RUN_OUTPUT_LIMIT_BYTES || '65536', 10),
    };

    const runner = RunnerFactory.getRunner();
    const runResult = await runner.run(
      jobPayload.code,
      jobPayload.testCases.map((tc) => ({
        id: tc.id,
        input: tc.input,
        expectedOutput: tc.expectedOutput,
        isHidden: tc.isHidden,
      })),
      limits,
      jobPayload.problemVersion.points,
    );

    jobLogger.info(
      { verdict: runResult.verdict, score: runResult.score, executionTimeMs: runResult.executionTimeMs },
      'Runner execution finished',
    );

    // Check failpoint: crash_before_ack
    if (process.env.FAILPOINT === 'crash_before_ack') {
      jobLogger.error('FAILPOINT=crash_before_ack triggered! Crashing before acknowledging to database.');
      process.exit(1);
    }

    // Acknowledge completion with CAS Update
    const isInfraFailure = runResult.verdict === Verdict.INFRA_FAILURE;
    const targetStatus = isInfraFailure ? AttemptStatus.FAILED : AttemptStatus.COMPLETED;

    await prisma.$transaction(async (tx) => {
      // 1. CAS Update on attempt
      const updateResult: any[] = await tx.$queryRawUnsafe(
        `
        UPDATE attempts
        SET status = $1::"AttemptStatus",
            verdict = $2::"Verdict",
            score = $3,
            execution_time_ms = $4,
            updated_at = NOW()
        WHERE id = $5 AND status = 'RUNNING' AND lease_token = $6
        RETURNING *;
      `,
        targetStatus,
        runResult.verdict,
        runResult.score,
        runResult.executionTimeMs,
        jobPayload.attemptId,
        jobPayload.leaseToken,
      );

      // If zero rows updated, worker was stale/superseded -> discard!
      if (!updateResult || updateResult.length === 0) {
        jobLogger.warn('Zero rows updated: worker lease expired or superseded. Discarded result.');
        return;
      }

      // 2. Insert test results (hidden details protected from logs/participants)
      if (runResult.testResults && runResult.testResults.length > 0) {
        await tx.attemptTestResult.createMany({
          data: runResult.testResults.map((tr) => ({
            attemptId: jobPayload.attemptId,
            testCaseId: tr.testCaseId,
            passed: tr.passed,
            executionTimeMs: tr.executionTimeMs,
            output: tr.output,
            error: tr.error,
          })),
        });
      }

      // 3. Update Job
      if (isInfraFailure) {
        const job = await tx.job.findUnique({ where: { id: jobPayload.jobId } });
        if (job && job.attemptsCount < maxAttempts) {
          // Re-queue for retry
          await tx.job.update({
            where: { id: jobPayload.jobId },
            data: {
              status: JobStatus.QUEUED,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
          jobLogger.info({ attemptCount: job.attemptsCount }, 'Job requeued due to INFRA_FAILURE');
        } else {
          await tx.job.update({
            where: { id: jobPayload.jobId },
            data: { status: JobStatus.FAILED },
          });
          jobLogger.error('Job permanently failed after reaching MAX_ATTEMPTS');
        }
      } else {
        await tx.job.update({
          where: { id: jobPayload.jobId },
          data: { status: JobStatus.COMPLETED },
        });
      }

      // 4. Update authoritative attempt pointer & standings in SAME transaction
      const latestValidAttempt = await tx.attempt.findFirst({
        where: {
          submissionId: jobPayload.submissionId,
          status: AttemptStatus.COMPLETED,
          verdict: { not: Verdict.INFRA_FAILURE },
        },
        orderBy: { attemptNo: 'desc' },
      });

      if (latestValidAttempt && latestValidAttempt.id === jobPayload.attemptId) {
        await tx.submission.update({
          where: { id: jobPayload.submissionId },
          data: { authoritativeAttemptId: jobPayload.attemptId },
        });

        await standingsService.updateStandingForUser(
          tx,
          jobPayload.contestId,
          jobPayload.userId,
        );
        jobLogger.info('Authoritative attempt and standings updated atomically');
      } else {
        jobLogger.info('Completed attempt is not latest valid attempt (superseded by rejudge). Standings preserved.');
      }
    });
  } catch (err: any) {
    jobLogger.error({ err: err.message }, 'Unexpected worker execution error');
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function loop() {
  while (isRunning) {
    try {
      const job = await claimNextJob();
      if (job) {
        await processJob(job);
      } else {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Error in worker loop');
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
  await prisma.$disconnect();
  logger.info('Worker loop shut down cleanly');
}

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down...');
  isRunning = false;
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down...');
  isRunning = false;
});

if (require.main === module) {
  loop().catch((err) => {
    logger.error({ err }, 'Worker fatal error');
    process.exit(1);
  });
}

export { claimNextJob, processJob, heartbeat };
