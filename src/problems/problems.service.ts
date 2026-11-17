import { Injectable, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService } from '../auth/access-control.service';
import { CreateProblemDto } from './dto/create-problem.dto';
import { PublishVersionDto } from './dto/publish-version.dto';
import { Role } from '@prisma/client';
import { BusinessRuleException } from '../common/errors/exceptions';

@Injectable()
export class ProblemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessControl: AccessControlService,
  ) {}

  async createProblem(user: any, contestId: string, dto: CreateProblemDto) {
    const { contest } = await this.accessControl.getAuthorizedContest(user, contestId);
    await this.accessControl.assertOrganizer(user, contest.organizationId);

    return this.prisma.$transaction(async (tx) => {
      // 1. Create Problem
      const problem = await tx.problem.create({
        data: {
          contestId,
          organizationId: contest.organizationId,
          title: dto.title,
          description: dto.description,
          points: dto.points,
          timeLimitMs: dto.timeLimitMs,
          memoryLimitMb: dto.memoryLimitMb,
        },
      });

      // 2. Create ProblemVersion 1
      const version = await tx.problemVersion.create({
        data: {
          problemId: problem.id,
          versionNumber: 1,
          title: dto.title,
          description: dto.description,
          points: dto.points,
          timeLimitMs: dto.timeLimitMs,
          memoryLimitMb: dto.memoryLimitMb,
        },
      });

      // 3. Create TestSuite 1
      const suite = await tx.testSuite.create({
        data: {
          problemId: problem.id,
          versionNumber: 1,
          isActive: true,
        },
      });

      // 4. Create TestCases
      if (dto.testCases && dto.testCases.length > 0) {
        await tx.testCase.createMany({
          data: dto.testCases.map((tc, index) => ({
            testSuiteId: suite.id,
            input: tc.input,
            expectedOutput: tc.expectedOutput,
            isHidden: !!tc.isHidden,
            orderIndex: tc.orderIndex ?? index,
          })),
        });
      }

      return {
        id: problem.id,
        contestId: problem.contestId,
        title: problem.title,
        points: problem.points,
        initialVersionId: version.id,
        initialSuiteId: suite.id,
      };
    });
  }

  async publishVersion(user: any, problemId: string, dto: PublishVersionDto) {
    const { problem } = await this.accessControl.getAuthorizedProblem(user, problemId);
    await this.accessControl.assertOrganizer(user, problem.organizationId);

    return this.prisma.$transaction(async (tx) => {
      // Find latest version number
      const latestVersion = await tx.problemVersion.findFirst({
        where: { problemId },
        orderBy: { versionNumber: 'desc' },
      });
      const nextVersionNumber = (latestVersion?.versionNumber || 0) + 1;

      // Update problem summary fields
      await tx.problem.update({
        where: { id: problemId },
        data: {
          title: dto.title,
          description: dto.description,
          points: dto.points,
          timeLimitMs: dto.timeLimitMs,
          memoryLimitMb: dto.memoryLimitMb,
        },
      });

      // Create new ProblemVersion
      const version = await tx.problemVersion.create({
        data: {
          problemId,
          versionNumber: nextVersionNumber,
          title: dto.title,
          description: dto.description,
          points: dto.points,
          timeLimitMs: dto.timeLimitMs,
          memoryLimitMb: dto.memoryLimitMb,
        },
      });

      // Deactivate previous suites
      await tx.testSuite.updateMany({
        where: { problemId, isActive: true },
        data: { isActive: false },
      });

      // Create new active TestSuite
      const suite = await tx.testSuite.create({
        data: {
          problemId,
          versionNumber: nextVersionNumber,
          isActive: true,
        },
      });

      // Create TestCases
      if (dto.testCases && dto.testCases.length > 0) {
        await tx.testCase.createMany({
          data: dto.testCases.map((tc, index) => ({
            testSuiteId: suite.id,
            input: tc.input,
            expectedOutput: tc.expectedOutput,
            isHidden: !!tc.isHidden,
            orderIndex: tc.orderIndex ?? index,
          })),
        });
      }

      return {
        problemId,
        versionNumber: nextVersionNumber,
        problemVersionId: version.id,
        suiteVersionId: suite.id,
      };
    });
  }

  async getProblem(user: any, problemId: string) {
    const { problem, role } = await this.accessControl.getAuthorizedProblem(user, problemId);

    // Get active test suite and test cases
    const activeSuite = await this.prisma.testSuite.findFirst({
      where: { problemId, isActive: true },
      include: {
        testCases: {
          orderBy: { orderIndex: 'asc' },
        },
      },
    });

    const isOrg = role === Role.ORGANIZER;

    // Redact hidden test cases for participants
    const sanitizedTestCases = activeSuite?.testCases.map((tc) => {
      if (tc.isHidden && !isOrg) {
        return {
          id: tc.id,
          isHidden: true,
          orderIndex: tc.orderIndex,
          input: null,
          expectedOutput: null,
        };
      }
      return tc;
    }) || [];

    return {
      ...problem,
      activeSuite: activeSuite
        ? {
            id: activeSuite.id,
            versionNumber: activeSuite.versionNumber,
            testCases: sanitizedTestCases,
          }
        : null,
    };
  }
}
