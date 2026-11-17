import { Injectable, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StandingsService } from '../standings/standings.service';
import { JudgeClaimDto, JudgeHeartbeatDto, JudgeCompleteDto } from './dto/judge.dto';
import { BusinessRuleException } from '../common/errors/exceptions';
import { AttemptStatus, JobStatus, Verdict } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class JudgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly standingsService: StandingsService,
  ) {}

  private get leaseSeconds(): number {
    return parseInt(process.env.LEASE_SECONDS || '30', 10);
  }

  private get maxAttempts(): number {
    return parseInt(process.env.MAX_ATTEMPTS || '3', 10);
  }

  /**
   * Worker claims next eligible job using FOR UPDATE SKIP LOCKED
   */
  async claimJob(dto: JudgeClaimDto) {
    const leaseSeconds = this.leaseSeconds;
    const maxAttempts = this.maxAttempts;

    return this.prisma.$transaction(async (tx) => {
      // Find candidate job with raw SQL FOR UPDATE SKIP LOCKED
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
        return { job: null };
      }

      const candidate = jobs[0];
      const newAttemptsCount = candidate.attempts_count + 1;

      // Check max attempts
      if (newAttemptsCount > maxAttempts) {
        // Mark job and attempt as FAILED with INFRA_FAILURE
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

        return { job: null };
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
          workerId: dto.workerId,
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
          workerId: dto.workerId,
        },
      });

      // Fetch attempt, submission, problem, and test cases
      const attempt = await tx.attempt.findUnique({
        where: { id: candidate.attempt_id },
        include: {
          submission: true,
          problemVersion: true,
          suiteVersion: {
            include: {
              testCases: {
                orderBy: { orderIndex: 'asc' },
              },
            },
          },
        },
      });

      return {
        job: {
          jobId: candidate.id,
          attemptId: attempt.id,
          attemptNo: attempt.attemptNo,
          leaseToken,
          leaseExpiresAt,
          submissionId: attempt.submission.id,
          contestId: attempt.submission.contestId,
          userId: attempt.submission.userId,
          code: attempt.submission.code,
          language: attempt.submission.language,
          runtimeConfig: attempt.submission.runtimeConfig,
          problem: {
            points: attempt.problemVersion.points,
            timeLimitMs: attempt.problemVersion.timeLimitMs,
            memoryLimitMb: attempt.problemVersion.memoryLimitMb,
          },
          testCases: attempt.suiteVersion.testCases.map((tc) => ({
            id: tc.id,
            input: tc.input,
            expectedOutput: tc.expectedOutput,
            isHidden: tc.isHidden,
            orderIndex: tc.orderIndex,
          })),
        },
      };
    });
  }

  /**
   * Heartbeat to extend lease
   */
  async heartbeat(jobId: string, dto: JudgeHeartbeatDto) {
    const leaseSeconds = this.leaseSeconds;
    const newExpiresAt = new Date(Date.now() + leaseSeconds * 1000);

    const updated = await this.prisma.job.updateMany({
      where: {
        id: jobId,
        leaseToken: dto.leaseToken,
        status: JobStatus.RUNNING,
      },
      data: {
        leaseExpiresAt: newExpiresAt,
      },
    });

    if (updated.count === 0) {
      throw new BusinessRuleException(
        'Heartbeat failed: Job lease expired or invalid token',
        'STALE_LEASE',
        HttpStatus.CONFLICT,
      );
    }

    // Also extend attempt lease
    await this.prisma.attempt.updateMany({
      where: {
        leaseToken: dto.leaseToken,
        status: AttemptStatus.RUNNING,
      },
      data: {
        leaseExpiresAt: newExpiresAt,
      },
    });

    return {
      success: true,
      leaseExpiresAt: newExpiresAt,
    };
  }

  /**
   * Complete attempt atomically with CAS, updating standings if authoritative
   */
  async completeAttempt(attemptId: string, dto: JudgeCompleteDto) {
    const isInfraFailure = dto.verdict === Verdict.INFRA_FAILURE;
    const targetStatus = isInfraFailure ? AttemptStatus.FAILED : AttemptStatus.COMPLETED;

    return this.prisma.$transaction(async (tx) => {
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
        dto.verdict,
        dto.score,
        dto.executionTimeMs,
        attemptId,
        dto.leaseToken,
      );

      // If zero rows updated, worker was stale/superseded -> discard!
      if (!updateResult || updateResult.length === 0) {
        return {
          success: false,
          staleWorker: true,
          message: 'Zero rows updated: worker lease expired or superseded. Discarded.',
        };
      }

      const completedAttempt = updateResult[0];

      // 2. Insert test results
      if (dto.testResults && dto.testResults.length > 0) {
        await tx.attemptTestResult.createMany({
          data: dto.testResults.map((tr) => ({
            attemptId,
            testCaseId: tr.testCaseId,
            passed: tr.passed,
            executionTimeMs: tr.executionTimeMs,
            output: tr.output,
            error: tr.error,
          })),
        });
      }

      // 3. Update Job status
      if (isInfraFailure) {
        // Check retry count
        const job = await tx.job.findUnique({ where: { attemptId } });
        if (job && job.attemptsCount < this.maxAttempts) {
          // Re-queue job for retry
          await tx.job.update({
            where: { attemptId },
            data: {
              status: JobStatus.QUEUED,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
        } else {
          await tx.job.update({
            where: { attemptId },
            data: {
              status: JobStatus.FAILED,
            },
          });
        }
      } else {
        await tx.job.update({
          where: { attemptId },
          data: {
            status: JobStatus.COMPLETED,
          },
        });
      }

      // 4. Update authoritative attempt pointer & standings
      // "Authoritative attempt is the latest COMPLETED attempt that is not INFRA_FAILURE,
      // set in the same transaction that updates standings. Late results from replaced
      // attempts are stored but do not change authoritative pointer or standings."
      const submission = await tx.submission.findUnique({
        where: { id: completedAttempt.submission_id },
      });

      if (submission) {
        // Find highest attempt_no that is COMPLETED and not INFRA_FAILURE
        const latestValidAttempt = await tx.attempt.findFirst({
          where: {
            submissionId: submission.id,
            status: AttemptStatus.COMPLETED,
            verdict: { not: Verdict.INFRA_FAILURE },
          },
          orderBy: { attemptNo: 'desc' },
        });

        if (latestValidAttempt && latestValidAttempt.id === completedAttempt.id) {
          // Point authoritative pointer to this attempt
          await tx.submission.update({
            where: { id: submission.id },
            data: { authoritativeAttemptId: completedAttempt.id },
          });

          // Update standings in the same transaction
          await this.standingsService.updateStandingForUser(
            tx,
            submission.contestId,
            submission.userId,
          );
        }
      }

      return {
        success: true,
        staleWorker: false,
        attemptId: completedAttempt.id,
        verdict: completedAttempt.verdict,
        score: completedAttempt.score,
      };
    });
  }
}
