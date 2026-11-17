import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from '../auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessRuleException } from '../../common/errors/exceptions';

@Injectable()
export class DevAuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.headers['x-dev-user-id'] as string;
    const signature = request.headers['x-dev-signature'] as string;

    if (!userId || !signature) {
      throw new BusinessRuleException(
        'Missing authentication headers: x-dev-user-id and x-dev-signature are required',
        'AUTH_REQUIRED',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const isValid = this.authService.verifySignature(userId, signature);
    if (!isValid) {
      throw new BusinessRuleException(
        'Invalid authentication signature',
        'INVALID_SIGNATURE',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          include: { organization: true },
        },
      },
    });

    if (!user) {
      throw new BusinessRuleException(
        'User not found',
        'USER_NOT_FOUND',
        HttpStatus.UNAUTHORIZED,
      );
    }

    request.user = user;
    return true;
  }
}
