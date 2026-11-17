import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

export const SEED_DATA = {
  orgs: {
    alpha: { id: 'org-alpha', name: 'Alpha Algorithms' },
    beta: { id: 'org-beta', name: 'Beta Byte' },
  },
  users: {
    alphaOrganizer: { id: 'user-org1-organizer', username: 'alpha_admin', email: 'admin@alpha.org' },
    alphaParticipant1: { id: 'user-org1-participant1', username: 'alice_coder', email: 'alice@alpha.org' },
    alphaParticipant2: { id: 'user-org1-participant2', username: 'bob_coder', email: 'bob@alpha.org' },
    betaOrganizer: { id: 'user-org2-organizer', username: 'beta_admin', email: 'admin@beta.org' },
    betaParticipant1: { id: 'user-org2-participant1', username: 'charlie_coder', email: 'charlie@beta.org' },
  },
  contests: {
    alphaLive: {
      id: 'contest-alpha-live',
      orgId: 'org-alpha',
      title: 'Alpha Weekly Challenge #1',
      description: 'The weekly competitive programming contest for Alpha Algorithms.',
      startTime: new Date(Date.now() - 3600 * 1000), // started 1h ago
      endTime: new Date(Date.now() + 24 * 3600 * 1000), // ends in 24h
    },
    betaFuture: {
      id: 'contest-beta-future',
      orgId: 'org-beta',
      title: 'Beta Masters Contest',
      description: 'Exclusive Beta Byte Masters.',
      startTime: new Date(Date.now() + 2 * 3600 * 1000), // starts in 2h
      endTime: new Date(Date.now() + 6 * 3600 * 1000),
    },
  },
  problems: {
    twoSum: {
      id: 'prob-two-sum',
      contestId: 'contest-alpha-live',
      orgId: 'org-alpha',
      title: 'Sum of Two Numbers',
      description: 'Read two integers a and b from stdin and print their sum.',
      points: 100,
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      versionId: 'pv-two-sum-1',
      suiteId: 'ts-two-sum-1',
      testCases: [
        { id: 'tc-ts-1', input: '1 2\n', expectedOutput: '3\n', isHidden: false, orderIndex: 0 },
        { id: 'tc-ts-2', input: '10 20\n', expectedOutput: '30\n', isHidden: false, orderIndex: 1 },
        { id: 'tc-ts-3', input: '-5 15\n', expectedOutput: '10\n', isHidden: true, orderIndex: 2 },
        { id: 'tc-ts-4', input: '1000000 2000000\n', expectedOutput: '3000000\n', isHidden: true, orderIndex: 3 },
      ],
    },
    palindrome: {
      id: 'prob-palindrome',
      contestId: 'contest-alpha-live',
      orgId: 'org-alpha',
      title: 'Palindrome Checker',
      description: 'Read a single line string. Output YES if palindrome, NO otherwise.',
      points: 200,
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      versionId: 'pv-pal-1',
      suiteId: 'ts-pal-1',
      testCases: [
        { id: 'tc-pal-1', input: 'racecar\n', expectedOutput: 'YES\n', isHidden: false, orderIndex: 0 },
        { id: 'tc-pal-2', input: 'hello\n', expectedOutput: 'NO\n', isHidden: false, orderIndex: 1 },
        { id: 'tc-pal-3', input: 'madam\n', expectedOutput: 'YES\n', isHidden: true, orderIndex: 2 },
        { id: 'tc-pal-4', input: 'antigravity\n', expectedOutput: 'NO\n', isHidden: true, orderIndex: 3 },
      ],
    },
    maxElement: {
      id: 'prob-max-element',
      contestId: 'contest-alpha-live',
      orgId: 'org-alpha',
      title: 'Maximum Element',
      description: 'Read integers separated by space. Output the maximum integer.',
      points: 150,
      timeLimitMs: 2000,
      memoryLimitMb: 128,
      versionId: 'pv-max-1',
      suiteId: 'ts-max-1',
      testCases: [
        { id: 'tc-max-1', input: '3 1 4 1 5 9 2 6\n', expectedOutput: '9\n', isHidden: false, orderIndex: 0 },
        { id: 'tc-max-2', input: '-10 -20 -5 -30\n', expectedOutput: '-5\n', isHidden: true, orderIndex: 1 },
      ],
    },
  },
  samplePrograms: {
    correctTwoSum: 'import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)\n',
    wrongAnswer: 'print(0)\n',
    runtimeError: 'import sys\nraise RuntimeError("Deliberate runtime crash")\n',
    infiniteLoop: 'import time\nwhile True:\n    pass\n',
    excessiveOutput: 'print("A" * 100000)\n',
  },
};

