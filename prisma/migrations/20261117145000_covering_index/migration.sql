-- Drop legacy non-covering composite index if present
DROP INDEX IF EXISTS "idx_submissions_perf_tuning";

-- Create covering index for submissions lookup during standings recalculation
CREATE INDEX IF NOT EXISTS "idx_submissions_covering" 
ON "submissions" ("contest_id", "user_id", "problem_id", "created_at" ASC)
INCLUDE ("id", "authoritative_attempt_id");
