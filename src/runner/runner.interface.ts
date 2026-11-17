import { Verdict } from '@prisma/client';

export interface ResourceLimits {
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  wallTimeMs: number;
  outputLimitBytes: number;
}

export interface TestCaseRun {
  id: string;
  input: string;
  expectedOutput: string;
  isHidden: boolean;
  orderIndex?: number;
}

export interface TestCaseResult {
  testCaseId: string;
  passed: boolean;
  verdict: Verdict;
  executionTimeMs: number;
  output?: string;
  error?: string;
}

export interface RunResult {
  verdict: Verdict;
  score: number;
  executionTimeMs: number;
  testResults: TestCaseResult[];
  executionMode: 'docker' | 'mock';
}

export interface IRunner {
  readonly executionMode: 'docker' | 'mock';
  run(
    code: string,
    testCases: TestCaseRun[],
    limits: ResourceLimits,
    problemPoints: number,
  ): Promise<RunResult>;
}
