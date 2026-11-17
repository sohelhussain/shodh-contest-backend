import { Injectable, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService } from '../auth/access-control.service';
import { CreateSubmissionDto } from './dto/create-submission.dto';
import { RejudgeDto } from './dto/rejudge.dto';
import { BusinessRuleException, CrossOrgNotFoundException } from '../common/errors/exceptions';
import { Role, AttemptStatus, JobStatus } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class SubmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessControl: AccessControlService,
  ) {}

  computeRequestHash(problemId: string, language: string, code: string): string {
    return crypto
      .createHash('sha256')
      .update(`${problemId}:${language}:${code}`)
      .digest('hex');
  }

  async submit(user: any, contestId: string, dto: CreateSubmissionDto) {
    const { contest } = await this.accessControl.getAuthorizedContest(user, contestId);

    // 1. Check contest active window: startTime <= now < endTime
    const now = new Date();
    if (now < contest.startTime || now >= contest.endTime) {
      throw new BusinessRuleException(
        'Contest is not currently active for submissions',
        'CONTEST_NOT_ACTIVE',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // 2. Check user has joined the contest
    const participation = await this.prisma.contestParticipant.findUnique({
      where: {
        contestId_userId: {
          contestId,
          userId: user.id,
        },
      },
    });
    if (!participation) {
      throw new BusinessRuleException(
        'User has not joined this contest',
        'USER_NOT_JOINED',
        HttpStatus.FORBIDDEN,
      );
    }

    // 3. Check problem belongs to contest
    const problem = await this.prisma.problem.findUnique({
      where: { id: dto.problemId },
      include: {
        versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
        testSuites: { where: { isActive: true }, take: 1 },
      },
    });

    if (!problem || problem.contestId !== contestId) {
      throw new CrossOrgNotFoundException('Problem');
    }

    const activeVersion = problem.versions[0];
    const activeSuite = problem.testSuites[0];

    if (!activeVersion || !activeSuite) {
      throw new BusinessRuleException(
        'Problem has no published version or test suite',
        'PROBLEM_NOT_READY',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const language = dto.language || 'python';
    const requestHash = this.computeRequestHash(dto.problemId, language, dto.code);

    // 4. Check existing idempotency key
    const existing = await this.prisma.submission.findUnique({
      where: {
        contestId_userId_idempotencyKey: {
          contestId,
          userId: user.id,
          idempotencyKey: dto.idempotencyKey,
        },
      },
      include: {
        authoritativeAttempt: true,
      },
    });

    if (existing) {
      // Same key + same hash -> return existing submission
      if (existing.requestHash === requestHash) {
        return {
          id: existing.id,
          status: existing.authoritativeAttempt?.status || AttemptStatus.QUEUED,
          verdict: existing.authoritativeAttempt?.verdict || null,
          message: 'Existing submission returned (idempotent)',
        };
      }
      // Same key + different hash -> 409 Conflict
      throw new BusinessRuleException(
        'Idempotency key reused with different request payload',
        'IDEMPOTENCY_CONFLICT',
        HttpStatus.CONFLICT,
      );
    }

    // 5. Atomic transaction: create submission, attempt 1, and job
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const submission = await tx.submission.create({
          data: {
            contestId,
            problemId: dto.problemId,
            userId: user.id,
            code: dto.code,
            language,
            runtimeConfig: dto.runtimeConfig || {
              cpus: parseFloat(process.env.RUN_CPUS || '0.5'),
              memoryMb: parseInt(process.env.RUN_MEMORY_MB || '128', 10),
              wallTimeMs: parseInt(process.env.RUN_WALL_TIME_MS || '3000', 10),
              pidsLimit: parseInt(process.env.RUN_PIDS_LIMIT || '32', 10),
            },
            problemVersionId: activeVersion.id,
            suiteVersionId: activeSuite.id,
            idempotencyKey: dto.idempotencyKey,
            requestHash,
          },
        });

        const attempt = await tx.attempt.create({
          data: {
            submissionId: submission.id,
            attemptNo: 1,
            problemVersionId: activeVersion.id,
            suiteVersionId: activeSuite.id,
            status: AttemptStatus.QUEUED,
          },
        });

        // Point authoritative_attempt_id initially to attempt 1
        await tx.submission.update({
          where: { id: submission.id },
          data: { authoritativeAttemptId: attempt.id },
        });

        await tx.job.create({
          data: {
            attemptId: attempt.id,
            status: JobStatus.QUEUED,
          },
        });

        return {
          id: submission.id,
          attemptId: attempt.id,
          status: AttemptStatus.QUEUED,
          message: 'Submission accepted for judging',
        };
      });

      return result;
    } catch (err: any) {
      // Handle concurrent race condition where another parallel request inserted the key
      if (err.code === 'P2002' || (err.message && err.message.includes('Unique constraint'))) {
        const raced = await this.prisma.submission.findUnique({
          where: {
            contestId_userId_idempotencyKey: {
              contestId,
              userId: user.id,
              idempotencyKey: dto.idempotencyKey,
            },
          },
          include: { authoritativeAttempt: true },
        });

        if (raced) {
          if (raced.requestHash === requestHash) {
            return {
              id: raced.id,
              status: raced.authoritativeAttempt?.status || AttemptStatus.QUEUED,
              verdict: raced.authoritativeAttempt?.verdict || null,
              message: 'Existing submission returned (idempotent)',
            };
          }
          throw new BusinessRuleException(
            'Idempotency key reused with different request payload',
            'IDEMPOTENCY_CONFLICT',
            HttpStatus.CONFLICT,
          );
        }
      }
      throw err;
    }
  }

  async getSubmission(user: any, submissionId: string) {
    const { submission, role } = await this.accessControl.getAuthorizedSubmission(
      user,
      submissionId,
    );

    const isOwn = submission.userId === user.id;
    const isOrg = role === Role.ORGANIZER;

    if (!isOwn && !isOrg) {
      throw new BusinessRuleException(
        'Cannot view code or details of another participant submission',
        'FORBIDDEN',
        HttpStatus.FORBIDDEN,
      );
    }

    return {
      id: submission.id,
      contestId: submission.contestId,
      problemId: submission.problemId,
      userId: submission.userId,
      code: submission.code,
      language: submission.language,
      runtimeConfig: submission.runtimeConfig,
      createdAt: submission.createdAt,
      authoritativeAttemptId: submission.authoritativeAttemptId,
      authoritativeAttempt: submission.authoritativeAttempt,
      attempts: isOrg ? submission.attempts : undefined,
    };
  }

  async rejudge(user: any, submissionId: string, dto: RejudgeDto) {
    const { submission } = await this.accessControl.getAuthorizedSubmission(user, submissionId);
    await this.accessControl.assertOrganizer(user, submission.contest.organizationId);

    return this.prisma.$transaction(async (tx) => {
      // Find latest attempt number
      const latestAttempt = await tx.attempt.findFirst({
        where: { submissionId },
        orderBy: { attemptNo: 'desc' },
      });

      const nextAttemptNo = (latestAttempt?.attemptNo || 0) + 1;

      // Determine problem version and suite version
      const problemVersionId = dto.problemVersionId || submission.problemVersionId;
      const suiteVersionId = dto.suiteVersionId || submission.suiteVersionId;

      const newAttempt = await tx.attempt.create({
        data: {
          submissionId,
          attemptNo: nextAttemptNo,
          problemVersionId,
          suiteVersionId,
          status: AttemptStatus.QUEUED,
        },
      });

      await tx.job.create({
        data: {
          attemptId: newAttempt.id,
          status: JobStatus.QUEUED,
        },
      });

      return {
        submissionId,
        attemptId: newAttempt.id,
        attemptNo: nextAttemptNo,
        status: AttemptStatus.QUEUED,
        message: 'Rejudge attempt created and queued',
      };
    });
  }
}
