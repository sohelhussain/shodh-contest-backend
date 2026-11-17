import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from '../auth.service';
import { BusinessRuleException } from '../../common/errors/exceptions';

@Injectable()
export class JudgeAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-judge-token'] as string;

    if (!token) {
      throw new BusinessRuleException(
        'Missing judge token: x-judge-token header required',
        'JUDGE_AUTH_REQUIRED',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (!this.authService.verifyJudgeToken(token)) {
      throw new BusinessRuleException(
        'Invalid judge token',
        'JUDGE_AUTH_INVALID',
        HttpStatus.UNAUTHORIZED,
      );
    }

    request.isJudge = true;
    return true;
  }
}
