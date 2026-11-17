import { Injectable, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService } from '../auth/access-control.service';
import { CreateContestDto } from './dto/create-contest.dto';
import { BusinessRuleException } from '../common/errors/exceptions';
import { StandingsService } from '../standings/standings.service';
import { Role } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class ContestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessControl: AccessControlService,
    private readonly standingsService: StandingsService,
  ) {}

  async createContest(user: any, dto: CreateContestDto) {
    await this.accessControl.assertOrganizer(user, dto.organizationId);

    const start = new Date(dto.startTime);
    const end = new Date(dto.endTime);
    if (end.getTime() <= start.getTime()) {
      throw new BusinessRuleException(
        'Contest end time must be after start time',
        'INVALID_CONTEST_WINDOW',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.prisma.contest.create({
      data: {
        organizationId: dto.organizationId,
        title: dto.title,
        description: dto.description,
        startTime: start,
        endTime: end,
      },
    });
  }

  async listContests(user: any) {
    const orgIds = user.memberships?.map((m: any) => m.organizationId) || [];
    return this.prisma.contest.findMany({
      where: {
        organizationId: { in: orgIds },
      },
      orderBy: { startTime: 'desc' },
      include: {
        organization: { select: { id: true, name: true } },
      },
    });
  }

  async getContest(user: any, contestId: string) {
    const { contest } = await this.accessControl.getAuthorizedContest(user, contestId);
    return contest;
  }

  async joinContest(user: any, contestId: string) {
    const { contest } = await this.accessControl.getAuthorizedContest(user, contestId);

    const existing = await this.prisma.contestParticipant.findUnique({
      where: {
        contestId_userId: {
          contestId,
          userId: user.id,
        },
      },
    });

    if (existing) {
      throw new BusinessRuleException(
        'User has already joined this contest',
        'ALREADY_JOINED',
        HttpStatus.CONFLICT,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const participant = await tx.contestParticipant.create({
        data: {
          contestId,
          userId: user.id,
        },
      });

      await tx.standing.upsert({
        where: {
          contestId_userId: {
            contestId,
            userId: user.id,
          },
        },
        create: {
          contestId,
          userId: user.id,
          totalScore: 0,
          totalPenalty: 0,
        },
        update: {},
      });

      return participant;
    });
  }

  async getLeaderboard(user: any, contestId: string) {
    await this.accessControl.getAuthorizedContest(user, contestId);
    const { entries, updatedAt } = await this.standingsService.getLeaderboard(contestId);

    const dataString = JSON.stringify(entries) + updatedAt.toISOString();
    const etag = `"${crypto.createHash('md5').update(dataString).digest('hex')}"`;

    return {
      etag,
      updatedAt: updatedAt.toISOString(),
      entries,
    };
  }

  async listSubmissions(
    user: any,
    contestId: string,
    limit = 20,
    cursor?: string,
  ) {
    const { role } = await this.accessControl.getAuthorizedContest(user, contestId);
    const take = Math.min(Math.max(1, limit), 100);

    const items = await this.prisma.submission.findMany({
      where: { contestId },
      take: take + 1,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      include: {
        user: { select: { id: true, username: true } },
        authoritativeAttempt: {
          select: {
            id: true,
            attemptNo: true,
            status: true,
            verdict: true,
            score: true,
            executionTimeMs: true,
          },
        },
      },
    });
    let nextCursor: string | null = null;

    if (items.length > take) {
      const nextItem = items.pop();
      nextCursor = nextItem.id;
    }

    // Participants cannot see other participants' code
    const sanitized = items.map((sub) => {
      const isOwn = sub.userId === user.id;
      const isOrg = role === Role.ORGANIZER;
      return {
        id: sub.id,
        contestId: sub.contestId,
        problemId: sub.problemId,
        userId: sub.userId,
        username: sub.user.username,
        code: isOwn || isOrg ? sub.code : null,
        language: sub.language,
        createdAt: sub.createdAt,
        authoritativeAttempt: sub.authoritativeAttempt,
      };
    });

    return {
      items: sanitized,
      next_cursor: nextCursor,
    };
  }
}
