import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function seed50k() {
  console.log('=== Starting fast bulk seed of 50,000 Submissions ===');
  const startTime = Date.now();

  const contestId = 'contest-alpha-live';
  const users = [
    'user-org1-participant1',
    'user-org1-participant2',
    'user-org2-participant1',
  ];
  const problems = [
    { problemId: 'prob-two-sum', versionId: 'pv-two-sum-1', suiteId: 'ts-two-sum-1' },
    { problemId: 'prob-palindrome', versionId: 'pv-pal-1', suiteId: 'ts-pal-1' },
    { problemId: 'prob-max-element', versionId: 'pv-max-1', suiteId: 'ts-max-1' },
  ];

  const TOTAL_ROWS = 50000;
  const BATCH_SIZE = 5000;
  const now = Date.now();

  let inserted = 0;
  for (let b = 0; b < TOTAL_ROWS / BATCH_SIZE; b++) {
    const rows = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const idx = b * BATCH_SIZE + i;
      const prob = problems[idx % problems.length];
      const user = users[idx % users.length];

      rows.push({
        id: `bulk-sub-${idx}`,
        contestId,
        problemId: prob.problemId,
        userId: user,
        code: `print(${idx})`,
        language: 'python',
        runtimeConfig: {},
        problemVersionId: prob.versionId,
        suiteVersionId: prob.suiteId,
        idempotencyKey: `bulk-key-${idx}`,
        requestHash: `bulk-hash-${idx}`,
        createdAt: new Date(now - (TOTAL_ROWS - idx) * 50),
      });
    }

    await prisma.submission.createMany({
      data: rows,
      skipDuplicates: true,
    });
    inserted += rows.length;
    console.log(`Seeded ${inserted} / ${TOTAL_ROWS} submissions (${((Date.now() - startTime) / 1000).toFixed(1)}s)...`);
  }

  const count = await prisma.submission.count();
  console.log(`=== Fast bulk seed complete: ${count} total submissions in database (${((Date.now() - startTime) / 1000).toFixed(2)}s) ===`);
  await prisma.$disconnect();
}

seed50k().catch((e) => {
  console.error('Seeding 50k failed:', e);
  process.exit(1);
});
