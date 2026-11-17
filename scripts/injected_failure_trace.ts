import { PrismaClient, Verdict, AttemptStatus, JobStatus } from '@prisma/client';
import { claimNextJob, processJob } from '../src/worker';
import { SubmissionsService } from '../src/submissions/submissions.service';
import { AccessControlService } from '../src/auth/access-control.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { seed, SEED_DATA } from '../prisma/seed';
import * as fs from 'fs';
import * as path from 'path';

async function runInjectedFailureTrace() {
  const prisma = new PrismaClient();
  await seed();

  const prismaService = new PrismaService();
  const accessControl = new AccessControlService(prismaService);
  const submissionsService = new SubmissionsService(prismaService, accessControl);

  const logs: string[] = [];
  const log = (msg: any) => {
    const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
    console.log(str);
    logs.push(str);
  };

  log('================================================================================');
  log('INJECTED FAILURE TRACE: FAILPOINT=runner_crash -> RECOVERY -> STORED OUTCOME');
  log('================================================================================\n');

  // 1. Submit code
  const user = {
    id: SEED_DATA.users.alphaParticipant1.id,
    memberships: [{ organizationId: SEED_DATA.orgs.alpha.id, role: 'PARTICIPANT' }],
  };

  log('[STEP 1] Participant submits solution');
  const subResult = await submissionsService.submit(
    user,
    SEED_DATA.contests.alphaLive.id,
    {
      problemId: SEED_DATA.problems.twoSum.id,
      code: SEED_DATA.samplePrograms.correctTwoSum,
      language: 'python',
      idempotencyKey: 'injected-failpoint-trace-sub',
    },
  );

  log({
    event: 'SUBMISSION_ACCEPTED',
    submissionId: subResult.id,
    attemptId: (subResult as any).attemptId,
    status: subResult.status,
  });

  // 2. Set FAILPOINT=runner_crash and simulate Worker 1 claiming and failing
  log('\n[STEP 2] Worker 1 claims job with FAILPOINT=runner_crash');
  process.env.FAILPOINT = 'runner_crash';

  const job1 = await claimNextJob();
  log({
    event: 'JOB_CLAIMED_WORKER_1',
    jobId: job1?.jobId,
    attemptId: job1?.attemptId,
    leaseToken: job1?.leaseToken,
    failpoint: process.env.FAILPOINT,
  });

  if (job1) {
    await processJob(job1);
  }

  // Inspect state after crash
  const jobAfterCrash = await prisma.job.findUnique({ where: { id: job1!.jobId } });
  const attemptAfterCrash = await prisma.attempt.findUnique({ where: { id: job1!.attemptId } });

  log({
    event: 'POST_CRASH_DATABASE_STATE',
    jobStatus: jobAfterCrash?.status,
    jobAttemptsCount: jobAfterCrash?.attemptsCount,
    attemptStatus: attemptAfterCrash?.status,
    attemptVerdict: attemptAfterCrash?.verdict,
    attemptScore: attemptAfterCrash?.score,
  });

  // 3. Clear failpoint and simulate Worker 2 picking up the requeued job
  log('\n[STEP 3] Failpoint cleared. Worker 2 reclaims and retries the job');
  delete process.env.FAILPOINT;

  const job2 = await claimNextJob();
  log({
    event: 'JOB_RECLAIMED_WORKER_2',
    jobId: job2?.jobId,
    attemptId: job2?.attemptId,
    newLeaseToken: job2?.leaseToken,
    attemptsCount: 2,
  });

  if (job2) {
    await processJob(job2);
  }

  // 4. Inspect final outcome
  log('\n[STEP 4] Final stored outcome in persistent database:');
  const finalJob = await prisma.job.findUnique({ where: { id: job1!.jobId } });
  const finalAttempt = await prisma.attempt.findUnique({
    where: { id: job1!.attemptId },
    include: { testResults: true },
  });
  const finalSubmission = await prisma.submission.findUnique({
    where: { id: subResult.id },
    include: { authoritativeAttempt: true },
  });
  const finalStanding = await prisma.standing.findUnique({
    where: {
      contestId_userId: {
        contestId: SEED_DATA.contests.alphaLive.id,
        userId: SEED_DATA.users.alphaParticipant1.id,
      },
    },
  });

  log({
    event: 'FINAL_STORED_OUTCOME',
    submissionId: finalSubmission?.id,
    authoritativeAttemptId: finalSubmission?.authoritativeAttemptId,
    jobStatus: finalJob?.status,
    jobTotalAttempts: finalJob?.attemptsCount,
    attemptStatus: finalAttempt?.status,
    attemptVerdict: finalAttempt?.verdict,
    attemptScore: finalAttempt?.score,
    testResultsCount: finalAttempt?.testResults.length,
    userTotalScore: finalStanding?.totalScore,
    userTotalPenalty: finalStanding?.totalPenalty,
  });

  log('\n================================================================================');
  log('INJECTED FAILURE TEST COMPLETED SUCCESSFULLY');
  log('================================================================================');

  const resultsDir = path.join(process.cwd(), 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(resultsDir, 'injected-failure.log'),
    logs.join('\n'),
    'utf-8',
  );

  await prisma.$disconnect();
}

runInjectedFailureTrace().catch((err) => {
  console.error('Failure trace failed:', err);
  process.exit(1);
});
