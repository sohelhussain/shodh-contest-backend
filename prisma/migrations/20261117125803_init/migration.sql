-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ORGANIZER', 'PARTICIPANT');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('ACCEPTED', 'WRONG_ANSWER', 'RUNTIME_ERROR', 'TIME_LIMIT', 'OUTPUT_LIMIT', 'COMPILE_ERROR', 'INFRA_FAILURE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contests" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "start_time" TIMESTAMP(3) NOT NULL,
    "end_time" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contest_participants" (
    "id" TEXT NOT NULL,
    "contest_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contest_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "problems" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contest_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 100,
    "time_limit_ms" INTEGER NOT NULL DEFAULT 2000,
    "memory_limit_mb" INTEGER NOT NULL DEFAULT 128,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "problems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "problem_versions" (
    "id" TEXT NOT NULL,
    "problem_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "time_limit_ms" INTEGER NOT NULL,
    "memory_limit_mb" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "problem_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_suites" (
    "id" TEXT NOT NULL,
    "problem_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_suites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_cases" (
    "id" TEXT NOT NULL,
    "test_suite_id" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "expected_output" TEXT NOT NULL,
    "is_hidden" BOOLEAN NOT NULL DEFAULT false,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" TEXT NOT NULL,
    "contest_id" TEXT NOT NULL,
    "problem_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'python',
    "runtime_config" JSONB NOT NULL,
    "problem_version_id" TEXT NOT NULL,
    "suite_version_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "authoritative_attempt_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempts" (
    "id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "problem_version_id" TEXT NOT NULL,
    "suite_version_id" TEXT NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'QUEUED',
    "verdict" "Verdict",
    "score" INTEGER NOT NULL DEFAULT 0,
    "lease_token" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "worker_id" TEXT,
    "execution_time_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempt_test_results" (
    "id" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "test_case_id" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "execution_time_ms" INTEGER NOT NULL DEFAULT 0,
    "output" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attempt_test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts_count" INTEGER NOT NULL DEFAULT 0,
    "lease_token" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "worker_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standings" (
    "id" TEXT NOT NULL,
    "contest_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "total_score" INTEGER NOT NULL DEFAULT 0,
    "total_penalty" INTEGER NOT NULL DEFAULT 0,
    "last_accepted_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "standings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE INDEX "memberships_organization_id_idx" ON "memberships"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_organization_id_key" ON "memberships"("user_id", "organization_id");

-- CreateIndex
CREATE INDEX "contests_organization_id_idx" ON "contests"("organization_id");

-- CreateIndex
CREATE INDEX "contest_participants_contest_id_idx" ON "contest_participants"("contest_id");

-- CreateIndex
CREATE INDEX "contest_participants_user_id_idx" ON "contest_participants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "contest_participants_contest_id_user_id_key" ON "contest_participants"("contest_id", "user_id");

-- CreateIndex
CREATE INDEX "problems_contest_id_idx" ON "problems"("contest_id");

-- CreateIndex
CREATE INDEX "problems_organization_id_idx" ON "problems"("organization_id");

-- CreateIndex
CREATE INDEX "problem_versions_problem_id_idx" ON "problem_versions"("problem_id");

-- CreateIndex
CREATE UNIQUE INDEX "problem_versions_problem_id_version_number_key" ON "problem_versions"("problem_id", "version_number");

-- CreateIndex
CREATE INDEX "test_suites_problem_id_idx" ON "test_suites"("problem_id");

-- CreateIndex
CREATE UNIQUE INDEX "test_suites_problem_id_version_number_key" ON "test_suites"("problem_id", "version_number");

-- CreateIndex
CREATE INDEX "test_cases_test_suite_id_idx" ON "test_cases"("test_suite_id");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_authoritative_attempt_id_key" ON "submissions"("authoritative_attempt_id");

-- CreateIndex
CREATE INDEX "submissions_contest_id_user_id_idx" ON "submissions"("contest_id", "user_id");

-- CreateIndex
CREATE INDEX "submissions_problem_id_idx" ON "submissions"("problem_id");

-- CreateIndex
CREATE INDEX "submissions_created_at_id_idx" ON "submissions"("created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_contest_id_user_id_idempotency_key_key" ON "submissions"("contest_id", "user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "attempts_submission_id_idx" ON "attempts"("submission_id");

-- CreateIndex
CREATE INDEX "attempts_status_lease_expires_at_idx" ON "attempts"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "attempts_submission_id_attempt_no_key" ON "attempts"("submission_id", "attempt_no");

-- CreateIndex
CREATE INDEX "attempt_test_results_attempt_id_idx" ON "attempt_test_results"("attempt_id");

-- CreateIndex
CREATE INDEX "attempt_test_results_test_case_id_idx" ON "attempt_test_results"("test_case_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_attempt_id_key" ON "jobs"("attempt_id");

-- CreateIndex
CREATE INDEX "jobs_status_lease_expires_at_idx" ON "jobs"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "standings_contest_id_total_score_total_penalty_last_accepte_idx" ON "standings"("contest_id", "total_score" DESC, "total_penalty" ASC, "last_accepted_at" ASC, "user_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "standings_contest_id_user_id_key" ON "standings"("contest_id", "user_id");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contests" ADD CONSTRAINT "contests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contest_participants" ADD CONSTRAINT "contest_participants_contest_id_fkey" FOREIGN KEY ("contest_id") REFERENCES "contests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contest_participants" ADD CONSTRAINT "contest_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problems" ADD CONSTRAINT "problems_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problems" ADD CONSTRAINT "problems_contest_id_fkey" FOREIGN KEY ("contest_id") REFERENCES "contests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_versions" ADD CONSTRAINT "problem_versions_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_suites" ADD CONSTRAINT "test_suites_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_test_suite_id_fkey" FOREIGN KEY ("test_suite_id") REFERENCES "test_suites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_contest_id_fkey" FOREIGN KEY ("contest_id") REFERENCES "contests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_problem_version_id_fkey" FOREIGN KEY ("problem_version_id") REFERENCES "problem_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_suite_version_id_fkey" FOREIGN KEY ("suite_version_id") REFERENCES "test_suites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_authoritative_attempt_id_fkey" FOREIGN KEY ("authoritative_attempt_id") REFERENCES "attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_problem_version_id_fkey" FOREIGN KEY ("problem_version_id") REFERENCES "problem_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_suite_version_id_fkey" FOREIGN KEY ("suite_version_id") REFERENCES "test_suites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_test_results" ADD CONSTRAINT "attempt_test_results_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_test_results" ADD CONSTRAINT "attempt_test_results_test_case_id_fkey" FOREIGN KEY ("test_case_id") REFERENCES "test_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standings" ADD CONSTRAINT "standings_contest_id_fkey" FOREIGN KEY ("contest_id") REFERENCES "contests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standings" ADD CONSTRAINT "standings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
