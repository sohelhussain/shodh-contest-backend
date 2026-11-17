import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function profileQueries() {
  console.log('=== Profiling Candidate Queries on 50,000 Dataset ===');
  const contestId = 'contest-alpha-live';
  const userId = 'user-org1-participant1';
  const problemId = 'prob-two-sum';

  // 1. Leaderboard query (standings findMany with sort)
  const qLeaderboard = `
    SELECT s.*, u.username 
    FROM standings s
    JOIN users u ON s.user_id = u.id
    WHERE s.contest_id = '${contestId}'
    ORDER BY s.total_score DESC, s.total_penalty ASC, s.last_accepted_at ASC NULLS LAST, s.user_id ASC;
  `;
  const tLbStart = performance.now();
  for (let i = 0; i < 20; i++) {
    await prisma.$queryRawUnsafe(qLeaderboard);
  }
  const tLbAvg = (performance.now() - tLbStart) / 20;
  console.log(`1. Leaderboard query average time: ${tLbAvg.toFixed(3)} ms`);

  // 2. Job claim query (FOR UPDATE SKIP LOCKED)
  const qJobClaim = `
    SELECT id, attempt_id, attempts_count
    FROM jobs
    WHERE (status = 'QUEUED')
       OR (status = 'RUNNING' AND lease_expires_at < NOW())
    ORDER BY created_at ASC
    LIMIT 1;
  `;
  const tJobStart = performance.now();
  for (let i = 0; i < 20; i++) {
    await prisma.$queryRawUnsafe(qJobClaim);
  }
  const tJobAvg = (performance.now() - tJobStart) / 20;
  console.log(`2. Job claim candidate query average time: ${tJobAvg.toFixed(3)} ms`);

  // 3. User submissions by problem query (used in calculateUserStanding during standings recalculation)
  const qUserSubmissions = `
    SELECT id, contest_id, problem_id, user_id, created_at, authoritative_attempt_id
    FROM submissions
    WHERE contest_id = '${contestId}'
      AND user_id = '${userId}'
      AND problem_id = '${problemId}'
    ORDER BY created_at ASC;
  `;
  const tSubStart = performance.now();
  for (let i = 0; i < 20; i++) {
    await prisma.$queryRawUnsafe(qUserSubmissions);
  }
  const tSubAvg = (performance.now() - tSubStart) / 20;
  console.log(`3. User submissions by problem query average time: ${tSubAvg.toFixed(3)} ms`);

  // 4. Distinct submission users in rebuildStandings
  const qDistinctUsers = `
    SELECT DISTINCT user_id
    FROM submissions
    WHERE contest_id = '${contestId}';
  `;
  const tDistStart = performance.now();
  for (let i = 0; i < 20; i++) {
    await prisma.$queryRawUnsafe(qDistinctUsers);
  }
  const tDistAvg = (performance.now() - tDistStart) / 20;
  console.log(`4. Distinct users in contest query average time: ${tDistAvg.toFixed(3)} ms`);

  // 5. Submissions list endpoint with cursor pagination
  const qSubmissionsList = `
    SELECT id, contest_id, user_id, problem_id, created_at
    FROM submissions
    WHERE contest_id = '${contestId}'
    ORDER BY created_at DESC, id DESC
    LIMIT 50;
  `;
  const tListStart = performance.now();
  for (let i = 0; i < 20; i++) {
    await prisma.$queryRawUnsafe(qSubmissionsList);
  }
  const tListAvg = (performance.now() - tListStart) / 20;
  console.log(`5. Submissions list pagination average time: ${tListAvg.toFixed(3)} ms`);

  await prisma.$disconnect();
}

profileQueries().catch(console.error);
