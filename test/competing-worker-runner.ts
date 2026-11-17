import { PrismaClient, JobStatus } from '@prisma/client';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config();

const workerId = process.argv[2] || `worker-${process.pid}`;
const prisma = new PrismaClient();
const leaseSeconds = 30;

process.on('message', async (msg: any) => {
  if (msg && msg.action === 'claim') {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const jobs: any[] = await tx.$queryRawUnsafe(`
          SELECT id, attempt_id, attempts_count
          FROM jobs
          WHERE (status = 'QUEUED')
             OR (status = 'RUNNING' AND lease_expires_at < NOW())
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED;
        `);

        if (!jobs || jobs.length === 0) {
          return null;
        }

        const candidate = jobs[0];
        const leaseToken = crypto.randomUUID();
        const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000);

        await tx.job.update({
          where: { id: candidate.id },
          data: {
            status: JobStatus.RUNNING,
            leaseToken,
            leaseExpiresAt,
            workerId,
            attemptsCount: candidate.attempts_count + 1,
          },
        });

        return {
          workerId,
          jobId: candidate.id,
          attemptId: candidate.attempt_id,
          leaseToken,
        };
      });

      if (process.send) {
        process.send({ success: true, result });
      }
    } catch (err: any) {
      if (process.send) {
        process.send({ success: false, error: err.message });
      }
    } finally {
      await prisma.$disconnect();
      process.exit(0);
    }
  }
});

// Signal to parent that child process is ready and connected to DB
if (process.send) {
  process.send({ ready: true, workerId });
}
