import { IRunner } from './runner.interface';
import { DockerRunner } from './docker-runner';
import { MockRunner } from './mock-runner';

export class RunnerFactory {
  static getRunner(mode?: string): IRunner {
    const runnerMode = mode || process.env.RUNNER_MODE || 'docker';
    if (runnerMode === 'docker') {
      return new DockerRunner();
    }
    return new MockRunner();
  }
}
