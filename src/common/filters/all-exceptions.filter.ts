import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { BusinessRuleException, InfrastructureException } from '../errors/exceptions';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof BusinessRuleException) {
      const res = exception.getResponse() as any;
      return response.status(exception.getStatus()).json(res);
    }

    if (exception instanceof InfrastructureException) {
      const res = exception.getResponse() as any;
      return response.status(exception.getStatus()).json(res);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse() as any;

      // Validation errors from NestJS ValidationPipe (400 Bad Request)
      if (status === HttpStatus.BAD_REQUEST) {
        const details = Array.isArray(res?.message) ? res.message : [res?.message || 'Validation error'];
        return response.status(HttpStatus.BAD_REQUEST).json({
          error_type: 'VALIDATION_ERROR',
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Validation failed',
          details,
        });
      }

      // 4xx HTTP exceptions (e.g. 403, 404, 409)
      if (status >= 400 && status < 500) {
        return response.status(status).json({
          error_type: 'BUSINESS_RULE_ERROR',
          statusCode: status,
          code: res?.code || (status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : status === 409 ? 'CONFLICT' : 'BUSINESS_ERROR'),
          message: typeof res === 'string' ? res : res?.message || 'Business rule violation',
        });
      }

      // 5xx HTTP exceptions
      return response.status(status).json({
        error_type: 'INFRASTRUCTURE_ERROR',
        statusCode: status,
        message: res?.message || 'Infrastructure error',
      });
    }

    // Uncaught unexpected errors
    console.error('Unhandled exception:', exception);
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error_type: 'INFRASTRUCTURE_ERROR',
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: (exception as Error)?.message || 'Internal server error',
    });
  }
}
