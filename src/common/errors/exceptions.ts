import { HttpException, HttpStatus } from '@nestjs/common';

export class BusinessRuleException extends HttpException {
  public readonly code: string;

  constructor(message: string, code: string, status: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY) {
    super(
      {
        error_type: 'BUSINESS_RULE_ERROR',
        statusCode: status,
        code,
        message,
      },
      status,
    );
    this.code = code;
  }
}

export class CrossOrgNotFoundException extends BusinessRuleException {
  constructor(entityName = 'Resource') {
    super(`${entityName} not found`, 'NOT_FOUND', HttpStatus.NOT_FOUND);
  }
}

export class InfrastructureException extends HttpException {
  constructor(message: string) {
    super(
      {
        error_type: 'INFRASTRUCTURE_ERROR',
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message,
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
