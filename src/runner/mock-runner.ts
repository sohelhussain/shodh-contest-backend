import { IRunner, ResourceLimits, TestCaseRun, RunResult, TestCaseResult } from './runner.interface';
import { Verdict } from '@prisma/client';
import { appLogger } from '../common/logging/logger';

export class MockRunner implements IRunner {
  readonly executionMode = 'mock' as const;

  async run(
    code: string,
    testCases: TestCaseRun[],
    limits: ResourceLimits,
    problemPoints: number,
  ): Promise<RunResult> {
    const logger = appLogger.child({ execution_mode: 'mock' });

    // Failpoint: runner_crash
    if (process.env.FAILPOINT === 'runner_crash') {
      logger.error('Injected failpoint: runner_crash triggered');
      return {
        verdict: Verdict.INFRA_FAILURE,
        score: 0,
        executionTimeMs: 0,
        testResults: [],
        executionMode: 'mock',
      };
    }

    // Check code directives for simulated verdicts
    let simulatedVerdict: Verdict | null = null;
    if (code.includes('# mock: TIME_LIMIT') || code.includes('while True:')) {
      simulatedVerdict = Verdict.TIME_LIMIT;
    } else if (code.includes('# mock: RUNTIME_ERROR') || code.includes('RuntimeError')) {
      simulatedVerdict = Verdict.RUNTIME_ERROR;
    } else if (code.includes('# mock: OUTPUT_LIMIT') || code.includes('print("A" * 100000)')) {
      simulatedVerdict = Verdict.OUTPUT_LIMIT;
    } else if (code.includes('# mock: WRONG_ANSWER') || code.includes('print(0)')) {
      simulatedVerdict = Verdict.WRONG_ANSWER;
    } else if (code.includes('# mock: INFRA_FAILURE')) {
      simulatedVerdict = Verdict.INFRA_FAILURE;
    }

    const results: TestCaseResult[] = [];
    let overallVerdict: Verdict = Verdict.ACCEPTED;
    let totalTime = 15;

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      if (simulatedVerdict && simulatedVerdict !== Verdict.ACCEPTED) {
        // Trigger simulated failure on this or specified test case
        results.push({
          testCaseId: tc.id,
          passed: false,
          verdict: simulatedVerdict,
          executionTimeMs: simulatedVerdict === Verdict.TIME_LIMIT ? limits.wallTimeMs : 10,
          error: `Simulated ${simulatedVerdict}`,
        });
        overallVerdict = simulatedVerdict;
        break;
      }

      // Default mock logic: simulate two-sum and palindrome logic or exact match
      let passed = true;
      let output = tc.expectedOutput;

      if (code.includes('a + b')) {
        const parts = tc.input.trim().split(/\s+/).map(Number);
        if (parts.length >= 2) {
          output = `${parts[0] + parts[1]}\n`;
          passed = output.trim() === tc.expectedOutput.trim();
        }
      }

      results.push({
        testCaseId: tc.id,
        passed,
        verdict: passed ? Verdict.ACCEPTED : Verdict.WRONG_ANSWER,
        executionTimeMs: 15,
        output,
      });

      if (!passed) {
        overallVerdict = Verdict.WRONG_ANSWER;
        break;
      }
    }

    const score = overallVerdict === Verdict.ACCEPTED ? problemPoints : 0;
    return {
      verdict: overallVerdict,
      score,
      executionTimeMs: totalTime * results.length,
      testResults: results,
      executionMode: 'mock',
    };
  }
}
