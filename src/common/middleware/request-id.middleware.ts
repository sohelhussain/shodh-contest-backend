import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { appLogger } from '../logging/logger';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
    (req as any).requestId = requestId;
    res.setHeader('x-request-id', requestId);

    const start = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      appLogger.info({
        request_id: requestId,
        method: req.method,
        url: req.originalUrl || req.url,
        statusCode: res.statusCode,
        duration_ms: durationMs,
      }, 'HTTP Request Completed');
    });

    next();
  }
}
