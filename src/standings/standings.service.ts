import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Verdict, Prisma } from '@prisma/client';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  totalScore: number;
  totalPenalty: number;
  lastAcceptedAt: string | null;
  problemsSolved: number;
}

@Injectable()
export class StandingsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deterministically calculate standings for a single user in a contest,
   * based on authoritative attempts of their submissions.
   */
  async calculateUserStanding(
    tx: Prisma.TransactionClient,
    contestId: string,
    userId: string,
  ): Promise<{
    totalScore: number;
    totalPenalty: number;
    lastAcceptedAt: Date | null;
  }> {
    const contest = await tx.contest.findUnique({
      where: { id: contestId },
    });
    if (!contest) {
      return { totalScore: 0, totalPenalty: 0, lastAcceptedAt: null };
    }

    // Get all problems for this contest
    const problems = await tx.problem.findMany({
      where: { contestId },
      select: { id: true, points: true },
    });

    let totalScore = 0;
    let totalPenalty = 0;
    let latestAcceptedTime: Date | null = null;

    for (const prob of problems) {
      // Get all submissions by this user for this problem, ordered by created_at asc
      const submissions = await tx.submission.findMany({
        where: {
          contestId,
          problemId: prob.id,
          userId,
        },
        orderBy: { createdAt: 'asc' },
        include: {
          authoritativeAttempt: {
            include: {
              problemVersion: true,
            },
          },
        },
      });

      let wrongAttemptsBeforeAccepted = 0;
      let solved = false;
      let problemScore = 0;
      let problemPenalty = 0;

      for (const sub of submissions) {
        const attempt = sub.authoritativeAttempt;
        if (!attempt) continue;

        // Infra failures never count as wrong attempts and never affect score
        if (attempt.verdict === Verdict.INFRA_FAILURE) {
          continue;
        }

        if (attempt.verdict === Verdict.ACCEPTED) {
          solved = true;
          problemScore = attempt.problemVersion?.points ?? prob.points;
          const acceptedTime = attempt.createdAt;
          const minutesFromStart = Math.max(
            0,
            Math.floor((acceptedTime.getTime() - contest.startTime.getTime()) / 60000),
          );
          problemPenalty = wrongAttemptsBeforeAccepted * 10 + minutesFromStart;

          if (!latestAcceptedTime || acceptedTime.getTime() > latestAcceptedTime.getTime()) {
            latestAcceptedTime = acceptedTime;
          }
          // Wrong attempts after acceptance are ignored
          break;
        } else if (
          attempt.verdict === Verdict.WRONG_ANSWER ||
          attempt.verdict === Verdict.RUNTIME_ERROR ||
          attempt.verdict === Verdict.TIME_LIMIT ||
          attempt.verdict === Verdict.OUTPUT_LIMIT ||
          attempt.verdict === Verdict.COMPILE_ERROR
        ) {
          wrongAttemptsBeforeAccepted++;
        }
      }

      if (solved) {
        totalScore += problemScore;
        totalPenalty += problemPenalty;
      }
    }

    return {
      totalScore,
      totalPenalty,
      lastAcceptedAt: latestAcceptedTime,
    };
  }

  /**
   * Updates standing for a specific user in a transaction
   */
  async updateStandingForUser(
    tx: Prisma.TransactionClient,
    contestId: string,
    userId: string,
  ): Promise<void> {
    const calc = await this.calculateUserStanding(tx, contestId, userId);

    await tx.standing.upsert({
      where: {
        contestId_userId: {
          contestId,
          userId,
        },
      },
      create: {
        contestId,
        userId,
        totalScore: calc.totalScore,
        totalPenalty: calc.totalPenalty,
        lastAcceptedAt: calc.lastAcceptedAt,
      },
      update: {
        totalScore: calc.totalScore,
        totalPenalty: calc.totalPenalty,
        lastAcceptedAt: calc.lastAcceptedAt,
      },
    });
  }

  /**
   * Rebuilds the entire standings table for a contest purely from stored records
   */
  async rebuildStandings(contestId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Get all participants who have joined or submitted
      const participants = await tx.contestParticipant.findMany({
        where: { contestId },
        select: { userId: true },
      });

      const submissionUsers = await tx.submission.findMany({
        where: { contestId },
        select: { userId: true },
        distinct: ['userId'],
      });

      const allUserIds = Array.from(
        new Set([
          ...participants.map((p) => p.userId),
          ...submissionUsers.map((s) => s.userId),
        ]),
      );

      for (const userId of allUserIds) {
        await this.updateStandingForUser(tx, contestId, userId);
      }
    });
  }

  /**
   * Returns sorted leaderboard with ranks
   * Tie-break order: score desc, total penalty asc, last accepted time asc, user id asc
   */
  async getLeaderboard(contestId: string): Promise<{
    entries: LeaderboardEntry[];
    updatedAt: Date;
  }> {
    const standings = await this.prisma.standing.findMany({
      where: { contestId },
      include: {
        user: { select: { username: true } },
      },
      orderBy: [
        { totalScore: 'desc' },
        { totalPenalty: 'asc' },
        { lastAcceptedAt: { sort: 'asc', nulls: 'last' } },
        { userId: 'asc' },
      ],
    });

    let currentRank = 1;
    const entries: LeaderboardEntry[] = standings.map((s, index) => {
      // Standard competition ranking
      return {
        rank: index + 1,
        userId: s.userId,
        username: s.user.username,
        totalScore: s.totalScore,
        totalPenalty: s.totalPenalty,
        lastAcceptedAt: s.lastAcceptedAt ? s.lastAcceptedAt.toISOString() : null,
        problemsSolved: 0, // calculated if needed
      };
    });

    const latestUpdate = standings.reduce((max, s) => {
      return s.updatedAt.getTime() > max.getTime() ? s.updatedAt : max;
    }, new Date(0));

    return {
      entries,
      updatedAt: latestUpdate,
    };
  }
}
