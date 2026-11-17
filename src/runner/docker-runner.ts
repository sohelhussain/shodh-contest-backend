import { IRunner, ResourceLimits, TestCaseRun, RunResult, TestCaseResult } from './runner.interface';
import { Verdict } from '@prisma/client';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, execSync } from 'child_process';
import { appLogger } from '../common/logging/logger';

export class DockerRunner implements IRunner {
  readonly executionMode = 'docker' as const;

  async run(
    code: string,
    testCases: TestCaseRun[],
    limits: ResourceLimits,
    problemPoints: number,
  ): Promise<RunResult> {
    const logger = appLogger.child({ execution_mode: 'docker' });

    // Failpoint: runner_crash
    if (process.env.FAILPOINT === 'runner_crash') {
      logger.error('Injected failpoint: runner_crash triggered');
      return {
        verdict: Verdict.INFRA_FAILURE,
        score: 0,
        executionTimeMs: 0,
        testResults: [],
        executionMode: 'docker',
      };
    }

    const baseTmp = process.env.SANDBOX_TMP_DIR || path.join(process.cwd(), 'tmp', 'sandbox-runs');
    if (!fs.existsSync(baseTmp)) {
      fs.mkdirSync(baseTmp, { recursive: true, mode: 0o777 });
    }
    const tempDir = fs.mkdtempSync(path.join(baseTmp, 'shodh-run-'));
    fs.chmodSync(tempDir, 0o777);

    const scriptPath = path.join(tempDir, 'solution.py');
    fs.writeFileSync(scriptPath, code, { mode: 0o666 });

    const results: TestCaseResult[] = [];
    let overallVerdict: Verdict = Verdict.ACCEPTED;
    let totalExecutionTimeMs = 0;

    try {
      for (const tc of testCases) {
        const tcResult = await this.executeTestCase(tempDir, tc, limits);
        results.push(tcResult);
        totalExecutionTimeMs += tcResult.executionTimeMs;

        if (!tcResult.passed) {
          overallVerdict = tcResult.verdict;
          break; // First failing test case determines the verdict
        }
      }

      const score = overallVerdict === Verdict.ACCEPTED ? problemPoints : 0;
      return {
        verdict: overallVerdict,
        score,
        executionTimeMs: totalExecutionTimeMs,
        testResults: results,
        executionMode: 'docker',
      };
    } catch (err: any) {
      logger.error({ err: err.message }, 'Docker runner infrastructure failure');
      return {
        verdict: Verdict.INFRA_FAILURE,
        score: 0,
        executionTimeMs: 0,
        testResults: [],
        executionMode: 'docker',
      };
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup error
      }
    }
  }

  private async executeTestCase(
    tempDir: string,
    tc: TestCaseRun,
    limits: ResourceLimits,
  ): Promise<TestCaseResult> {
    const containerName = `shodh-sandbox-${crypto.randomBytes(6).toString('hex')}`;
    const startTime = Date.now();

    return new Promise<TestCaseResult>((resolve) => {
      let isTimedOut = false;
      let outputLimitExceeded = false;
      let stdoutBuffer = '';
      let stderrBuffer = '';

      const runnerImage = process.env.RUNNER_IMAGE || 'shodh-python-runner:1';

      const args = [
        'run',
        '-i',
        '--name', containerName,
        '--network', 'none',
        '--memory', `${limits.memoryMb}m`,
        '--memory-swap', `${limits.memoryMb}m`,
        '--pids-limit', `${limits.pidsLimit}`,
        '--cpus', `${limits.cpus}`,
        '--read-only',
        '--user', '65534:65534',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
        '-v', `${tempDir}:/sandbox:ro`,
        runnerImage,
        'python3', '-u', '/sandbox/solution.py',
      ];

      let child: any = null;
      let timeoutTimer: NodeJS.Timeout | null = null;

      try {
        child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err: any) {
        return resolve({
          testCaseId: tc.id,
          passed: false,
          verdict: Verdict.INFRA_FAILURE,
          executionTimeMs: Date.now() - startTime,
          error: `Failed to spawn docker process: ${err.message}`,
        });
      }

      timeoutTimer = setTimeout(() => {
        isTimedOut = true;
        try {
          child.kill('SIGKILL');
        } catch (_) {}
        try {
          execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
        } catch (_) {}
      }, limits.wallTimeMs);

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutBuffer.length + chunk.length > limits.outputLimitBytes) {
          outputLimitExceeded = true;
          const allowed = limits.outputLimitBytes - stdoutBuffer.length;
          if (allowed > 0) {
            stdoutBuffer += chunk.toString('utf-8', 0, allowed);
          }
          try {
            child.kill('SIGKILL');
          } catch (_) {}
        } else {
          stdoutBuffer += chunk.toString('utf-8');
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBuffer.length < 4096) {
          stderrBuffer += chunk.toString('utf-8');
        }
      });

      // Write test case input to stdin and close
      if (tc.input) {
        child.stdin.write(tc.input);
      }
      child.stdin.end();

      child.on('close', (code: number | null) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const executionTimeMs = Date.now() - startTime;

        // Ensure container cleanup
        try {
          execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
        } catch (_) {}

        if (isTimedOut) {
          return resolve({
            testCaseId: tc.id,
            passed: false,
            verdict: Verdict.TIME_LIMIT,
            executionTimeMs: limits.wallTimeMs,
            error: 'Time Limit Exceeded',
          });
        }

        if (outputLimitExceeded) {
          return resolve({
            testCaseId: tc.id,
            passed: false,
            verdict: Verdict.OUTPUT_LIMIT,
            executionTimeMs,
            error: 'Output Limit Exceeded',
          });
        }

        if (code !== 0) {
          // If code is 137 (SIGKILL by Docker OOM killer) or stderr indicates out of memory
          const isOom = code === 137 || stderrBuffer.includes('Killed') || stderrBuffer.includes('MemoryError');
          const isPidsLimit = stderrBuffer.includes('BlockingIOError') || stderrBuffer.includes('Resource temporarily unavailable');
          return resolve({
            testCaseId: tc.id,
            passed: false,
            verdict: Verdict.RUNTIME_ERROR,
            executionTimeMs,
            error: isOom
              ? 'Memory limit exceeded (OOM killed)'
              : (stderrBuffer.trim() || `Process exited with code ${code}`),
          });
        }

        // Compare stdout with expected output (normalizing whitespace)
        const actualTrimmed = stdoutBuffer.trim();
        const expectedTrimmed = tc.expectedOutput.trim();
        const passed = actualTrimmed === expectedTrimmed;

        return resolve({
          testCaseId: tc.id,
          passed,
          verdict: passed ? Verdict.ACCEPTED : Verdict.WRONG_ANSWER,
          executionTimeMs,
          output: stdoutBuffer,
          error: passed ? undefined : 'Output mismatch',
        });
      });

      child.on('error', (err: any) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        try {
          execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
        } catch (_) {}
        return resolve({
          testCaseId: tc.id,
          passed: false,
          verdict: Verdict.INFRA_FAILURE,
          executionTimeMs: Date.now() - startTime,
          error: `Docker error: ${err.message}`,
        });
      });
    });
  }
}
