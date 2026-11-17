import { Injectable, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User, Role } from '@prisma/client';
import { BusinessRuleException, CrossOrgNotFoundException } from '../common/errors/exceptions';

@Injectable()
export class AccessControlService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Asserts user belongs to organization, returning their role.
   * If user is not member of org, throws 404 (Cross-org denial).
   */
  async assertOrgMembership(user: any, organizationId: string): Promise<Role> {
    const membership = user.memberships?.find(
      (m: any) => m.organizationId === organizationId,
    );
    if (!membership) {
      throw new CrossOrgNotFoundException('Organization');
    }
    return membership.role;
  }

  /**
   * Asserts user is an ORGANIZER in the given organization.
   */
  async assertOrganizer(user: any, organizationId: string): Promise<void> {
    const role = await this.assertOrgMembership(user, organizationId);
    if (role !== Role.ORGANIZER) {
      throw new BusinessRuleException(
        'Organizer role required for this action',
        'ORGANIZER_REQUIRED',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * Asserts contest exists and user belongs to its organization.
   * Returns contest object.
   */
  async getAuthorizedContest(user: any, contestId: string) {
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
    });
    if (!contest) {
      throw new CrossOrgNotFoundException('Contest');
    }
    const role = await this.assertOrgMembership(user, contest.organizationId);
    return { contest, role };
  }

  /**
   * Asserts problem exists and user belongs to its organization.
   * Returns problem and contest.
   */
  async getAuthorizedProblem(user: any, problemId: string) {
    const problem = await this.prisma.problem.findUnique({
      where: { id: problemId },
      include: { contest: true },
    });
    if (!problem) {
      throw new CrossOrgNotFoundException('Problem');
    }
    const role = await this.assertOrgMembership(user, problem.organizationId);
    return { problem, role };
  }

  /**
   * Asserts submission exists and user belongs to its organization.
   */
  async getAuthorizedSubmission(user: any, submissionId: string) {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: {
        contest: true,
        authoritativeAttempt: true,
        attempts: {
          orderBy: { attemptNo: 'asc' },
        },
      },
    });
    if (!submission) {
      throw new CrossOrgNotFoundException('Submission');
    }
    const role = await this.assertOrgMembership(user, submission.contest.organizationId);
    return { submission, role };
  }

  /**
   * Asserts attempt exists and user belongs to its organization.
   */
  async getAuthorizedAttempt(user: any, attemptId: string) {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: {
        submission: {
          include: { contest: true },
        },
        testResults: {
          include: { testCase: true },
        },
      },
    });
    if (!attempt) {
      throw new CrossOrgNotFoundException('Attempt');
    }
    const role = await this.assertOrgMembership(
      user,
      attempt.submission.contest.organizationId,
    );
    return { attempt, role };
  }
}
