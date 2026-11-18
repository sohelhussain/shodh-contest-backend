import { Injectable, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService } from '../auth/access-control.service';
import { BusinessRuleException } from '../common/errors/exceptions';
import { Role } from '@prisma/client';

@Injectable()
export class AttemptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessControl: AccessControlService,
  ) {}

  async getAttemptDetails(user: any, attemptId: string) {
    const { attempt, role } = await this.accessControl.getAuthorizedAttempt(
      user,
      attemptId,
    );

    const isOwn = attempt.submission.userId === user.id;
    const isOrg = role === Role.ORGANIZER;

    if (!isOwn && !isOrg) {
      throw new BusinessRuleException(
        'Cannot view attempt details of another participant',
        'FORBIDDEN',
        HttpStatus.FORBIDDEN,
      );
    }

    // Redact hidden test inputs and outputs for participants
    const sanitizedTestResults = attempt.testResults.map((tr) => {
      const isHidden = tr.testCase.isHidden;
      if (isHidden && !isOrg) {
        return {
          id: tr.id,
          testCaseId: tr.testCaseId,
          passed: tr.passed,
          executionTimeMs: tr.executionTimeMs,
          output: tr.passed ? null : '(hidden test output withheld)',
          error: tr.error ? '(hidden test error withheld)' : null,
          testCase: {
            id: tr.testCase.id,
            orderIndex: tr.testCase.orderIndex,
            isHidden: true,
            input: null,
            expectedOutput: null,
          },
        };
      }

      return {
        id: tr.id,
        testCaseId: tr.testCaseId,
        passed: tr.passed,
        executionTimeMs: tr.executionTimeMs,
        output: tr.output,
        error: tr.error,
        testCase: {
          id: tr.testCase.id,
          orderIndex: tr.testCase.orderIndex,
          isHidden: tr.testCase.isHidden,
          input: tr.testCase.input,
          expectedOutput: tr.testCase.expectedOutput,
        },
      };
    });

    return {
      id: attempt.id,
      submissionId: attempt.submissionId,
      attemptNo: attempt.attemptNo,
      problemVersionId: attempt.problemVersionId,
      suiteVersionId: attempt.suiteVersionId,
      status: attempt.status,
      verdict: attempt.verdict,
      score: attempt.score,
      executionTimeMs: attempt.executionTimeMs,
      leaseExpiresAt: isOrg ? attempt.leaseExpiresAt : undefined,
      workerId: isOrg ? attempt.workerId : undefined,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
      testResults: sanitizedTestResults,
    };
  }
}