export async function seed() {
  console.log('--- Starting deterministic database seed ---');

  // Clean existing tables in reverse dependency order
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE 
    attempt_test_results, jobs, attempts, submissions, standings,
    test_cases, test_suites, problem_versions, problems,
    contest_participants, contests, memberships, organizations, users 
    CASCADE;`);

  // Organizations
  for (const org of Object.values(SEED_DATA.orgs)) {
    await prisma.organization.create({
      data: org,
    });
  }

  // Users
  for (const user of Object.values(SEED_DATA.users)) {
    await prisma.user.create({
      data: user,
    });
  }

  // Memberships
  await prisma.membership.createMany({
    data: [
      { userId: SEED_DATA.users.alphaOrganizer.id, organizationId: SEED_DATA.orgs.alpha.id, role: Role.ORGANIZER },
      { userId: SEED_DATA.users.alphaParticipant1.id, organizationId: SEED_DATA.orgs.alpha.id, role: Role.PARTICIPANT },
      { userId: SEED_DATA.users.alphaParticipant2.id, organizationId: SEED_DATA.orgs.alpha.id, role: Role.PARTICIPANT },
      { userId: SEED_DATA.users.betaOrganizer.id, organizationId: SEED_DATA.orgs.beta.id, role: Role.ORGANIZER },
      { userId: SEED_DATA.users.betaParticipant1.id, organizationId: SEED_DATA.orgs.beta.id, role: Role.PARTICIPANT },
    ],
  });

  // Contests
  for (const contest of Object.values(SEED_DATA.contests)) {
    await prisma.contest.create({
      data: {
        id: contest.id,
        organizationId: contest.orgId,
        title: contest.title,
        description: contest.description,
        startTime: contest.startTime,
        endTime: contest.endTime,
      },
    });
  }

  // Participants & Standings
  const participantsData = [
    { contestId: SEED_DATA.contests.alphaLive.id, userId: SEED_DATA.users.alphaParticipant1.id },
    { contestId: SEED_DATA.contests.alphaLive.id, userId: SEED_DATA.users.alphaParticipant2.id },
    { contestId: SEED_DATA.contests.betaFuture.id, userId: SEED_DATA.users.betaParticipant1.id },
  ];

  await prisma.contestParticipant.createMany({
    data: participantsData,
  });

  await prisma.standing.createMany({
    data: participantsData.map((p) => ({
      contestId: p.contestId,
      userId: p.userId,
      totalScore: 0,
      totalPenalty: 0,
    })),
  });

  // Problems + Versions + Test Suites + Test Cases
  for (const prob of Object.values(SEED_DATA.problems)) {
    await prisma.problem.create({
      data: {
        id: prob.id,
        organizationId: prob.orgId,
        contestId: prob.contestId,
        title: prob.title,
        description: prob.description,
        points: prob.points,
        timeLimitMs: prob.timeLimitMs,
        memoryLimitMb: prob.memoryLimitMb,
      },
    });

    await prisma.problemVersion.create({
      data: {
        id: prob.versionId,
        problemId: prob.id,
        versionNumber: 1,
        title: prob.title,
        description: prob.description,
        points: prob.points,
        timeLimitMs: prob.timeLimitMs,
        memoryLimitMb: prob.memoryLimitMb,
      },
    });

    await prisma.testSuite.create({
      data: {
        id: prob.suiteId,
        problemId: prob.id,
        versionNumber: 1,
        isActive: true,
      },
    });

    for (const tc of prob.testCases) {
      await prisma.testCase.create({
        data: {
          id: tc.id,
          testSuiteId: prob.suiteId,
          input: tc.input,
          expectedOutput: tc.expectedOutput,
          isHidden: tc.isHidden,
          orderIndex: tc.orderIndex,
        },
      });
    }
  }

  console.log('--- Seed complete successfully ---');
}

if (require.main === module) {
  seed()
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
