-- Partial index for job claiming
CREATE INDEX IF NOT EXISTS "idx_jobs_claimable" ON "jobs" ("status", "lease_expires_at") WHERE "status" = 'QUEUED' OR "status" = 'RUNNING';
