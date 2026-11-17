import pino from 'pino';
import * as crypto from 'crypto';

export const appLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function createStructuredLogger(context: {
  requestId?: string;
  submissionId?: string;
  attemptId?: string;
  workerId?: string;
  executionMode?: 'docker' | 'mock';
}) {
  return appLogger.child(context);
}
